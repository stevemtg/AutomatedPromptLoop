import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { NdjsonParser } from './ndjson';
import { Settings } from './types';

type Json = Record<string, any>;
const optionRanges: Record<string, [number, number, boolean?]> = {
  temperature: [0, 2], top_p: [0, 1], top_k: [0, 1000, true], min_p: [0, 1],
  repeat_penalty: [0, 2], repeat_last_n: [-1, 1000000, true],
  presence_penalty: [-2, 2], frequency_penalty: [-2, 2],
  num_predict: [-1, 1000000, true], seed: [0, 2147483647, true]
};

export function validateOllamaSettings(settings: Settings): void {
  if (!Number.isInteger(settings.ollamaContextWindow) || settings.ollamaContextWindow < 0) throw new Error('Ollama Context Window must be a nonnegative integer.');
  if (!Number.isFinite(settings.ollamaRequestTimeout) || settings.ollamaRequestTimeout <= 0) throw new Error('Ollama Request Timeout must be positive.');
  if (settings.ollamaKeepAlive && !/^(?:-1|0|\d+(?:\.\d+)?(?:ms|s|m|h))$/.test(settings.ollamaKeepAlive)) throw new Error('Ollama Keep Alive must be a duration such as 30m, 0, or -1.');
  if (!settings.ollamaOptions || typeof settings.ollamaOptions !== 'object' || Array.isArray(settings.ollamaOptions)) throw new Error('Ollama Options must be an object.');
  for (const [key, value] of Object.entries(settings.ollamaOptions)) {
    const range = optionRanges[key];
    if (!range || typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1] || (range[2] && !Number.isInteger(value))) throw new Error(`Invalid Ollama option: ${key}.`);
  }
}

/** Repair AI SDK 7's misplaced sampling fields without touching messages or tool results.
 * Native Ollama uses options.num_predict, not max_output_tokens. Model defaults matter
 * for Qwen: Cline's implicit temperature/think values should not override its Modelfile. */
export function normalizeOllamaRequest(body: Json, settings: Settings, provider: Json): Json {
  const options = { ...body.options };
  const mappings = { temperature: 'temperature', top_p: 'top_p', max_output_tokens: 'num_predict' };
  for (const [source, target] of Object.entries(mappings)) {
    if (body[source] !== undefined && options[target] === undefined
      && (source !== 'temperature' || provider.temperature !== undefined)) options[target] = body[source];
  }
  if (settings.ollamaContextWindow) options.num_ctx = settings.ollamaContextWindow;
  Object.assign(options, settings.ollamaOptions);
  const result: Json = { ...body, options };
  for (const key of Object.keys(mappings)) delete result[key];
  if (settings.ollamaKeepAlive) result.keep_alive = settings.ollamaKeepAlive === '-1' ? -1 : settings.ollamaKeepAlive;
  if (settings.thinking) {
    // Qwen's native Ollama API supports on/off. Do not assume a model accepts
    // GPT-OSS thinking levels or Qwen's hosted reasoning_effort parameter.
    result.think = settings.thinking !== 'none';
  } else if (provider.thinking === undefined && provider.reasoningEffort === undefined) {
    delete result.think; // Let Ollama select the model's default (thinking on for Qwen).
  }
  if (Array.isArray(result.tools)) result.tools = result.tools.map((tool: Json) =>
    tool.type === 'function' && !tool.function && typeof tool.name === 'string'
      ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } } : tool);
  return result;
}

export interface OllamaBridge {
  baseUrl: string;
  close(): Promise<void>;
}

/** A per-attempt, loopback-only native API adapter. Raw response bytes stream through
 * with backpressure; aborting Cline also aborts inference. No request history is kept. */
