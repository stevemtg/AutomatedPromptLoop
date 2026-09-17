# Prompt Loop

A standalone Visual Studio Code extension that runs a list of prompts against the current project with the npm-installed Cline CLI. It streams activity into a sidebar, advances on confirmed completion, and retries failed or stalled attempts with a completion reminder.

## Install and run

1. Install Node.js and the Cline CLI (`npm install -g cline`). Configure a working provider with `cline auth` or `cline config`.
2. In this project, run `npm install`, then `npm run compile`.
3. Press **F5** and select **Run Prompt Loop**. In the Extension Development Host, open the project you want Cline to work on.
4. Click the **Prompt Loop** activity bar icon, enter prompts, and choose **Start Queue**.

For normal use, run `npm run package` and install the resulting `.vsix` using **Extensions: Install from VSIX…**. This extension does not require the Cline VS Code extension. It uses your existing Cline CLI provider configuration.

On Windows, the extension discovers npm's Cline shim under `%APPDATA%\npm` and Node under `%ProgramFiles%\nodejs` if they are missing from VS Code's inherited PATH. Custom installations can use `promptLoop.cliPath` and `promptLoop.nodePath` in User settings. Prompts are passed as literal process arguments with shell execution disabled. Long prompts exceeding Windows' process argument limit receive a clear error asking you to split them.

## Entering prompts

Add individual multiline prompts, or paste a list separated by a line containing `---`:

```text
Create hello.txt with 'hi' as its first line.
---
Add a second line containing 'second' to hello.txt.
```

Use **Ctrl/Cmd + Enter** to add the list. Unstarted prompts can be edited, reordered, or removed. Import accepts a JSON array of strings or a text/Markdown file with `---` separators. Export saves the prompt texts as a JSON array.

Expand **Shared instructions** to edit `prompt_constant`, then click **Save instructions**. These instructions are prepended to both first attempts and retries. Other settings are available through the gear button.

## Execution and recovery

- One process runs at a time, in the selected open workspace folder. Multi-root workspaces prompt for a target folder.
- Each new queue item starts a new Cline session. An attempt succeeds only when Cline reports terminal completion **and** exits with code 0. A tool succeeding, an iteration ending, or an unconfirmed zero exit is insufficient.
- A nonzero exit, incomplete terminal result, or inactivity timeout triggers another attempt. The original prompt and shared instructions are retained and the reminder is appended. When a stable session ID was captured, the new process tries `--id`; otherwise it starts a fresh session. Cline versions that explicitly reject headless `--id` automatically fall back to a fresh session with the same retry prompt. This compatibility fallback is logged and keeps project files, but loses conversation history.
- The inactivity timer resets on structured task events, including text and tool output. Diagnostics and heartbeat messages do not keep a stalled attempt alive. Cline processes and their subprocess trees are terminated before launching a replacement.
- At the attempt limit, the failed item pauses the queue. Later prompts remain untouched until **Retry Failed** or **Skip**.
- **Pause** interrupts the current attempt, retains its session, and waits for **Resume Queue**. Intentional pauses do not consume the automatic retry budget. Total launch counts remain visible.
- **Retry Current** interrupts and restarts the current item with a reminder and a new retry budget. **Skip** terminates and marks the current item skipped; a running queue continues. **Stop** terminates the running process and prevents further launches. Resume can continue a stopped queue.
- Queue state survives VS Code reloads. An interrupted attempt restores as paused; it never starts automatically on reload. Prompt edits and settings changed during an attempt apply to subsequent attempts.

Commands: **Prompt Loop: Start**, **Pause**, **Resume**, **Retry Current**, **Skip Current**, **Stop**, **Add Prompt**, **Open Panel**, and **Show Logs**. The status bar displays the current prompt and attempt; click it to open the sidebar.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `promptLoop.stallTimeout` | `180` | Seconds without meaningful activity before retrying |
| `promptLoop.maxAttempts` | `3` | Attempts in each automatic retry cycle, including the first |
| `promptLoop.reminderText` | Completion reminder | Supports `{reason}`, `{attempt}`, `{maxAttempts}`, `{prompt}` |
| `promptLoop.prompt_constant` | Empty | Instructions at the top of every prompt |
| `promptLoop.model` | Empty | Cline `--model` override |
| `promptLoop.provider` | Empty | Cline `--provider` override |
| `promptLoop.autoApprove` | `true` | Passes `--auto-approve true/false` explicitly |
| `promptLoop.cliPath` | `cline` | Executable, npm shim, or JavaScript CLI entry point |
| `promptLoop.nodePath` | Auto-discovered | Node executable for npm Cline installations |

