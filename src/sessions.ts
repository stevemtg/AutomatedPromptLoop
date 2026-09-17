import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export function sessionsDirectory(): string {
  return path.join(process.env.CLINE_DATA_DIR || path.join(os.homedir(), '.cline', 'data'), 'sessions');
}
export async function sessionDirectories(directory: string): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
/** Cline 3.0.62 omits the stable session ID from NDJSON. Match only newly created
 * session metadata with the exact workspace, full prompt and launch timestamp.
 * Never guess by "latest session", or consume another concurrent Cline task. */
export async function findSession(directory: string, existing: Set<string>, workspace: string, prompt: string, started: number): Promise<string | undefined> {
  const candidates = (await sessionDirectories(directory)).filter(name => !existing.has(name));
  const matches: string[] = [];
  for (const id of candidates) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, id, `${id}.json`), 'utf8'));
      if (metadata.session_id === id && path.resolve(metadata.cwd) === path.resolve(workspace)
        && metadata.prompt === prompt && Date.parse(metadata.started_at) >= started - 2000) matches.push(id);
    } catch { /* The CLI may still be writing this file. Retry on the next poll. */ }
  }
  if (matches.length > 1) throw new Error('Multiple new Cline sessions matched this prompt. Cannot safely choose a session to resume.');
  return matches[0];
}
