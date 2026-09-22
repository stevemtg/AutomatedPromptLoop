import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { PromptLoopController } from './extension';
import { QueueState, Settings } from './types';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';

export class PromptLoopView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  constructor(private readonly extensionUri: vscode.Uri, private readonly controller: PromptLoopController, private readonly imageDirectory: vscode.Uri) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), this.imageDirectory,
      ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri)] };
    const nonce = randomBytes(24).toString('base64');
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const transcriptJs = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'transcript.js'));
    const transcriptCss = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'transcript.css'));
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data: https: http:; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link href="${css}" rel="stylesheet"><link href="${transcriptCss}" rel="stylesheet"><title>Prompt Loop</title></head><body>
<header><div class="brand"><span class="brand-mark" aria-hidden="true">↻</span><div><h1>Prompt Loop</h1><p>One project. One prompt at a time.</p></div></div><button id="settings" class="quiet" title="Open Prompt Loop settings" aria-label="Open settings">⚙</button></header>
<main>
<section class="project"><span class="eyebrow">PROJECT</span><button id="workspace" class="project-name" title="Choose workspace">Select project folder</button></section>
<div id="notice" role="alert" hidden></div>
<section class="run-card"><div class="run-heading"><span id="status" class="badge">IDLE</span><span id="progress">0 / 0 complete</span></div><p id="activity" role="status" aria-live="polite">Ready when you are</p><progress id="progressbar" max="1" value="0" aria-label="Queue progress"></progress>
<div class="controls"><button id="start" class="primary">▶ Start Queue</button><button id="pause" title="Interrupt this attempt and preserve the session">Ⅱ Pause</button><button id="resume">▶ Resume Queue</button><button id="retry">↻ Retry Failed</button><button id="skip">Skip →</button><button id="stop" class="danger">■ Stop</button></div></section>
<details class="constant"><summary>Shared instructions <span>prompt_constant</span></summary><label for="constant">Prepended to every prompt and retry</label><textarea id="constant" rows="4" placeholder="Project conventions, testing requirements, working style…"></textarea><button id="saveConstant">Save instructions</button><span id="constantSaved" role="status"></span></details>
<section><div class="section-heading"><h2>Prompt queue <span id="queueCount" class="count">0</span></h2><div><button id="import" class="quiet">Import</button><button id="export" class="quiet">Export</button></div></div><ol id="queue" aria-label="Prompt queue"></ol><div id="empty" class="empty"><span aria-hidden="true">≋</span><h3>Give your project a next step.</h3><p>Add a prompt below, or paste a whole list.<br>Prompt Loop takes care of the sequence.</p></div>
<div class="composer"><label for="prompt">Add to the queue</label><textarea id="prompt" rows="5" placeholder="Describe what to build, fix, or verify…"></textarea><p class="hint">Separate prompts with a line containing <code>---</code>. Use Ctrl/Cmd + Enter to add.</p><div class="composer-footer"><button id="clear" class="quiet">Clear queue</button><button id="add" class="primary">＋ Add prompts</button></div></div></section>
<section class="monitor"><div class="section-heading"><h2>Activity <span id="activityLive" class="activity-live" hidden>Live</span></h2><button id="logs" class="quiet">Output log ↗</button></div><div class="session"><span class="eyebrow">SESSION</span><code id="session">No active session</code></div><div class="metrics"><div><strong id="tokensIn">0</strong><span>tokens in</span></div><div><strong id="tokensOut">0</strong><span>tokens out</span></div><div><strong id="cost">$0.0000</strong><span>reported cost</span></div><div id="generationSpeedMetric" class="generation-metric" title="Waiting for a completed model response with token counts and timing."><strong id="generationSpeed">—</strong><span>avg generation (tokens/s)</span></div></div>
<div class="activity-filters" role="group" aria-label="Filter activity"><button class="quiet" data-filter="all" aria-pressed="true">All</button><button class="quiet" data-filter="responses" aria-pressed="false">Responses</button><button class="quiet" data-filter="tools" aria-pressed="false">Tools</button><button class="quiet" data-filter="problems" aria-pressed="false">Problems</button></div>
<div class="activity-search"><input id="activitySearch" type="search" placeholder="Search activity…" aria-label="Search activity"><button id="copyTranscript" class="quiet" title="Copy the visible activity">Copy</button></div>
<div class="transcript-toolbar"><label><input id="follow" type="checkbox" checked> Follow activity</label><button id="logfile" class="quiet">Full log file</button></div>
<div class="transcript-shell"><div id="transcript" tabindex="0" role="region" aria-label="Live task transcript"></div><button id="jumpLatest" hidden>↓ Latest activity</button></div>
<div class="activity-footer"><span id="activityCount">No activity yet</span><span id="copyStatus" role="status" aria-live="polite"></span></div></section>
<footer id="footer">180s stall timeout · 3 attempts</footer></main><script nonce="${nonce}" src="${transcriptJs}"></script><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(message => {
      void this.controller.guard(async () => {
        if (!message || typeof message.type !== 'string') throw new Error('Invalid panel message.');
        const queue = this.controller.queue;
        switch (message.type) {
          case 'ready': this.controller.refresh(); break;
          case 'start': case 'resume': await this.controller.start(); break;
          case 'pause': await queue.pause(); break;
          case 'stop': await queue.stop(); break;
          case 'retry': await this.controller.retry(); break;
          case 'skip': await queue.skip(); break;
          case 'add': queue.add(message.prompts); break;
          case 'edit': if (typeof message.id === 'string' && typeof message.text === 'string') queue.edit(message.id, message.text); break;
          case 'remove': if (typeof message.id === 'string') queue.remove(message.id); break;
          case 'move': if (typeof message.id === 'string' && typeof message.direction === 'number') queue.move(message.id, message.direction); break;
          case 'clear': queue.clear(); break;
          case 'workspace': await this.controller.selectWorkspace(); break;
          case 'constant': await this.controller.saveConstant(message.value); void this.view?.webview.postMessage({ type: 'constantSaved' }); break;
          case 'logs': this.controller.output.show(true); break;
          case 'logfile': await this.controller.showLogFile(); break;
          case 'copy':
            if (typeof message.text !== 'string' || message.text.length > 10_000_000) throw new Error('Invalid text to copy.');
            await vscode.env.clipboard.writeText(message.text);
            void this.view?.webview.postMessage({ type: 'copied' });
            break;
          case 'openLink': {
            if (typeof message.url !== 'string') throw new Error('Invalid link.');
            const uri = vscode.Uri.parse(message.url, true);
            if (!['https', 'http'].includes(uri.scheme.toLowerCase())) throw new Error('Only web links can be opened from activity.');
            await vscode.env.openExternal(uri);
            break;
          }
          case 'import': await this.controller.importPrompts(); break;
          case 'export': await this.controller.exportPrompts(); break;
          case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'promptLoop'); break;
          default: throw new Error('Unknown panel action.');
        }
      });
    });
    view.onDidDispose(() => { this.view = undefined; });
  }
  update(state: QueueState, settings: Settings, busy: boolean): void {
    if (!this.view) return;
    const webview = this.view.webview;
    const roots = [this.imageDirectory, ...(state.workspace ? [vscode.Uri.file(state.workspace)] : [])];
    const imageSource = (src: string): string => {
      if (/^https?:\/\//i.test(src)) return src;
      if (!src || !/\.(png|jpe?g|webp|gif)$/i.test(src)) return '';
      try {
        const file = /^file:/i.test(src) ? vscode.Uri.parse(src).fsPath : path.resolve(state.workspace ?? '', src);
        const resolved = realpathSync(file);
        const allowed = roots.some(root => {
          try {
            const relative = path.relative(realpathSync(root.fsPath), resolved);
            return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
          } catch { return false; }
        });
        return allowed ? webview.asWebviewUri(vscode.Uri.file(resolved)).toString() : '';
      } catch { return ''; }
    };
    // Raw events stay in the host; only bounded display fields reach the panel.
    const logs = state.logs.map(({ data, ...entry }) => ({ ...entry,
      display: entry.display?.type === 'tool' && entry.display.images ? { ...entry.display, images: entry.display.images.map(image => ({ ...image, src: imageSource(image.src) })) } : entry.display
    }));
    void webview.postMessage({ type: 'state', state: { ...state, logs }, settings, busy });
  }
  error(message: string): void { void this.view?.webview.postMessage({ type: 'error', message }); }
}
