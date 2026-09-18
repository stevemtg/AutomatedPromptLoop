import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NdjsonParser, normalizeEvent } from '../ndjson';

test('NDJSON decodes arbitrarily split UTF-8, CRLF, multiple lines, malformed output and an unterminated final record', () => {
  const events: unknown[] = [], diagnostics: string[] = [];
  const parser = new NdjsonParser(value => events.push(value), value => diagnostics.push(value));
  const data = Buffer.from('\r\n{"text":"héllo 🌍"}\r\nnot json\n{"type":"done"}');
  for (const byte of data) parser.write(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(events, [{text:'héllo 🌍'}, {type:'done'}]); assert.deepEqual(diagnostics, ['not json']);
});
test('oversized lines are discarded and parsing recovers at the next newline', () => {
  const events: unknown[] = []; const parser = new NdjsonParser(value => events.push(value), () => {}, 20);
  parser.write('x'.repeat(25)); parser.write('ignored\n{"ok":true}\n');
  assert.deepEqual(events, [{ok:true}]);
});
test('Cline 3 content, completion and cumulative usage records normalize correctly', () => {
  assert.equal(normalizeEvent({type:'agent_event',event:{type:'content_start',contentType:'tool',toolName:'editor',input:{path:'hello.txt'}}}).kind,'tool');
  assert.equal(normalizeEvent({type:'agent_event',event:{type:'content_start',contentType:'reasoning',reasoning:'Checking'}}).message,'Checking');
  assert.equal(normalizeEvent({type:'agent_event',event:{type:'done',reason:'completed'}}).success,true);
  assert.equal(normalizeEvent({type:'run_result',finishReason:'completed'}).success,true);
  assert.ok(normalizeEvent({type:'run_result',finishReason:'mistake_limit'}).failure);
  assert.equal(normalizeEvent({type:'heartbeat'}).meaningful,false);
  assert.deepEqual(normalizeEvent({type:'agent_event',event:{type:'usage',inputTokens:3,outputTokens:2,totalInputTokens:12,totalOutputTokens:6,totalCost:.25}}).usage,{inputTokens:12,outputTokens:6,cost:.25,cumulative:true});
});
test('iteration end, tool success, and human text do not falsely signal task completion', () => {
  for (const event of [{type:'iteration_end',hadToolCalls:false},{type:'content_end',contentType:'tool',output:{success:true}},{type:'text',text:'done'},{type:'run_result',finishReason:'aborted'}]) assert.equal(normalizeEvent({type:'agent_event',event}).success,false);
});

test('tool display preserves inputs, readable results, failures, and bounded content', () => {
  const start = normalizeEvent({type:'agent_event',event:{type:'content_start',contentType:'tool',toolName:'editor',toolCallId:'call-1',input:{path:'hello.txt',new_text:'hi\n'}}});
  assert.deepEqual(start.display, {type:'tool',name:'editor',callId:'call-1',status:'running',input:'{\n  "path": "hello.txt",\n  "new_text": "hi\\n"\n}',summary:'hello.txt'});
  const result = normalizeEvent({type:'agent_event',event:{type:'content_end',contentType:'tool',toolName:'editor',toolCallId:'call-1',output:[{success:false,result:'Permission denied'}],durationMs:8}});
  assert.deepEqual(result.display,{type:'tool',name:'editor',callId:'call-1',status:'failed',output:'Permission denied',outputFormat:'markdown',durationMs:8});
  assert.equal(result.success,false,'A tool result never completes the task');
  assert.equal(result.failure,undefined,'Tool failures are shown without changing queue completion semantics');
  const huge = normalizeEvent({type:'tool_result',output:'x'.repeat(25000)}).display;
  assert.ok(huge?.type === 'tool'); assert.match(huge.output!,/Truncated/); assert.ok(huge.output!.length < 20100);
  assert.equal(normalizeEvent({type:'agent_event',event:{type:'content_start',contentType:'reasoning',reasoning:'Check'}}).display?.type,'reasoning');
});
