export interface GenerationSample { outputTokens: number; durationMs: number; estimated: boolean }

/** One tracker per attempt: provider timing wins; otherwise time completed Cline turns. */
export class GenerationTracker {
  private providerTiming = false;
  private requests = new Set<string>();
  private turns = new Map<string, { start: number; end?: number }>();
  observe(raw: unknown, now = performance.now()): GenerationSample | undefined {
    if (!raw || typeof raw !== 'object') return;
    const outer = raw as Record<string, any>;
    if (outer.type === 'ollama_request') { this.providerTiming = true; return; }
    if (outer.type === 'generation_metrics') {
      const { requestId, outputTokens, durationMs } = outer;
      if (typeof requestId !== 'string' || !requestId || this.requests.has(requestId)
        || !Number.isFinite(outputTokens) || outputTokens <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
      this.providerTiming = true;
      this.requests.add(requestId);
      return { outputTokens, durationMs, estimated: false };
    }
    if (this.providerTiming) return;
    const event = outer.type === 'agent_event' ? outer.event : outer;
    if (!event || typeof event !== 'object') return;
    const agent = String(outer.agentId ?? event.agentId ?? outer.parentAgentId ?? event.parentAgentId ?? 'main');
    if (event.type === 'iteration_start') { this.turns.set(agent, { start: now }); return; }
    const turn = this.turns.get(agent);
    if (!turn) return;
    // Cline starts executing tools after the model finishes; usage can arrive later.
    if (event.type === 'content_start' && event.contentType === 'tool') turn.end ??= now;
    if (event.type === 'usage') {
      this.turns.delete(agent); // Duplicate usage and final cumulative totals cannot add another sample.
      const tokens = event.outputTokens ?? event.usage?.outputTokens;
      const durationMs = (turn.end ?? now) - turn.start;
      if (Number.isFinite(tokens) && tokens > 0 && durationMs > 0) return { outputTokens: tokens, durationMs, estimated: true };
    }
    if (['iteration_end', 'error', 'done'].includes(event.type)) this.turns.delete(agent);
  }
}
