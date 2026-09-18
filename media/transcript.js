(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const action = (label, title, handler) => {
    const node = element('button', 'quiet', label);
    node.type = 'button'; node.title = title; node.setAttribute('aria-label', title);
    node.addEventListener('click', handler);
    return node;
  };

  // Model output is always text, never HTML. Links require a click and an HTTP(S) URL.
  function inline(parent, text, send, depth = 0) {
    if (depth > 5) { parent.append(document.createTextNode(text)); return; }
    const pattern = /(`+)([^`\n]+)\1|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
      let node;
      if (match[1]) node = element('code', '', match[2]);
      else if (match[3]) {
        node = element('a', '', match[3]); node.href = match[4]; node.title = match[4];
        node.addEventListener('click', event => { event.preventDefault(); send('openLink', { url: match[4] }); });
      } else {
        node = element(match[5] || match[6] ? 'strong' : match[7] ? 'del' : 'em');
        inline(node, match[5] || match[6] || match[7] || match[8], send, depth + 1);
      }
      parent.append(node); cursor = match.index + match[0].length;
    }
    parent.append(document.createTextNode(text.slice(cursor)));
  }

  function codeBlock(text, language, send) {
    const block = element('div', 'activity-code');
    const heading = element('div', 'code-heading');
    heading.append(element('span', '', language || 'text'), action('Copy', 'Copy code', () => send('copy', { text })));
    const pre = element('pre'); const code = element('code');
    if (language.toLowerCase() === 'diff') {
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        const kind = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : '';
        code.append(element('span', kind ? `diff-${kind}` : '', line + (index < lines.length - 1 ? '\n' : '')));
      });
    } else code.textContent = text;
    pre.append(code); block.append(heading, pre); return block;
  }

  function markdown(text, send) {
    const root = element('div', 'activity-markdown');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const blockStart = line => /^(\s*(`{3,}|~{3,})|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?|\s*([-*_])(?:\s*\3){2,}\s*$)/.test(line);
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^\s*(`{3,}|~{3,})([^\s]*)\s*$/);
      if (fence) {
        const body = []; i++;
        while (i < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i++;
        root.append(codeBlock(body.join('\n'), fence[2], send)); continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { const node = element(`h${Math.min(6, heading[1].length + 2)}`); inline(node, heading[2], send); root.append(node); i++; continue; }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { root.append(element('hr')); i++; continue; }
      if (line.startsWith('>')) {
        const quote = element('blockquote'); const body = [];
        while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
        inline(quote, body.join('\n'), send); root.append(quote); continue;
      }
      const list = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
      if (list) {
        const node = element(list[2] ? 'ol' : 'ul');
        if (list[2]) node.start = Number(list[2]);
        while (i < lines.length) {
          const match = lines[i].match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
          if (!match || Boolean(match[2]) !== Boolean(list[2])) break;
          const item = element('li'); const task = match[3].match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            item.className = 'task-item';
            const check = element('input'); check.type = 'checkbox'; check.disabled = true; check.checked = task[1] !== ' '; check.setAttribute('aria-label', check.checked ? 'Completed' : 'Incomplete');
            item.append(check); inline(item, task[2], send);
          } else inline(item, match[3], send);
          node.append(item); i++;
        }
        root.append(node); continue;
      }
      const cells = value => value.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      if (line.includes('|') && i + 1 < lines.length && cells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
        const wrap = element('div', 'activity-table'); const table = element('table');
        const head = element('thead'); const header = element('tr');
        for (const cell of cells(line)) { const th = element('th'); inline(th, cell, send); header.append(th); }
        head.append(header); table.append(head); i += 2;
        const body = element('tbody');
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const row = element('tr');
          for (const cell of cells(lines[i++])) { const td = element('td'); inline(td, cell, send); row.append(td); }
          body.append(row);
        }
        table.append(body); wrap.append(table); root.append(wrap); continue;
      }
      const paragraph = [line]; i++;
      while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) {
        if (lines[i].includes('|') && i + 1 < lines.length && cells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) break;
        paragraph.push(lines[i++]);
      }
      const node = element('p'); inline(node, paragraph.join('\n'), send); root.append(node);
    }
    return root;
  }

  class Transcript {
    constructor(send, preferences = {}, save) {
      this.send = send; this.save = save; this.root = $('transcript');
      this.filter = ['all', 'responses', 'tools', 'problems'].includes(preferences.filter) ? preferences.filter : 'all';
      this.query = typeof preferences.query === 'string' ? preferences.query : '';
      this.expanded = new Set(preferences.expanded || []); this.nodes = new Map(); this.entries = []; this.items = [];
      $('follow').checked = preferences.follow !== false; $('activitySearch').value = this.query;
      document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
        this.filter = button.dataset.filter; this.render(); this.save();
      }));
      $('activitySearch').addEventListener('input', () => { this.query = $('activitySearch').value; this.render(); this.save(); });
      $('follow').addEventListener('change', () => { if ($('follow').checked) this.scrollToLatest(); this.updateJump(); this.save(); });
      $('jumpLatest').addEventListener('click', () => { $('follow').checked = true; this.scrollToLatest(); this.updateJump(); this.save(); });
      $('copyTranscript').addEventListener('click', () => this.send('copy', { text: this.visible.map(entry => {
        const context = this.context(entry);
        return `[${new Date(entry.time).toLocaleTimeString()}] ${context ? context + ' · ' : ''}${this.label(entry)}\n${this.plainText(entry)}`;
      }).join('\n\n') }));
      // Only a user scroll away pauses following; incoming records keep existing DOM nodes.
      this.root.addEventListener('scroll', () => {
        if ($('follow').checked && this.root.scrollHeight - this.root.clientHeight - this.root.scrollTop > 40) {
          $('follow').checked = false; this.updateJump(); this.save();
        }
      });
      this.render();
    }
    preferences() { return { filter: this.filter, query: this.query, follow: $('follow').checked, expanded: [...this.expanded].slice(-150) }; }
    copied() {
      $('copyStatus').textContent = 'Copied to clipboard';
      clearTimeout(this.copyTimer); this.copyTimer = setTimeout(() => { $('copyStatus').textContent = ''; }, 2500);
    }
    update(logs, items, running) {
      this.items = items; this.running = running;
      this.entries = logs.filter(entry => entry.kind !== 'event' && entry.kind !== 'usage').slice(-150);
      $('activityLive').hidden = !running;
      this.render();
    }
    key(entry) { return entry.id || `${entry.time}/${entry.promptId || ''}/${entry.attempt || 0}/${entry.kind}`; }
    label(entry) {
      if (entry.display?.type === 'tool') return entry.display.name.replace(/_/g, ' ');
      if (entry.display?.type === 'reasoning') return 'Thinking';
      return { text: 'Cline', tool: 'Tool call', error: 'Error', diagnostic: 'Diagnostic', queue: 'Queue' }[entry.kind] || entry.kind;
    }
    context(entry) {
      if (!entry.promptId) return '';
      const index = this.items.findIndex(item => item.id === entry.promptId);
      return `${index < 0 ? 'Earlier prompt' : `Prompt ${index + 1}`}${entry.attempt ? ` · Attempt ${entry.attempt}` : ''}`;
    }
    plainText(entry) {
      if (entry.display?.type !== 'tool') return entry.message;
      const tool = entry.display;
      return [tool.name, tool.input !== undefined ? `Input\n${tool.input}` : '', tool.output !== undefined ? `Output\n${tool.output}` : '', tool.input === undefined && tool.output === undefined ? entry.message : ''].filter(Boolean).join('\n\n');
    }
    matches(entry) {
      const tool = entry.display?.type === 'tool' || entry.kind === 'tool';
      if (this.filter === 'responses' && entry.kind !== 'text') return false;
      if (this.filter === 'tools' && !tool) return false;
      if (this.filter === 'problems' && !['error', 'diagnostic'].includes(entry.kind) && entry.display?.status !== 'failed') return false;
      return !this.query.trim() || `${this.label(entry)} ${this.context(entry)} ${this.plainText(entry)}`.toLowerCase().includes(this.query.trim().toLowerCase());
    }
    toolStatus(entry) {
      const status = entry.display.status;
      const active = this.items.some(item => item.id === entry.promptId && item.status === 'running' && item.attempts === entry.attempt);
      return status === 'running' && (!this.running || !active) ? 'unknown' : status;
    }
    makeRow(entry) {
      const collapsible = entry.kind === 'tool' || entry.display?.type === 'tool' || entry.display?.type === 'reasoning' || entry.kind === 'diagnostic';
      const row = element(collapsible ? 'details' : 'article', 'activity-entry');
      row.dataset.key = this.key(entry);
      if (collapsible) {
        row.open = this.expanded.has(this.key(entry));
        row.addEventListener('toggle', () => {
          if (!row.isConnected) return;
          if (row.open) this.expanded.add(this.key(entry)); else this.expanded.delete(this.key(entry));
          this.save();
        });
      }
      row.append(element(collapsible ? 'summary' : 'div', 'activity-entry-heading'), element('div', 'activity-entry-body'));
      return row;
    }
    updateRow(row, entry) {
      const tool = entry.display?.type === 'tool' ? entry.display : undefined;
      const thinking = entry.display?.type === 'reasoning';
      const compact = entry.kind === 'queue' || entry.kind === 'error';
      const status = tool ? this.toolStatus(entry) : '';
      row.dataset.kind = thinking ? 'reasoning' : entry.kind;
      row.dataset.status = status;
      const heading = row.firstChild;
      const icon = element('span', 'activity-icon', tool ? { running: '◌', completed: '✓', failed: '!', unknown: '◇' }[status] : { text: '✦', error: '!', queue: '·', diagnostic: '≡' }[entry.kind] || '◇');
      icon.setAttribute('aria-hidden', 'true');
      const label = element('span', 'activity-label', this.label(entry));
      const time = element('time', 'activity-time', new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      time.dateTime = entry.time; time.title = new Date(entry.time).toLocaleString();
      heading.replaceChildren(icon, label);
      if (tool) {
        const statusLabel = { running: 'Running', completed: 'Done', failed: 'Failed', unknown: 'Unconfirmed' }[status];
        heading.append(element('span', 'tool-status', statusLabel));
      }
      heading.append(time);
      if (row.tagName === 'DETAILS') { const chevron = element('span', 'activity-chevron', '›'); chevron.setAttribute('aria-hidden', 'true'); heading.append(chevron); }
      if (tool?.summary) { const preview = element('span', 'tool-preview', tool.summary); preview.title = tool.summary; heading.append(preview); }
      const body = row.lastChild;
      body.replaceChildren();
      if (tool) {
        if (tool.input !== undefined) { body.append(element('h4', 'tool-section-label', 'Input'), codeBlock(tool.input, /^[\[{]/.test(tool.input) ? 'json' : 'text', this.send)); }
        if (tool.output !== undefined) { body.append(element('h4', 'tool-section-label', 'Output'), tool.outputFormat === 'markdown' ? markdown(tool.output, this.send) : codeBlock(tool.output, tool.outputFormat || 'text', this.send)); }
        if (tool.input === undefined && tool.output === undefined) body.append(element('pre', 'activity-raw', entry.message));
        if (tool.durationMs !== undefined) body.append(element('p', 'tool-duration', `Finished in ${tool.durationMs < 1000 ? `${tool.durationMs} ms` : `${(tool.durationMs / 1000).toFixed(1)} s`}`));
      } else if (entry.kind === 'text') body.append(markdown(entry.message, this.send));
      else body.append(element(compact ? 'p' : 'pre', compact ? 'activity-message' : 'activity-raw', entry.message));
      if (!compact) {
        const footer = element('div', 'entry-actions');
        footer.append(action('Copy', 'Copy entry', () => this.send('copy', { text: this.plainText(entry) })));
        body.append(footer);
      }
    }
    render() {
      const oldTop = this.root.scrollTop;
      const rootTop = this.root.getBoundingClientRect().top;
      const anchor = [...this.root.children].find(node => node.getBoundingClientRect().bottom > rootTop);
      const anchorOffset = anchor ? anchor.getBoundingClientRect().top - rootTop : 0;
      document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === this.filter)));
      this.visible = this.entries.filter(entry => this.matches(entry));
      const wanted = [];
      let lastContext = '';
      for (const entry of this.visible) {
        const context = this.context(entry);
        const key = this.key(entry);
        if (context && context !== lastContext) {
          const groupKey = `group/${key}`;
          let group = this.nodes.get(groupKey);
          if (!group) { group = { node: element('div', 'activity-group') }; this.nodes.set(groupKey, group); }
          group.node.textContent = context;
          const item = this.items.find(item => item.id === entry.promptId);
          if (item) group.node.title = item.text;
          wanted.push(group.node);
        }
        lastContext = context;
        let record = this.nodes.get(key);
        if (!record) { record = { node: this.makeRow(entry), signature: '' }; this.nodes.set(key, record); }
        const signature = JSON.stringify([entry, entry.display?.type === 'tool' ? this.toolStatus(entry) : '']);
        if (record.signature !== signature) { this.updateRow(record.node, entry); record.signature = signature; }
        wanted.push(record.node);
      }
      if (!wanted.length) {
        const empty = element('div', 'activity-empty');
        empty.append(element('span', 'activity-empty-icon', this.entries.length ? '⌕' : '✦'), element('strong', '', this.entries.length ? 'No matching activity' : 'A clearer view of every step'), element('p', '', this.entries.length ? 'Try another filter or search term.' : 'Responses, tool calls, and progress will appear here when the queue runs.'));
        wanted.push(empty);
      }
      // Reconcile in place so expanded details, text selection and focus survive refreshes.
      const wantedSet = new Set(wanted);
      for (const child of [...this.root.children]) if (!wantedSet.has(child)) child.remove();
      wanted.forEach((node, index) => { if (this.root.children[index] !== node) this.root.insertBefore(node, this.root.children[index] || null); });
      const retained = new Set(this.entries.flatMap(entry => [this.key(entry), `group/${this.key(entry)}`]));
      for (const key of this.nodes.keys()) if (!retained.has(key)) { this.nodes.delete(key); this.expanded.delete(key); }
      $('copyTranscript').disabled = !this.visible.length;
      $('activityCount').textContent = this.entries.length ? `${this.visible.length} of ${this.entries.length} recent entries` : 'No activity yet';
      if ($('follow').checked) this.scrollToLatest();
      else if (anchor?.isConnected) this.root.scrollTop = oldTop + anchor.getBoundingClientRect().top - rootTop - anchorOffset;
      else this.root.scrollTop = oldTop;
      this.updateJump();
    }
    scrollToLatest() { this.root.scrollTop = this.root.scrollHeight; }
    updateJump() { $('jumpLatest').hidden = $('follow').checked || !this.visible.length; }
  }
  window.PromptLoopTranscript = Transcript;
})();
