/* 工具函数 & 全局状态 */
'use strict';
window.SR = window.SR || {};

SR.state = {
  config: null,
  prompts: null,
  mode: 'library',          // library | reader | explore
  doc: null,                // { path,title,pdf,pages,outline,parts,ann,readPos,zoom }
  cards: [],
  session: null,            // 当前对话 { id,mode:'part'|'explore'|'sel'|'free', title, context, messages:[{role,content}] }
};

/* ---------- API 封装 ---------- */
SR.api = async (path, opts = {}) => {
  const res = await fetch(path, opts);
  let j = null;
  try { j = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw new Error((j && j.error) || `HTTP ${res.status}`);
  return j;
};
SR.apiPost = (path, body) => SR.api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
SR.apiPut = (path, body) => SR.api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ---------- Toast ---------- */
SR.toast = (msg, type = 'info', ms = 2600) => {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms);
};

/* ---------- DOM / 文本 ---------- */
SR.esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
SR.el = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {   // 显式传 null 也不炸
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
};
SR.copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); SR.toast('已复制到剪贴板 ✂'); }
  catch {
    const ta = SR.el('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); SR.toast('已复制到剪贴板 ✂'); } catch { SR.toast('复制失败', 'error'); }
    ta.remove();
  }
};
SR.fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
SR.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- 极简 Markdown 渲染（先转义，安全优先） ---------- */
SR.md = (src) => {
  let s = SR.esc(src ?? '');
  const blocks = [];
  s = s.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^&gt;\s?(.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/^\s*\d+\.\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>')
    .replace(/^---$/gm, '<hr>');
  s = s.split(/\n{2,}/).map((para) => {
    const t = para.trim();
    if (!t) return '';
    if (/^<(h\d|ul|blockquote|pre|hr)/.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return s;
};

/* ---------- 脚本加载（本地 vendor 优先，CDN 兜底） ---------- */
SR.loadScript = (urls) => new Promise((resolve, reject) => {
  const tryNext = (i) => {
    if (i >= urls.length) return reject(new Error('全部加载失败：' + urls.join(', ')));
    const s = document.createElement('script');
    s.src = urls[i];
    s.onload = () => resolve(urls[i]);
    s.onerror = () => { s.remove(); tryNext(i + 1); };
    document.head.appendChild(s);
  };
  tryNext(0);
});

/* ---------- 状态持久化（刷新不丢） ---------- */
SR.persist = {
  KEY: 'sr_state_v1',
  SKEY: 'sr_sessions_v1',     // 按书分桶的对话页：{ 书路径或__free__: session }
  MAX_BOOKS: 8,               // 最多保留几本书的对话页（LRU，按会话时间）
  _loadMap() { try { return JSON.parse(localStorage.getItem(this.SKEY) || '{}'); } catch { return {}; } },
  _saveMap(map) {
    try {
      const keys = Object.keys(map);
      if (keys.length > this.MAX_BOOKS) {          // 超限：丢最旧的
        keys.sort((a, b) => (map[b].id || 0) - (map[a].id || 0));
        for (const k of keys.slice(this.MAX_BOOKS)) delete map[k];
      }
      localStorage.setItem(this.SKEY, JSON.stringify(map));
    } catch (e) { console.warn('对话页保存失败', e); }
  },
  /* 会话属于哪本书：选段/带读/复盘带 file；巩固会话带 bookPath；其余算无书页 */
  bucketOf(session) {
    if (!session || !session.context) return '__free__';
    return session.context.file || session.context.bookPath || '__free__';
  },
  _slim(s) {
    const ctx = s.context ? { ...s.context } : undefined;
    if (ctx && ctx.text && ctx.text.length > 12000) { ctx.text = ''; ctx.textDropped = true; }
    return { id: s.id, mode: s.mode, title: s.title, context: ctx, system: s.system, messages: s.messages.slice(-100) };
  },
  /* 把当前会话收进它所属书的对话页 */
  stashSession() {
    const s = SR.state.session;
    if (!s || !s.messages || !s.messages.length) return;
    const map = this._loadMap();
    map[this.bucketOf(s)] = this._slim(s);
    this._saveMap(map);
  },
  getSession(docPath) { return this._loadMap()[docPath] || null; },
  dropSession(docPath) {
    if (!docPath) return;
    const map = this._loadMap();
    delete map[docPath];
    this._saveMap(map);
  },
  save() {
    try {
      this.stashSession();                           // 同步按书分桶的对话页
      const s = SR.state.session;
      let session = null;
      if (s && s.messages && s.messages.length) session = this._slim(s);
      localStorage.setItem(this.KEY, JSON.stringify({
        t: Date.now(),
        session,
        docPath: (SR.state.doc && SR.state.doc.path) || null,
        mode: SR.state.mode,
        readalong: (typeof SR !== 'undefined' && SR.reader && SR.reader.readalong) ? { ...SR.reader.readalong } : null,
      }));
    } catch (e) { console.warn('状态保存失败', e); }
  },
  load() {
    try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); } catch { return null; }
  },
  clearSession() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return;
      const st = JSON.parse(raw);
      st.session = null;
      localStorage.setItem(this.KEY, JSON.stringify(st));
    } catch { /* ignore */ }
  },
};

/* ---------- LLM 流式对话 ---------- */
SR.chatStream = async (messages, { onDelta, onDone, onError, signal } = {}) => {
  let acc = '';
  try {
    const res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: true }),
      signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let j = null;
          try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (j.error) throw new Error(j.error);
          if (j.delta) { acc += j.delta; onDelta && onDelta(j.delta, acc); }
        }
      }
    }
    onDone && onDone(acc);
    return acc;
  } catch (e) {
    if (e.name === 'AbortError') { onDone && onDone(acc); return acc; }
    onError && onError(e);
    throw e;
  }
};
