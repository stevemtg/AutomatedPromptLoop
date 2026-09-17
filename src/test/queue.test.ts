import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptQueue } from '../queue';
import { defaultSettings, Runner, RunRequest, RunResult, Settings } from '../types';
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
