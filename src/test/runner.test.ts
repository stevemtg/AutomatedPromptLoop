import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCline, buildArgs } from '../runner';
import { defaultSettings } from '../types';

test('subprocess preserves multiline prompts and shell metacharacters as literal text',async()=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'prompt-loop-runner-'));
  const prompt='Create hello.txt with hi\nQuotes: "double" \'single\' & | %PATH% $HOME $(echo nothing) `literal` 🌍';
  const events:unknown[]=[];
  try {
    const handle=runCline({workspace,prompt,settings:{...defaultSettings,cliPath:path.resolve('scripts/fixture-cli.cjs'),nodePath:process.execPath}},event=>events.push(event),()=>{});
    assert.equal((await handle.result).code,0);
    const invocation=JSON.parse((await readFile(path.join(workspace,'invocations.ndjson'),'utf8')).trim());
    assert.equal(invocation.prompt,prompt);assert.ok(events.length>=5);
  } finally { await rm(workspace,{recursive:true,force:true}); }
});
test('CLI arguments explicitly carry provider, model, approval setting and resume ID',()=>{
  const args=buildArgs({workspace:'/project',prompt:'--literal prompt',sessionId:'stable-id',settings:{...defaultSettings,model:'model-id',provider:'provider-id',autoApprove:false}});
  assert.deepEqual(args,['--json','--auto-approve','false','--cwd','/project','--model','model-id','--provider','provider-id','--id','stable-id','--','--literal prompt']);
});