With auto-approve disabled, headless Cline may deny tools that require interactive approval. The sidebar shows those results; it does not provide an approval bridge. Use a trusted workspace and choose the setting appropriate for the queue.

## Transcript and logs

The sidebar shows prompt status, attempt counts, live text and tool calls, session ID, and total input/output tokens and reported cost across attempts. Cumulative usage records are deduplicated. Cost is whatever Cline reports; a local provider may report zero.

Every lifecycle transition, diagnostic, and structured Cline event is appended to a timestamped NDJSON log in VS Code's extension storage. **Full log file** opens the current file; **Output log** opens the Prompt Loop output channel. The sidebar retains the latest 500 display records (shows the latest 150 non-event records), and workspace state keeps the latest 150 records for reloads. Full event logs remain on disk and may contain prompts, tool inputs, and tool outputs; retention is manual.

## CLI compatibility

Tested against Cline **3.0.62**. The adapter handles `agent_event` content/usage/done records and terminal `run_result` records. That CLI version emits a conversation `taskId`, which is **not** the stable session ID used by `--id`. When an explicit `sessionId` is absent, the runner finds newly created session metadata under `~/.cline/data/sessions` (or `CLINE_DATA_DIR/sessions`) using the exact prompt, workspace, and launch timestamp. It refuses ambiguous matches. Local backend mode keeps execution attached to the child process so controls can terminate it.

**Cline 3.0.62 limitation:** its `--id` handling forces interactive mode and rejects `--json`, even when a prompt is supplied. Prompt Loop detects that exact rejection, logs the limitation, and launches the same reminder prompt as a new session. The rejected resume invocation makes no model call and does not consume another logical retry attempt. Other resume errors follow the usual failure policy. True headless session continuation needs a Cline version that supports `--json --id`; the controlled fixture verifies that path separately. No Cline installation files are modified.

“Succeeded” means the agent reported completion and exited cleanly; the extension cannot independently prove arbitrary project requirements. Put concrete verification instructions in the prompt or shared instructions.

## Development and verification

```text
npm run compile          # TypeScript build
npm test                 # Parser, queue, session discovery and process tests
npm run test:extension   # Real VS Code host + deterministic CLI fixture
npm run test:live        # Real VS Code host + your configured Cline provider
npm run package          # Build an installable VSIX
```

The host tests create isolated scratch projects and user profiles in `.test-artifacts/`. They enter and start the two-prompt `hello.txt` queue through the actual sidebar using Playwright. A transport wrapper deliberately changes the second task's first successful process exit to 17; the next attempt must try the captured `--id`, original prompt, constant, and reminder. Assertions check the final file, sessions, attempt counts, usage, extension activation, commands, rendered status, and transcript. The live mode runs actual Cline and can incur provider charges; its report distinguishes successful `--id` continuation from the known compatibility fallback. Reports and a screenshot are written to `verification.json`, `queue-result.json`, `events.ndjson`, and `sidebar.png` in the test artifact directory.

On Windows, tests use the installed VS Code. Override `VSCODE_EXECUTABLE` for a different installation; set `PROMPT_LOOP_REAL_CLI` to a custom Cline JavaScript entry point. Other platforms can let `@vscode/test-electron` download a compatible host.

The implementation follows the [VS Code webview API](https://code.visualstudio.com/api/extension-guides/webview) and [Cline CLI reference](https://github.com/cline/cline/blob/main/docs/cli/cli-reference.mdx). Webview content uses a restrictive CSP, local assets, and text-only rendering of prompt/model output.
