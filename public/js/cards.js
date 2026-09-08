/* SuperMemo 制卡：摘录 / 挖空 / 问答 + vault Markdown 同步 + Q&A 导出 */
'use strict';

SR.cards = {
  _edit: null,     // 当前编辑中的卡
  _source: null,
  panelEl: null,

  async load() {
    try { SR.state.cards = (await SR.api('/api/cards')).cards || []; }
    catch { SR.state.cards = []; }
  },

  /* ---------- 制卡对话框 ---------- */
  openModal(prefill = {}) {
    const dlg = document.getElementById('dlgCard');
    this._edit = prefill.id || null;
    this._source = prefill.source || null;
    const typeSel = document.getElementById('cardType');
    typeSel.value = preill.type || 'extract';
    document.getElementById('cardFront').value = prefill.front || '';
    document.getElementById('cardBack').value = prefill.back || '';
    document.getElementById('cardTags').value = (prefill.tags || []).join(', ');
    const src = this._source;
    document.getElementById('cardSource').textContent = src && src.file
      ? `来源：${src.file.split(/[\\/]/).pop()}${src.page ? ' · p.' + src.page : ''}`
      : '';
    this.syncTypeUI();
    dlg.showModal();
    setTimeout(() => document.getElementById('cardFront').focus(), 50);
  },

  syncTypeUI() {
    const t = document.getElementById('cardType').value;
    document.getElementById('clozeBar').classList.toggle('hidden', t !== 'cloze');
    document.getElementById('cardFrontLabel').textContent =
      t === 'extract' ? '摘录内容（阅读卡片）' : t === 'cloze' ? '句子（用 [[ ]] 挖空关键词）' : '问题（正面）';
    document.getElementById('cardBackLabel').textContent =
      t === 'qa' ? '答案（背面）' : '备注 / 你的想法（可选）';
    document.getElementById('cardDlgTitle').textContent =
      t === 'extract' ? '📖 摘录制卡' : t === 'cloze' ? '🕳 挖空制卡' : '❓ 问答制卡';
  },

  clozeSelection() {
    const ta = document.getElementById('cardFront');
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { SR.toast('请先在文本框中选中要挖空的词'); return; }
    const v = ta.value;
    ta.value = v.slice(0, s) + '[[' + v.slice(s, e) + ']]' + v.slice(e);
    ta.focus();
  },

  collect() {
    const t = document.getElementById('cardType').value;
    const front = document.getElementById('cardFront').value.trim();
    if (!front) { SR.toast('内容不能为空', 'error'); return null; }
    return {
      id: this._edit || undefined,
      type: t,
      front,
      back: document.getElementById('cardBack').value.trim(),
      tags: document.getElementById('cardTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      source: this._source || {},
    };
  },

  async save(alsoCopy = false) {
    const card = this.collect();
    if (!card) return false;
    try {
      const r = await SR.apiPost('/api/cards', { card });
      SR.state.cards = r.cards;
      if (alsoCopy) SR.copyText(this.qaText(card));
      SR.toast('卡片已保存 🗂' + (alsoCopy ? '（Q/A 已复制）' : ''), 'success');
      document.getElementById('dlgCard').close();
      this.renderPanel();
      return true;
    } catch (e) {
      SR.toast('保存失败：' + e.message, 'error');
      return false;
    }
  },

  qaText(c) {
    const src = c.source && c.source.file
      ? `（${c.source.file.split(/[\\/]/).pop()}${c.source.page ? ' p.' + c.source.page : ''}）` : '';
    if (c.type === 'qa') return `Q: ${c.front}\nA: ${c.back}`;
    if (c.type === 'cloze') {
      const q = c.front.replace(/\[\[([^\]]+)\]\]/g, '[...]');
      const a = [...c.front.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]).join('；');
      return `Q: ${q}\nA: ${a}${src}`;
    }
    return `Q: 请回忆这段摘录${src}：「${c.front.slice(0, 50)}…」\nA: ${c.front}${src}`;
  },

  /* ---------- 卡片抽屉 ---------- */
  togglePanel() {
    if (!this.panelEl) {
      this.panelEl = SR.el('div', { id: 'cardsPanel' });
      this.panelEl.style.display = 'none';
      document.body.appendChild(this.panelEl);
    }
    const showing = this.panelEl.style.display === 'flex';
    this.panelEl.style.display = showing ? 'none' : 'flex';
    if (!showing) this.renderPanel();
  },

  renderPanel() {
    const p = this.panelEl;
    if (!p) return;
    const typeFilter = p.querySelector('#cardFType') ? p.querySelector('#cardFType').value : 'all';
    p.innerHTML = '';
    p.appendChild(SR.el('div', { class: 'head' },
      SR.el('span', { class: 'title' }, `🗂 卡片库（${SR.state.cards.length}）`),
      SR.el('button', { class: 'ghost small', onclick: () => SR.cards.export('md') }, ' 导出到 vault MD'),
      SR.el('button', { class: 'ghost small', onclick: () => SR.cards.export('qa') }, ' SM Q&A'),
      SR.el('button', { class: 'ghost small', onclick: () => { p.style.display = 'none'; } }, '✕'),
    ));
    const filters = SR.el('div', { class: 'filters' });
    const typeSel = SR.el('select', { id: 'cardFType', onchange: () => SR.cards.renderPanel() },
      SR.el('option', { value: 'all' }, '全部类型'),
      SR.el('option', { value: 'extract' }, '📖 摘录卡'),
      SR.el('option', { value: 'cloze' }, '🕳 挖空卡'),
      SR.el('option', { value: 'qa' }, '❓ 问答卡'),
    );
    typeSel.value = typeFilter;
    filters.appendChild(typeSel);
    p.appendChild(filters);
    const list = SR.el('div', { class: 'list' });
    const cards = SR.state.cards.filter((c) => typeFilter === 'all' || c.type === typeFilter);
    if (!cards.length) list.appendChild(SR.el('div', { class: 'empty-tip' }, '还没有卡片。<br>阅读时选中文字 → 🗂，或在对话中点「制卡」。'));
    for (const c of [...cards].reverse()) {
      const frontHtml = SR.esc(c.front).replace(/\[\[([^\]]+)\]\]/g, '<span class="cz">$1</span>');
      list.appendChild(SR.el('div', { class: 'card-item' },
        SR.el('div', {},
          SR.el('span', { class: `type ${c.type}` }, { extract: '📖 摘录', cloze: '🕳 挖空', qa: '❓ 问答' }[c.type]),
          c.tags && c.tags.length ? SR.el('span', { class: 'muted' }, ' #' + c.tags.join(' #')) : null,
        ),
        SR.el('div', { class: 'front', html: frontHtml }),
        c.back ? SR.el('div', { class: 'back' }, c.back) : null,
        c.source && c.source.file ? SR.el('div', { class: 'src' }, `📎 ${c.source.file.split(/[\\/]/).pop()}${c.source.page ? ' · p.' + c.source.page : ''}`) : null,
        SR.el('div', { class: 'ops' },
          SR.el('button', { onclick: () => SR.copyText(SR.cards.qaText(c)) }, '复制'),
          SR.el('button', {
            onclick: () => {
              SR.cards.openModal({ id: c.id, type: c.type, front: c.front, back: c.back, tags: c.tags, source: c.source });
            },
          }, '编辑'),
          SR.el('button', {
            onclick: async () => {
              if (!confirm('删除这张卡片？')) return;
              SR.state.cards = (await SR.api('/api/cards?id=' + c.id, { method: 'DELETE' })).cards;
              SR.cards.renderPanel();
            },
          }, '删除'),
        ),
      ));
    }
    p.appendChild(list);
  },

  async export(format) {
    try {
      const r = await SR.apiPost('/api/cards/export', { format });
      SR.toast(`已导出 ${r.count} 张 → ${r.path}`, 'success', 6000);
      SR.copyText(r.path);
    } catch (e) {
      SR.toast('导出失败：' + e.message, 'error', 5000);
    }
  },

  init() {
    document.getElementById('cardType').onchange = () => this.syncTypeUI();
    document.getElementById('btnCloze').onclick = () => this.clozeSelection();
    document.getElementById('btnCardCancel').onclick = () => document.getElementById('dlgCard').close();
    document.getElementById('btnCardClose').onclick = () => document.getElementById('dlgCard').close();
    document.getElementById('btnCardSave').onclick = () => this.save(false);
    document.getElementById('btnCardSaveCopy').onclick = () => this.save(true);
  },
};
