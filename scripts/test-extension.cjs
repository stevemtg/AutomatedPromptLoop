const { runTests } = require('@vscode/test-electron');
// This agent shell may inherit Electron's Node-only mode; the test needs the GUI host.
delete process.env.ELECTRON_RUN_AS_NODE;
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const live = process.argv.includes('--live');
const artifacts = path.join(root, '.test-artifacts', `${live?'live':'extension'}-${Date.now()}`);
const scratch = path.join(artifacts, 'scratch');
fs.mkdirSync(path.join(scratch,'.vscode'), { recursive: true });
fs.writeFileSync(path.join(scratch,'.vscode','settings.json'), JSON.stringify({
  'promptLoop.cliPath': path.join(root,'scripts','fixture-cli.cjs'),
  'promptLoop.nodePath': process.execPath,
  'promptLoop.prompt_constant': 'Work only in the current scratch project. Use file tools directly; avoid shell commands. Make the requested edit, verify it, and keep your final answer to one short sentence.',
  'promptLoop.stallTimeout': 180,
  'promptLoop.maxAttempts': 3,
  'promptLoop.autoApprove': true,
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none'
},null,2));
// Machine-scoped executable settings live in the isolated test profile.
const userData = path.join(artifacts,'user-data');
fs.mkdirSync(path.join(userData,'User'),{recursive:true});
fs.writeFileSync(path.join(userData,'User','settings.json'),JSON.stringify({
  'promptLoop.cliPath': path.join(root,'scripts','fixture-cli.cjs'), 'promptLoop.nodePath':process.execPath,
  'security.workspace.trust.enabled':false, 'workbench.startupEditor':'none', 'telemetry.telemetryLevel':'off'
}));
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE || (process.platform==='win32' ? path.join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe') : undefined);
console.log(`Artifacts: ${artifacts}`);
(async () => {
const cdpPort = await new Promise((resolve,reject) => { const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));}); });
await runTests({
  vscodeExecutablePath, extensionDevelopmentPath:root, extensionTestsPath:path.join(root,'out','test','extension-suite.js'),
  extensionTestsEnv:{PROMPT_LOOP_CDP_PORT:String(cdpPort),PROMPT_LOOP_LIVE:live?'1':'0',PROMPT_LOOP_ARTIFACTS:artifacts,PROMPT_LOOP_REAL_CLI:process.env.PROMPT_LOOP_REAL_CLI||path.join(process.env.APPDATA||'', 'npm','node_modules','cline','bin','cline')},
  launchArgs:[scratch,'--user-data-dir',userData,'--extensions-dir',path.join(artifacts,'extensions'),'--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--no-sandbox',`--remote-debugging-port=${cdpPort}`,'--remote-debugging-address=127.0.0.1']
});
})().catch(error=>{console.error(error);process.exitCode=1;});
