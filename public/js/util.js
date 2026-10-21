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

/* 长任务进度 toast：返回控制器 {set(pct, msg), note, done, fail, close}；同 key 复用一条 */
SR.progress = (key, title) => {
  const box = document.getElementById('toasts');
  if (!box) return { set(){}, note(){}, done(){}, fail(){}, close(){} };
  const old = box.querySelector(`.toast[data-key="${key}"]`);
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast info prog';
  el.dataset.key = key;
  el.innerHTML = '<div class="pg-title"></div><div class="pg-bar"><div class="pg-fill"></div></div><div class="pg-note"></div>';
  const t = el.querySelector('.pg-title'), f = el.querySelector('.pg-fill'), n = el.querySelector('.pg-note');
  t.textContent = title || '';
  box.appendChild(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 350); };
  return {
    set(pct, msg) { f.style.width = Math.max(0, Math.min(100, pct)) + '%'; if (msg !== undefined) n.textContent = msg; },
    note(msg) { n.textContent = msg; },
    done(msg, ms = 2600) { f.style.width = '100%'; el.classList.remove('info'); el.classList.add('success'); if (msg) n.textContent = msg; setTimeout(close, ms); },
    fail(msg, ms = 5000) { el.classList.remove('info'); el.classList.add('error'); if (msg) n.textContent = msg; setTimeout(close, ms); },
    close,
  };
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

/* ---------- 浮动卡拖拽（通用）：handle 按住拖动 el ----------
   3px 阈值内算点击（✕ 等按钮不受影响）；交互控件不触发拖拽；
   拖动时置顶、夹在视口内；right/bottom 定位的卡拖过自动换算 left/top。 */
SR.draggable = (el, handle) => {
  if (!el || !handle) return;
  let startX = 0, startY = 0, baseL = 0, baseT = 0, moved = false, dragging = false, savedZ = '';
  const interactive = (t) => t && t.closest && t.closest('button, input, textarea, select, a, [contenteditable]');
  const onDown = (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;          // 只认主键
    if (interactive(ev.target)) return;
    const r = el.getBoundingClientRect();
    startX = ev.clientX; startY = ev.clientY;
    baseL = r.left; baseT = r.top;
    moved = false; dragging = true;
    const onMove = (e2) => {
      if (!dragging) return;
      const dx = e2.clientX - startX, dy = e2.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 3) return;                  // 点击容差
      if (!moved) {
        moved = true;
        el.style.right = 'auto'; el.style.bottom = 'auto';
        savedZ = el.style.zIndex || '';
        el.style.zIndex = 1000;
        el.classList.add('dragging');
      }
      const w = r.width, h = r.height;
      el.style.left = Math.max(8 - w * 0.7, Math.min(window.innerWidth - w * 0.3, baseL + dx)) + 'px';
      el.style.top = Math.max(4, Math.min(window.innerHeight - 34, baseT + dy)) + 'px';
      e2.preventDefault();
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) { el.style.zIndex = savedZ; el.classList.remove('dragging'); }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
  handle.addEventListener('pointerdown', onDown);
};