export async function startOllamaBridge(upstream: string, settings: Settings, provider: Json,
  onEvent: (event: unknown) => void, diagnostic: (text: string) => void): Promise<OllamaBridge> {
  validateOllamaSettings(settings);
  const target = new URL(upstream.replace(/\/+$/, '').replace(/\/(api|v1)$/, '') + '/');
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('Ollama base URL must be an HTTP(S) URL without credentials, query, or fragment.');
  const secret = randomBytes(24).toString('hex');
  const pending = new Set<() => void>();
  let warned = false;
  const server = createServer((req, res) => { void handle(req, res).catch(error => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    if (!res.destroyed) res.end(JSON.stringify({ error: `Prompt Loop Ollama adapter: ${error.message}` }));
  }); });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = req.url?.slice(`/${secret}`.length);
    if (!req.url?.startsWith(`/${secret}/`) || !['/api/chat', '/api/show', '/api/tags', '/api/version', '/api/ps'].includes(route ?? '')) { res.writeHead(404).end(); return; }
    if (!['GET', 'POST'].includes(req.method ?? '')) { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
    let payload = Buffer.concat(chunks);
    const chat = route === '/api/chat';
    if (chat) {
      const body = normalizeOllamaRequest(JSON.parse(payload.toString('utf8')), settings, provider);
      if (!warned && body.messages?.some((message: Json) => message.role === 'assistant' && message.thinking)) {
        warned = true;
        diagnostic('Verified: assistant thinking is present in the native Ollama request. The SDK warning about unsupported reasoning in Ollama responses is a false positive in ollama-ai-provider-v2 4.0.1.');
      }
      payload = Buffer.from(JSON.stringify(body));
    }
    const id = randomBytes(8).toString('hex');
    if (chat) onEvent({ type: 'ollama_request', id, phase: 'started', message: 'Ollama is evaluating the prompt or generating tokens.' });
    try {
      await new Promise<void>((resolve, reject) => {
        const headers = { ...req.headers, host: target.host, 'content-length': String(payload.length) };
        delete headers.connection;
        const outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(route!.slice(1), target), { method: req.method, headers }, incoming => {
          res.writeHead(incoming.statusCode ?? 502, { 'content-type': incoming.headers['content-type'] ?? 'application/x-ndjson' });
          incoming.on('data', chunk => { touch(); if (chat) parser.write(chunk); });
          incoming.on('error', reject);
          incoming.on('end', () => { parser.end(); resolve(); });
          incoming.pipe(res);
        });
        const parser = new NdjsonParser(raw => {
          const value = raw as Json;
          if (value?.done === true) {
            if (chat) onEvent({ type: 'generation_metrics', requestId: id, outputTokens: value.eval_count, durationMs: value.eval_duration / 1e6 });
            const rate = value.eval_duration > 0 ? (value.eval_count / (value.eval_duration / 1e9)).toFixed(1) : undefined;
            diagnostic(`Ollama: ${value.prompt_eval_count ?? 0} prompt tokens, ${value.eval_count ?? 0} generated tokens${rate ? `, ${rate} tokens/s` : ''}, ${((value.load_duration ?? 0) / 1e9).toFixed(2)}s loading, ${value.prompt_eval_cached_count ?? 0} cached prompt tokens.`);
          }
        }, () => {});
        let timer: NodeJS.Timeout;
        const touch = (): void => { clearTimeout(timer); timer = setTimeout(() => outgoing.destroy(new Error(`Ollama sent no data for ${settings.ollamaRequestTimeout} seconds.`)), settings.ollamaRequestTimeout * 1000); };
        const abort = (): void => { outgoing.destroy(new Error('Ollama request cancelled.')); };
        pending.add(abort);
        res.once('close', abort);
        outgoing.once('error', reject);
        outgoing.once('close', () => { clearTimeout(timer); pending.delete(abort); res.removeListener('close', abort); });
        touch(); outgoing.end(payload);
      });
    } finally { if (chat) onEvent({ type: 'ollama_request', id, phase: 'finished', message: 'Ollama request finished.' }); }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}/${secret}`, close: async () => {
    for (const abort of pending) abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

export interface OllamaRuntime { env: NodeJS.ProcessEnv; close(): Promise<void> }
export async function prepareOllama(settings: Settings, onEvent: (event: unknown) => void, diagnostic: (text: string) => void): Promise<OllamaRuntime | undefined> {
  if (!settings.ollamaEnabled || (settings.provider && settings.provider !== 'ollama')) return;
  const source = process.env.CLINE_PROVIDER_SETTINGS_PATH || path.join(process.env.CLINE_DATA_DIR || path.join(process.env.CLINE_DIR || path.join(os.homedir(), '.cline'), 'data'), 'settings', 'providers.json');
  let config: Json;
  try { config = JSON.parse(await readFile(source, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read Cline provider settings: ${error}`); return; }
  const selected = settings.provider || config.modes?.act?.provider || config.lastUsedProvider;
  if (selected !== 'ollama') return;
  if (config.version !== 1 || !config.providers?.ollama?.settings) throw new Error('Unsupported Cline provider settings format. Disable Ollama Enabled to use Cline directly.');
  const provider = config.providers.ollama.settings;
  const bridge = await startOllamaBridge(provider.baseUrl || 'http://127.0.0.1:11434', settings, provider, onEvent, diagnostic);
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'prompt-loop-ollama-'));
    const file = path.join(directory, 'providers.json');
    // Only the child uses this snapshot. Global Cline settings, rules, MCP, and
    // session storage retain their existing paths.
    config.providers.ollama.settings = { ...provider, baseUrl: bridge.baseUrl,
      timeoutMs: settings.ollamaRequestTimeout * 1000,
      ...(settings.ollamaContextWindow ? { contextWindow: settings.ollamaContextWindow } : {}) };
    await writeFile(file, JSON.stringify(config), { mode: 0o600 });
    diagnostic(`Ollama native adapter enabled; context ${settings.ollamaContextWindow || provider.contextWindow || 'Cline default'}, inference inactivity timeout ${settings.ollamaRequestTimeout}s, thinking ${settings.thinking || 'model/configuration default'}.`);
    return { env: { CLINE_PROVIDER_SETTINGS_PATH: file }, close: async () => {
      try { await bridge.close(); } finally { await rm(directory!, { recursive: true, force: true }); }
    } };
  } catch (error) { await bridge.close(); if (directory) await rm(directory, { recursive: true, force: true }); throw error; }
}
