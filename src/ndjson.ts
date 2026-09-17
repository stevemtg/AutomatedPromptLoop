import { StringDecoder } from 'node:string_decoder';

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
  sessionId?: string; success: boolean; failure?: string; meaningful: boolean;
  usage?: { inputTokens: number; outputTokens: number; cost: number; cumulative: boolean };
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