/* ---------- 极简 Markdown 渲染（先转义，安全优先；KaTeX 公式） ---------- */
SR.tex = (tex, display) => {
  try {
    return window.katex.renderToString(tex, { displayMode: !!display, throwOnError: false, strict: false });
  } catch { return SR.esc(tex); }
};
SR.md = (src) => {
  let s = String(src ?? '');
  /* 公式先行提取（在转义与 Markdown 变换之前，防止 _ * \ 被吃）：
     支持 $$…$$、\[...\]（display）与 $…$、\(...\)（inline） */
  const maths = [];
  const stash = (tex, display) => { maths.push(SR.tex(tex, display)); return `\u0000M${maths.length - 1}\u0000`; };
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(t, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(t, false))
    .replace(/\$([^\s$][^$\n]*?[^\s$])\$/g, (_, t) => stash(t, false))
    .replace(/\$([^\s$])\$/g, (_, t) => stash(t, false));
  s = SR.esc(s);
  const blocks = [];
  s = s.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^\s*&gt;\s?(.*)$/gm, '<bq>$1</bq>')
    .replace(/^\s*[-*+]\s+(.+)$/gm, '<li data-k="u">$1</li>')
    .replace(/^\s*\d+[.)]\s+(.+)$/gm, '<li data-k="o">$1</li>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="wikilink">[[$1]]</span>')
    .replace(/^---$/gm, '<hr>');
  /* 列表/引用成组：连续 <li data-k="u|o"> 归并成一个 <ul>/<ol>；连续 <bq> 归并成一个 <blockquote> */
  {
    const lines = s.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const liM = lines[i].match(/^<li data-k="([uo])">([\s\S]*?)<\/li>$/);
      if (liM) {
        const kind = liM[1];
        const buf = [];
        while (i < lines.length) {
          const m = lines[i].match(/^<li data-k="([uo])">([\s\S]*?)<\/li>$/);
          if (!m || m[1] !== kind) break;
          buf.push(`<li>${m[2]}</li>`);
          i++;
        }
        out.push(kind === 'o' ? `<ol>${buf.join('')}</ol>` : `<ul>${buf.join('')}</ul>`);
        continue;
      }
      const bqM = lines[i].match(/^<bq>([\s\S]*?)<\/bq>$/);
      if (bqM) {
        const buf = [];
        while (i < lines.length) {
          const m = lines[i].match(/^<bq>([\s\S]*?)<\/bq>$/);
          if (!m) break;
          buf.push(m[1]);
          i++;
        }
        out.push(`<blockquote>${buf.join('<br>')}</blockquote>`);
        continue;
      }
      out.push(lines[i]);
      i++;
    }
    s = out.join('\n');
  }
  /* 表格：行级 GFM 解析（在行内格式已展开之后、段落切分之前）。
     支持有无首尾竖线、:--: 对齐、单元格内 \| 转义；表格整体替换成占位符，避免被 <p> 包住。 */
  const tables = [];
  {
    const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(l);
    const splitCells = (l) => {
      let t = String(l).trim();
      if (t.startsWith('|')) t = t.slice(1);
      if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
      return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    };
    const cellAlign = (c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : '');
    const lines = s.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (i + 1 < lines.length && lines[i].includes('|') && isSep(lines[i + 1])) {
        const head = splitCells(lines[i]);
        const aligns = splitCells(lines[i + 1]).map(cellAlign);
        const body = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].includes('|')) { body.push(splitCells(lines[j])); j++; }
        const th = head.map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${c}</th>`).join('');
        const tb = body.map((r) => `<tr>${r.map((c, k) => `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${c}</td>`).join('')}</tr>`).join('');
        tables.push(`<div class="md-table"><table><thead><tr>${th}</tr></thead>${tb ? `<tbody>${tb}</tbody>` : ''}</table></div>`);
        out.push(`\u0000T${tables.length - 1}\u0000`);
        i = j - 1;
      } else out.push(lines[i]);
    }
    s = out.join('\n');
  }
  s = s.split(/\n{2,}/).map((para) => {
    const t = para.trim();
    if (!t) return '';
    if (/^<(h\d|ul|blockquote|pre|hr)/.test(t)) return t;
    if (/^\u0000M\d+\u0000$/.test(t)) return t;   // 独立成段的公式：不加 <p>（display 层级合法）
    if (/^\u0000T\d+\u0000$/.test(t)) return t;   // 表格整体：不加 <p>
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  s = s.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  s = s.replace(/\u0000T(\d+)\u0000/g, (_, i) => tables[Number(i)]);
  s = s.replace(/\u0000M(\d+)\u0000/g, (_, i) => maths[Number(i)]);
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
SR.chatStream = async (messages, { onDelta, onDone, onError, signal, translate } = {}) => {
  let acc = '';
  try {
    const res = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: true, translate: !!translate }),
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
          else if (j.think) onDelta && onDelta(null, acc, true);   // 推理心跳：无正文增量，提示层显示"思考中"
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
