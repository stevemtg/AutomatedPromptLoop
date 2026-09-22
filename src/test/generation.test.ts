import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { GenerationTracker } from '../generation';
import { PromptQueue } from '../queue';
import { defaultSettings, Runner } from '../types';
import { startOllamaBridge } from '../ollama';

test('native generation timing is validated, deduplicated, and excludes Cline estimates', () => {
  const tracker = new GenerationTracker();
  const metric = {type:'generation_metrics',requestId:'one',outputTokens:40,durationMs:2000};
  for (const invalid of [0,-1,NaN,Infinity,'2000',undefined]) assert.equal(tracker.observe({...metric,durationMs:invalid}), undefined);
  assert.equal(tracker.observe({...metric,outputTokens:Infinity}), undefined);
  tracker.observe({type:'ollama_request',phase:'started'});
  tracker.observe({type:'iteration_start'}, 0);
  assert.equal(tracker.observe({type:'usage',outputTokens:40}, 1000), undefined);
  assert.deepEqual(tracker.observe(metric), {outputTokens:40,durationMs:2000,estimated:false});
  assert.equal(tracker.observe(metric), undefined);
  assert.equal(tracker.observe({type:'run_result',usage:{outputTokens:40}}), undefined);
});

test('estimated turn timing excludes tools, deduplicates usage, and tracks agents separately', () => {
  const tracker = new GenerationTracker();
  const event = (type: string, now: number, fields = {}, agentId = 'main') => tracker.observe({type:'agent_event',event:{type,agentId,...fields}}, now);
  event('iteration_start', 100);
  event('iteration_start', 200, {}, 'child');
  event('content_start', 1100, {contentType:'tool'});
  assert.deepEqual(event('usage', 3000, {outputTokens:20,totalOutputTokens:100}), {outputTokens:20,durationMs:1000,estimated:true});
  assert.equal(event('usage', 3100, {outputTokens:20,totalOutputTokens:100}), undefined);
  assert.deepEqual(event('usage', 3200, {outputTokens:30}, 'child'), {outputTokens:30,durationMs:3000,estimated:true});
  event('iteration_start', 4000);
  event('error', 5000);
  assert.equal(event('usage', 6000, {outputTokens:10}), undefined);
  event('iteration_start', 7000);
  assert.equal(event('usage', 7000, {outputTokens:10}), undefined, 'Zero elapsed time is unavailable');
});

test('speed totals survive retries and reload without double-counting final usage records', async () => {
  let attempt = 0;
  const runner: Runner = (_request, emit) => ({result:Promise.resolve().then(() => {
    attempt++;
    const metric = {type:'generation_metrics',requestId:'same-per-attempt',outputTokens:attempt * 10,durationMs:attempt * 1000};
    emit(metric); emit(metric);
    emit({type:'usage',outputTokens:attempt * 10,totalOutputTokens:attempt * 10});
    emit({type:'run_result',finishReason:'completed',usage:{outputTokens:attempt * 10}});
    return {code:attempt === 1 ? 17 : 0};
  }),cancel:async()=>{}});
  const queue = new PromptQueue(runner, () => defaultSettings);
  queue.setWorkspace(process.cwd()); queue.add(['Generate']); queue.start(); await queue.whenIdle();
  const expected = {outputTokens:30,durationMs:3000,samples:2,estimatedSamples:0};
  assert.deepEqual(queue.snapshot().items[0].generation, expected);
  const restored = new PromptQueue(runner, () => defaultSettings, queue.snapshot());
  assert.deepEqual(restored.snapshot().items[0].generation, expected);
  restored.clear();
  assert.deepEqual(restored.snapshot().items, []);
});

test('Ollama bridge emits generation metrics from final native timing without changing usage', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {'content-type':'application/x-ndjson'});
    res.end(JSON.stringify({done:true,eval_count:60,eval_duration:2e9,prompt_eval_duration:8e9,load_duration:10e9}) + '\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const events: any[] = [];
  const address = server.address() as {port:number};
  const bridge = await startOllamaBridge(`http://127.0.0.1:${address.port}`, defaultSettings, {}, event => events.push(event), () => {});
  try {
    const response = await fetch(`${bridge.baseUrl}/api/chat`, {method:'POST',body:JSON.stringify({model:'fixture',messages:[]})});
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(await response.text()).eval_count, 60);
    const metrics = events.filter(event => event.type === 'generation_metrics');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].outputTokens, 60);
    assert.equal(metrics[0].durationMs, 2000, 'Loading and prompt processing are excluded');
    assert.equal(metrics[0].requestId, events.find(event => event.phase === 'started').id);
  } finally {
    await bridge.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
