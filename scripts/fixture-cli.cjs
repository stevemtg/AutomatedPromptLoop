// Deterministic CLI fixture, or a real Cline transport with one injected exit failure.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const workspace = args[args.indexOf('--cwd') + 1];
let prompt = args.includes('--') ? args[args.indexOf('--') + 1] : '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { prompt += data; });
process.stdin.on('end', () => {
  const invocation = { args, prompt, time: new Date().toISOString() };
  fs.appendFileSync(path.join(workspace, 'invocations.ndjson'), JSON.stringify(invocation) + '\n');
  const second = prompt.includes('Add a second line');
  const marker = path.join(workspace, '.failure-injected');
  const forceFailure = second && !fs.existsSync(marker);
  if (forceFailure) fs.writeFileSync(marker, '1');
  if (process.env.PROMPT_LOOP_LIVE === '1') {
    const child = spawn(process.execPath, [process.env.PROMPT_LOOP_REAL_CLI, ...args], { cwd: workspace, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: {...process.env, CLINE_LOG_ENABLED:'0'} });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.stdin.end();
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('close', code => {
      if(forceFailure && code === 0) console.error('TEST FAULT: completed process intentionally exits with code 17.');
      process.exitCode = forceFailure && code === 0 ? 17 : code ?? 1;
    });
    return;
  }
  const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
  const sessionId = args.includes('--id') ? args[args.indexOf('--id') + 1] : `fixture-${second?'second':'first'}`;
  emit({type:'session', sessionId});
  emit({type:'agent_event', event:{type:'content_start',contentType:'text',text:'Working…'}});
  emit({type:'agent_event', event:{type:'content_start',contentType:'reasoning',reasoning:'Checking the existing file before making the requested edit.'}});
  emit({type:'agent_event', event:{type:'content_end',contentType:'reasoning',reasoning:'Checking the existing file before making the requested edit.'}});
  emit({type:'agent_event', event:{type:'content_start',contentType:'tool',toolName:'editor',toolCallId:'edit-hello',input:{path:'hello.txt',new_text:second ? 'hi\nsecond\n' : 'hi\n'}}});
  fs.writeFileSync(path.join(workspace,'hello.txt'), second ? 'hi\nsecond\n' : 'hi\n');
  emit({type:'agent_event', event:{type:'content_end',contentType:'tool',toolName:'editor',toolCallId:'edit-hello',output:{success:true,result:'Updated `hello.txt`.\n\n```diff\n+ hi\n' + (second ? '+ second\n' : '') + '```'},durationMs:12}});
  if (!second) {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VAAAAABJRU5ErkJggg==';
    fs.writeFileSync(path.join(workspace, 'crop.png'), Buffer.from(png, 'base64'));
    const results = {
      generate_image: {content:[{type:'text',text:'Generated preview.'},{type:'image',mimeType:'image/png',data:png}]},
      crop_zoom: {output_path:'crop.png'},
      check_transparency: {has_transparency:true,transparent_pixels:1},
      remove_bg: {content:[{type:'image',mediaType:'image/png',data:png},{type:'resource',resource:{mimeType:'image/png',blob:png}}]}
    };
    for (const [toolName, output] of Object.entries(results)) {
      emit({type:'agent_event',event:{type:'content_start',contentType:'tool',toolName,toolCallId:toolName,input:{prompt:'Preview fixture'}}});
      emit({type:'agent_event',event:{type:'content_end',contentType:'tool',toolName,toolCallId:toolName,output}});
    }
  }
  emit({type:'agent_event', event:{type:'content_end',contentType:'text',text:'## File updated\n\n**Verified** the contents of `hello.txt`.\n\n- [x] Apply the requested edit\n- [x] Check the result\n\n```text\nhi\n' + (second ? 'second\n' : '') + '```'}});
  emit({type:'agent_event',event:{type:'usage',inputTokens:10,outputTokens:2,totalInputTokens:10,totalOutputTokens:2,totalCost:.01}});
  emit({type:'generation_metrics',requestId:'fixture-generation',outputTokens:2,durationMs:second ? (forceFailure ? 200 : 300) : 100});
  emit({type:'agent_event',event:{type:'done',reason:'completed',text:'Done',usage:{inputTokens:10,outputTokens:2,totalCost:.01}}});
  emit({type:'run_result',finishReason:'completed',usage:{inputTokens:10,outputTokens:2,totalCost:.01}});
  process.exitCode = forceFailure ? 17 : 0;
});
