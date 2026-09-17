import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PromptLoopController } from '../extension';
import { chromium, Frame } from 'playwright-core';

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
    await panel.evaluate(()=>window.scrollTo(0,0));
    await panel.page().screenshot({path:path.join(artifacts,'sidebar.png')});
    await writeFile(path.join(artifacts,'verification.json'),JSON.stringify({passed:true,live:process.env.PROMPT_LOOP_LIVE==='1',sessions:state.items.map(item=>item.sessionId),attempts:state.items.map(item=>item.attempts),file:'hi\nsecond',resumeTransport:usedFreshFallback?'Installed Cline rejects headless --id; verified fresh-session fallback with identical reminder prompt':'--id',checks:['Extension Development Host activation','commands registered','webview input and button messaging','real subprocess NDJSON parsing','session ID capture','success advances queue','forced exit 17 attempts --id with reminder','prompt_constant prepended','token usage','scratch file contents']},null,2));
    console.log('All Extension Development Host checks passed.');
  } finally { clearTimeout(watchdog); await api.queue.stop(); await browser.close(); }
}
