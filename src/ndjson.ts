import { StringDecoder } from 'node:string_decoder';
import { LogDisplay } from './types';

/** Handles split UTF-8 characters, multiple records per chunk and a final line without LF. */
export class NdjsonParser {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private dropping = false;
  constructor(private readonly onRecord: (value: unknown) => void, private readonly onDiagnostic: (text: string) => void, private readonly maxLine = 4 * 1024 * 1024) {}
  write(chunk: Buffer | string): void {
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (!this.dropping) this.line(line);
      this.dropping = false;
    }
    if (this.pending.length > this.maxLine) {
      this.pending = ''; this.dropping = true;
      this.onDiagnostic('Cline output line exceeded the 4 MiB limit and was discarded.');
    }
  }
  end(): void {
    this.pending += this.decoder.end();
    if (!this.dropping && this.pending.trim()) this.line(this.pending);
    this.pending = '';
  }
  private line(raw: string): void {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!line) return;
    if (line.length > this.maxLine) { this.onDiagnostic('Oversized Cline output record discarded.'); return; }
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.onDiagnostic(line.slice(0, 8000)); return; }
    this.onRecord(value);
  }
}

type RecordValue = Record<string, any>;
function object(value: unknown): RecordValue { return value !== null && typeof value === 'object' ? value as RecordValue : {}; }
export interface NormalizedEvent {
  kind: 'text' | 'tool' | 'usage' | 'error' | 'event'; message: string;
  display?: LogDisplay;
  sessionId?: string; success: boolean; failure?: string; meaningful: boolean;
  usage?: { inputTokens: number; outputTokens: number; cost: number; cumulative: boolean };
}
// Only bounded, presentational fields cross into the webview or workspace state.
function displayText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > 20000 ? text.slice(0, 20000) + '\n… Truncated. Open the full log file for more.' : text;
}
function toolDisplay(event: RecordValue, outer: RecordValue, type: string): LogDisplay {
  const output = event.output ?? event.update ?? event.result;
  const outputs = Array.isArray(output) ? output : [output];
  const failed = /error|failed/.test(type) || event.success === false || event.is_error === true
    || outputs.some(value => object(value).success === false || object(value).is_error === true || object(value).error);
  const completed = type === 'content_end' || /tool_(result|end|complete)/.test(type) || event.output !== undefined;
  const display: Extract<LogDisplay, { type: 'tool' }> = {
    type: 'tool', name: String(event.toolName ?? event.name ?? object(event.toolCall).name ?? 'Tool').slice(0, 200),
    status: failed ? 'failed' : completed ? 'completed' : /start|tool_call/.test(type) ? 'running' : 'unknown'
  };
  const callId = event.toolCallId ?? object(event.toolCall).id;
  const agentId = outer.parentAgentId ?? event.parentAgentId;
  if (typeof callId === 'string') display.callId = callId.slice(0, 500);
  if (typeof agentId === 'string') display.agentId = agentId.slice(0, 500);
  if (event.input !== undefined) {
    display.input = displayText(event.input);
    const input = object(event.input);
    const summary = input.path ?? input.command ?? input.query ?? (Array.isArray(input.files) ? input.files.map(file => object(file).path).filter(Boolean).join(', ') : undefined);
    if (typeof summary === 'string') display.summary = summary.slice(0, 300);
  }
  if (output !== undefined) {
    const results = outputs.map(value => object(value));
    if (typeof output === 'string') { display.output = displayText(output); display.outputFormat = 'markdown'; }
    else if (results.length && results.every(value => typeof value.result === 'string')) {
      display.output = displayText(results.map(value => `${results.length > 1 && typeof value.query === 'string' ? value.query + '\n\n' : ''}${value.result}`).join('\n\n---\n\n'));
      display.outputFormat = 'markdown';
    } else { display.output = displayText(output); display.outputFormat = 'json'; }
  }
  if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) && event.durationMs >= 0) display.durationMs = event.durationMs;
  return display;
}
export function normalizeEvent(raw: unknown): NormalizedEvent {
  const outer = object(raw);
  const event = outer.type === 'agent_event' ? object(outer.event) : outer;
  const type = String(event.type ?? 'unknown');
  // hook_event.taskId is a conversation ID, NOT the persisted --id session ID.
  const sessionId = outer.sessionId ?? outer.session_id ?? event.sessionId ?? event.session_id;
  const result = object(event.result);
  const terminal = type === 'done' || type === 'run_result';
  const finishReason = event.finishReason ?? event.reason;
  const failed = (terminal && finishReason !== 'completed') || type === 'error' || type === 'task_failed' || type === 'failed'
    || (type === 'result' && (event.success === false || event.is_error === true || event.status === 'failed'));
  const childEvent = Boolean(outer.parentAgentId || event.parentAgentId);
  const success = !childEvent && !failed && ((terminal && finishReason === 'completed') || type === 'task_complete' || type === 'task_completed'
    || (type === 'result' && (event.success === true || event.status === 'success' || event.status === 'completed'))
    || (type === 'agent_end' && event.success === true));
  const isTool = /tool/.test(type) || event.contentType === 'tool';
  const isText = /text|message|reasoning/.test(type) || ['text', 'reasoning'].includes(event.contentType);
  const usage = object(event.aggregateUsage ?? event.usage ?? result.usage ?? event.stats);
  const hasUsage = Object.keys(usage).length > 0 || type === 'usage';
  const metrics = hasUsage && Object.keys(usage).length === 0 ? event : usage;
  const numeric = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const message = String(event.text ?? event.reasoning ?? event.message ?? event.error?.message ?? event.error
    ?? (isTool ? `${event.toolName ?? event.name ?? object(event.toolCall).name ?? type}: ${JSON.stringify(event.input ?? event.output ?? event.update ?? '')}` : failed ? `Cline finished: ${finishReason ?? type}` : type));
  return {
    kind: failed ? 'error' : isTool ? 'tool' : hasUsage ? 'usage' : isText ? 'text' : 'event',
    display: isTool ? toolDisplay(event, outer, type) : isText ? { type: event.contentType === 'reasoning' || /reasoning/.test(type) ? 'reasoning' : 'response' } : undefined,
    message, sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    success, failure: failed && !childEvent ? message : undefined,
    meaningful: type !== 'heartbeat' && type !== 'ping' && type !== 'keepalive' && outer.level === undefined,
    usage: hasUsage ? {
      inputTokens: numeric(metrics.totalInputTokens ?? metrics.inputTokens ?? metrics.input_tokens ?? metrics.promptTokens ?? metrics.tokensIn),
      outputTokens: numeric(metrics.totalOutputTokens ?? metrics.outputTokens ?? metrics.output_tokens ?? metrics.completionTokens ?? metrics.tokensOut),
      cost: numeric(metrics.totalCost ?? metrics.totalCostUsd ?? metrics.cost ?? event.cost),
      cumulative: terminal || type === 'result' || type === 'task_complete' || metrics.totalInputTokens !== undefined || metrics.cumulative === true
    } : undefined
  };
}
