import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { normalizeEvent } from './ndjson';
import { GenerationTracker } from './generation';
import { emptyUsage, LogDisplay, LogEntry, PromptItem, QueueState, RunHandle, Runner, Settings } from './types';

export function composePrompt(item: PromptItem, settings: Settings): string {
  const parts = [settings.prompt_constant.trim(), item.text];
  if (item.attempts > 1) {
    const values: Record<string, string> = { reason: item.error ?? 'interrupted', attempt: String(item.cycleAttempts), maxAttempts: String(settings.maxAttempts), prompt: item.text };
    parts.push(settings.reminderText.replace(/\{(reason|attempt|maxAttempts|prompt)\}/g, (_, key: string) => values[key]));
  }
  return parts.filter(Boolean).join('\n\n');
}

export class PromptQueue extends EventEmitter {
  private state: QueueState;
  private loop?: Promise<void>;
  private active?: RunHandle;
  private interruption?: 'pause' | 'stop' | 'skip' | 'retry';
  private disposed = false;
  constructor(private readonly runner: Runner, private readonly settings: () => Settings, saved?: QueueState,
    private readonly prepareDisplay: (display: LogDisplay) => LogDisplay = display => display) {
    super();
    this.state = saved?.version === 1 ? structuredClone(saved) : { version: 1, status: 'idle', items: [], activity: 'Ready when you are', logs: [] };
    for (const entry of this.state.logs) entry.id ??= randomUUID();
    if (this.state.status === 'running' || this.state.items.some(item => item.status === 'running')) {
      this.state.status = 'paused';
      this.state.activity = 'Previous run interrupted. Resume Queue to continue.';
      for (const item of this.state.items) if (item.status === 'running') {
        item.status = 'pending'; item.error = 'VS Code closed or reloaded during this attempt';
        item.cycleAttempts = Math.max(0, item.cycleAttempts - 1);
      }
    }
  }
  snapshot(): QueueState { return structuredClone(this.state); }
  get busy(): boolean { return !!this.loop; }
  private change(): void { this.emit('change'); }
  private log(kind: LogEntry['kind'], message: string, item?: PromptItem, data?: unknown, display?: LogDisplay): void {
    if (display) display = this.prepareDisplay(display);
    const entry: LogEntry = { id: randomUUID(), time: new Date().toISOString(), kind, message: message.slice(0, 20000), promptId: item?.id, attempt: item?.attempts, data, display };
    this.emit('log', entry);
    // Full binary results are already on disk; don't clone them on every UI refresh.
    const retainedData = display?.type === 'tool' && display.images?.length ? undefined : data;
    const previous = this.state.logs.at(-1);
    const event = (data as any)?.event;
    const previousEvent = (previous?.data as any)?.event;
    const tool = display?.type === 'tool' && display.callId ? [...this.state.logs].reverse().find(log =>
      log.display?.type === 'tool' && log.display.callId === display.callId && log.display.agentId === display.agentId
      && log.promptId === item?.id && log.attempt === item?.attempts) : undefined;
    if (tool && display?.type === 'tool') {
      const previousDisplay = tool.display as Extract<LogDisplay, { type: 'tool' }>;
      tool.display = { ...previousDisplay, ...display,
        name: display.name === 'Tool' ? previousDisplay.name : display.name,
        status: display.status === 'unknown' ? previousDisplay.status : display.status
      };
      if (previousDisplay.images && display.images) {
        tool.display.images = [...new Map([...previousDisplay.images, ...display.images].map(image => [image.src, image])).values()].slice(-8);
      }
      tool.message = message.slice(0, 20000); tool.data = retainedData;
    } else if (kind === 'text' && previous?.kind === 'text' && previous.promptId === item?.id && previous.attempt === item?.attempts
      && event?.contentType === previousEvent?.contentType && event?.type?.startsWith('content_') && previousEvent?.type !== 'content_end') {
      previous.message = (event.type === 'content_end' ? message : previous.message + message).slice(-20000);
      previous.data = data;
    } else {
      // Keep emitted disk-log records immutable when a display entry streams updates.
      this.state.logs.push({ ...entry, data: retainedData });
      if (this.state.logs.length > 500) this.state.logs.shift();
    }
    this.change();
  }
  setWorkspace(workspace: string): void {
    if (this.busy) throw new Error('Stop the queue before changing projects.');
    if (workspace !== this.state.workspace && this.state.items.some(item => item.sessionId)) throw new Error('Clear the queue before changing projects; its sessions belong to the current project.');
    this.state.workspace = workspace; this.change();
  }
  add(prompts: string[]): void {
    if (!Array.isArray(prompts) || prompts.some(text => typeof text !== 'string' || text.length > 200000)) throw new Error('Prompts must be strings shorter than 200,000 characters.');
    const texts = prompts.map(text => text.trim()).filter(Boolean);
    if (this.state.items.length + texts.length > 1000) throw new Error('A queue can contain up to 1,000 prompts.');
    for (const text of texts) this.state.items.push({ id: randomUUID(), text, status: 'pending', attempts: 0, cycleAttempts: 0, usage: emptyUsage() });
    if (this.state.status === 'completed') this.state.status = 'idle';
    this.log('queue', `Added ${texts.length} prompt${texts.length === 1 ? '' : 's'}.`);
  }
  edit(id: string, text: string): void {
    const item = this.state.items.find(candidate => candidate.id === id);
    if (!item || item.attempts || item.status !== 'pending') throw new Error('Only unstarted prompts can be edited.');
    if (!text.trim() || text.length > 200000) throw new Error('Enter a prompt between 1 and 200,000 characters.');
    item.text = text.trim(); this.log('queue', 'Updated prompt.', item);
  }
  remove(id: string): void {
    const item = this.state.items.find(candidate => candidate.id === id);
    if (!item || item.attempts || item.status !== 'pending') throw new Error('Only unstarted prompts can be removed.');
    this.state.items = this.state.items.filter(candidate => candidate !== item); this.log('queue', 'Removed prompt.');
  }
  move(id: string, direction: number): void {
    const index = this.state.items.findIndex(item => item.id === id);
    const next = index + (direction < 0 ? -1 : 1);
    const item = this.state.items[index], other = this.state.items[next];
    if (!item || !other || item.attempts || other.attempts || item.status !== 'pending' || other.status !== 'pending') return;
    [this.state.items[index], this.state.items[next]] = [other, item]; this.log('queue', 'Reordered pending prompts.');
  }
  clear(): void {
    if (this.busy) throw new Error('Stop the queue before clearing it.');
    this.state.items = []; this.state.currentId = undefined; this.state.status = 'idle';
    this.state.activity = 'Ready when you are'; this.log('queue', 'Cleared queue.');
  }
  start(): void {
    if (this.disposed) throw new Error('Queue is closed.');
    if (this.busy) return;
    if (!this.state.workspace) throw new Error('Open or select a project folder first.');
    if (this.state.items.some(item => item.status === 'failed')) throw new Error('Retry or skip the failed prompt before resuming.');
    if (!this.state.items.some(item => item.status === 'pending')) throw new Error('Add a prompt to the queue first.');
    this.interruption = undefined;
    this.state.status = 'running'; this.state.activity = 'Starting queue'; this.log('queue', 'Queue started.');
    // Store the loop before invoking the runner; synchronous events can request controls safely.
    this.loop = Promise.resolve().then(() => this.run()).catch(error => {
      this.state.status = 'paused'; this.state.activity = String(error); this.log('error', String(error));
    }).finally(() => { this.loop = undefined; this.active = undefined; this.change(); });
  }
  async pause(): Promise<void> { await this.interrupt('pause'); }
  async stop(): Promise<void> { await this.interrupt('stop'); }
  async skip(): Promise<void> {
    if (this.busy) { await this.interrupt('skip'); return; }
    const item = this.current();
    if (!item) return;
    item.status = 'skipped'; this.state.currentId = undefined; this.log('queue', 'Prompt skipped.', item);
    if (!this.state.items.some(candidate => ['pending','failed'].includes(candidate.status))) {
      this.state.status = 'completed'; this.state.activity = 'All prompts finished';
    } else this.state.activity = 'Prompt skipped. Resume Queue to continue.';
    this.change();
  }
  async retry(): Promise<void> {
    if (this.busy) { await this.interrupt('retry'); return; }
    const item = this.current();
    if (!item) throw new Error('There is no unfinished prompt to retry.');
    item.status = 'pending'; item.cycleAttempts = 0;
    item.error ??= 'manual retry requested'; this.log('queue', 'Manual retry requested.', item); this.start();
  }
  private current(): PromptItem | undefined {
    return this.state.items.find(item => item.id === this.state.currentId && !['succeeded', 'skipped'].includes(item.status))
      ?? this.state.items.find(item => ['pending', 'failed'].includes(item.status));
  }
  private async interrupt(action: 'pause' | 'stop' | 'skip' | 'retry'): Promise<void> {
    if (!this.busy && action === 'pause') return;
    if (!this.busy && action === 'stop' && ['idle','completed'].includes(this.state.status)) return;
    this.interruption = action;
    if (action === 'pause' || action === 'stop') this.state.status = action === 'pause' ? 'paused' : 'stopped';
    this.state.activity = this.active ? 'Stopping current Cline process…' : `Queue ${this.state.status}`;
    this.log('queue', `${action} requested.`);
    if (this.active) {
      const active = this.active;
      await active.cancel();
      if (action === 'skip' || action === 'retry') { await active.result; return; }
    }
    if (action !== 'skip' && action !== 'retry') await this.loop;
    this.change();
  }
  private async run(): Promise<void> {
    while (this.state.status === 'running' && !this.disposed) {
      const item = this.state.items.find(candidate => candidate.status === 'pending');
      if (!item) { this.state.status = 'completed'; this.state.currentId = undefined; this.state.activity = 'All prompts finished'; this.log('queue', 'Queue completed.'); break; }
      if (this.interruption === 'skip') {
        this.interruption = undefined; item.status = 'skipped'; this.log('queue', 'Prompt skipped.', item); continue;
      }
      if (this.interruption === 'retry') { this.interruption = undefined; item.cycleAttempts = 0; item.error = 'manual retry requested'; }
      const settings = this.settings();
      item.status = 'running'; item.attempts++; item.cycleAttempts++; this.state.currentId = item.id;
      this.state.activity = `Prompt ${this.state.items.indexOf(item) + 1} · attempt ${item.attempts}`;
      let lastActivity = Date.now(), success = false, failure: string | undefined, stalled = false;
      const inferenceRequests = new Set<string>();
      const generation = new GenerationTracker();
      const baseUsage = { ...item.usage };
      const usage = emptyUsage();
      this.log('queue', `Attempt ${item.attempts} started${item.sessionId ? `; resuming ${item.sessionId}` : '; new session'}.`, item);
      let timer: NodeJS.Timeout | undefined;
      try {
        this.active = this.runner({ workspace: this.state.workspace!, prompt: composePrompt(item, settings), sessionId: item.sessionId, settings }, raw => {
          const sample = generation.observe(raw);
          if (sample) {
            item.generation ??= { outputTokens: 0, durationMs: 0, samples: 0, estimatedSamples: 0 };
            item.generation.outputTokens += sample.outputTokens;
            item.generation.durationMs += sample.durationMs;
            item.generation.samples++;
            if (sample.estimated) item.generation.estimatedSamples++;
          }
          const inference = raw as { type?: string; id?: string; phase?: string };
          if (inference?.type === 'ollama_request' && inference.id) {
            if (inference.phase === 'started') inferenceRequests.add(inference.id);
            else if (inference.phase === 'finished') inferenceRequests.delete(inference.id);
          }
          if ((raw as { type?: string })?.type === 'session_reset') item.sessionId = undefined;
          const event = normalizeEvent(raw);
          if (event.meaningful) lastActivity = Date.now();
          if (event.sessionId && item.sessionId !== event.sessionId) {
            item.sessionId = event.sessionId; this.log('queue', `Session captured: ${event.sessionId}`, item);
          }
          if (event.success) { success = true; failure = undefined; }
          if (event.failure) { failure = event.failure; success = false; }
          if (event.usage) {
            for (const key of ['inputTokens', 'outputTokens', 'cost'] as const) {
              usage[key] = event.usage.cumulative ? Math.max(usage[key], event.usage[key]) : usage[key] + event.usage[key];
              item.usage[key] = baseUsage[key] + usage[key];
            }
          }
          if (event.kind === 'tool') this.state.activity = event.message.slice(0, 180);
          this.log(event.kind, event.message, item, raw, event.display);
        }, diagnostic => this.log('diagnostic', diagnostic, item));
        const active = this.active;
        timer = setInterval(() => {
          // The Ollama adapter owns a real HTTP inactivity timeout during model
          // loading/prefill. A short tool watchdog must not repeatedly kill it.
          if (!stalled && !this.interruption && inferenceRequests.size === 0 && Date.now() - lastActivity >= settings.stallTimeout * 1000) {
            stalled = true; failure = `No meaningful activity for ${settings.stallTimeout} seconds`;
            this.log('error', failure, item);
            void active.cancel().catch(error => { this.state.status = 'paused'; this.log('error', `Could not stop stalled process: ${error}`, item); });
          }
        }, Math.min(1000, Math.max(10, settings.stallTimeout * 250)));
        const result = await active.result;
        if (stalled) failure = `No meaningful activity for ${settings.stallTimeout} seconds`;
        else if (result.error) failure = result.error;
        else if (result.code !== 0) failure = `Cline exited with ${result.signal ?? `code ${result.code}`}${failure ? ': ' + failure : ''}`;
        else if (!success) failure ??= 'Cline exited without a confirmed completion event';
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      finally { if (timer) clearInterval(timer); this.active = undefined; }
      // Controls can mutate this field while awaiting the process result.
      const interruption = this.interruption as 'pause' | 'stop' | 'skip' | 'retry' | undefined;
      this.interruption = undefined;
      if (interruption) {
        item.error = `previous attempt interrupted by ${interruption}`;
        if (interruption === 'skip') { item.status = 'skipped'; this.log('queue', 'Prompt skipped.', item); continue; }
        item.status = 'pending';
        if (interruption === 'retry') { item.cycleAttempts = 0; continue; }
        item.cycleAttempts = Math.max(0, item.cycleAttempts - 1);
        this.state.activity = `Queue ${this.state.status}. Resume to continue.`; this.change(); break;
      }
      if (!failure && success) { item.status = 'succeeded'; item.error = undefined; this.log('queue', 'Prompt succeeded.', item); }
      else {
        item.error = failure ?? 'Unknown Cline failure';
        this.log('error', item.error, item);
        if (item.cycleAttempts >= settings.maxAttempts) {
          item.status = 'failed'; this.state.status = 'paused'; this.state.activity = 'Attempt limit reached. Retry or skip this prompt.';
          this.log('queue', 'Automatic retries exhausted; queue paused.', item); break;
        }
        item.status = 'pending'; this.state.activity = 'Retrying with completion reminder'; this.log('queue', this.state.activity, item);
        // Yield between failed launches so controls remain responsive.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  async shutdown(): Promise<void> { this.disposed = true; await this.stop(); }
  async whenIdle(): Promise<void> { await this.loop; }
}
