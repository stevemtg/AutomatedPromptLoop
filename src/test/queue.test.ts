import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptQueue } from '../queue';
import { defaultSettings, LogEntry, Runner, RunRequest, RunResult, Settings } from '../types';
const done = {type:'run_result',finishReason:'completed',usage:{inputTokens:10,outputTokens:2,totalCost:.01}};
function setup(runner: Runner, overrides: Partial<Settings> = {}) {
  const queue = new PromptQueue(runner,()=>({...defaultSettings,...overrides})); queue.setWorkspace(process.cwd()); return queue;
}
function scripted(steps: ((event: (event: unknown) => void) => RunResult)[], requests: RunRequest[] = []): Runner {
  return (request,onEvent) => { requests.push(request); return {result:Promise.resolve().then(()=>steps.shift()!(onEvent)),cancel:async()=>{}}; };
}
test('success advances in order and each new prompt has its own session', async () => {
  const requests: RunRequest[]=[];
  const queue=setup(scripted([event=>{event({type:'session',sessionId:'first'});event(done);return {code:0};},event=>{event(done);return {code:0};}],requests),{prompt_constant:'CONSTANT'});
  queue.add(['one','two']);queue.start();await queue.whenIdle();
  assert.equal(queue.snapshot().status,'completed'); assert.deepEqual(queue.snapshot().items.map(item=>item.status),['succeeded','succeeded']);
  assert.equal(requests[0].prompt,'CONSTANT\n\none');assert.equal(requests[1].sessionId,undefined);
});
test('failed exit after completion resumes captured session with original prompt, constant and reminder',async()=>{
  const requests:RunRequest[]=[];
  const queue=setup(scripted([event=>{event({type:'session',sessionId:'abc'});event(done);return {code:17};},event=>{event(done);return {code:0};}],requests),{prompt_constant:'ALWAYS',reminderText:'VERIFY {reason} {attempt}/{maxAttempts}'});
  queue.add(['fix this']);queue.start();await queue.whenIdle();
  assert.equal(requests[1].sessionId,'abc'); assert.match(requests[1].prompt,/^ALWAYS\n\nfix this\n\nVERIFY .*17.*2\/3$/);
  assert.equal(queue.snapshot().items[0].attempts,2);assert.equal(queue.snapshot().status,'completed');
});
test('exit zero without terminal completion exhausts attempts and blocks the next prompt',async()=>{
  const queue=setup(scripted([()=>({code:0}),()=>({code:0})]),{maxAttempts:2});
  queue.add(['fail','never run']);queue.start();await queue.whenIdle();
  assert.equal(queue.snapshot().status,'paused');assert.equal(queue.snapshot().items[0].status,'failed');assert.equal(queue.snapshot().items[1].attempts,0);
  assert.throws(()=>queue.start(),/Retry or skip/);
});
test('silent runner stalls and cancellation completes before retry launches',async()=>{
  let count=0,cancelled=false;
  const queue=setup((_request,event)=>{
    count++;
    if(count===2){assert.equal(cancelled,true);return {result:Promise.resolve().then(()=>{event(done);return {code:0};}),cancel:async()=>{}};}
    let resolve!:(result:RunResult)=>void;
    return {result:new Promise<RunResult>(r=>resolve=r),cancel:async()=>{cancelled=true;resolve({code:1});}};
  },{stallTimeout:.02});
  queue.add(['stall']);queue.start();await queue.whenIdle();assert.equal(count,2);assert.equal(queue.snapshot().status,'completed');
});
test('pause and resume preserve session, do not consume retry budget, and stop never advances',async()=>{
  let resolve!:(result:RunResult)=>void;let starts=0;let ready!:()=>void;
  const launched=new Promise<void>(r=>ready=r);
  const queue=setup((_request,event)=>{
    starts++;event({type:'session',sessionId:'paused-session'});ready();
    return {result:new Promise<RunResult>(r=>resolve=r),cancel:async()=>resolve({code:1})};
  });
  queue.add(['one','two']);queue.start();await launched;await queue.pause();
  assert.equal(queue.snapshot().status,'paused');assert.equal(queue.snapshot().items[0].cycleAttempts,0);assert.equal(queue.snapshot().items[0].sessionId,'paused-session');
  queue.start();await new Promise(r=>setImmediate(r));await queue.stop();
  assert.equal(starts,2);assert.equal(queue.snapshot().items[1].attempts,0);assert.equal(queue.snapshot().status,'stopped');
});
test('usage totals do not double count usage, done and run_result snapshots',async()=>{
  const queue=setup(scripted([event=>{
    event({type:'agent_event',event:{type:'usage',totalInputTokens:10,totalOutputTokens:2,totalCost:.01}});
    event({type:'agent_event',event:{type:'done',reason:'completed',usage:done.usage}});event(done);return {code:0};
  }]));queue.add(['one']);queue.start();await queue.whenIdle();assert.deepEqual(queue.snapshot().items[0].usage,done.usage && {inputTokens:10,outputTokens:2,cost:.01});
});
test('reload converts an interrupted attempt to pending, keeping its session and queue paused',()=>{
  const queue=setup(()=>{throw new Error('should not run');});queue.add(['one']);const saved=queue.snapshot();saved.status='running';saved.items[0].status='running';saved.items[0].sessionId='keep-me';saved.items[0].attempts=1;saved.items[0].cycleAttempts=1;
  const restored=new PromptQueue(()=>{throw new Error('should not run');},()=>defaultSettings,saved);
  assert.equal(restored.snapshot().status,'paused');assert.equal(restored.snapshot().items[0].status,'pending');assert.equal(restored.snapshot().items[0].sessionId,'keep-me');
});
test('manual retry grants a fresh attempt cycle; skipping a failure permits queue continuation',async()=>{
  const queue=setup(scripted([()=>({code:1}),event=>{event(done);return {code:0};},()=>({code:1})]),{maxAttempts:1});
  queue.add(['one','two']);queue.start();await queue.whenIdle();await queue.retry();await queue.whenIdle();
  assert.equal(queue.snapshot().items[0].status,'succeeded');assert.equal(queue.snapshot().items[0].attempts,2);
  assert.equal(queue.snapshot().items[1].status,'failed');await queue.skip();assert.equal(queue.snapshot().items[1].status,'skipped');
});
test('skip requested before process startup does not execute the skipped prompt',async()=>{
  const requests:RunRequest[]=[];
  const queue=setup(scripted([event=>{event(done);return {code:0};}],requests));queue.add(['skip this','run this']);queue.start();await queue.skip();await queue.whenIdle();
  assert.equal(requests.length,1);assert.equal(requests[0].prompt,'run this');assert.deepEqual(queue.snapshot().items.map(item=>item.status),['skipped','succeeded']);
});
test('pausing during retry backoff does not start another process',async()=>{
  let launches=0;const queue=setup(()=>{launches++;return {result:Promise.resolve({code:1}),cancel:async()=>{}};});
  queue.on('log',entry=>{if(entry.message==='Retrying with completion reminder') void queue.pause();});
  queue.add(['one']);queue.start();await queue.whenIdle();assert.equal(launches,1);assert.equal(queue.snapshot().status,'paused');
});

