/* 启动 / 书库 / 模式切换 / 事件接线 */
'use strict';

SR.setMode = function (m) {
  if (m === 'reader' && !SR.state.doc) { SR.toast('先从书库打开一个 PDF'); m = 'library'; }
  SR.state.mode = m;
  document.body.classList.remove('mode-library', 'mode-reader', 'mode-explore');
  document.body.classList.add('mode-' + m);
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  const show = (id, on) => document.getElementById(id).classList.toggle('hidden', !on);
  show('viewLibrary', m === 'library' && !SR.state.mdPath);
  show('viewMd', !!SR.state.mdPath && m === 'library');
  show('viewReader', m === 'reader');
  show('viewExplore', m === 'explore');
  show('viewReview', m === 'review');
  if (m === 'review' && typeof SR.renderReviewPool === 'function') SR.renderReviewPool();
  if (SR.persist) SR.persist.save();
};

/* ---------- 巩固题池（聚合所有书的待巩固点 + 已学部分） ---------- */
SR.renderReviewPool = async function () {
  const box = document.getElementById('reviewPool');
  if (!box) return;
  box.innerHTML = '<p class="muted">加载中…</p>';
  let data;
  try {
    data = await SR.api('/api/review/pool');
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(SR.el('p', { class: 'muted' }, '题池加载失败：' + e.message));
    return;
  }
  const books = data.books || [];
  if (!books.length) {
    box.innerHTML = '';
    box.appendChild(SR.el('div', { class: 'review-empty' }, '暂无可复习的内容。'));
    box.appendChild(SR.el('p', { class: 'muted' }, '先在「带你看书」里拆书并带读一个部分，或完成一次复盘并保存总结——学过的部分和暴露的薄弱点都会进入这里。'));
    return;
  }
  box.innerHTML = '';
  const totalWeak = books.reduce((n, b) => n + b.weakPoints.length, 0);
  const totalOpen = books.reduce((n, b) => n + (b.openParts || []).length, 0);
  const totalParts = books.reduce((n, b) => n + b.doneParts.length, 0);
  box.appendChild(SR.el('p', { class: 'review-stat' }, `📚 ${books.length} 本书 · 📌 ${totalWeak} 个待巩固点 · ⏳ ${totalOpen} 个待复盘 · ✅ ${totalParts} 个已掌握`));
  for (const b of books) {
    const card = SR.el('div', { class: 'review-card' });
    card.appendChild(SR.el('h3', {}, `《${SR.esc(b.title)}》`));
    if (b.weakPoints.length) {
      const sec = SR.el('div', { class: 'review-sec' });
      sec.appendChild(SR.el('div', { class: 'review-sec-title' }, `📌 待巩固点（${b.weakPoints.length}）— 学习时暴露的薄弱处`));
      const list = SR.el('div', { class: 'review-list' });
      for (const w of b.weakPoints) {
        list.appendChild(SR.el('button', {
          class: 'review-item weak',
          title: w.src || '',
          onclick: () => SR.chat.startWeakReview(b, w),
        }, `📌 ${SR.esc(w.text)}`));
      }
      sec.appendChild(list);
      card.appendChild(sec);
    }
    if ((b.openParts || []).length) {
      const sec = SR.el('div', { class: 'review-sec' });
      sec.appendChild(SR.el('div', { class: 'review-sec-title' }, `⏳ 待复盘（${b.openParts.length}）— 已学但还未检验，点开始检索式追问`));
      const list = SR.el('div', { class: 'review-list' });
      for (const pt of b.openParts) {
        list.appendChild(SR.el('button', {
          class: 'review-item open',
          title: `p.${pt.from}–${pt.to}`,
          onclick: () => SR.chat.startPartReReview(b, pt),
        }, `⏳ ${SR.esc(pt.title)}（p.${pt.from}–${pt.to}）`));
      }
      sec.appendChild(list);
      card.appendChild(sec);
    }
    if (b.doneParts.length) {
      const sec = SR.el('div', { class: 'review-sec' });
      sec.appendChild(SR.el('div', { class: 'review-sec-title' }, `✅ 已掌握（${b.doneParts.length}）— 随时再追问一轮`));
      const list = SR.el('div', { class: 'review-list' });
      for (const pt of b.doneParts) {
        list.appendChild(SR.el('button', {
          class: 'review-item part',
          title: `p.${pt.from}–${pt.to}`,
          onclick: () => SR.chat.startPartReReview(b, pt),
        }, `📖 ${SR.esc(pt.title)}（p.${pt.from}–${pt.to}）`));
      }
      sec.appendChild(list);
      card.appendChild(sec);
    }
    box.appendChild(card);
  }
};

