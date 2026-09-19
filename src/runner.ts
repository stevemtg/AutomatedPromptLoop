import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { NdjsonParser } from './ndjson';
import { Runner, RunRequest, RunResult, Settings } from './types';
import { findSession, sessionDirectories, sessionsDirectory } from './sessions';
import { OllamaRuntime, prepareOllama } from './ollama';

function findExecutable(name: string, extra: string[] = []): string | undefined {
  if (path.isAbsolute(name)) return existsSync(name) ? name : undefined;
  const directories = [...(process.env.PATH ?? '').split(path.delimiter), ...extra].filter(Boolean);
  const suffixes = process.platform === 'win32' && !path.extname(name) ? ['.exe', '.cmd', '.ps1', ''] : [''];
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = path.join(directory.replace(/^"|"$/g, ''), name + suffix);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
export function resolveCli(settings: Pick<Settings, 'cliPath' | 'nodePath'>): { command: string; prefix: string[] } {
  const extra = process.platform === 'win32' ? [path.join(process.env.APPDATA ?? os.homedir(), 'npm')] : [];
  const cli = findExecutable(settings.cliPath || 'cline', extra);
  if (!cli) throw new Error('Cline CLI was not found. Set Prompt Loop: Cli Path to your installed Cline executable.');
  let entry = realpathSync(cli);
  if (/\.(cmd|ps1)$/i.test(entry)) {
    // Resolve the npm package entry instead of sending prompts through cmd.exe.
    const manifestPath = path.join(path.dirname(entry), 'node_modules', 'cline', 'package.json');
    if (!existsSync(manifestPath)) throw new Error('This CLI shim is not an npm Cline installation. Set Cli Path to the executable or JavaScript entry point.');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    entry = path.resolve(path.dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.cline);
  }
  const isScript = /\.(c?js|mjs)$/i.test(entry) || (!/\.exe$/i.test(entry) && readFileSync(entry).subarray(0, 120).toString().includes('node'));
  if (!isScript) return { command: entry, prefix: [] };
  const node = findExecutable(settings.nodePath || 'node', process.platform === 'win32' ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs')] : []);
  if (!node) throw new Error('Node.js was not found. Set Prompt Loop: Node Path to node.exe.');
  return { command: node, prefix: [entry] };
}
export function buildArgs(request: RunRequest): string[] {
  const args = ['--json', '--auto-approve', String(request.settings.autoApprove), '--cwd', request.workspace];
  if (request.settings.model) args.push('--model', request.settings.model);
  if (request.settings.provider) args.push('--provider', request.settings.provider);
  if (request.settings.thinking) args.push('--thinking', request.settings.thinking);
  if (request.settings.compaction) args.push('--compaction', request.settings.compaction);
  if (request.settings.cliRetries > 0) args.push('--retries', String(request.settings.cliRetries));
  if (request.sessionId) args.push('--id', request.sessionId);
  args.push('--', request.prompt);
  return args;
}
async function terminateTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', code => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(new Error(`Could not terminate Cline process tree (taskkill exit ${code}).`));
      });
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    await new Promise(resolve => setTimeout(resolve, 500));
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}
const spawnCline = (request: RunRequest, onEvent: (event: unknown) => void, onDiagnostic: (text: string) => void, env: NodeJS.ProcessEnv = {}): ReturnType<Runner> => {
  const resolved = resolveCli(request.settings);
  const args = [...resolved.prefix, ...buildArgs(request)];
  if (process.platform === 'win32' && resolved.command.length + args.reduce((length, arg) => length + arg.length * 2 + 3, 0) > 30000) {
    throw new Error('This prompt exceeds the Windows process argument limit. Split it into smaller prompts or shorten the shared instructions.');
  }
  const child = spawn(resolved.command, args, {
    cwd: request.workspace, shell: false, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, ...env, PATH: [path.dirname(resolved.command), process.env.PATH].filter(Boolean).join(path.delimiter), CLINE_SESSION_BACKEND_MODE: 'local' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const parser = new NdjsonParser(onEvent, onDiagnostic);
  const diagnostics = new NdjsonParser(value => onDiagnostic(JSON.stringify(value)), onDiagnostic);
  child.stdout.on('data', data => parser.write(data));
  child.stderr.on('data', data => diagnostics.write(data));
  let spawnError: string | undefined;
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') onDiagnostic(error.message); });
  // Cline's Windows npm wrapper can lose piped stdin. Pass one literal argument
  // with shell:false; Node performs OS argument quoting and nothing is expanded.
  child.stdin.end();
  const result = new Promise<RunResult>(resolve => {
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (code, signal) => { parser.end(); diagnostics.end(); resolve({ code, signal, error: spawnError }); });
  });
  let cancellation: Promise<void> | undefined;
  return { result, cancel: () => cancellation ??= terminateTree(child) };
};

export const runCline: Runner = (request, onEvent, onDiagnostic) => {
  let handle: ReturnType<Runner> | undefined;
  let cancelled = false;
  const result = (async (): Promise<RunResult> => {
    const directory = sessionsDirectory();
    let existing: Set<string>;
    try { existing = new Set(await sessionDirectories(directory)); }
    catch (error) { return { code: null, error: `Cannot inspect Cline session storage: ${error}` }; }
    if (cancelled) return { code: null, signal: 'cancelled' };
    const started = Date.now();
    let captured = Boolean(request.sessionId), polling = false, resumeRejected = false;
    const inspectCompatibility = (text: string): void => {
      if (request.sessionId && text.includes('JSON output mode requires a prompt argument or piped stdin (interactive mode is unsupported)')) resumeRejected = true;
    };
    let lastPoll: Promise<void> = Promise.resolve();
    const poll = async (): Promise<void> => {
      if (captured || polling) return;
      polling = true;
      try {
        const id = await findSession(directory, existing, request.workspace, request.prompt, started);
        if (id) { captured = true; onEvent({ type: 'session', sessionId: id }); }
      } catch (error) { onDiagnostic(`Session discovery: ${error}`); }
      finally { polling = false; }
    };
    let timer: NodeJS.Timeout | undefined;
    let ollama: OllamaRuntime | undefined;
    try {
      ollama = await prepareOllama(request.settings, onEvent, onDiagnostic);
      if (cancelled) return { code: null, signal: 'cancelled' };
      handle = spawnCline(request, event => {
        const record = event as Record<string, unknown> | null;
        if (record?.sessionId || record?.session_id) captured = true;
        if (record?.type === 'error') inspectCompatibility(String(record.message ?? ''));
        onEvent(event);
      }, text => { inspectCompatibility(text); onDiagnostic(text); }, ollama?.env);
      timer = setInterval(() => { lastPoll = poll(); }, 500);
      const exit = await handle.result;
      clearInterval(timer); await lastPoll; await poll();
      if (resumeRejected && exit.code !== 0 && !cancelled) {
        onDiagnostic('This Cline version rejects --json with --id. Starting a fresh session with the original prompt, shared instructions, and completion reminder. Prior conversation history is unavailable; project files are preserved.');
        onEvent({ type: 'session_reset' });
        handle = runCline({ ...request, sessionId: undefined }, onEvent, onDiagnostic);
        return await handle.result;
      }
      if (!captured) onDiagnostic('No stable Cline session ID found. A retry will start a new session with the original prompt and reminder.');
      return exit;
    } catch (error) { return { code: null, error: error instanceof Error ? error.message : String(error) }; }
    finally {
      if (timer) clearInterval(timer);
      try { await ollama?.close(); } catch (error) { onDiagnostic(`Ollama adapter cleanup: ${error}`); }
    }
  })();
  return { result, cancel: async () => { cancelled = true; if (handle) await handle.cancel(); } };
};