test('streaming activity keeps stable IDs and paired tools without mutating emitted log records', async () => {
  const emitted: LogEntry[] = [];
  const queue = setup(scripted([event => {
    event({type:'agent_event',event:{type:'content_start',contentType:'text',text:'Hel'}});
    event({type:'agent_event',event:{type:'content_delta',contentType:'text',text:'lo'}});
    event({type:'agent_event',event:{type:'content_end',contentType:'text',text:'Hello'}});
    event({type:'agent_event',event:{type:'content_start',contentType:'tool',toolCallId:'a',toolName:'editor',input:{path:'hello.txt'}}});
    event({type:'agent_event',event:{type:'content_start',contentType:'tool',toolCallId:'b',toolName:'read_files',input:{path:'other.txt'}}});
    event({type:'agent_event',parentAgentId:'child',event:{type:'content_start',contentType:'tool',toolCallId:'a',toolName:'editor',input:{path:'child.txt'}}});
    event({type:'agent_event',event:{type:'content_update',contentType:'tool',toolCallId:'a',update:'Saving…'}});
    event({type:'agent_event',event:{type:'content_end',contentType:'tool',toolCallId:'a',output:{success:true,result:'Saved'},durationMs:10}});
    event({type:'agent_event',event:{type:'content_end',contentType:'tool',toolCallId:'b',toolName:'read_files',output:{success:false,result:'Missing'}}});
    event(done); return {code:0};
  }, event => {
    event({type:'agent_event',event:{type:'content_start',contentType:'tool',toolCallId:'a',toolName:'editor',input:{path:'next.txt'}}});
    event(done); return {code:0};
  }]));
  queue.on('log', entry => emitted.push(entry));
  queue.add(['first', 'second']); queue.start(); await queue.whenIdle();
  const logs = queue.snapshot().logs;
  const text = logs.filter(entry => entry.kind === 'text');
  assert.equal(text.length, 1); assert.equal(text[0].message, 'Hello');
  assert.equal(text[0].id, emitted.find(entry => entry.kind === 'text')!.id);
  assert.equal(emitted.find(entry => entry.kind === 'text')!.message, 'Hel', 'Disk events remain immutable');
  const tools = logs.filter(entry => entry.display?.type === 'tool');
  assert.equal(tools.length, 4, 'Only matching call IDs in the same prompt, attempt and agent are joined');
  const first = tools[0].display;
  assert.ok(first?.type === 'tool'); assert.equal(first.name, 'editor'); assert.equal(first.status, 'completed'); assert.equal(first.output, 'Saved'); assert.match(first.input!, /hello.txt/);
  assert.equal(tools[0].id, emitted.find(entry => entry.kind === 'tool')!.id);
  assert.equal(emitted.filter(entry => entry.kind === 'tool').length, 7, 'All tool events still reach the full log');
  const persisted = {...queue.snapshot(), logs: logs.map(({data, ...entry}) => entry)};
  const restored = new PromptQueue(() => { throw new Error('No run'); }, () => defaultSettings, persisted);
  assert.deepEqual(restored.snapshot().logs.filter(entry => entry.kind === 'tool').map(entry => entry.display), tools.map(entry => entry.display));
});

test('older saved logs receive unique IDs even when their timestamps match', () => {
  const queue = setup(() => { throw new Error('No run'); });
  const saved = queue.snapshot();
  saved.logs = [
    {time:'2026-09-17T00:00:00.000Z',kind:'tool',message:'first tool'},
    {time:'2026-09-17T00:00:00.000Z',kind:'tool',message:'second tool'}
  ];
  const restored = new PromptQueue(() => { throw new Error('No run'); }, () => defaultSettings, saved);
  const logs = restored.snapshot().logs;
  assert.ok(logs.every(entry => entry.id)); assert.notEqual(logs[0].id, logs[1].id);
  assert.deepEqual(logs.map(entry => entry.message), ['first tool', 'second tool']);
});
