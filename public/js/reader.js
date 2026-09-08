/* PDF 阅读器：渲染 / 文本层 / 高亮批注 / 选区工具条 / 部分划分 */
'use strict';

SR.reader = {
  io: null,
  HL_COLORS: ['#ffd54f', '#a5d6a7', '#90caf9', '#ef9a9a', '#ce93d8'],
  lastColor: '#ffd54f',
  _sel: null, // 当前选区 { page, text, rects, x, y }

  get doc() { return SR.state.doc; },
  get scroll() { return document.getElementById('pdfScroll'); },

  /* ===== 打开文档 ===== */
  async open(absPath) {
    if (!window.pdfjsLib) {
      SR.toast('PDF.js 未加载成功：请检查网络，或运行 node tools/get-vendor.js 后刷新', 'error', 5000);
      return;
    }
    SR.toast('正在打开…');
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({
        url: '/api/fs/file?path=' + encodeURIComponent(absPath),
        cMapUrl: (SR.pdfjsLocal ? 'vendor/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/'),
        cMapPacked: true,
      }).promise;
    } catch (e) {
      SR.toast('打开 PDF 失败：' + (e.message || e), 'error', 5000);
      return;
    }
    const saved = await SR.api('/api/annotations?path=' + encodeURIComponent(absPath)).catch(() => ({ annotations: [], readPos: 1 }));
    /* 换书 = 换对话页：旧书的对话先收好，新书的对话恢复出来 */
    const prevDoc = SR.state.doc;
    if (prevDoc && prevDoc.path !== absPath && SR.chat && SR.chat.swapSession) {
      try { await SR.chat.swapSession(absPath); } catch (e) { console.warn('[SR] 对话页切换失败（不影响打开）', e); }
    }
    SR.state.doc = {
      path: absPath,
      title: absPath.split(/[\\/]/).pop().replace(/\.pdf$/i, ''),
      pdf, pages: pdf.numPages,
      ann: (saved && saved.annotations) || [],
      readPos: (saved && saved.readPos) || 1,
      partsDone: (saved && saved.partsDone) || {},
      weakPoints: (saved && Array.isArray(saved.weakPoints)) ? saved.weakPoints : [],
      zoom: 1, baseScale: 1, outline: [], parts: [], renderSeq: 0,
    };
    document.getElementById('docTitle').textContent = `${SR.state.doc.title} · ${pdf.numPages} 页`;
    SR.setMode('reader');
    // 重置陪读状态（跨文档不复用）
    this.readalong.on = false;
    this.readalong.goal = null;
    this.readalong.bannerShownFor = null;
    this.hideBanner();
    const raBtn = document.getElementById('btnReadalong');
    raBtn.textContent = '🚶 陪读:关';
    raBtn.classList.remove('active-btn');
    document.getElementById('raProgressWrap').classList.add('hidden');
    this.buildView();
    this.bindSelectionEngine(); // 自研选区引擎：彻底摆脱原生选区的间隙跳变
    this.bindBoxSelectEngine(); // 圈图提问：拖矩形截屏问视觉模型
    /* 各阶段隔离：任何一步失败不再炸断整个 open（v4 的教训：
       renderAnnotsList 抛错把 open/init 全部带崩，选区引擎跟着陪葬） */
    const safe = (label, fn) => { try { fn(); } catch (e) { console.warn('[SR] ' + label + ' 失败（不影响其他功能）', e); } };
    await this.buildOutline().catch((e) => console.warn('[SR] buildOutline 失败', e));
    await this.buildParts().catch((e) => console.warn('[SR] buildParts 失败', e));
    await this.loadBookmap().catch((e) => console.warn('[SR] loadBookmap 失败', e));
    safe('renderAnnotsList', () => this.renderAnnotsList());
    safe('renderBookmap', () => this.renderBookmap());
    SR.persist.save();
    setTimeout(() => this.scrollToPage(Math.min(SR.state.doc.readPos || 1, pdf.numPages), 'auto'), 350);
    this.saveAnnDebounced();
  },

  /* ===== 圈图提问：工具栏按钮切换模式，拖矩形 → 截图+周文 → 发给视觉模型 ===== */
  toggleBoxSelect(on) {
    this._boxSel = on === undefined ? !this._boxSel : !!on;
    const btn = document.getElementById('btnBoxAsk');
    if (btn) {
      btn.classList.toggle('active-btn', this._boxSel);
      btn.title = this._boxSel ? '圈图模式开：在 PDF 上拖框圈住图表，松手后提问（再点退出）' : '圈住一块图/公式/表格，向 AI 提问';
    }
    document.body.classList.toggle('box-selecting', this._boxSel);
    if (!this._boxSel && this._boxEl) { this._boxEl.remove(); this._boxEl = null; }
    if (this._boxSel) SR.toast('🔲 圈图模式：在 PDF 上拖一个矩形框住想问的图表/公式', 'info', 3500);
  },

  _boxToPageRect(x0, y0, x1, y1) {
    /* 视口坐标 → { page, rect:{x,y,w,h} 页内坐标 }；找不到页返回 null */
    const pages = [...this.scroll.querySelectorAll('.page')];
    const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
    for (const p of pages) {
      const pr = p.getBoundingClientRect();
      if (r < pr.left || l > pr.right || b < pr.top || t > pr.bottom) continue;
      const pageNo = Number(p.dataset.page);
      return { pageNo, rect: { x: l - pr.left, y: t - pr.top, w: r - l, h: b - t } };
    }
    return null;
  },

  async _snapshotRegion(pageNo, rect) {
    /* 页内矩形 → 裁剪 JPEG base64（周边再放宽 8px 留白）+ 框周正文（上下各 2 行 span 文本） */
    const d = this.doc;
    const pg = await d.pdf.getPage(pageNo);
    const pageEl = this.scroll.querySelector(`.page[data-page="${pageNo}"]`);
    if (!pageEl) return null;
    const pr = pageEl.getBoundingClientRect();
    const vp1 = pg.getViewport({ scale: 1 });
    const cssScale = pr.width / vp1.width;                 // CSS 像素 → PDF 单位
    const pdfRect = { x: rect.x / cssScale, y: rect.y / cssScale, w: rect.w / cssScale, h: rect.h / cssScale };
    const margin = 8 / cssScale;                           // 周边留白（CSS 8px）
    /* 稳妥裁剪：先整页离屏渲染（scale 自适应，区域宽度 ~1400px 基准），
       再 drawImage 裁出目标矩形——避免 render transform 的双缩放坑 */
    const scale = Math.min(2.5, Math.max(1.2, 1400 / (pdfRect.w || 300)));
    const vpFull = pg.getViewport({ scale });
    const full = document.createElement('canvas');
    full.width = Math.floor(vpFull.width);
    full.height = Math.floor(vpFull.height);
    await pg.render({ canvasContext: full.getContext('2d'), viewport: vpFull }).promise;
    const sx = (pdfRect.x - margin) * scale, sy = (pdfRect.y - margin) * scale;
    const sw = (pdfRect.w + margin * 2) * scale, sh = (pdfRect.h + margin * 2) * scale;
    const cw = Math.max(60, Math.min(1600, Math.floor(sw)));
    const ch = Math.max(60, Math.floor(cw * (sh / sw)));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    canvas.getContext('2d').drawImage(full,
      Math.max(0, sx), Math.max(0, sy), Math.min(sw, full.width - Math.max(0, sx)), Math.min(sh, full.height - Math.max(0, sy)),
      0, 0, cw, ch);
    /* 框周正文：页内 span 的几何位置在 rect 上下各取最近 2 行 */
    let around = '';
    try {
      const tl = pageEl.querySelector('.textLayer');
      if (tl) {
        const spans = [...tl.querySelectorAll('span')].filter((s) => (s.textContent || '').trim());
        const rows = [];
        for (const sp of spans) {
          const r = sp.getBoundingClientRect();
          const cy = r.top + r.height / 2 - pr.top;
          rows.push({ cy, text: sp.textContent });
        }
        rows.sort((a, b) => a.cy - b.cy);
        const above = rows.filter((x) => x.cy < rect.y).slice(-2);
        const below = rows.filter((x) => x.cy > rect.y + rect.h).slice(0, 2);
        around = [...above, ...below].map((x) => x.text.trim()).filter(Boolean).join(' ');
      }
    } catch { /* 文字层没渲染也不影响截图 */ }
    return { page: pageNo, b64: canvas.toDataURL('image/jpeg', 0.85), around: around.slice(0, 500) };
  },

  bindBoxSelectEngine() {
    if (this._boxBound) return;
    this._boxBound = true;
    const scroll = this.scroll;
    scroll.addEventListener('mousedown', (ev) => {
      if (!this._boxSel || ev.button !== 0) return;
      if (ev.target.closest && ev.target.closest('.annToolbar, .selToolbar, .readerToolbar')) return;
      ev.preventDefault();
      this._boxStart = [ev.clientX, ev.clientY];
      const box = SR.el('div', { class: 'boxsel-rect' });
      box.style.left = ev.clientX + 'px'; box.style.top = ev.clientY + 'px';
      box.style.width = '0px'; box.style.height = '0px';
      document.body.appendChild(box);
      this._boxEl = box;
    });
    window.addEventListener('mousemove', (ev) => {
      if (!this._boxSel || !this._boxStart || !this._boxEl) return;
      const [x0, y0] = this._boxStart;
      this._boxEl.style.left = Math.min(x0, ev.clientX) + 'px';
      this._boxEl.style.top = Math.min(y0, ev.clientY) + 'px';
      this._boxEl.style.width = Math.abs(ev.clientX - x0) + 'px';
      this._boxEl.style.height = Math.abs(ev.clientY - y0) + 'px';
    });
    window.addEventListener('mouseup', (ev) => {
      if (!this._boxSel || !this._boxStart) return;
      const [x0, y0] = this._boxStart;
      this._boxStart = null;
      const w = Math.abs(ev.clientX - x0), h = Math.abs(ev.clientY - y0);
      if (this._boxEl) { this._boxEl.remove(); this._boxEl = null; }
      if (w < 24 || h < 24) return;                       // 误触小框忽略
      const hit = this._boxToPageRect(x0, y0, ev.clientX, ev.clientY);
      if (!hit) return;
      this.toggleBoxSelect(false);                        // 圈完自动退出模式
      SR.chat.pendingImageAsk(hit.pageNo, hit.rect);
    });
    /* Esc 取消圈图 */
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this._boxSel) this.toggleBoxSelect(false);
    });
  },

  /* ===== 视图构建 ===== */
  async buildView() {
    const d = this.doc, scroll = this.scroll;
    const ratio = scroll.scrollHeight ? scroll.scrollTop / scroll.scrollHeight : 0;
    if (this.io) this.io.disconnect();
    scroll.innerHTML = '';
    d.renderSeq++;

    const p1 = await d.pdf.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    d.baseScale = Math.max(0.1, (scroll.clientWidth - 36) / vp1.width);
    const w = vp1.width * d.baseScale * d.zoom;
    const h = vp1.height * d.baseScale * d.zoom;

    const frag = document.createDocumentFragment();
    for (let i = 1; i <= d.pages; i++) {
      const el = SR.el('div', { class: 'page', 'data-page': i, style: `width:${w}px;height:${h}px` });
      el.appendChild(SR.el('canvas'));
      el.appendChild(SR.el('div', { class: 'textLayer' }));
      el.appendChild(SR.el('div', { class: 'selLayer' }));
      el.appendChild(SR.el('div', { class: 'hlLayer' }));
      frag.appendChild(el);
    }
    scroll.appendChild(frag);
    scroll.scrollTop = ratio * scroll.scrollHeight;
    this.setPageIndicator(d.readPos || 1);

    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) this.renderPage(Number(e.target.dataset.page));
    }, { root: scroll, rootMargin: '600px 0px' });
    scroll.querySelectorAll('.page').forEach((p) => this.io.observe(p));

    scroll.onscroll = SR.debounce(() => {
      const cur = this.currentPage();
      d.readPos = cur;
      this.setPageIndicator(cur);
      this.onReadalongTick(cur);
      this.saveAnnDebounced();
    }, 250);
  },

  async renderPage(i) {
    const d = this.doc;
    const el = this.scroll.querySelector(`.page[data-page="${i}"]`);
    if (!el || el.dataset.rendered === String(d.zoom)) return;
    const seq = d.renderSeq;
    const pg = await d.pdf.getPage(i);
    const scale = d.baseScale * d.zoom;
    const vp = pg.getViewport({ scale });
    if (seq !== d.renderSeq) return;
    el.style.width = vp.width + 'px';
    el.style.height = vp.height + 'px';
    const canvas = el.querySelector('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    await pg.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    if (seq !== d.renderSeq) return;
    // 双 API 兼容：3.x 用 textContentSource，个别构建只认 textContent；都失败会在控制台留痕
    const tl = el.querySelector('.textLayer');
    tl.innerHTML = '';
    // 关键：pdf.js 3.x 的 span font-size 写作 calc(var(--scale-factor)*Npx)，
    // 不设此变量字号会整体回退成继承值（14px）→ span 盒与真实字形错位 → 高亮"漂移"
    el.style.setProperty('--scale-factor', vp.scale);
    tl.style.setProperty('--scale-factor', vp.scale);
    let tc = null;
    try { tc = await pg.getTextContent(); } catch { /* 扫描件无文本 */ }
    if (seq !== d.renderSeq) return;
    if (tc) {
      try {
        await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp }).promise;
      } catch (e1) {
        try { await pdfjsLib.renderTextLayer({ textContent: tc, container: tl, viewport: vp }).promise; }
        catch (e2) { console.warn('[SR] 文本层渲染失败（此页将无法选中文字）', e1, e2); }
      }
    }
    el.dataset.rendered = d.zoom;
    this.renderHls(i);
    // 字体是异步加载的：加载完成后 span 布局可能微调，补一次吸附对齐
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (SR.state.doc === d) this.renderHls(i); }).catch(() => {});
    }
  },

  currentPage() {
    const d = this.doc, scroll = this.scroll;
    const top = scroll.scrollTop + 90;
    let cur = 1;
    scroll.querySelectorAll('.page').forEach((p) => { if (p.offsetTop <= top) cur = Number(p.dataset.page); });
    return cur;
  },

  setPageIndicator(cur) {
    const inp = document.getElementById('pageJump');
    if (inp && document.activeElement !== inp) inp.value = cur;
    const tot = document.getElementById('pageTotal');
    if (tot && this.doc) tot.textContent = this.doc.pages;
  },

  scrollToPage(n, behavior = 'smooth') {
    const el = this.scroll.querySelector(`.page[data-page="${n}"]`);
    if (!el) return;
    this.scroll.scrollTo({ top: el.offsetTop - 10, behavior });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
    this.setPageIndicator(n);
  },

  /* 带读聚焦：AI 标记 @pN[-M]|开头短语[→结尾短语] → 跨页定位整块并高亮；失败降级整页柔光。
     focusMode（设置里选）：off=只滚动不高亮 | flash=高亮片刻后淡出 | keep=常亮到下一块 */
  focusPages(from, to, quote, endQuote) {
    const d = this.doc;
    if (!d || !this.scroll) return;
    const f = Math.max(1, Math.round(Number(from)) || 1);
    const t = Math.min(d.pages, Math.max(f, Math.round(Number(to)) || f));
    this._clearFocus();
    const mode = (SR.state.config && SR.state.config.focusMode) || 'flash';
    this.scrollToPage(f);                       // 先滚动（即时反馈 + 触发目标页渲染）
    if (mode === 'off') { console.log('[SR带读] 聚焦模式=off，仅滚动 p.' + f); return; }
    if (quote) {
      /* 目标页 textLayer 可能还是空的（懒渲染）→ 轮询重试 */
      let tries = 0;
      const attempt = () => {
        tries++;
        const hits = this._locateBlock(f, t, quote, endQuote);
        if (hits) {
          this._drawFocusMarks(hits);
          console.log(`[SR带读] 块命中 ${hits.map((h) => `p.${h.pageNo}(${h.rows.length}行)`).join('+')}（第${tries}次尝试）✓`);
          if (mode === 'flash') this._focusTimer = setTimeout(() => this._clearFocus(), 8000);   // 块高亮 8s
          return;
        }
        if (tries < 5) { this._focusRetry = setTimeout(attempt, 450); }
        else { this._pageGlow(f, t, mode); console.log('[SR带读] 短语未命中，降级整页柔光（quote=' + quote.slice(0, 14) + '…）'); }
      };
      attempt();
    } else {
      this._pageGlow(f, t, mode);
      console.log('[SR带读] 无短语，整页柔光 p.' + f + (t > f ? '-' + t : ''));
    }
  },

  _pageGlow(f, t, mode) {
    let hit = 0;
    for (let p = f; p <= Math.min(t, f + 2); p++) {
      const el = this.scroll.querySelector(`.page[data-page="${p}"]`);
      if (el) { el.classList.add('page-focus'); hit++; }
    }
    if (mode === 'flash') this._focusTimer = setTimeout(() => this._clearFocus(), 5000);   // 整页柔光 5s
    return hit;
  },

  /* 页文本索引：{spans, S(去空白全文), map(字符→span 下标)}；textLayer 未渲染/空 → null */
  _pageTextIndex(pageNo) {
    const pageEl = this.scroll.querySelector(`.page[data-page="${pageNo}"]`);
    if (!pageEl) return null;
    const tl = pageEl.querySelector('.textLayer');
    if (!tl || !tl.children.length) return null;
    const strip = (s) => String(s || '').replace(/\s+/g, '');
    const spans = [...tl.querySelectorAll('span')]
      .filter((sp) => !sp.querySelector('span') && strip(sp.textContent).length);
    if (!spans.length) return null;
    let S = '';
    const map = [];
    spans.forEach((sp, i) => {
      const tx = strip(sp.textContent);
      for (let k = 0; k < tx.length; k++) map[S.length + k] = i;
      S += tx;
    });
    return { spans, S, map };
  },

  /* 跨页定位块：开头短语找起点（按页序），结尾短语在起点之后找终点（可跨页）。
     返回 [{pageNo, rows}]（多页时逐页给行带），未找到起点返回 null。
     探针逐级降长（60→24→12 字符）容忍模型轻微改写/截断。 */
  _locateBlock(f, t, quote, endQuote) {
    const maxP = Math.min(t, f + 2);
    const idxs = [];
    for (let p = f; p <= maxP; p++) {
      const ix = this._pageTextIndex(p);
      if (ix) idxs.push({ pageNo: p, ...ix });
    }
    if (!idxs.length) return null;
    const strip = (s) => String(s || '').replace(/\s+/g, '');
    const probes = (q) => {
      const s = strip(q);
      if (s.length < 4) return [];
      return [...new Set([s.slice(0, 60), s.slice(0, 24), s.slice(0, 12)].filter((x) => x.length >= 4))];
    };
    /* 起点：长探针优先，页序次之 */
    let start = null;
    for (const pr of probes(quote)) {
      for (const pg of idxs) {
        const i = pg.S.indexOf(pr);
        if (i >= 0) { start = { pg, i, len: pr.length }; break; }
      }
      if (start) break;
    }
    if (!start) return null;
    /* 终点：在起点之后（同页更后或后页）找结尾短语 */
    let end = null;
    if (endQuote) {
      outer: for (const pr of probes(endQuote)) {
        for (const pg of idxs) {
          if (pg.pageNo < start.pg.pageNo) continue;
          const from = pg === start.pg ? start.i + start.len : 0;
          const i = pg.S.indexOf(pr, from);
          if (i >= 0) { end = { pg, i, len: pr.length }; break outer; }
        }
      }
    }
    const spanAt = (pg, ci) => (pg.map[ci] !== undefined ? pg.map[ci] : 0);
    if (!end) {
      /* 无终点/终点未命中：起点行 +2 行（同页，保守范围） */
      const pg = start.pg;
      const i0 = spanAt(pg, start.i);
      const rows = this._rowsFromSpans(pg, i0, Math.min(i0 + 2, pg.spans.length - 1));
      console.log('[SR带读] 结尾短语未命中（' + String(endQuote || '').slice(0, 14) + '…），退化为起点+2行');
      return rows.length ? [{ pageNo: pg.pageNo, rows }] : null;
    }
    /* 起终点齐全：起页 [起点..页尾]，中间页整页，终页 [页首..终点] */
    const out = [];
    if (start.pg === end.pg) {
      const eIdx = Math.min(end.i + end.len - 1, end.pg.S.length - 1);
      const rows = this._rowsFromSpans(start.pg, spanAt(start.pg, start.i), spanAt(start.pg, eIdx));
      if (rows.length) out.push({ pageNo: start.pg.pageNo, rows });
    } else {
      const sRows = this._rowsFromSpans(start.pg, spanAt(start.pg, start.i), start.pg.spans.length - 1);
      if (sRows.length) out.push({ pageNo: start.pg.pageNo, rows: sRows });
      for (const pg of idxs) {
        if (pg.pageNo <= start.pg.pageNo || pg.pageNo >= end.pg.pageNo) continue;
        const rows = this._rowsFromSpans(pg, 0, pg.spans.length - 1);
        if (rows.length) out.push({ pageNo: pg.pageNo, rows });
      }
      const eIdx = Math.min(end.i + end.len - 1, end.pg.S.length - 1);
      const eRows = this._rowsFromSpans(end.pg, 0, spanAt(end.pg, eIdx));
      if (eRows.length) out.push({ pageNo: end.pg.pageNo, rows: eRows });
    }
    return out.length ? out : null;
  },

  /* span 区间 [i0,i1] → 按行合并的页内像素矩形带 */
  _rowsFromSpans(pg, i0, i1) {
    const pageEl = this.scroll.querySelector(`.page[data-page="${pg.pageNo}"]`);
    if (!pageEl) return [];
    const pr = pageEl.getBoundingClientRect();
    const rows = [];
    for (let i = Math.max(0, i0); i <= Math.min(i1, pg.spans.length - 1); i++) {
      const r = pg.spans[i].getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const rel = { top: r.top - pr.top, bottom: r.bottom - pr.top, left: r.left - pr.left, right: r.right - pr.left };
      const row = rows.find((w) => Math.abs(w.top - rel.top) < (rel.bottom - rel.top) * 0.7);
      if (row) {
        row.top = Math.min(row.top, rel.top); row.bottom = Math.max(row.bottom, rel.bottom);
        row.left = Math.min(row.left, rel.left); row.right = Math.max(row.right, rel.right);
      } else rows.push(rel);
    }
    return rows.map((w) => ({ x: w.left, y: w.top, w: w.right - w.left, h: w.bottom - w.top }));
  },

  /* 在各命中页画块高亮框，滚动定位到第一页的首个框（块首而非页顶） */
  _drawFocusMarks(hits) {
    for (const hit of hits) {
      const pageEl = this.scroll.querySelector(`.page[data-page="${hit.pageNo}"]`);
      if (!pageEl) continue;
      const layer = SR.el('div', { class: 'focusLayer' });
      for (const r of hit.rows) {
        layer.appendChild(SR.el('div', {
          class: 'focus-mark',
          style: `left:${r.x - 4}px;top:${r.y - 2}px;width:${r.w + 8}px;height:${r.h + 4}px`,
        }));
      }
      pageEl.appendChild(layer);
    }
    const first = hits[0];
    const firstPage = this.scroll.querySelector(`.page[data-page="${first.pageNo}"]`);
    if (firstPage) {
      const target = firstPage.offsetTop + first.rows[0].y - 120;
      this.scroll.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  },

  _clearFocus() {
    if (this._focusTimer) { clearTimeout(this._focusTimer); this._focusTimer = 0; }
    if (this._focusRetry) { clearTimeout(this._focusRetry); this._focusRetry = 0; }
    if (this._focusFadeTimer) { clearTimeout(this._focusFadeTimer); this._focusFadeTimer = 0; }
    /* 淡出 .5s 后再移除节点；期间来了新聚焦会再次进本函数，节点被立即移除，不叠影 */
    const layers = [...this.scroll.querySelectorAll('.focusLayer')];
    const glows = [...this.scroll.querySelectorAll('.page-focus')];
    if (!layers.length && !glows.length) return;
    layers.forEach((el) => el.classList.add('fading'));
    glows.forEach((el) => { el.classList.add('fading'); el.classList.remove('page-focus'); });   // 先摘 page-focus 防重复聚焦命中
    this._focusFadeTimer = setTimeout(() => {
      layers.forEach((el) => el.remove());
      glows.forEach((el) => el.classList.remove('fading'));
    }, 520);
  },

  setZoom(z, absolute = false) {
    const d = this.doc; if (!d) return;
    d.zoom = Math.min(4, Math.max(0.4, absolute ? z : d.zoom * z));
    this.buildView();
  },

  /* ===== 高亮 ===== */
  /* 用文本匹配把【旧版】批注吸附到当前文本层（自愈错误几何）。
     v2 批注（字符级精确几何）永不吸附——吸附重算整 span 盒会把单词精度毁成整行。
     自愈本身也用字符级子区间：定位 [idx, idx+len) 后按 span 内偏移取子区间矩形。 */
  snapAnnToSpans(ann, pageNo) {
    if (ann.v2) return;
    try {
      const pageEl = this.scroll.querySelector(`.page[data-page="${pageNo}"]`);
      if (!pageEl) return;
      const tl = pageEl.querySelector('.textLayer');
      if (!tl || !tl.children.length) return;
      const strip = (s) => String(s || '').replace(/\s+/g, '');
      const A = strip(ann.fullText || ann.text);
      if (A.length < 4) return;
      const spans = [...tl.querySelectorAll('span')]
        .filter((sp) => !sp.querySelector('span') && strip(sp.textContent).length); // 只取叶子 span
      if (!spans.length) return;
      let S = '';
      const map = []; // 去空白索引 -> span 下标
      spans.forEach((sp, i) => {
        const t = strip(sp.textContent);
        for (let k = 0; k < t.length; k++) map[S.length + k] = i;
        S += t;
      });
      let idx = S.indexOf(A);
      let len = A.length;
      if (idx < 0) {
        const probe = A.slice(0, Math.min(20, A.length));
        const p = S.indexOf(probe);
        if (p < 0) return;
        idx = p; len = 0;
        while (len < A.length && idx + len < S.length && S[idx + len] === A[len]) len++;
        if (len < Math.min(8, A.length)) return; // 共同片段太短，不可信
      }
      /* 字符级子区间：把 [idx, idx+len) 映射回各 span 的原始文本偏移（含空白） */
      const pr = pageEl.getBoundingClientRect();
      const rects = [];
      let consumed = 0; // 已在 S 中走过的字符数
      for (const sp of spans) {
        if (rects.length && consumed >= idx + len) break;
        const raw = sp.textContent || '';
        const strippedLen = strip(raw).length;
        const spanS0 = consumed, spanS1 = consumed + strippedLen;
        consumed = spanS1;
        if (spanS1 <= idx || spanS0 >= idx + len) continue; // 本 span 与命中区无交集
        // 计算原始文本（含空白）的起止偏移：把 S 中 [idx, idx+len) 映射回 raw 下标
        let local = 0;   // 本 span 内非空白计数
        let off1 = -1, off2 = raw.length;
        for (let k = 0; k <= raw.length; k++) {
          const ch = raw[k];
          const isWs = !ch || /\s/.test(ch);
          if (isWs) {
            if (off1 >= 0 && off2 === raw.length && spanS0 + local >= idx + len) { off2 = k; break; }
            continue;
          }
          const sIdx = spanS0 + local;
          if (off1 < 0 && sIdx >= idx) off1 = k;
          if (sIdx === idx + len - 1) off2 = k + 1;
          if (off2 < raw.length && k + 1 >= off2) break; // 已越过命中终点
          local++;
        }
        if (off1 < 0) off1 = 0;
        if (off2 <= off1) off2 = raw.length;
        const tn = sp.firstChild;
        if (tn && tn.nodeType === 3 && tn.textContent === raw) {
          const sr = document.createRange();
          sr.setStart(tn, Math.min(off1, raw.length));
          sr.setEnd(tn, Math.min(off2, raw.length));
          for (const r of sr.getClientRects()) {
            if (r.width < 0.5 || r.height < 0.5) continue;
            rects.push({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height });
          }
        } else {
          const r = sp.getBoundingClientRect(); // 结构异常兜底：退回整盒
          rects.push({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height });
        }
      }
      if (!rects.length) return;
      const merged = this.mergeLineRects(rects);
      if (JSON.stringify(merged) !== JSON.stringify(ann.rects)) {
        ann.rects = merged;
        ann.v2 = 2; // 已治愈，之后不再吸附
        this.saveAnnDebounced();
      }
    } catch { /* 吸附失败不影响绘制 */ }
  },

  /* 显示用几何：色带垂直内收，正好裹住可见字形——
     上内收 8%（顶到大写高度之间的空隙），下内收 5%（避开下伸部最低点即止），
     不再向下延伸，绝不触及下一行。只影响渲染，存储仍是精确几何 */
  displayRects(rects) {
    return rects.map((r) => ({
      ...r,
      y: r.y + r.h * 0.08,
      h: r.h * 0.87,
    }));
  },

  renderHls(pageNo) {
    const d = this.doc;
    const layer = this.scroll.querySelector(`.page[data-page="${pageNo}"] .hlLayer`);
    if (!layer) return;
    layer.innerHTML = '';
    for (const ann of d.ann.filter((a) => a.page === pageNo && a.rects && a.rects.length)) {
      this.snapAnnToSpans(ann, pageNo); // 先尝试按当前 span 几何自愈
      const disp = this.displayRects(ann.rects); // 行间衔接（仅显示）
      disp.forEach((r, ri) => {
        const rect = SR.el('div', {
          class: 'hl', 'data-ann': ann.id,
          title: ann.note ? '点击查看笔记' : '点击添加笔记',
          style: `background:${ann.color || '#ffd54f'};left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`,
        });
        if (ann.note && ri === disp.length - 1) {
          rect.appendChild(SR.el('span', { class: 'noteflag', title: ann.note }, '📝'));
        }
        layer.appendChild(rect);
      });
    }
  },

  addHighlight(pagesOrRects, text, page, color, note = '') {
    const d = this.doc;
    // 新格式：[{page,rects,text}]；旧格式：rects + page
    const groups = Array.isArray(pagesOrRects) && pagesOrRects[0] && pagesOrRects[0].rects
      ? pagesOrRects
      : [{ page, rects: pagesOrRects }];
    const created = [];
    const multi = groups.length > 1;
    for (const g of groups) {
      const ann = {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
        type: note ? 'note' : 'hl', page: g.page, color, rects: g.rects,
        text: (g.text && g.text.length >= 4) ? g.text : text, // 每页存本页文本（吸附匹配用）
        fullText: multi ? text : undefined,                    // 跨页时保留全文（复制/匹配用）
        note, created: Date.now(),
        v2: 2, // 字符级精确几何：永不触发吸附（吸附的整 span 盒会把单词毁成整行）
      };
      d.ann.push(ann);
      created.push(ann);
      this.renderHls(g.page);
    }
    this.renderAnnotsList();
    this.saveAnnDebounced();
    return created[0];
  },

  /* 手动把所有批注按当前文本层重新对齐（旧数据自愈的显式入口） */
  async realignAll() {
    const d = this.doc;
    if (!d || !d.ann.length) { SR.toast('没有批注需要对齐'); return; }
    const pages = [...new Set(d.ann.map((a) => a.page))].sort((a, b) => a - b);
    SR.toast(`正在重新对齐 ${pages.length} 页的批注…`, 'info', 3000);
    for (const p of pages) {
      try { await this.renderPage(p); } catch { /* 已渲染则跳过 */ }
      this.renderHls(p);
    }
    this.renderAnnotsList();
    SR.toast('批注已按当前文本层重新对齐 ✅', 'success');
  },

  removeAnn(ann) {
    const d = this.doc;
    d.ann = d.ann.filter((a) => a.id !== ann.id);
    this.renderHls(ann.page);
    this.renderAnnotsList();
    this.saveAnnDebounced();
  },

  renderAnnotsList() {
    const panel = document.getElementById('panelAnnots');
    const d = this.doc;
    if (!d) { panel.innerHTML = '<div class="hint pad">高亮与笔记会显示在这里</div>'; return; }
    const items = [...d.ann].sort((a, b) => a.page - b.page);
    panel.innerHTML = '';
    /* 当前高亮颜色选择（🖍 固定用它；点色块切换） */
    const colorRow = SR.el('div', { class: 'color-row' });
    colorRow.appendChild(SR.el('span', { class: 'muted', style: 'font-size:11.5px' }, '当前颜色'));
    const names = { '#ffd54f': '黄', '#a5d6a7': '绿', '#90caf9': '蓝', '#ef9a9a': '红', '#ce93d8': '紫' };
    for (const c of this.HL_COLORS) {
      colorRow.appendChild(SR.el('button', {
        class: 'swatch' + (c === this.lastColor ? ' sel' : ''),
        style: `background:${c}`,
        title: names[c] || c,
        onclick: () => { this.lastColor = c; this.renderAnnotsList(); },
      }));
    }
    panel.appendChild(colorRow);
    const head = SR.el('div', { class: 'section-title', style: 'display:flex;align-items:center;gap:8px' });
    head.appendChild(SR.el('span', {}, `共 ${items.length} 条批注（管理操作在此）`));
    if (items.length) head.appendChild(SR.el('button', {
      class: 'ghost small', style: 'margin-left:auto;font-size:11px;padding:2px 8px',
      title: '按当前文本层重新计算所有高亮的位置（修复旧批注偏移）',
      onclick: () => this.realignAll(),
    }, '🔁 重新对齐'));
    panel.appendChild(head);
    if (!items.length) panel.appendChild(SR.el('div', { class: 'hint pad' }, '在正文中选中文字即可高亮 / 制卡 / 提问'));
    for (const a of items) {
      const ops = SR.el('div', { class: 'ann-ops' });
      ops.appendChild(SR.el('button', { title: '跳到该页', onclick: () => this.scrollToPage(a.page) }, '↗'));
      ops.appendChild(SR.el('button', {
        title: '复制文字', onclick: () => SR.copyText(a.fullText || a.text),
      }, '📋'));
      ops.appendChild(SR.el('button', {
        title: '编辑笔记', onclick: (ev) => {
          const item = ev.target.closest('.ann-item');
          this.openNoteCard(a, item ? item.getBoundingClientRect() : null);
        },
      }, '✏'));
      ops.appendChild(SR.el('button', {
        title: '换色', onclick: () => {
          const i = this.HL_COLORS.indexOf(a.color);
          a.color = this.HL_COLORS[(i + 1) % this.HL_COLORS.length] || this.HL_COLORS[0];
          this.renderHls(a.page); this.renderAnnotsList(); this.saveAnnDebounced();
        },
      }, '🎨'));
      ops.appendChild(SR.el('button', {
        title: '删除', onclick: () => this.removeAnn(a),
      }, '🗑'));
      panel.appendChild(SR.el('div', { class: 'ann-item' },
        SR.el('div', {},
          SR.el('span', { class: 'dot', style: `background:${a.color}` }),
          a.note ? '📝 笔记' : '🖍 高亮',
          SR.el('span', { class: 'pg' }, `p.${a.page}`)),
        SR.el('div', { class: 'txt' }, a.text || ''),
        a.note ? SR.el('div', { class: 'note' }, '💡 ' + a.note) : null,
        ops,
      ));
    }
  },

  /* ===== 选区工具条 ===== */
  /* 把同一行的碎矩形合并成整行矩形（消除两端对齐/词间隙造成的锯齿） */
  mergeLineRects(rects) {
    const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last) {
        const overlap = Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y);
        const gap = r.x - (last.x + last.w);
        if (overlap > Math.min(last.h, r.h) * 0.5 && gap <= 0.035) {
          const y0 = Math.min(last.y, r.y), y1 = Math.max(last.y + last.h, r.y + r.h);
          last.x = Math.min(last.x, r.x);
          last.w = Math.max(last.x + last.w, r.x + r.w) - last.x;
          last.y = y0; last.h = y1 - y0;
          continue;
        }
      }
      out.push({ ...r });
    }
    return out;
  },

  /* ---------- 自研选区引擎（取代浏览器原生选区） ----------
     原生选区在 pdf.js 文本层（绝对定位 span + 段落间隙）上行为不可控：
     拖过间隙会把端点跳到容器上 = 突然全选，不同 PDF 排版表现各异、拦不完。
     于是彻底弃用：CSS user-select:none 关闭浏览器选中，选区全部自算——
     mousedown 记锚点 caret、mousemove 追焦点 caret（找不到文字就冻结），
     Range 与 span 求字符级交集（与高亮同一条几何管线），实时画蓝色覆盖层。
     所见即所得：覆盖层画出的就是将要高亮/复制的内容。 */
  /* 在指针处找文字 caret。混合方案：
     ① caretRangeFromPoint 快路径——但 Chrome 在 user-select:none 元素上会返回
        元素节点（非文字节点），必须校验后放行；
     ② 几何自算兜底：扫描可见页叶子 span 的盒子，命中行内二分查找字符偏移，
        完全不依赖浏览器命中测试——任何怪癖都影响不到这里。 */
  _caretAt(x, y, dir) {
    /* ① 快路径 */
    for (const dy of [0]) {
      let hit = null;
      if (document.caretRangeFromPoint) hit = document.caretRangeFromPoint(x, y + dy);
      else if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y + dy);
        if (p) { hit = document.createRange(); hit.setStart(p.offsetNode, p.offset); }
      }
      const n = hit && hit.startContainer;
      if (n && n.nodeType === 3 && n.textContent.trim()) {
        const el = n.parentElement;
        if (el && el.closest && el.closest('.textLayer')) return { node: n, off: hit.startOffset };
      }
    }
    /* ② 几何自算 */
    return this._caretFromGeometry(x, y, dir);
  },
  /* span 内按 x 二分找字符偏移：用 range 的字符矩形定位，
     与 user-select / 浏览器命中测试无关 */
  _offsetInSpan(sp, x) {
    const tn = sp.firstChild;
    if (!tn || tn.nodeType !== 3 || !tn.length) return null;
    const r = sp.getBoundingClientRect();
    if (x <= r.left + 1) return { node: tn, off: 0 };
    if (x >= r.right - 1) return { node: tn, off: tn.length };
    let lo = 0, hi = tn.length;
    while (lo < hi) {                       // 找出指针落在的字符 lo
      const mid = (lo + hi) >> 1;
      const cr = document.createRange();
      cr.setStart(tn, mid); cr.setEnd(tn, Math.min(mid + 1, tn.length));
      const b = cr.getBoundingClientRect();
      if (!b.width && !b.height) { lo = mid + 1; continue; }
      if (x > b.right) lo = mid + 1; else hi = mid;
    }
    /* 就近边界语义（与浏览器 caret 一致）：指针偏向字符右半 → 光标落在该字符之后 */
    if (lo < tn.length) {
      const cr = document.createRange();
      cr.setStart(tn, lo); cr.setEnd(tn, Math.min(lo + 1, tn.length));
      const b = cr.getBoundingClientRect();
      if (b.width || b.height) {
        const dl = x - b.left, dr = b.right - x;
        if (dr < dl) return { node: tn, off: lo + 1 };
      }
    }
    return { node: tn, off: Math.min(lo, tn.length) };
  },
  _caretFromGeometry(x, y, dir) {
    let best = null;                        // {dy, sp}
    const consider = (sp) => {
      if (sp.querySelector('span')) return; // 只取叶子
      const tn = sp.firstChild;
      if (!tn || tn.nodeType !== 3 || !tn.textContent.trim()) return;
      const r = sp.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) return;
      const inside = y >= r.top && y <= r.bottom && x >= r.left - 2 && x <= r.right + 2;
      let dy = 0;
      if (!inside) {
        const dyT = r.top - y, dyB = y - r.bottom;
        dy = y < r.top ? dyT : dyB;         // 指针在该行上方/下方的距离
        if (Math.abs(dy) > 64) return;      // 太远不考虑
        if (x < r.left - 2 || x > r.right + 2) dy += 24; // 水平脱靶的行降权
      }
      const score = Math.abs(dy) + (dir >= 0 ? (y > r.bottom ? 0 : 2) : (y < r.top ? 0 : 2));
      if (!best || score < best.score) best = { score, dy, sp, inside };
    };
    for (const pageEl of this.scroll.querySelectorAll('.page')) {
      const pr = pageEl.getBoundingClientRect();
      if (y < pr.top - 80 || y > pr.bottom + 80) continue;   // 只扫视口附近的页
      for (const sp of pageEl.querySelectorAll('.textLayer span')) consider(sp);
    }
    if (!best) return null;
    const cx = Math.max(best.sp.getBoundingClientRect().left + 1, Math.min(x, best.sp.getBoundingClientRect().right - 1));
    return this._offsetInSpan(best.sp, cx);
  },
  _rangeFromCarets(a, b) {
    const r = document.createRange();
    const ra = document.createRange(); ra.setStart(a.node, a.off);
    const rb = document.createRange(); rb.setStart(b.node, b.off);
    if (ra.compareBoundaryPoints(Range.START_TO_START, rb) <= 0) { r.setStart(a.node, a.off); r.setEnd(b.node, b.off); }
    else { r.setStart(b.node, b.off); r.setEnd(a.node, a.off); }
    return r;
  },
  /* Range 与各页文本层 span 求字符级交集 → {byPage, lastCR}（高亮/选区共用管线）
     全部使用无歧义原生 API：
     - intersectsNode(span)：选区与该 span 是否相交（布尔，无语义争议）
     - comparePoint(tn, off)：-1=点在选区前 0=点在选区内 1=点在选区后 */
  _pagesFromRange(selRange) {
    const byPage = new Map();
    let lastCR = null;
    for (const pageEl of this.scroll.querySelectorAll('.page')) {
      const pr = pageEl.getBoundingClientRect();
      const rects = [];
      let pageText = '';
      for (const sp of pageEl.querySelectorAll('.textLayer span')) {
        if (sp.querySelector('span')) continue;            // markedContent 包装层，只取叶子
        const tn = sp.firstChild;
        if (!tn || tn.nodeType !== 3 || !tn.textContent.trim()) continue;
        if (!selRange.intersectsNode(sp)) continue;         // 不相交：跳过
        const sr = document.createRange();
        sr.selectNodeContents(sp);
        // span 起点在选区之前 → 选区起点落在本 span 内 → 收缩到选区起点
        if (selRange.comparePoint(tn, 0) === -1) sr.setStart(selRange.startContainer, selRange.startOffset);
        // span 终点在选区之后 → 选区终点落在本 span 内 → 收缩到选区终点
        if (selRange.comparePoint(tn, tn.length) === 1) sr.setEnd(selRange.endContainer, selRange.endOffset);
        if (sr.collapsed) continue;                         // 交集为空
        const t = sr.toString();
        if (t && t.trim()) pageText += (pageText && !/\s$/.test(pageText) ? ' ' : '') + t;
        for (const r of sr.getClientRects()) {
          if (r.width < 0.5 || r.height < 0.5) continue;
          rects.push({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height });
          lastCR = r;
        }
      }
      if (rects.length) {
        const no = Number(pageEl.dataset.page);
        byPage.set(no, { page: no, rects: this.mergeLineRects(rects), text: pageText.replace(/\s+/g, ' ').trim() });
      }
    }
    return { byPage, lastCR };
  },
  _clearSelOverlay() {
    this.scroll.querySelectorAll('.selLayer').forEach((l) => { l.innerHTML = ''; });
  },
  _drawSel(range) {
    this._clearSelOverlay();
    const { byPage } = this._pagesFromRange(range);
    for (const g of byPage.values()) {
      const layer = this.scroll.querySelector(`.page[data-page="${g.page}"] .selLayer`);
      if (!layer) continue;
      for (const r of g.rects) layer.appendChild(SR.el('div', {
        class: 'selRect', style: `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`,
      }));
    }
    return byPage;
  },
  /* 拖选结束：算交集、存 _sel、定位工具条（每级失败都留 console 痕迹） */
  _finishSel(a, b) {
    const toolbar = document.getElementById('selToolbar');
    const range = this._rangeFromCarets(a, b);
    if (range.collapsed) {
      console.log('[SR选区] finish 塌缩（a==b，焦点从未移动到别的字符） anchor.off=', a.off, 'focus.off=', b.off);
      this._sel = null; this._clearSelOverlay(); toolbar.classList.add('hidden'); return;
    }
    const { byPage, lastCR } = this._pagesFromRange(range);
    this._drawSel(range);
    const pages = [...byPage.values()].sort((x, y) => x.page - y.page);
    const text = pages.map((p) => p.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (!pages.length) console.log('[SR选区] finish 交集为空：range=', range.toString().slice(0, 30));
    else if (!text) console.log('[SR选区] finish 有矩形但文本为空');
    else if (!lastCR) console.log('[SR选区] finish 无 lastCR');
    if (!pages.length || !text || !lastCR) { this._sel = null; this._clearSelOverlay(); toolbar.classList.add('hidden'); return; }
    this._sel = { pages, text };
    toolbar.classList.remove('hidden');
    this.refreshToolbarColor();
    toolbar.style.left = Math.max(8, Math.min(window.innerWidth - 250, lastCR.left + lastCR.width / 2 - 115)) + 'px';
    toolbar.style.top = Math.max(54, lastCR.top - 48) + 'px';
  },

  /* Alt+Click 自检：在点击处逐步验证选区引擎的每一环，toast 报告（无需控制台） */
  _diagSel(x, y) {
    const steps = [];
    try {
      const c = this._caretAt(x, y, 0);
      steps.push(c ? `caret1✓ off=${c.off}` : 'caret1✗');
      if (c) {
        let c2 = null, dx = 0;
        for (const d of [60, -60, 120, -120, 200]) {       // 右/左/更远依次探测第二个点
          const cand = this._caretAt(Math.max(8, Math.min(window.innerWidth - 8, x + d)), y, 0);
          if (cand && (cand.node !== c.node || cand.off !== c.off)) { c2 = cand; dx = d; break; }
        }
        steps.push(c2 ? `caret2✓ off=${c2.off} (x${dx>0?'+':''}${dx})` : 'caret2✗（左右都找不到第二个点→几何路径失效）');
        if (c2) {
          const r = this._rangeFromCarets(c, c2);
          const { byPage, lastCR } = this._pagesFromRange(r);
          const pages = [...byPage.values()];
          const text = pages.map((p) => p.text).join(' ');
          steps.push(`range${r.collapsed ? '塌缩✗' : '✓'}`);
          steps.push(`交集页=${pages.length} 矩形=${pages.reduce((n, p) => n + p.rects.length, 0)} 文本="${text.slice(0, 10)}…"`);
          if (!r.collapsed && pages.length) {
            this._sel = { pages: pages.sort((p, q) => p.page - q.page), text };
            document.getElementById('selToolbar').classList.remove('hidden');
            this.refreshToolbarColor();
            steps.push('工具条已弹出✓（点空白处清掉）');
          }
          void lastCR;
        }
      }
    } catch (e) { steps.push('异常: ' + (e && e.message)); }
    SR.toast('🔧 ' + steps.join('｜'), 'info', 10000);
  },

  /* 选区出现时刷新工具条：🖍 按钮显示当前颜色 */
  refreshToolbarColor() {
    const btn = document.querySelector('#selToolbar button[data-act="hl"]');
    if (btn) {
      btn.style.color = this.lastColor;
      btn.title = `高亮（当前颜色 ${this.lastColor}）`;
    }
  },

  /* ---------- 选区引擎事件绑定 ---------- */
  bindSelectionEngine() {
    if (this._engBound) return;
    this._engBound = true;
    const scroll = this.scroll;
    const inText = (t) => !!(t && t.closest && (t.closest('.textLayer') || t.closest('.hl')));
    scroll.addEventListener('mousedown', (ev) => {
      if (ev.altKey) { this._diagSel(ev.clientX, ev.clientY); ev.preventDefault(); return; } // Alt+Click 自检
      if (ev.button !== 0) { this._eng = null; return; }
      this._eng = null;
      this._engDownXY = [ev.clientX, ev.clientY];          // 供 click 判定拖动量
      /* 锚点建立不要求恰好点中 span（行间/字间也算）：
         _caretAt 的几何路径会在 ±64px 内就近吸附到文字行 */
      const c = this._caretAt(ev.clientX, ev.clientY, 0);
      console.log('[SR选区] mousedown', ev.clientX + ',' + ev.clientY, 'target=', (ev.target.className || ev.target.tagName) + '', 'caret=', c ? `✓ off=${c.off}` : '✗');
      if (!c) return;
      this._eng = { active: true, anchor: c, focus: c, lastY: ev.clientY, raf: 0 };
    });
    window.addEventListener('mousemove', (ev) => {
      const e = this._eng;
      if (!e || !e.active || ev.buttons !== 1) return;
      const dir = Math.sign(ev.clientY - (e.lastY ?? ev.clientY));
      e.lastY = ev.clientY;
      const c = this._caretAt(ev.clientX, ev.clientY, dir);
      if (c) e.focus = c;                 // 指针在空白上找不到文字：焦点冻结，选区绝不跳
      if (!e.raf) e.raf = requestAnimationFrame(() => {
        e.raf = 0;
        if (e.active) this._drawSel(this._rangeFromCarets(e.anchor, e.focus));
      });
    });
    window.addEventListener('mouseup', (ev) => {
      const e = this._eng;
      if (e && e.active) {
        e.active = false;
        if (e.raf) { cancelAnimationFrame(e.raf); e.raf = 0; }
        console.log('[SR选区] mouseup → finish, anchor.off=', e.anchor.off, 'focus.off=', e.focus.off);
        this._finishSel(e.anchor, e.focus);
      }
      /* 拖动超过阈值则抑制随后的 click 弹批注菜单（拖选 ≠ 点击批注） */
      const down = this._engDownXY;
      this._suppressAnnClick = !!(down && Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5);
    });
    /* 点击高亮块 → 笔记卡片（有笔记显示内容，无笔记可直接添加） */
    scroll.addEventListener('click', (ev) => {
      if (this._suppressAnnClick) { this._suppressAnnClick = false; return; }
      const hl = ev.target.closest && ev.target.closest('.hl');
      if (!hl) return;
      const d = SR.state.doc;
      const ann = d && d.ann.find((a) => a.id === hl.dataset.ann);
      if (ann) this.openNoteCard(ann, hl.getBoundingClientRect());
    });
    scroll.addEventListener('scroll', () => { this.hideAnnMenu(); this.closeNoteCard(); }, { passive: true });
    /* 双击选词 / 三击选整行（原生选中已关闭，自己实现） */
    scroll.addEventListener('dblclick', (ev) => {
      if (!inText(ev.target)) return;
      this.hideAnnMenu();
      this.closeNoteCard();
      const c = this._caretAt(ev.clientX, ev.clientY, 0);
      if (!c) return;
      const s = c.node.textContent;
      const cls = (ch) => !ch ? 'e' : (/[\u4e00-\u9fff\u3040-\u30ff]/.test(ch) ? 'c' : (/[A-Za-z0-9]/.test(ch) ? 'w' : (/\s/.test(ch) ? 's' : 'o')));
      let i = Math.min(c.off, s.length - 1), j = i;
      const k = cls(s[i]);
      if (k === 'w' || k === 'c') {
        while (i > 0 && cls(s[i - 1]) === k) i--;
        while (j < s.length - 1 && cls(s[j + 1]) === k) j++;
        this._finishSel({ node: c.node, off: i }, { node: c.node, off: j + 1 });
        return;
      }
      for (let r = c.off; r < s.length; r++) {             // 落在空白/符号上：就近取词
        if (cls(s[r]) === 'w' || cls(s[r]) === 'c') {
          let r2 = r; while (r2 < s.length - 1 && cls(s[r2 + 1]) === cls(s[r])) r2++;
          this._finishSel({ node: c.node, off: r }, { node: c.node, off: r2 + 1 });
          return;
        }
      }
      for (let l = Math.min(c.off, s.length - 1); l >= 0; l--) {
        if (cls(s[l]) === 'w' || cls(s[l]) === 'c') {
          let l2 = l; while (l2 > 0 && cls(s[l2 - 1]) === cls(s[l])) l2--;
          this._finishSel({ node: c.node, off: l2 }, { node: c.node, off: l + 1 });
          return;
        }
      }
    });
    scroll.addEventListener('click', (ev) => {
      if (ev.detail >= 3 && inText(ev.target)) {           // 三击：整行（pdf.js 的 span 通常就是一行）
        const sp = ev.target.closest('.textLayer span');
        const tn = sp && sp.firstChild;
        if (tn && tn.nodeType === 3) this._finishSel({ node: tn, off: 0 }, { node: tn, off: tn.length });
      }
    });
    /* 保险丝：任何情况下浏览器原生选区都不允许出现在文本层内
       （user-select:none 已关闭，这里是双保险——哪怕某个路径触发了原生选区也立即掐灭） */
    document.addEventListener('selectionchange', () => {
      const s = window.getSelection();
      if (s && !s.isCollapsed && this._eng && this._eng.active) {
        const n = s.anchorNode;
        const el = n && (n.nodeType === 3 ? n.parentElement : n);
        if (el && el.closest && el.closest('.textLayer')) s.removeAllRanges();
      }
    });
    /* Ctrl+C：复制自算选区的文本 */
    window.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C') && this._sel
        && !(ev.target.closest && ev.target.closest('input,textarea,[contenteditable]'))) {
        SR.copyText(this._sel.text);
      }
    });
  },

  /* ---------- 批注管理浮条（点击高亮块弹出） ---------- */
  hideAnnMenu() {
    const bar = document.getElementById('annToolbar');
    if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
  },
  showAnnMenu(ann, rect) {
    const bar = document.getElementById('annToolbar');
    if (!bar) return;
    bar.innerHTML = '';
    const d = SR.state.doc;
    const names = { '#ffd54f': '黄', '#a5d6a7': '绿', '#90caf9': '蓝', '#ef9a9a': '红', '#ce93d8': '紫' };
    const done = () => { this.hideAnnMenu(); };
    const mk = (label, title, fn) => bar.appendChild(SR.el('button', {
      title,
      onclick: (ev) => { ev.stopPropagation(); fn(); },
    }, label));

    mk('🎨', '换色', () => {
      const exist = bar.querySelector('.ann-swatches');
      if (exist) { exist.remove(); return; }              // 再点收起
      const row = SR.el('div', { class: 'ann-swatches' });
      for (const c of this.HL_COLORS) {
        row.appendChild(SR.el('button', {
          class: 'swatch big' + (c === ann.color ? ' sel' : ''),
          style: `background:${c}`, title: names[c] || c,
          onclick: (ev) => {
            ev.stopPropagation();
            ann.color = c;
            this.renderHls(ann.page); this.renderAnnotsList(); this.saveAnnDebounced();
            done(); SR.toast(`已改为${names[c] || c}色 🎨`);
          },
        }));
      }
      bar.appendChild(row);
    });
    mk('📝', ann.note ? '编辑笔记' : '添加笔记', () => {
      done();
      this.openNoteCard(ann, bar.getBoundingClientRect());
    });
    mk('💬', '就这段向 AI 提问', () => {
      done();
      SR.chat.askAboutSelection({ text: ann.fullText || ann.text, page: ann.page, title: d ? d.title : '' });
    });
    mk('↩', '撤销此批注', () => {
      this.removeAnn(ann); done(); SR.toast('已撤销该批注 ↩');
    });

    bar.classList.remove('hidden');
    const w = 250;
    bar.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + 'px';
    bar.style.top = (rect.top > 100 ? rect.top - 48 : rect.bottom + 10) + 'px';
  },

  /* ===== 笔记卡片：点标记弹出（有笔记显示内容，无笔记可添加），✕/Esc/点外面关闭 ===== */
  openNoteCard(ann, anchor) {
    this.closeNoteCard();
    const names = { '#ffd54f': '黄', '#a5d6a7': '绿', '#90caf9': '蓝', '#ef9a9a': '红', '#ce93d8': '紫' };
    const save = () => {
      const n = ta.value.trim();
      ann.note = n; ann.type = n ? 'note' : 'hl';
      this.renderHls(ann.page); this.renderAnnotsList(); this.saveAnnDebounced();
      this.closeNoteCard();
      SR.toast(n ? '笔记已保存 📝' : '笔记已清空（保留高亮）');
    };
    const src = String(ann.fullText || ann.text || '').replace(/\s+/g, ' ').trim();
    const ta = SR.el('textarea', { class: 'nc-text', placeholder: '写下这段的想法…（Ctrl+Enter 保存）', rows: 4 });
    ta.value = ann.note || '';
    const sw = SR.el('span', { class: 'ann-swatches' });
    for (const c of this.HL_COLORS) {
      sw.appendChild(SR.el('button', {
        class: 'swatch' + (c === ann.color ? ' sel' : ''), style: `background:${c}`, title: names[c] || c,
        onclick: (ev) => {
          ev.stopPropagation();
          ann.color = c;
          sw.querySelectorAll('.swatch').forEach((b) => b.classList.remove('sel'));
          ev.target.classList.add('sel');
          this.renderHls(ann.page); this.saveAnnDebounced();
        },
      }));
    }
    const card = SR.el('div', { class: 'noteCard' },
      SR.el('div', { class: 'nc-head' },
        SR.el('span', {}, ann.note ? '📝 笔记' : '📝 添加笔记'),
        SR.el('span', { class: 'nc-pg' }, 'p.' + ann.page),
        SR.el('button', { class: 'ghost small', title: '关闭（Esc）', onclick: () => this.closeNoteCard() }, '✕')),
      src ? SR.el('div', { class: 'nc-quote' }, '“' + (src.length > 120 ? src.slice(0, 120) + '…' : src) + '”') : null,
      ta,
      SR.el('div', { class: 'nc-ops' },
        SR.el('button', { class: 'primary small', onclick: save }, '💾 保存'),
        sw,
        SR.el('span', { class: 'nc-gap' }),
        SR.el('button', { class: 'ghost small', title: '就这段向 AI 提问', onclick: () => {
          this.closeNoteCard();
          SR.chat.askAboutSelection({ text: ann.fullText || ann.text, page: ann.page, title: SR.state.doc ? SR.state.doc.title : '' });
        } }, '💬'),
        SR.el('button', { class: 'ghost small', title: '删除此批注（连笔记）', onclick: () => {
          this.removeAnn(ann); this.closeNoteCard(); SR.toast('已删除该批注 ↩');
        } }, '🗑')));
    ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); save(); }
      if (ev.key === 'Escape') this.closeNoteCard();
    });
    document.body.appendChild(card);
    this._ncEl = card;
    /* 定位：锚点上方优先，放不下放下方；水平夹在视口内 */
    card.style.visibility = 'hidden';
    const r = anchor || { top: window.innerHeight / 2, bottom: window.innerHeight / 2, left: window.innerWidth / 2 - 140, width: 0 };
    const cw = card.offsetWidth, ch = card.offsetHeight;
    card.style.left = Math.max(8, Math.min(window.innerWidth - cw - 8, r.left + (r.width || 0) / 2 - cw / 2)) + 'px';
    card.style.top = (r.top - ch - 10 > 8 ? r.top - ch - 10 : Math.min(window.innerHeight - ch - 8, r.bottom + 10)) + 'px';
    card.style.visibility = '';
    /* 外点关闭 + Esc（延迟挂载，避免打开那一击立即关掉） */
    const outside = (ev) => { if (!card.contains(ev.target)) this.closeNoteCard(); };
    setTimeout(() => document.addEventListener('mousedown', outside), 0);
    this._ncCleanup = () => document.removeEventListener('mousedown', outside);
    ta.focus();
    if (ann.note) ta.setSelectionRange(ta.value.length, ta.value.length);
  },

  closeNoteCard() {
    if (this._ncCleanup) { this._ncCleanup(); this._ncCleanup = null; }
    if (this._ncEl) { this._ncEl.remove(); this._ncEl = null; }
  },

  hidePop() {
    document.getElementById('selToolbar').classList.add('hidden');
    const pal = document.getElementById('colorPalette');
    if (pal) pal.classList.add('hidden');
    this.hideAnnMenu();
    this._sel = null;            // 自研选区：收起工具条即清选区
    this._clearSelOverlay();
  },

  /* 选区工具条下方的换色板：只负责选取当前颜色（不触发标记） */
  togglePalette() {
    const pal = document.getElementById('colorPalette');
    const toolbar = document.getElementById('selToolbar');
    if (!pal || !this._sel) return;
    if (!pal.classList.contains('hidden')) { pal.classList.add('hidden'); return; }
    pal.innerHTML = '';
    const names = { '#ffd54f': '黄', '#a5d6a7': '绿', '#90caf9': '蓝', '#ef9a9a': '红', '#ce93d8': '紫' };
    for (const c of this.HL_COLORS) {
      pal.appendChild(SR.el('button', {
        class: 'swatch big' + (c === this.lastColor ? ' sel' : ''),
        style: `background:${c}`,
        title: '设为当前颜色（不标记，点 🖍 标记）',
        onclick: () => {
          this.lastColor = c;
          SR.toast(`当前颜色：${names[c] || c}（点 🖍 标记）`, 'info', 1800);
          this.renderAnnotsList();
          pal.classList.add('hidden');
          // 工具条与选区保持，方便接着点 🖍
        },
      }));
    }
    pal.classList.remove('hidden');
    const tb = toolbar.getBoundingClientRect();
    pal.style.left = Math.max(8, Math.min(window.innerWidth - 190, tb.left)) + 'px';
    pal.style.top = (tb.bottom + 8) + 'px';
  },

  async selAction(act) {
    const s = this._sel;
    if (!s) return;
    if (act === 'color') { this.togglePalette(); return; } // 🎨 弹出色板，不收工具条
    const tbEl = document.getElementById('selToolbar');   // 收起前记下锚点（笔记卡片定位用）
    const tbAnchor = tbEl && !tbEl.classList.contains('hidden') ? tbEl.getBoundingClientRect() : null;
    this.hidePop();
    const firstPage = s.pages[0].page;
    if (act === 'hl') {
      // 固定用当前颜色（🎨 色板 / 批注面板色块处切换）
      this.addHighlight(s.pages, s.text, firstPage, this.lastColor);
      SR.toast(s.pages.length > 1 ? `已高亮（跨 ${s.pages.length} 页）🖍` : '已高亮 🖍');
    } else if (act === 'copy') {
      SR.copyText(s.text);
    } else if (act === 'ask') {
      SR.chat.askAboutSelection({ text: s.text, page: firstPage, title: this.doc.title });
    } else if (act === 'note') {
      /* 先落高亮，再弹笔记卡片就地书写 */
      const ann = this.addHighlight(s.pages, s.text, firstPage, this.lastColor, '');
      if (ann) this.openNoteCard(ann, tbAnchor);
      return;
    }
    window.getSelection().removeAllRanges();
  },

  /* ===== 目录 ===== */
  async destToPage(dest) {
    const d = this.doc;
    try {
      if (typeof dest === 'string') dest = await d.pdf.getDestination(dest);
      if (!Array.isArray(dest)) return null;
      return (await d.pdf.getPageIndex(dest[0])) + 1;
    } catch { return null; }
  },

  async buildOutline() {
    const d = this.doc;
    let ol = null;
    try { ol = await d.pdf.getOutline(); } catch { /* 无目录 */ }
    d.outline = ol || [];
    const panel = document.getElementById('panelToc');
    panel.innerHTML = '';
    if (!d.outline.length) {
      panel.appendChild(SR.el('div', { class: 'hint pad' }, '此 PDF 没有内嵌目录；可在上方工具栏自定义页码段。'));
      return;
    }
    const renderItems = (items, lv) => {
      for (const it of items || []) {
        panel.appendChild(SR.el('div', {
          class: 'toc-item', style: `--lv:${lv}`,
          onclick: async () => {
            const pg = await this.destToPage(it.dest);
            if (pg) this.scrollToPage(pg);
          },
        }, it.title || '(无标题)'));
        if (it.items && it.items.length && lv < 2) renderItems(it.items, lv + 1);
      }
    };
    renderItems(d.outline, 0);
  },

  /* ===== 部分（part）划分 ===== */
  /* 前置废料页判定（确定性规则，非 AI）：
     标题命中版权/封面/目录等模式，且位于书前 15 页、跨度 ≤5 页 → 不进入陪读队列。
     版权页被滤掉后其页码自动并入前一部分，不影响区间连续性。 */
  TRIVIAL_RE: /^(copyright|all rights|cover|title page|dedication|frontispiece|contents|table of contents|about the (author|translator|contributors))\s*$|版权|版權|著作权|封面|扉页|书名页|献词|目录|目錄/i,
  isTrivialPart(p) {
    if (!p || !p.title) return false;
    if (p.from > 15) return false;                      // 只可能是前置废料
    if (p.to !== undefined && (p.to - p.from) > 5) return false; // 大区间不算废料（书图节点用）
    return this.TRIVIAL_RE.test(String(p.title).trim());
  },

  async buildParts() {
    const d = this.doc;
    const parts = [];
    const tops = [];
    for (const it of d.outline.slice(0, 60)) {
      const pg = await this.destToPage(it.dest);
      tops.push({ title: it.title || '', from: pg || 1 });
    }
    tops.sort((a, b) => a.from - b.from);
    /* 滤掉前置废料（Copyright/封面/目录…）——仅当滤后仍有实质部分 */
    const meaty = tops.filter((t) => !this.isTrivialPart(t));
    const useTops = meaty.length ? meaty : tops;
    if (useTops.length >= 2) {
      for (let i = 0; i < useTops.length; i++) {
        const from = useTops[i].from;
        const to = i + 1 < useTops.length ? Math.max(from, useTops[i + 1].from - 1) : d.pages;
        if (to >= from) parts.push({ id: 'sec' + i, title: useTops[i].title, from, to });
      }
    } else {
      const step = Math.max(4, Math.ceil(d.pages / 12));
      for (let from = 1; from <= d.pages; from += step) {
        parts.push({ id: 'seg' + from, title: `第 ${from}–${Math.min(from + step - 1, d.pages)} 页`, from, to: Math.min(from + step - 1, d.pages) });
      }
    }
    d.parts = parts;
    this.refreshPartSelect();
  },

  /* 部分选择器：双来源分组（目录部分 + AI 拆书节点），节点带时长/风险/打卡标记 */
  refreshPartSelect() {
    const d = this.doc;
    const sel = document.getElementById('partSelect');
    if (!sel || !d) return;
    const prev = sel.value;
    this._partIdx = {};
    const secOpts = (d.parts || []).map((p, i) => {
      const key = 'sec:' + i;
      this._partIdx[key] = p;
      return `<option value="${key}">${SR.esc(p.title.slice(0, 42))} (p.${p.from}–${p.to})</option>`;
    }).join('');
    const nodes = ((d.bookmap && d.bookmap.nodes) || []).filter((n) => !this.isTrivialPart(n));
    const bmOpts = nodes.map((n) => {
      const key = 'bm:' + n.id;
      this._partIdx[key] = n;
      const done = (d.partsDone || {})[n.id] ? '✅ ' : '';
      const meta = [`${n.from}–${n.to}页`, n.minutes ? n.minutes + '分' : '', n.risk ? '⚠高风险' : '']
        .filter(Boolean).join(' · ');
      return `<option value="${key}">${done}${SR.esc(n.title.slice(0, 30))} (${meta})</option>`;
    }).join('');
    sel.innerHTML =
      `<optgroup label="🗺 AI 拆书节点（推荐：细粒度）">${bmOpts || '<option value="__need_bm" disabled>（点顶部「🗺 拆书」生成，100 页大章会切成可带读的小节）</option>'}</optgroup>`
      + `<optgroup label="📑 目录部分（书签顶层）">${secOpts}</optgroup>`
      + '<option value="custom">✏ 自定义页码段…</option>';
    sel.onchange = () => document.getElementById('customRange').classList.toggle('hidden', sel.value !== 'custom');
    /* 恢复原选择；无选择且有节点时默认指向第一个未打卡节点（顺着学习进度） */
    const values = [...sel.options].map((o) => o.value);
    if (prev && values.includes(prev)) sel.value = prev;
    else {
      const next = nodes.find((n) => !(d.partsDone || {})[n.id]) || nodes[0];
      sel.value = next ? 'bm:' + next.id : (values[0] || 'custom');
    }
  },

  currentPart() {
    const d = this.doc;
    if (!d) return null;
    const sel = document.getElementById('partSelect');
    if (!sel.value || sel.value === 'custom') {
      const from = Math.max(1, Number(document.getElementById('partFrom').value) || 1);
      const to = Math.min(d.pages, Number(document.getElementById('partTo').value) || d.pages);
      return { title: `自定义段`, from: Math.min(from, to), to: Math.max(from, to) };
    }
    const hit = (this._partIdx || {})[sel.value];
    if (hit) return hit;
    return d.parts[Number(sel.value)] || d.parts[0];   // 兼容旧版纯数字索引
  },

  async getPartMaterial(part) {
    const d = this.doc;
    let text = '';
    const imgPages = [];          // 含显著图形对象的页码（供视觉模型截屏）
    for (let p = part.from; p <= part.to; p++) {
      try {
        const pg = await d.pdf.getPage(p);
        const tc = await pg.getTextContent();
        text += `\n[p.${p}]\n` + tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim() + '\n\n';
        /* 显著图形检测：页面对象里的 Image/XObject，宽高超过页面的 1/5 视为图表候选 */
        try {
          const ops = await pg.getOperatorList();
          for (let k = 0; k < ops.fnArray.length; k++) {
            if (ops.fnArray[k] === 85 /* OPS.paintImageXObject */) {
              const name = ops.argsArray[k][0];
              const img = pg.objs && pg.objs.get && pg.objs.get(name);
              if (img && img.width && img.height && Math.min(img.width, img.height) >= 60) {
                if (!imgPages.includes(p)) imgPages.push(p);
                break;
              }
            }
          }
        } catch { /* 老版本 pdf.js 无 objs，退化为不检测 */ }
      } catch { /* 跳过 */ }
      if (text.length > 60000) { text = text.slice(0, 60000) + '\n…(已截断)'; break; }
    }
    /* 图表截屏（最多 4 页，多了 token 爆炸）：配置了视觉模型才干这活 */
    const wantVision = !!(SR.state.config && SR.state.config.llm && SR.state.config.llm.visionModel);
    const images = (wantVision && imgPages.length) ? await this.snapshotPages(imgPages.slice(0, 4)) : [];
    const highlights = d.ann
      .filter((a) => a.page >= part.from && a.page <= part.to)
      .map((a) => `p.${a.page}「${(a.text || '').slice(0, 120)}」${a.note ? ' 💡' + a.note : ''}`);
    return { text: text.trim(), highlights, images, imgPages };
  },

  /* 把整页渲染成 JPEG base64（图表页截屏给视觉模型；scale 控制在 ~1500px 宽，质量 0.8） */
  async snapshotPages(pages) {
    const d = this.doc;
    const out = [];
    for (const p of pages) {
      try {
        const pg = await d.pdf.getPage(p);
        const vp1 = pg.getViewport({ scale: 1 });
        const scale = Math.min(2.2, Math.max(1.2, 1500 / vp1.width));
        const vp = pg.getViewport({ scale });
        const cv = document.createElement('canvas');
        cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
        await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        out.push({ page: p, b64: cv.toDataURL('image/jpeg', 0.8) });
      } catch (e) { console.warn('[SR] 图表截屏失败 p.' + p, e); }
    }
    return out;
  },

  /* 独立文本提取：不打开阅读视图，直接从 PDF 文件抽指定页文本
     （巩固模式的追问复习用：材料来源页，无需加载整个阅读界面） */
  async extractPages(absPath, from, to) {
    if (!window.pdfjsLib) return '';
    try {
      const pdf = await pdfjsLib.getDocument({
        url: '/api/fs/file?path=' + encodeURIComponent(absPath),
        cMapUrl: (SR.pdfjsLocal ? 'vendor/cmaps/' : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/'),
        cMapPacked: true,
      }).promise;
      let text = '';
      for (let p = Math.max(1, from); p <= Math.min(to, pdf.numPages); p++) {
        try {
          const pg = await pdf.getPage(p);
          const tc = await pg.getTextContent();
          text += `\n[p.${p}]\n` + tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim() + '\n\n';
        } catch { /* 跳过 */ }
        if (text.length > 30000) { text = text.slice(0, 30000) + '\n…(已截断)'; break; }
      }
      try { await pdf.destroy(); } catch { /* ignore */ }
      return text.trim();
    } catch { return ''; }
  },

  /* ===== 持久化 ===== */
  saveAnnDebounced: null,

  /* ===== 陪读模式（读到部分末尾自动邀请复盘） ===== */
  readalong: {
    on: false,
    goal: null,        // { id,title,from,to }
    bannerShownFor: null,
  },

  /* 刷新后恢复陪读状态 */
  restoreReadalong(ra) {
    if (!ra || !ra.on || !this.doc) return false;
    const raw = (this.doc.bookmap && this.doc.bookmap.nodes && this.doc.bookmap.nodes.length)
      ? this.doc.bookmap.nodes : this.doc.parts;
    const src = raw.filter((n) => !this.isTrivialPart(n));   // 废料节点不作陪读目标
    if (!src.length) return false;
    let goal = ra.goal && src.find((n) => n.id === ra.goal.id);
    if (!goal && ra.goal) goal = src.find((n) => n.from === ra.goal.from && n.to === ra.goal.to);
    if (!goal) goal = src.find((n) => !((this.doc.partsDone || {})[n.id]));
    if (!goal) return false;
    this.readalong = { on: true, goal, bannerShownFor: ra.bannerShownFor || null };
    const btn = document.getElementById('btnReadalong');
    btn.textContent = '🚶 陪读:开';
    btn.classList.add('active-btn');
    document.getElementById('raProgressWrap').classList.remove('hidden');
    this.setGoal(goal);
    return true;
  },

  toggleReadalong() {
    const d = this.doc;
    if (!d) { SR.toast('先打开一个 PDF'); return; }
    const btn = document.getElementById('btnReadalong');
    this.readalong.on = !this.readalong.on;
    document.getElementById('raProgressWrap').classList.toggle('hidden', !this.readalong.on);
    if (this.readalong.on) {
      this.setGoal(this.currentPart() || d.parts[0]);
      SR.toast('🚶 陪读已开启：读完目标部分会提醒你复盘');
    } else {
      this.readalong.goal = null;
      this.hideBanner();
      SR.toast('陪读已关闭');
    }
    btn.textContent = this.readalong.on ? '🚶 陪读:开' : '🚶 陪读:关';
    btn.classList.toggle('active-btn', this.readalong.on);
  },

  setGoal(part) {
    if (!part) return;
    this.readalong.goal = part;
    this.readalong.bannerShownFor = null;
    const el = document.getElementById('raGoal');
    if (el) el.textContent = `🎯 ${part.title} (p.${part.from}–${part.to})`;
    this.updateRaProgress(this.doc ? this.doc.readPos : 1);
    SR.persist.save();
  },

  onReadalongTick(curPage) {
    if (!this.readalong.on || !this.readalong.goal || !this.doc) return;
    const g = this.readalong.goal;
    this.updateRaProgress(curPage);
    const done = this.doc.partsDone && this.doc.partsDone[g.id];
    if (curPage >= g.to && this.readalong.bannerShownFor !== g.id && !done) {
      this.readalong.bannerShownFor = g.id;
      this.showBanner(g);
    }
  },

  updateRaProgress(cur) {
    const g = this.readalong.goal;
    const bar = document.getElementById('raProgress');
    if (!g || !bar) return;
    const span = Math.max(1, g.to - g.from + 1);
    const pct = Math.max(0, Math.min(100, ((cur - g.from + 1) / span) * 100));
    bar.style.width = pct + '%';
    document.getElementById('raProgressText').textContent = `陪读 ${Math.min(cur > g.to ? span : cur - g.from + 1, span)}/${span} 页`;
  },

  showBanner(part) {
    const b = document.getElementById('reviewBanner');
    document.getElementById('bannerText').textContent = `读到这里，「${part.title}」应该读完了 —— 现在复盘吗？`;
    b.classList.remove('hidden');
    b.dataset.partId = part.id || '';
  },

  hideBanner() {
    document.getElementById('reviewBanner').classList.add('hidden');
  },

  async nextPartAfter(part) {
    const d = this.doc;
    if (!d || !d.parts.length) return null;
    const i = d.parts.findIndex((p) => p.id === (part && part.id));
    return d.parts[i + 1] || null;
  },

  async advanceGoal() {
    const d = this.doc;
    const next = await this.nextPartAfter(this.readalong.goal);
    if (!next) { SR.toast('🎉 这本书的陪读目标全部完成！'); this.toggleReadalong(); return; }
    this.setGoal(next);
    this.scrollToPage(next.from);
    SR.toast(`下一个目标：${next.title} (p.${next.from}–${next.to})`);
  },

  markPartDone(partId) {
    const d = this.doc;
    if (!d || !partId) return;
    d.partsDone = d.partsDone || {};
    d.partsDone[partId] = { at: Date.now() };
    this.saveAnnDebounced();
    SR.persist.save();
    this.renderBookmap();
    this.refreshPartSelect();                          // 选择器里的 ✅ 同步
  },

  /* ===== 知识地图（拆书 DAG） ===== */
  async loadBookmap() {
    const d = this.doc;
    if (!d) return null;
    try {
      const r = await SR.api('/api/bookmap?path=' + encodeURIComponent(d.path));
      d.bookmap = (r && r.nodes && r.nodes.length) ? r : null;
    } catch { d.bookmap = null; }
    this.refreshPartSelect();                          // 节点加载后进入选择器
    return d.bookmap;
  },

  async generateBookmap() {
    const d = this.doc;
    if (!d) { SR.toast('先打开一个 PDF'); return; }
    if (!d.outline.length && !d.parts.length) { SR.toast('此 PDF 没有目录，无法拆书'); return; }
    SR.toast('🗺 正在让 AI 拆书（需要 LLM）…', 'info', 4000);
    const ol = d.outline.map((it) => it.title).filter(Boolean);
    const pages = [];
    for (const it of d.outline.slice(0, 60)) {
      const pg = await this.destToPage(it.dest);
      pages.push({ title: it.title || '', page: pg || 1 });
    }
    const sys = `你是教材设计专家。把一本书/论文的目录拆解为知识节点 DAG，用于苏格拉底式陪读。
要求：
1. 每个节点是一段可独立阅读的页码区间（from,to 整数，1..${d.pages}，覆盖全书不重叠可合并零散小节）；
2. 节点要少而重要（4-14 个），不是照抄目录；
3. 【禁止】为封面、版权页（Copyright）、献词、目录、作者简介等前置废料生成节点——从正文第一个实质章节开始；
4. deps 是前置节点 id 数组（可空），体现依赖关系，允许并行路线；
5. minutes 预计阅读分钟数；difficulty 1-3；risk:true 表示"不真懂后面全白学"的高风险节点；
6. reason 一句话说明该节点讲什么。
输出格式（严格遵守，这会被程序解析）：
- 只输出一个 JSON 数组，不要 markdown 代码块，不要任何解释文字；
- 字符串值内部【禁止出现英文双引号 "】——需要引用术语时用「」；
- 不要注释、不要尾逗号、键名和结构完全如下例：
[{"id":"A1","title":"逻辑门","from":10,"to":28,"minutes":45,"difficulty":2,"deps":["A0"],"risk":true,"reason":"用电路实现布尔运算"}]`;
    const user = `书名：${d.title}\n总页数：${d.pages}\n目录（含起始页）：\n${pages.map((p) => `- p.${p.page} ${p.title}`).join('\n')}`;
    let nodes = null;
    try {
      const r = await SR.apiPost('/api/llm/chat', { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], stream: false, temperature: 0.3 });
      const parsed = window.SRJsonFix.parseLLMJsonArray(r.content || '');
      if (Array.isArray(parsed) && parsed.length) {
        nodes = parsed
          .map((n) => ({
            id: String(n.id || n.title || '').slice(0, 16),
            title: String(n.title || '').trim(),
            from: Math.max(1, Math.round(Number(n.from)) || 1),
            to: Math.min(d.pages, Math.max(1, Math.round(Number(n.to)) || 1)),
            minutes: Math.min(600, Math.max(5, Math.round(Number(n.minutes)) || 20)),
            difficulty: Math.min(3, Math.max(1, Math.round(Number(n.difficulty)) || 1)),
            deps: Array.isArray(n.deps) ? n.deps.map(String).slice(0, 6) : [],
            risk: !!n.risk,
            reason: String(n.reason || '').slice(0, 200),
          }))
          .filter((n) => n.title && n.id && n.to >= n.from)
          .filter((n) => !this.isTrivialPart(n));      // AI 偶尔仍会产出废料节点，双保险
      }
    } catch (e) {
      SR.toast('AI 拆书失败：' + e.message, 'error', 5000);
    }
    if (!Array.isArray(nodes) || !nodes.length) {
      // 降级：直接用目录当节点
      nodes = d.parts.map((p, i) => ({
        id: p.id, title: p.title, from: p.from, to: p.to,
        minutes: Math.max(10, Math.round((p.to - p.from + 1) * 3)),
        difficulty: 1, deps: i > 0 ? [d.parts[i - 1].id] : [], risk: false, reason: '',
      }));
      SR.toast('已用目录生成基础地图（AI 不可用时降级）');
    }
    d.bookmap = { nodes, generatedAt: Date.now() };
    await SR.apiPut('/api/bookmap', { path: d.path, title: d.title, nodes }).catch(() => {});
    this.renderBookmap();
    this.refreshPartSelect();                          // 新节点立即可选为带读范围
    SR.toast(`🗺 拆书完成：${nodes.length} 个知识节点（已加入部分选择器）`, 'success');
  },

  renderBookmap() {
    const d = this.doc;
    const panel = document.getElementById('panelMap');
    if (!panel) return;
    panel.innerHTML = '';
    if (!d) { panel.appendChild(SR.el('div', { class: 'hint pad' }, '打开 PDF 后点「🗺 拆书」生成知识地图')); return; }
    if (!d.bookmap || !d.bookmap.nodes.length) {
      panel.appendChild(SR.el('div', { class: 'hint pad' }, '还没有知识地图。点击顶部工具栏「🗺 拆书」让 AI 把这本书拆成带依赖关系的节点。'));
      return;
    }
    const nodes = d.bookmap.nodes.filter((n) => !this.isTrivialPart(n)); // 存量书图里的废料节点不显示
    if (!nodes.length) {
      panel.appendChild(SR.el('div', { class: 'hint pad' }, '知识地图没有实质节点。'));
      return;
    }
    // 拓扑分层显示
    const level = {};
    const getId = (n) => n.id;
    const resolve = (id, seen = new Set()) => {
      if (level[id] !== undefined) return level[id];
      if (seen.has(id)) return 0;
      seen.add(id);
      const n = nodes.find((x) => getId(x) === id);
      let lv = 0;
      for (const dep of (n && n.deps) || []) lv = Math.max(lv, resolve(dep, seen) + 1);
      level[id] = lv;
      return lv;
    };
    nodes.forEach((n) => resolve(n.id));
    const maxLv = Math.max(0, ...Object.values(level));
    panel.appendChild(SR.el('div', { class: 'section-title' }, `🗺 知识地图 · ${nodes.length} 节点（${Object.keys(d.partsDone || {}).length} 已打卡）`));
    for (let lv = 0; lv <= maxLv; lv++) {
      const group = nodes.filter((n) => level[n.id] === lv);
      if (!group.length) continue;
      if (lv > 0) panel.appendChild(SR.el('div', { class: 'map-level-title' }, `▼ 依赖层 ${lv}（可在此层自由选择）`));
      for (const n of group) {
        const done = d.partsDone && d.partsDone[n.id];
        const cur = this.readalong.goal && this.readalong.goal.id === n.id;
        const stars = '★'.repeat(n.difficulty || 1) + '☆'.repeat(3 - (n.difficulty || 1));
        const row = SR.el('div', {
          class: 'map-node' + (done ? ' done' : '') + (cur ? ' current' : ''),
          title: (n.reason || '') + `\np.${n.from}–${n.to} · 约 ${n.minutes || '?'} 分钟` + (n.risk ? ' · ⚠ 高风险节点' : ''),
        });
        row.appendChild(SR.el('div', { class: 'map-node-title' },
          (done ? '✅ ' : n.risk ? '⚠️ ' : '') + `${n.id} ${SR.esc(n.title)}`));
        row.appendChild(SR.el('div', { class: 'map-node-meta' },
          `p.${n.from}–${n.to} · ${n.minutes || '?'}min · ${stars}`));
        const ops = SR.el('div', { class: 'map-node-ops' });
        ops.appendChild(SR.el('button', { onclick: () => this.scrollToPage(n.from) }, '跳转'));
        ops.appendChild(SR.el('button', {
          onclick: () => {
            const part = { id: n.id, title: n.title, from: n.from, to: Math.min(n.to, d.pages) };
            if (!this.readalong.on) this.toggleReadalong();
            this.setGoal(part);
            this.scrollToPage(part.from);
            SR.toast(`🎯 陪读目标：${n.title}`);
          },
        }, '设为陪读目标'));
        ops.appendChild(SR.el('button', {
          onclick: () => SR.chat.startPartReview({ id: n.id, title: n.title, from: n.from, to: Math.min(n.to, d.pages) }),
        }, '直接复盘'));
        if (n.deps && n.deps.length) {
          row.appendChild(SR.el('div', { class: 'map-node-deps' }, '⇠ 依赖：' + n.deps.join(', ')));
        }
        row.appendChild(ops);
        panel.appendChild(row);
      }
    }
  },
};
SR.reader.saveAnnDebounced = SR.debounce(() => SR.reader.saveAnn(), 800);
SR.reader.saveAnn = async function () {
  const d = SR.state.doc;
  if (!d) return;
  try {
    await SR.apiPut('/api/annotations', {
      path: d.path, title: d.title, pages: d.pages, readPos: SR.reader.currentPage(),
      annotations: d.ann, partsDone: d.partsDone || {}, weakPoints: d.weakPoints || [],
    });
  } catch (e) { console.warn('批注保存失败', e); }
};