/* ---------- 书库 ---------- */
SR.library = {
  path: null,

  refresh() { this.path = null; this.render(); },

  async render() {
    await Promise.all([this.renderInto(document.getElementById('panelFiles'), false), this.renderCenter()]);
  },

  async renderCenter() {
    const box = document.getElementById('viewLibrary');
    box.innerHTML = '';
    // 最近阅读
    const rec = SR.el('div', { style: 'padding:14px 16px 0' });
    try {
      const r = await SR.api('/api/fs/recent');
      if (r.items.length) {
        rec.appendChild(SR.el('div', { class: 'section-title' }, '🕘 最近阅读'));
        const wrap = SR.el('div', { style: 'display:flex;flex-wrap:wrap;gap:10px;padding:0 16px' });
        for (const it of r.items.slice(0, 6)) {
          wrap.appendChild(SR.el('div', {
            class: 'recent-item', style: 'flex:1 1 240px;margin:0',
            title: it.path,
            onclick: () => SR.reader.open(it.path),
          },
            SR.el('div', { class: 't' }, '📕 ' + it.title),
            SR.el('div', { class: 'm' }, `读到 p.${it.lastPage || 1} / ${it.pages || '?'} · ${SR.fmtTime(it.at)}`),
          ));
        }
        rec.appendChild(wrap);
      }
    } catch { /* ignore */ }
    box.appendChild(rec);
    const brow = SR.el('div', { style: 'flex:1;overflow:auto;padding-bottom:20px' });
    box.appendChild(brow);
    await this.renderInto(brow, true);
  },

  async renderInto(container, big) {
    const q = this.path ? '?path=' + encodeURIComponent(this.path) : '';
    let data;
    try { data = await SR.api('/api/fs/list' + q); }
    catch (e) { container.appendChild(SR.el('div', { class: 'hint pad' }, '加载失败：' + e.message)); return; }
    if (!this.path && data.path) this.path = data.path;
    container.innerHTML = '';
    // 路径栏
    const bar = SR.el('div', { class: 'path-bar' });
    for (const r of data.roots || []) {
      bar.appendChild(SR.el('button', {
        class: 'ghost small', title: r,
        onclick: () => { SR.library.path = r; SR.library.render(); },
      }, '🏠 ' + r.split(/[\\/]/).filter(Boolean).pop()));
    }
    if (data.parent !== null && data.parent !== undefined) {
      bar.appendChild(SR.el('button', { class: 'ghost small', onclick: () => { SR.library.path = data.parent; SR.library.render(); } }, '⬆ 上级'));
    }
    bar.appendChild(SR.el('span', { class: 'crumb', title: data.path }, data.path));
    container.appendChild(bar);
    // 列表
    const list = SR.el('div', { class: 'file-list' });
    if (!data.entries.length) list.appendChild(SR.el('div', { class: 'hint pad' }, '（空目录）'));
    for (const e of data.entries) {
      const icon = e.dir ? '📁' : e.ext === '.pdf' ? '📕' : e.ext === '.md' ? '📝' : e.ext === '.txt' ? '📄' : e.ext === '.json' ? '🧾' : '📎';
      const size = e.dir ? '' : (e.size > 1048576 ? (e.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(e.size / 1024)) + ' KB');
      list.appendChild(SR.el('div', {
        class: 'file-row' + (e.dir ? ' dir' : ''),
        onclick: () => {
          if (e.dir) { SR.library.path = e.path; SR.library.render(); }
          else if (e.ext === '.pdf') SR.reader.open(e.path);
          else if (e.ext === '.md' || e.ext === '.txt' || e.ext === '.json') SR.showMd(e.path, e.name);
        },
      },
        SR.el('span', { class: 'icon' }, icon),
        SR.el('span', { class: 'name' }, e.name),
        SR.el('span', { class: 'meta' }, size),
      ));
    }
    container.appendChild(list);
    if (big && !data.entries.length && !data.roots.length) {
      container.appendChild(SR.el('div', { class: 'hint pad' }, '到 ⚙ 设置 → 文件库根目录 添加你的文献文件夹'));
    }
  },
};

