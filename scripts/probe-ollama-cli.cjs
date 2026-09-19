// Probe the installed CLI against a local, deterministic Ollama server. No model inference.
const {createServer} = require('node:http');
const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve('.test-artifacts', `ollama-probe-${Date.now()}`);
(async () => {
  await fs.mkdir(root, {recursive:true});
  let calls = 0;
  const server = createServer(async (req,res) => {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if(req.url.endsWith('/chat')) {
      calls++;
      await fs.writeFile(path.join(root, `request-${calls}.json`), JSON.stringify(body,null,2));
      console.log('request',calls,req.url,JSON.stringify({model:body.model,think:body.think,options:body.options,temperature:body.temperature,max_output_tokens:body.max_output_tokens,tools:body.tools?.slice(0,2),assistant:body.messages?.filter(m=>m.role==='assistant')}));
      const base={model:body.model,created_at:new Date().toISOString()};
      res.writeHead(200, {'content-type':'application/x-ndjson'});
      if(calls===1) {
        res.write(JSON.stringify({...base,message:{role:'assistant',content:'',thinking:'I will inspect the file.',tool_calls:[{function:{name:'read_file',arguments:{path:'marker.txt'}}}]},done:false})+'\n');
      } else res.write(JSON.stringify({...base,message:{role:'assistant',content:'The task is complete.'},done:false})+'\n');
      res.end(JSON.stringify({...base,message:{role:'assistant',content:''},done:true,done_reason:'stop',prompt_eval_count:50,eval_count:10})+'\n');
    } else {
      console.log('metadata',req.url);
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(req.url.endsWith('/tags')?{models:[]}:{capabilities:['completion','tools','thinking'],model_info:{'general.architecture':'qwen4exp','qwen4exp.context_length':262144}}));
    }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const config={version:1,lastUsedProvider:'ollama',modes:{},providers:{ollama:{settings:{provider:'ollama',model:'qwen3.8-flash-next:125b-a6b-q4_K_M',baseUrl:`http://127.0.0.1:${server.address().port}`,contextWindow:131072}}}};
  const configPath=path.join(root,'providers.json');await fs.writeFile(configPath,JSON.stringify(config));
  await fs.writeFile(path.join(root,'marker.txt'),'fixture');
  const cli=path.join(process.env.APPDATA,'npm/node_modules/cline/bin/cline');
  const child=spawn(process.execPath,[cli,'--json','--auto-approve','false','--provider','ollama','--cwd',root,'--timeout','40','--retries','1','--','Read marker.txt using a tool, then summarize it.'],{windowsHide:true,env:{...process.env,CLINE_DATA_DIR:root,CLINE_PROVIDER_SETTINGS_PATH:configPath,CLINE_SESSION_BACKEND_MODE:'local',CLINE_LOG_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
  const output=[];child.stdout.on('data',c=>output.push(c));child.stderr.on('data',c=>process.stderr.write(c));
  child.on('error',e=>console.error(e));
  const code=await new Promise(r=>child.on('close',r));
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await fs.writeFile(path.join(root,'output.ndjson'),Buffer.concat(output));console.log({code,calls,root});
})().catch(e=>{console.error(e);process.exitCode=1;});
