import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PromptLoopController } from '../extension';
import { chromium, Frame } from 'playwright-core';
import { defaultSettings, LogEntry } from '../types';

export async function run(): Promise<void> {
  const artifacts = process.env.PROMPT_LOOP_ARTIFACTS!;
  const extension = vscode.extensions.getExtension<PromptLoopController>('local-prompt-loop.automated-prompt-loop');
  assert.ok(extension, 'Extension must be installed in the Development Host');
  const api = await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['start','pause','resume','retry','skip','stop','add','open']) assert.ok(commands.includes(`promptLoop.${name}`), `${name} command registered`);
  await vscode.commands.executeCommand('promptLoop.open');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.PROMPT_LOOP_CDP_PORT}`);
  let panel: Frame | undefined;
  for (let attempt=0;attempt<100&&!panel;attempt++) {
    for (const page of browser.contexts().flatMap(context=>context.pages())) for (const frame of page.frames()) {
      if (await frame.locator('#prompt').count()) { panel=frame; break; }
    }
    if (!panel) await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(panel,'Sidebar webview must render');
  const prompts = [
    "Create hello.txt with 'hi' as its only line. Use the file editor tool and finish.",
    "Add a second line containing 'second' to hello.txt. The final file must have exactly two lines: hi and second. If already correct, verify and finish without adding duplicates."
  ];
  await panel.locator('#prompt').fill(prompts.join('\n---\n'));
  await panel.locator('#add').click();
  for (let attempt=0;attempt<30&&api.queue.snapshot().items.length<2;attempt++) await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(api.queue.snapshot().items.length,2,'Webview Add message reaches extension host');
  const log: unknown[] = [];
  api.queue.on('log', entry => { log.push(entry); if(entry.kind==='queue'||entry.kind==='error') console.log(entry.message); });
  await panel.locator('#start').click();
  for(let attempt=0;attempt<30&&!api.queue.busy;attempt++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(api.queue.busy,'Webview Start starts the queue');
  const watchdog = setTimeout(() => { void api.queue.stop(); }, 15 * 60 * 1000);
  try {
    await api.queue.whenIdle();
    const state=api.queue.snapshot();
    await writeFile(path.join(artifacts,'queue-result.json'),JSON.stringify(state,null,2));
    await writeFile(path.join(artifacts,'events.ndjson'),log.map(entry=>JSON.stringify(entry)).join('\n'));
    assert.equal(state.status,'completed',state.activity);
    assert.deepEqual(state.items.map(item=>item.status),['succeeded','succeeded']);
    assert.deepEqual(state.items.map(item=>item.attempts),[1,2]);
    assert.ok(state.items.every(item=>item.sessionId),'Stable session IDs captured');
    assert.notEqual(state.items[0].sessionId,state.items[1].sessionId,'Independent prompts have independent sessions');
    const scratch=vscode.workspace.workspaceFolders![0].uri.fsPath;
    assert.deepEqual((await readFile(path.join(scratch,'hello.txt'),'utf8')).trim().split(/\r?\n/),['hi','second']);
    const invocations=(await readFile(path.join(scratch,'invocations.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(invocations.length===3 || (process.env.PROMPT_LOOP_LIVE==='1' && invocations.length===4));
    assert.ok(!invocations[0].args.includes('--id')&&!invocations[1].args.includes('--id'));
    const resumedId=invocations[2].args[invocations[2].args.indexOf('--id')+1];
    assert.ok(resumedId,'Retry must attempt --id with the captured session');
    const usedFreshFallback=invocations.length===4;
    if (!usedFreshFallback) assert.equal(resumedId,state.items[1].sessionId);
    else {
      assert.ok(!invocations[3].args.includes('--id'));
      assert.equal(invocations[3].prompt,invocations[2].prompt);
      assert.ok(log.some((entry:any)=>entry.message.includes('rejects --json with --id')));
    }
    assert.ok(invocations.every(invocation=>invocation.prompt.startsWith('Work only in the current scratch project.')));
    assert.match(invocations[2].prompt,/Check the project and verify what is already complete/);
    assert.match(invocations[2].prompt,/code 17/);
    assert.ok(state.items[0].usage.inputTokens>0);
    await panel.locator('#status[data-status="completed"]').waitFor();
    assert.equal(await panel.locator('.prompt-item[data-status="succeeded"]').count(),2);
    assert.match(await panel.locator('#session').innerText(),new RegExp(state.items[1].sessionId!));
    assert.ok((await panel.locator('#transcript').innerText()).includes('Prompt succeeded.'));
    if (process.env.PROMPT_LOOP_LIVE !== '1') await verifyActivityPanel(panel, api, artifacts);
    await panel.evaluate(()=>window.scrollTo(0,0));
    await panel.page().screenshot({path:path.join(artifacts,'sidebar.png')});
    await writeFile(path.join(artifacts,'verification.json'),JSON.stringify({passed:true,live:process.env.PROMPT_LOOP_LIVE==='1',sessions:state.items.map(item=>item.sessionId),attempts:state.items.map(item=>item.attempts),file:'hi\nsecond',resumeTransport:usedFreshFallback?'Installed Cline rejects headless --id; verified fresh-session fallback with identical reminder prompt':'--id',checks:['Extension Development Host activation','commands registered','webview input and button messaging','real subprocess NDJSON parsing','session ID capture','success advances queue','forced exit 17 attempts --id with reminder','prompt_constant prepended','token usage','scratch file contents']},null,2));
    console.log('All Extension Development Host checks passed.');
  } finally { clearTimeout(watchdog); await api.queue.stop(); await browser.close(); }
}

async function verifyActivityPanel(panel: Frame, api: PromptLoopController, artifacts: string): Promise<void> {
  assert.equal(await panel.locator('.activity-entry[data-kind="tool"]').count(), 3, 'Each attempt has one paired tool card');
  assert.equal(await panel.locator('.activity-entry[data-kind="tool"][data-status="completed"]').count(), 3);
  assert.equal(await panel.locator('.activity-markdown h4').filter({hasText:'File updated'}).count(), 3);
  const tool = panel.locator('.activity-entry[data-kind="tool"]').last();
  await tool.locator('summary').click();
  assert.equal(await tool.getAttribute('open'), '');
  assert.match(await tool.innerText(), /Input[\s\S]*hello.txt[\s\S]*Output[\s\S]*12 ms/i);
  assert.ok(await tool.locator('.diff-added').count());
  await panel.locator('[data-filter="tools"]').click();
  assert.equal(await panel.locator('.activity-entry').count(), 3);
  await panel.locator('#activitySearch').fill('no-such-output');
  assert.equal(await panel.locator('.activity-entry').count(), 0);
  assert.match(await panel.locator('.activity-empty').innerText(), /No matching activity/);
  await panel.locator('#activitySearch').fill('hello.txt');
  assert.equal(await panel.locator('.activity-entry').count(), 3);
  assert.equal(await tool.getAttribute('open'), '', 'Details remain open across filtering');
  const clipboard = await vscode.env.clipboard.readText();
  try {
    await tool.locator('.code-heading button').first().click();
    await panel.locator('#copyStatus').filter({hasText:'Copied to clipboard'}).waitFor();
    assert.match(await vscode.env.clipboard.readText(), /"path": "hello.txt"/);
    await panel.locator('#copyTranscript').click();
    for (let i = 0; i < 30 && !(await vscode.env.clipboard.readText()).includes('Prompt 2'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(await vscode.env.clipboard.readText(), /Prompt 2 · Attempt 2/);
  } finally { await vscode.env.clipboard.writeText(clipboard); }
  await panel.locator('#activitySearch').fill('');
  await panel.locator('[data-filter="problems"]').click();
  assert.ok(await panel.locator('.activity-entry[data-kind="error"]').count());
  assert.equal(await panel.locator('.activity-entry[data-kind="text"]').count(), 0);
  await panel.locator('[data-filter="all"]').click();

  // Exercise untrusted output and incremental updates through the real webview listener.
  const state = api.queue.snapshot();
  const entry: LogEntry = {id:'ui-safety',time:new Date().toISOString(),kind:'text',message:'### Safe rendering\n\n<img src=x onerror="window.activityInjected=true">\n\n[unsafe](javascript:alert(1)) [command](command:workbench.action.closeWindow) [docs](https://example.com)\n\n| File | Result |\n| --- | --- |\n| `hello.txt` | **Ready** |',display:{type:'response'}};
  const stream: LogEntry = {id:'ui-stream',time:new Date().toISOString(),kind:'tool',message:'editor',promptId:state.items[0].id,attempt:state.items[0].attempts,display:{type:'tool',name:'editor',callId:'ui-tool',status:'running',input:'{"path":"stream.txt"}'}};
  state.items[0].status = 'running';
  state.status = 'running';
  state.logs = [entry, ...Array.from({length:20}, (_, index): LogEntry => ({id:`ui-line-${index}`,time:entry.time,kind:'text',message:`Response ${index}\n\nMore activity to check scrolling.`,display:{type:'response'}})), stream];
  const postState = () => panel.evaluate(data => window.postMessage(data, '*'), {type:'state',state,settings:defaultSettings,busy:true});
  await postState();
  await panel.locator('[data-key="ui-safety"]').waitFor({state:'attached'});
  assert.equal(await panel.locator('#transcript img, #transcript script, #transcript iframe').count(), 0);
  assert.equal(await panel.locator('#transcript a').count(), 1);
  assert.equal(await panel.locator('#transcript a').getAttribute('href'), 'https://example.com');
  assert.equal(await panel.locator('.activity-table th').count(), 2);
  const streaming = panel.locator('[data-key="ui-stream"]');
  await streaming.locator('summary').focus(); await panel.page().keyboard.press('Enter');
  assert.equal(await streaming.getAttribute('open'), '');
  await streaming.evaluate(node => { (node as HTMLElement).dataset.retained = 'yes'; });
  await panel.locator('#transcript').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  assert.equal(await panel.locator('#follow').isChecked(), false);
  stream.display = {...stream.display as Extract<NonNullable<LogEntry['display']>, {type:'tool'}>,status:'completed',output:'Saved **successfully**.',outputFormat:'markdown',durationMs:24};
  await postState();
  await panel.locator('[data-key="ui-stream"][data-status="completed"]').waitFor({state:'attached'});
  assert.equal(await streaming.getAttribute('data-retained'), 'yes', 'Stream updates preserve the same card');
  assert.equal(await streaming.getAttribute('open'), '', 'Stream updates preserve disclosure state');
  assert.ok(await panel.locator('#transcript').evaluate(node => node.scrollTop < 10), 'Reading position stays at older output');
  await panel.locator('#jumpLatest').click();
  assert.equal(await panel.locator('#follow').isChecked(), true);
  assert.ok(await panel.locator('#transcript').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 5));

  // Return to actual fixture output for the screenshot and final state.
  api.refresh();
  await panel.locator('#status[data-status="completed"]').waitFor();
  const finalTool = panel.locator('.activity-entry[data-kind="tool"]').last();
  if (await finalTool.getAttribute('open') === null) await finalTool.locator('summary').click();
  await panel.locator('#transcript').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await panel.locator('.monitor').scrollIntoViewIfNeeded();
  await panel.page().screenshot({path:path.join(artifacts,'activity.png')});
  assert.ok(await panel.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'Sidebar has no horizontal overflow');
  console.log('Activity checks passed: Markdown, tool pairing, filters, copy, safe rendering, streaming, scroll preservation.');
}