/* ---------- Markdown 预览 ---------- */
SR.showMd = async function (path, name) {
  SR.state.mdPath = path;
  document.getElementById('mdTitle').textContent = path;
  try {
    const res = await fetch('/api/fs/file?path=' + encodeURIComponent(path));
    const text = await res.text();
    document.getElementById('mdContent').innerHTML = SR.md(text);
  } catch (e) {
    document.getElementById('mdContent').innerHTML = '<p class="muted">读取失败：' + SR.esc(e.message) + '</p>';
  }
  SR.setMode('library');
};

/* ---------- Zotero 文献库 ---------- */
SR.zotero = {
  async render() {
    const panel = document.getElementById('panelZotero');
    panel.innerHTML = '';
    let st = null, items = null;
    try { st = await SR.api('/api/zotero/status'); } catch (e) {
      panel.appendChild(SR.el('div', { class: 'hint pad' }, '检测失败：' + e.message)); return;
    }
    if (!st.found) {
      panel.appendChild(SR.el('div', { class: 'hint pad' },
        `未找到 Zotero 数据目录。${st.candidates && st.candidates.length ? '探测过：' + st.candidates.join('、') : ''}。请到 ⚙ 设置 → Zotero 数据目录 手动填写（Windows 形如 C:\\Users\\你\\Zotero）。`));
      return;
    }
    const head = SR.el('div', { class: 'path-bar' },
      SR.el('span', { class: 'crumb', title: st.dataDir }, '🦊 ' + st.dataDir));
    panel.appendChild(head);
    panel.appendChild(SR.el('div', { class: 'section-title' }, 'Zotero PDF 附件'));
    try { items = await SR.api('/api/zotero/items'); } catch (e) {
      panel.appendChild(SR.el('div', { class: 'hint pad' }, '读取失败：' + e.message)); return;
    }
    if (!items.items.length) {
      panel.appendChild(SR.el('div', { class: 'hint pad' }, 'storage/ 里没有找到 PDF 附件。'));
      return;
    }
    const search = SR.el('input', {
      type: 'text', placeholder: `搜索 ${items.count} 篇文献…`,
      style: 'width:calc(100% - 20px);margin:6px 10px;padding:6px 10px;background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12.5px',
    });
    panel.appendChild(search);
    const list = SR.el('div', { class: 'file-list' });
    const draw = (filter) => {
      list.innerHTML = '';
      for (const it of items.items) {
        if (filter && !(it.title + it.file).toLowerCase().includes(filter.toLowerCase())) continue;
        list.appendChild(SR.el('div', {
          class: 'file-row', title: it.path,
          onclick: () => SR.reader.open(it.path),
        },
          SR.el('span', { class: 'icon' }, '📕'),
          SR.el('span', { class: 'name' }, it.title),
          SR.el('span', { class: 'meta' }, (it.size / 1048576).toFixed(1) + 'MB'),
        ));
      }
      if (!list.children.length) list.appendChild(SR.el('div', { class: 'hint pad' }, '（无匹配）'));
    };
    search.addEventListener('input', SR.debounce(() => draw(search.value), 200));
    draw('');
    panel.appendChild(list);
    if (items.sqliteMeta) {
      const m = String(items.sqliteMeta);
      const tip = m === 'no-sqlite'
        ? '⚠ 未读到条目标题（当前 Node 无 node:sqlite 模块，需要 Node ≥ 22.5）。重启服务时用新版 Node 即可读取 Zotero 条目标题。'
        : '⚠ 未读到条目标题（' + SR.esc(m) + '），当前用文件名代替。多为 Zotero 正在运行占用数据库，关闭 Zotero 后刷新即可。';
      panel.appendChild(SR.el('div', { class: 'hint pad' }, tip));
    }
  },
};

