import * as vscode from 'vscode';
import { createWriteStream, WriteStream } from 'node:fs';
import { PromptQueue } from './queue';
import { runCline } from './runner';
import { defaultSettings, QueueState, Settings } from './types';
import { PromptLoopView } from './webview';
import { ImageCache } from './images';

let controller: PromptLoopController | undefined;
export async function activate(context: vscode.ExtensionContext): Promise<PromptLoopController> {
  controller = new PromptLoopController(context);
  await controller.initialize();
  return controller;
}
export async function deactivate(): Promise<void> { await controller?.dispose(); }

export class PromptLoopController {
  readonly queue: PromptQueue;
  readonly output = vscode.window.createOutputChannel('Prompt Loop');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  private logStream?: WriteStream;
  private logUri?: vscode.Uri;
  private refreshTimer?: NodeJS.Timeout;
  private persist = Promise.resolve();
  private view: PromptLoopView;
  private closed = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    const imageDirectory = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'images');
    const imageCache = new ImageCache(imageDirectory.fsPath, message => this.output.appendLine(message));
    this.queue = new PromptQueue(runCline, () => this.settings(), context.workspaceState.get<QueueState>('queue'), display => imageCache.prepare(display));
    this.view = new PromptLoopView(context.extensionUri, this, imageDirectory);
  }
  settings(): Settings {
    const workspace = this.queue?.snapshot().workspace;
    const config = vscode.workspace.getConfiguration('promptLoop', workspace ? vscode.Uri.file(workspace) : undefined);
    return Object.fromEntries(Object.entries(defaultSettings).map(([key, value]) => [key, config.get(key, value)])) as unknown as Settings;
  }
  async initialize(): Promise<void> {
    const directory = this.context.storageUri ?? this.context.globalStorageUri;
    await vscode.workspace.fs.createDirectory(directory);
    this.logUri = vscode.Uri.joinPath(directory, `prompt-loop-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
    this.logStream = createWriteStream(this.logUri.fsPath, { flags: 'a', encoding: 'utf8' });
    this.logStream.on('error', error => {
      this.output.appendLine(`Could not write log file: ${error.message}`);
      void vscode.window.showErrorMessage(`Prompt Loop could not write its log: ${error.message}`);
    });
    this.queue.on('log', entry => {
      this.output.appendLine(`[${entry.time}] ${entry.kind.toUpperCase()}${entry.attempt ? ` #${entry.attempt}` : ''} ${entry.message}`);
      if (!this.logStream?.destroyed) this.logStream?.write(JSON.stringify(entry) + '\n');
    });
    this.queue.on('change', () => this.scheduleRefresh());
    this.context.subscriptions.push(this.output, this.status,
      vscode.window.registerWebviewViewProvider('promptLoop.panel', this.view, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('promptLoop')) this.refresh(); })
    );
    const commands: Record<string, () => unknown> = {
      open: () => this.open(), start: () => this.start(), pause: () => this.queue.pause(),
      resume: () => this.start(), retry: () => this.retry(), skip: () => this.queue.skip(), stop: () => this.queue.stop(),
      add: async () => { const text = await vscode.window.showInputBox({ title: 'Add prompt to queue', prompt: 'For multiline prompts, use the Prompt Loop sidebar.', ignoreFocusOut: true }); if (text?.trim()) this.queue.add([text]); await this.open(); },
      logs: () => this.output.show(true)
    };
    for (const [name, handler] of Object.entries(commands)) this.context.subscriptions.push(vscode.commands.registerCommand(`promptLoop.${name}`, () => this.guard(handler)));
    this.status.command = 'promptLoop.open'; this.status.show(); this.refresh();
  }
  async guard(action: () => unknown): Promise<void> {
    try { await action(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.error(message); this.output.appendLine(`ERROR ${message}`); void vscode.window.showErrorMessage(`Prompt Loop: ${message}`);
    }
  }
  async open(): Promise<void> { await vscode.commands.executeCommand('promptLoop.panel.focus'); }
  async selectWorkspace(): Promise<void> {
    if (this.queue.busy) throw new Error('Stop the queue before changing projects.');
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) throw new Error('Open a local project folder in VS Code first.');
    const selected = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the project for this prompt queue' });
    if (selected) {
      if (selected.uri.scheme !== 'file') throw new Error('Prompt Loop requires a filesystem workspace.');
      this.queue.setWorkspace(selected.uri.fsPath);
    }
  }
  private async ensureWorkspace(): Promise<boolean> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before running Cline.');
    if (!this.queue.snapshot().workspace) await this.selectWorkspace();
    const selected = this.queue.snapshot().workspace;
    if (!selected) return false;
    if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath === selected)) throw new Error('The queued project is no longer open. Open it again or clear the queue and select another project.');
    return true;
  }
  async start(): Promise<void> { if (await this.ensureWorkspace()) { this.queue.start(); await this.open(); } }
  async retry(): Promise<void> { if (await this.ensureWorkspace()) await this.queue.retry(); }
  async saveConstant(text: string): Promise<void> {
    if (typeof text !== 'string' || text.length > 200000) throw new Error('Prompt constant is too large.');
    if (!await this.ensureWorkspace()) return;
    const uri = vscode.Uri.file(this.queue.snapshot().workspace!);
    await vscode.workspace.getConfiguration('promptLoop', uri).update('prompt_constant', text, vscode.ConfigurationTarget.WorkspaceFolder);
    this.refresh();
  }
  async showLogFile(): Promise<void> { if (this.logUri) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(this.logUri), { preview: false }); }
  async importPrompts(): Promise<void> {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Prompt list': ['json', 'txt', 'md'] } });
    if (!files?.[0]) return;
    const contents = Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8');
    if (contents.length > 5_000_000) throw new Error('Prompt list must be smaller than 5 MB.');
    const prompts = files[0].path.endsWith('.json') ? JSON.parse(contents) : contents.split(/^\s*---\s*$/m);
    this.queue.add(prompts);
  }
  async exportPrompts(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`${this.queue.snapshot().workspace ?? ''}/prompts.json`), filters: { JSON: ['json'] } });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this.queue.snapshot().items.map(item => item.text), null, 2) + '\n'));
  }
  private scheduleRefresh(): void {
    if (!this.refreshTimer) this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.refresh(); }, 150);
  }
  refresh(): void {
    if (this.closed) return;
    const state = this.queue.snapshot();
    const current = state.items.find(item => item.id === state.currentId);
    const icon = state.status === 'running' ? '$(sync~spin)' : state.status === 'paused' ? '$(debug-pause)' : '$(list-ordered)';
    this.status.text = `${icon} Prompt Loop${current ? ` ${state.items.indexOf(current) + 1}/${state.items.length} · attempt ${current.attempts}` : ` · ${state.status}`}`;
    this.status.tooltip = state.activity;
    this.view.update(state, this.settings(), this.queue.busy);
    // Limit persisted transcript data; the append-only NDJSON file contains full events.
    const saved = { ...state, logs: state.logs.slice(-150).map(({ data, ...entry }) => entry) };
    this.persist = this.persist.then(() => this.context.workspaceState.update('queue', saved)).catch(error => { this.output.appendLine(`Could not save queue: ${error}`); });
  }
  async dispose(): Promise<void> {
    await this.queue.shutdown();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refresh(); this.closed = true; await this.persist;
    if (this.logStream && !this.logStream.destroyed) await new Promise<void>(resolve => this.logStream!.end(resolve));
  }
}
