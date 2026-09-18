(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const cached = vscode.getState() || {};
  let currentState;
  let constantDirty = Boolean(cached.constantDirty);
  let queueSignature = '';
  $('prompt').value = cached.draft || '';
  $('constant').value = cached.constant || '';
  const send = (type, fields = {}) => vscode.postMessage({ type, ...fields });
  const saveDraft = () => vscode.setState({ draft: $('prompt').value, constant: $('constant').value, constantDirty, activity: transcript.preferences() });
  const transcript = new window.PromptLoopTranscript(send, cached.activity, saveDraft);
  for (const id of ['start','pause','resume','retry','skip','stop','workspace','settings','logs','logfile','import','export']) $(id).addEventListener('click', () => { $('notice').hidden = true; send(id); });
  $('prompt').addEventListener('input', saveDraft);
  $('constant').addEventListener('input', () => { constantDirty = true; $('constantSaved').textContent = 'Unsaved'; saveDraft(); });
  $('saveConstant').addEventListener('click', () => send('constant', { value: $('constant').value }));
  $('add').addEventListener('click', () => {
    const prompts = $('prompt').value.split(/^\s*---\s*$/m).map(text => text.trim()).filter(Boolean);
    if (prompts.length) { send('add', { prompts }); $('prompt').value = ''; saveDraft(); }
  });
  $('prompt').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('add').click(); });
  $('clear').addEventListener('click', () => { send('clear'); });
  function button(label, title, action) {
    const el = document.createElement('button'); el.className = 'quiet'; el.textContent = label; el.title = title; el.setAttribute('aria-label', title); el.addEventListener('click', action); return el;
  }
  function renderQueue(items) {
    const signature = JSON.stringify(items.map(({usage, ...item}) => item));
    if (signature === queueSignature || $('queue').querySelector('textarea')) return;
    queueSignature = signature;
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = document.createElement('li'); row.className = 'prompt-item'; row.dataset.status = item.status;
      const title = document.createElement('div'); title.className = 'prompt-title'; title.tabIndex = 0;
      title.addEventListener('click', () => row.classList.toggle('expanded'));
      title.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.classList.toggle('expanded'); } });
      const icon = document.createElement('span'); icon.className = 'prompt-icon'; icon.textContent = {pending:'○',running:'◌',succeeded:'✓',failed:'!',skipped:'↷'}[item.status]; icon.setAttribute('aria-label', item.status);
      const text = document.createElement('p'); text.className = 'prompt-text'; text.textContent = item.text;
      title.append(icon,text);
      const meta = document.createElement('div'); meta.className = 'prompt-meta';
      const info = document.createElement('span'); info.textContent = `${String(index+1).padStart(2,'0')} · ${item.status} · ${item.attempts} attempt${item.attempts===1?'':'s'}`; meta.append(info);
      if (!item.attempts && item.status === 'pending') {
        meta.append(button('↑','Move prompt up',()=>send('move',{id:item.id,direction:-1})),button('↓','Move prompt down',()=>send('move',{id:item.id,direction:1})),button('Edit','Edit prompt',()=>{
          const editor = document.createElement('textarea'); editor.value = item.text; editor.rows=5; editor.setAttribute('aria-label','Edit prompt');
          const save = button('Save','Save prompt',()=>{ if(editor.value.trim()) { send('edit',{id:item.id,text:editor.value}); editor.remove(); queueSignature=''; renderQueue(currentState.items); } });
          const cancel = button('Cancel','Cancel editing',()=>{ editor.remove(); queueSignature=''; renderQueue(currentState.items); });
          row.append(editor,save,cancel); editor.focus();
        }),button('×','Remove prompt',()=>send('remove',{id:item.id})));
      }
      row.append(title,meta);
      if(item.error) { const error=document.createElement('p');error.className='prompt-error';error.textContent=item.error;row.append(error); }
      fragment.append(row);
    });
    $('queue').replaceChildren(fragment);
  }
  window.addEventListener('message', ({ data }) => {
    if(data.type==='error') { $('notice').textContent=data.message;$('notice').hidden=false;return; }
    if(data.type==='constantSaved') { constantDirty=false;$('constantSaved').textContent='Saved';saveDraft();return; }
    if(data.type==='copied') { transcript.copied(); return; }
    if(data.type!=='state') return;
    const {state,settings,busy}=data;currentState=state;
    const completed=state.items.filter(item=>item.status==='succeeded').length;
    const finished=state.items.filter(item=>['succeeded','skipped'].includes(item.status)).length;
    const current=state.items.find(item=>item.id===state.currentId);
    const failed=state.items.some(item=>item.status==='failed');
    const pending=state.items.some(item=>item.status==='pending');
    $('workspace').textContent=state.workspace || 'Select project folder';$('workspace').disabled=busy;
    $('status').textContent=state.status.toUpperCase();$('status').dataset.status=state.status;
    $('progress').textContent=`${completed} / ${state.items.length} complete`;
    $('progressbar').max=state.items.length||1;$('progressbar').value=finished;
    $('activity').textContent=state.activity;$('queueCount').textContent=state.items.length;
    $('empty').hidden=state.items.length>0;
    $('start').hidden=['running','paused','stopped'].includes(state.status);$('start').disabled=busy||!pending;
    $('pause').hidden=state.status!=='running';$('pause').disabled=!busy;
    $('resume').hidden=!['paused','stopped'].includes(state.status);$('resume').disabled=busy||failed||!pending;
    $('retry').hidden=!failed && !current;$('retry').textContent=failed?'↻ Retry Failed':'↻ Retry Current';$('retry').disabled=busy&&state.status!=='running';
    $('skip').disabled=!current&&!pending&&!failed;$('stop').disabled=!busy&&!['paused','running'].includes(state.status);
    $('clear').disabled=busy||!state.items.length;
    if(!constantDirty && document.activeElement!==$('constant')) $('constant').value=settings.prompt_constant;
    $('session').textContent=current?.sessionId||[...state.items].reverse().find(item=>item.sessionId)?.sessionId||'No active session';
    const usage=state.items.reduce((sum,item)=>({inputTokens:sum.inputTokens+item.usage.inputTokens,outputTokens:sum.outputTokens+item.usage.outputTokens,cost:sum.cost+item.usage.cost}),{inputTokens:0,outputTokens:0,cost:0});
    $('tokensIn').textContent=usage.inputTokens.toLocaleString();$('tokensOut').textContent=usage.outputTokens.toLocaleString();$('cost').textContent=`$${usage.cost.toFixed(4)}`;
    $('footer').textContent=`${settings.stallTimeout}s stall timeout · ${settings.maxAttempts} attempts · auto-approve ${settings.autoApprove?'on':'off'}`;
    renderQueue(state.items);transcript.update(state.logs, state.items, busy && state.status === 'running');
  });
  send('ready');
})();