/* ---------- 启动 ---------- */
(async function init() {
  SR.VERSION = 'v42-热忱学伴';
  console.log('%c[SR] 苏格拉底阅读器 ' + SR.VERSION, 'color:#e3b34c;font-weight:bold');
  /* PDF.js：本地 vendor 优先，CDN 兜底 */
  try {
    if (!window.pdfjsLib) {
      const ok = await SR.loadScript([
        'vendor/pdf.min.js',
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
        'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
      ]);
      SR.pdfjsLocal = String(ok).includes('vendor');
    } else SR.pdfjsLocal = true;
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = SR.pdfjsLocal
        ? 'vendor/pdf.worker.min.js'
        : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
  } catch (e) {
    console.warn('PDF.js 加载失败', e);
  }

  /* 配置 & 提示词 */
  try {
    SR.state.config = await SR.api('/api/config');
    SR.state.prompts = await SR.api('/api/prompts');
  } catch (e) {
    SR.toast('服务异常：' + e.message, 'error', 5000);
  }
  const st = await SR.api('/api/status').catch(() => null);
  if (st && !st.vault.exists) {
    SR.toast('⚠️ 未找到 Obsidian vault（' + st.vault.configured + '），卡片/总结将无法写入，请到 ⚙ 设置修改', 'error', 6000);
  }

  await SR.cards.load();
  SR.cards.init();
  SR.settings.init();

  /* 主题切换（亮=暖纸色 / 暗=神庙深色），选择记住 */
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('sr_theme', t); } catch { /* ignore */ }
    const b = document.getElementById('btnTheme');
    b.textContent = t === 'light' ? '🌙' : '☀️';
    b.title = t === 'light' ? '切换到暗色模式' : '切换到亮色模式';
  };
  document.getElementById('btnTheme').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

  /* 顶栏 */
  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => SR.setMode(b.dataset.mode)));
  document.getElementById('btnSettings').addEventListener('click', () => SR.settings.open());
  document.getElementById('btnCards').addEventListener('click', () => SR.cards.togglePanel()); // 制卡功能已下线：按钮隐藏，逻辑保留（学习记录在 Obsidian 仓库制卡）
  document.getElementById('btnAiToggle').addEventListener('click', () => {
    document.body.classList.toggle('ai-hidden');
  });

  /* 侧栏 tabs */
  document.querySelectorAll('.side-tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.side-tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const id of ['panelFiles', 'panelZotero', 'panelToc', 'panelMap', 'panelAnnots']) {
      document.getElementById(id).classList.toggle('hidden', id !== 'panel' + t.dataset.tab[0].toUpperCase() + t.dataset.tab.slice(1));
    }
    if (t.dataset.tab === 'zotero') SR.zotero.render();
    if (t.dataset.tab === 'map') SR.reader.renderBookmap();
  }));

  /* 书库 */
  await SR.library.render();

  /* ---- 恢复上次会话（刷新不丢） ---- */
  const saved = SR.persist.load();
  let restored = false;
  if (saved && saved.docPath) {
    try {
      await SR.reader.open(saved.docPath);
      restored = true;
    } catch (e) { /* 文件可能被移动，忽略 */ }
  }
  const chatRestored = await SR.chat.restoreSession(saved && saved.session);
  if (restored) SR.reader.restoreReadalong(saved.readalong);
  SR.setMode(restored ? 'reader' : (saved && saved.mode === 'explore' ? 'explore' : 'library'));
  if (restored || chatRestored) SR.toast('已恢复上次的阅读与会话 🗂');
  window.addEventListener('beforeunload', () => SR.persist.save());
  setInterval(() => SR.persist.save(), 30000);

  /* 阅读器工具栏 */
  document.getElementById('btnPartReview').addEventListener('click', () => SR.chat.startGuidedReading());
  document.getElementById('btnWitRead').addEventListener('click', () => SR.chat.startWitReading());   // WIT 科研审读
  /* 带读位置徽章：点击跳转并块高亮 PDF 对应位置 */
  document.getElementById('chatMsgs').addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('.page-badge');
    if (!b) return;
    if (SR.state.doc && SR.reader) SR.reader.focusPages(b.dataset.from, b.dataset.to, b.dataset.quote || '', b.dataset.q2 || '');
    else SR.toast('当前没有打开的 PDF');
  });
  document.getElementById('btnReadalong').addEventListener('click', () => SR.reader.toggleReadalong());
  document.getElementById('btnBoxAsk').addEventListener('click', () => SR.reader.toggleBoxSelect());   // 圈图提问
  document.getElementById('btnBookmap').addEventListener('click', () => SR.reader.generateBookmap());
  /* 复盘提醒条 */
  document.getElementById('bannerReview').addEventListener('click', async () => {
    const b = document.getElementById('reviewBanner');
    b.classList.add('hidden');
    if (b.dataset.advance === '1') { delete b.dataset.advance; await SR.reader.advanceGoal(); return; }
    const d = SR.state.doc;
    const part = SR.reader.readalong.goal || (d && SR.reader.currentPart());
    SR.chat.startPartReview(part);
  });
  document.getElementById('bannerLater').addEventListener('click', () => SR.reader.hideBanner());
  document.getElementById('bannerNext').addEventListener('click', async () => {
    SR.reader.hideBanner();
    await SR.reader.advanceGoal();
  });
  document.getElementById('btnPrev').addEventListener('click', () => SR.reader.scrollToPage(Math.max(1, SR.reader.currentPage() - 1)));
  document.getElementById('btnNext').addEventListener('click', () => SR.reader.scrollToPage(Math.min(SR.state.doc.pages, SR.reader.currentPage() + 1)));
  document.getElementById('btnZoomIn').addEventListener('click', () => SR.reader.setZoom(1.2));
  document.getElementById('btnZoomOut').addEventListener('click', () => SR.reader.setZoom(1 / 1.2));
  document.getElementById('btnZoomFit').addEventListener('click', () => SR.reader.setZoom(1, true));
  document.getElementById('mdBack').addEventListener('click', () => { SR.state.mdPath = null; SR.setMode('library'); });

  /* 选区工具条（选区计算由 reader 的自研选区引擎完成，不再依赖原生 mouseup 选区） */
  document.querySelectorAll('#selToolbar button').forEach((b) => b.addEventListener('click', () => SR.reader.selAction(b.dataset.act)));
  document.addEventListener('mousedown', (ev) => {
    if (!ev.target.closest('#selToolbar') && !ev.target.closest('#colorPalette') && !ev.target.closest('#annToolbar')) SR.reader.hidePop();
  });

  /* 页码跳转 & 键盘翻页 */
  const pageJump = document.getElementById('pageJump');
  pageJump.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const d = SR.state.doc;
    if (!d) return;
    const n = Math.max(1, Math.min(d.pages, Number(pageJump.value) || 1));
    SR.reader.scrollToPage(n);
    pageJump.blur();
  });
  pageJump.addEventListener('blur', () => {
    if (SR.state.doc) SR.reader.setPageIndicator(SR.state.doc.readPos || 1);
  });
  document.addEventListener('keydown', (ev) => {
    if (SR.state.mode !== 'reader' || !SR.state.doc) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown') { ev.preventDefault(); SR.reader.scrollToPage(Math.min(SR.state.doc.pages, SR.reader.currentPage() + 1)); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); SR.reader.scrollToPage(Math.max(1, SR.reader.currentPage() - 1)); }
    else if (ev.key === 'F9') {
      ev.preventDefault();
      const on = document.body.classList.toggle('debug-hl');
      if (on) {
        const pg = document.querySelector('.page[data-page="' + (SR.state.doc ? SR.reader.currentPage() : 1) + '"]');
        const sf = pg ? getComputedStyle(pg).getPropertyValue('--scale-factor').trim() : '?';
        const nsp = pg ? pg.querySelectorAll('.textLayer span').length : 0;
        SR.toast(`🐞 ${SR.VERSION}｜绿=页面框 蓝=文本span 红=高亮矩形｜--scale-factor=${sf}｜本页 span=${nsp}｜再按 F9 关闭`, 'info', 7000);
      }
    }
    else if (ev.key === 'Escape') { SR.reader.hidePop(); const s = window.getSelection(); s && s.removeAllRanges(); }
  });

  /* AI 面板 */
  const chatInput = document.getElementById('chatInput');
  document.getElementById('btnSend').addEventListener('click', () => SR.chat.send(chatInput.value));
  chatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); SR.chat.send(chatInput.value); }
  });
  document.getElementById('btnStop').addEventListener('click', () => {
    if (SR.chat.abort) { try { SR.chat.abort.abort(); } catch {} }
  });
  document.getElementById('btnChatClear').addEventListener('click', () => SR.chat.clear());
  document.getElementById('btnExportChat').addEventListener('click', () => SR.chat.exportChat());   // 对话导出为 md（存 vault）
  /* 闭卷复盘的偷看开关：掀开↔收起，纯视图切换（遮罩由会话开合控制） */
  document.getElementById('btnPeek').addEventListener('click', () => {
    const masked = document.body.classList.toggle('pdf-masked');
    const b = document.getElementById('btnPeek');
    b.textContent = masked ? '👁 偷看原文' : '🙈 收起原文';
    b.title = masked ? '暂时掀开 PDF 核对（复盘应先凭记忆作答）' : '收起 PDF，回到闭卷复盘';
  });

  /* 自由探索 */
  document.getElementById('btnExploreStart').addEventListener('click', () => SR.chat.startExplore());
  document.getElementById('exploreTopic').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') SR.chat.startExplore();
  });

  /* 总结对话框 */
  document.getElementById('sumClose').addEventListener('click', () => {
    if (SR.chat.abort) { try { SR.chat.abort.abort(); } catch {} SR.chat.abort = null; }
    document.getElementById('dlgSummary').close();
  });
  document.getElementById('sumSave').addEventListener('click', () => SR.chat.saveSummary());
  document.getElementById('sumRegen').addEventListener('click', () => {
    SR.chat.summarize(SR.chat._sumMeta && SR.chat._sumMeta.kind === 'part' ? 'part' : 'explore');
  });

  /* 确认对话框 Esc 兜底 */
  const cdlg = document.getElementById('dlgConfirm');
  cdlg.addEventListener('close', () => { /* promise 兜底见 chat.confirm */ });

  /* 窗口缩放 → 重排阅读器 */
  window.addEventListener('resize', SR.debounce(() => {
    if (SR.state.mode === 'reader' && SR.state.doc) SR.reader.buildView();
  }, 300));

  if (!restored) SR.setMode('library'); // 有恢复时上面已设置，避免覆盖
})();
