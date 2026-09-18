export type PromptStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type QueueStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed';
export interface Usage { inputTokens: number; outputTokens: number; cost: number }
export interface PromptItem {
  id: string; text: string; status: PromptStatus; attempts: number; cycleAttempts: number;
  sessionId?: string; error?: string; usage: Usage;
}
export interface LogEntry {
  id?: string;
  time: string; kind: 'queue' | 'text' | 'tool' | 'usage' | 'error' | 'diagnostic' | 'event';
  message: string; promptId?: string; attempt?: number; data?: unknown;
  display?: LogDisplay;
}
export type LogDisplay = { type: 'response' | 'reasoning' } | {
  type: 'tool'; name: string; callId?: string; agentId?: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  input?: string; output?: string; outputFormat?: 'markdown' | 'json'; summary?: string; durationMs?: number;
};
export interface QueueState {
  version: 1; status: QueueStatus; workspace?: string; items: PromptItem[];
  currentId?: string; activity: string; logs: LogEntry[];
}
export interface Settings {
  stallTimeout: number; maxAttempts: number; reminderText: string; prompt_constant: string;
  model: string; provider: string; autoApprove: boolean; cliPath: string; nodePath: string;
}
export const defaultSettings: Settings = {
  stallTimeout: 180, maxAttempts: 3,
  reminderText: 'The previous attempt did not finish ({reason}). Check the project and verify what is already complete. Finish anything remaining from the original prompt, run relevant checks, and report completion only when the requested work is finished. This is attempt {attempt} of {maxAttempts}.',
  prompt_constant: '', model: '', provider: '', autoApprove: true, cliPath: 'cline', nodePath: ''
};
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cost: 0 });
export interface RunRequest { workspace: string; prompt: string; sessionId?: string; settings: Settings }
export interface RunResult { code: number | null; signal?: string | null; error?: string }
export interface RunHandle { result: Promise<RunResult>; cancel(): Promise<void> }
export type Runner = (request: RunRequest, onEvent: (event: unknown) => void, onDiagnostic: (text: string) => void) => RunHandle;
