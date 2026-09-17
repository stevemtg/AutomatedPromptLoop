import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findSession } from '../sessions';
import { normalizeEvent } from '../ndjson';

test('conversation IDs are not confused with resumable session IDs',()=>{
  assert.equal(normalizeEvent({type:'hook_event',hookEventName:'agent_start',taskId:'conv_123'}).sessionId,undefined);
  assert.equal(normalizeEvent({type:'session',sessionId:'stable-id'}).sessionId,'stable-id');
});
test('session discovery matches exact prompt, workspace, creation time and excludes pre-existing sessions',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'prompt-loop-sessions-'));
  const started=Date.now();
  const write=async(id:string,prompt:string,cwd:string,time=started)=>{
    await mkdir(path.join(directory,id));await writeFile(path.join(directory,id,`${id}.json`),JSON.stringify({session_id:id,prompt,cwd,started_at:new Date(time).toISOString()}));
  };
  try {
    await write('old','prompt',process.cwd());await write('wrong-prompt','different',process.cwd());
    await write('wrong-workspace','prompt',os.tmpdir());await write('old-time','prompt',process.cwd(),started-3000);
    await write('match','prompt',process.cwd());
    assert.equal(await findSession(directory,new Set(['old']),process.cwd(),'prompt',started),'match');
    await write('ambiguous','prompt',process.cwd());
    await assert.rejects(findSession(directory,new Set(['old']),process.cwd(),'prompt',started),/Multiple/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
