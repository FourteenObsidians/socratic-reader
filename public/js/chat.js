/* 苏格拉底对话：部分复盘 / 选段提问 / 自由探索 / 重点总结 */
'use strict';

SR.chat = {
  busy: false,
  abort: null,

  /* ---------- 会话管理 ---------- */
  newSession(mode, title, context, systemPrompt) {
    this.clearStream();
    this.closeAllTermCards();   // 换会话时清空速查卡栈（术语链属于旧语境）
    this._focusKey = null;   // 带读位置标记去重（每次新标记只触发一次聚焦）
    SR.state.session = {
      id: Date.now(), mode, title, context,
      system: systemPrompt,
      messages: [], // {role:'user'|'assistant', content}
    };
    document.getElementById('chatTitle').textContent = title;
    const ctx = document.getElementById('chatContext');
    if (context && context.brief) {
      ctx.innerHTML = SR.esc(context.brief);
      ctx.classList.remove('hidden');
    } else ctx.classList.add('hidden');
    this.renderChips(mode);
    document.getElementById('chatMsgs').innerHTML = '';
    this.showAiPanel();
    this.setPdfMask(mode === 'part');   // 复盘=检索练习，收起 PDF 防开卷
    SR.persist.save();
  },

  /* 刷新后恢复会话（含文本过大被丢弃时的重新提取） */
  async restoreSession(sess) {
    if (!sess || !sess.messages || !sess.messages.length) return false;
    SR.state.session = { ...sess, messages: sess.messages.slice() };
    const s = SR.state.session;
    const ctx = s.context;
    if (ctx && ctx.textDropped && ctx.file && SR.state.doc && ctx.file === SR.state.doc.path && ctx.from && ctx.to) {
      try {
        const mat = await SR.reader.getPartMaterial({ from: ctx.from, to: ctx.to });
        if (mat.text) { ctx.text = mat.text; ctx.highlights = mat.highlights; delete ctx.textDropped; }
      } catch { /* 正文补不回来也不影响对话继续 */ }
    }
    document.getElementById('chatTitle').textContent = s.title || '🤖 苏格拉底引导者';
    const ctxEl = document.getElementById('chatContext');
    if (ctx && ctx.brief) { ctxEl.innerHTML = SR.esc(ctx.brief); ctxEl.classList.remove('hidden'); }
    else ctxEl.classList.add('hidden');
    this.renderChips(s.mode);
    this.renderMsgs();
    this.showAiPanel();
    this.setPdfMask(s.mode === 'part');
    return true;
  },

  _resetChatUi() {
    this.setPdfMask(false);
    document.getElementById('chatTitle').textContent = '🤖 苏格拉底引导者';
    document.getElementById('chatContext').classList.add('hidden');
    document.getElementById('chatChips').classList.add('hidden');
    const ex = document.getElementById('btnExportChat');
    if (ex) ex.classList.add('hidden');
    document.getElementById('chatMsgs').innerHTML = `
      <div class="chat-empty"><div class="big">🏛</div>
      <p>我是您的苏格拉底式引导者。<br>我将仅通过提问来协助您思考——不提供答案，但会认真对待每一个想法。</p></div>`;
  },

  clear() {
    this.closeAllTermCards();   // 清对话页连同速查卡栈
    SR.persist.dropSession(SR.persist.bucketOf(SR.state.session));   // 只删本书的对话页，别的书不受影响
    SR.state.session = null;
    SR.persist.clearSession();
    this._resetChatUi();
  },

  /* 换书时切换对话页：当前对话收进它所属的书（保留），再恢复新书的页；新书没对话则空页 */
  async swapSession(docPath) {
    this.clearStream();
    SR.persist.stashSession();
    const sess = SR.persist.getSession(docPath);
    if (sess && sess.messages && sess.messages.length) {
      await this.restoreSession(sess);
      SR.toast('💬 已切到本书的对话页');
    } else {
      SR.state.session = null;
      SR.persist.clearSession();
      this._resetChatUi();
    }
  },

  showAiPanel() {
    document.body.classList.remove('ai-hidden');
    const s = SR.state.session;
    const ex = document.getElementById('btnExportChat');
    if (ex) ex.classList.toggle('hidden', !(s && s.messages && s.messages.length));
    setTimeout(() => { const m = document.getElementById('chatMsgs'); m.scrollTop = m.scrollHeight; }, 60);
  },

  /* 复盘闭卷模式：检索练习时收起 PDF（余光扫到原文，检索效果就归零）。
     不锁死——聊天头部留「👁 偷看原文」按钮，想核对随时掀开（刻意保留摩擦）。 */
  setPdfMask(on) {
    const was = document.body.classList.contains('pdf-masked');
    document.body.classList.toggle('pdf-masked', !!on);
    const btn = document.getElementById('btnPeek');
    if (btn) {
      btn.classList.toggle('hidden', !on);
      btn.textContent = '👁 偷看原文';
      btn.title = '暂时掀开 PDF 核对（复盘应先凭记忆作答）';
    }
    if (on && !was) SR.toast('闭卷复盘：PDF 已蒙上毛玻璃——先凭记忆作答，需要核对再点「👁 偷看」', 'info', 5000);
  },

  renderChips(mode) {
    const box = document.getElementById('chatChips');
    const defs = {
      part: [
        ['🧭 深挖', () => this.send('（指令）请切换到深挖模式：从第一性原理、哲学基础、数学基础三个维度继续向我提问。')],
        ['🫣 盲区检查', () => this.send('（指令）请进行盲区检查：回顾我们讨论过的所有内容，指出哪些重要的问题完全没有被提到，并用提问引导我思考这些盲区。')],
        ['🍳 通俗解释', () => this.send('（指令）我没读懂，请直接解释：用 300 字通俗介绍这部分内容，举一个做饭相关的例子，并解释核心概念。')],
        ['📝 生成重点总结', () => this.summarize('part')],
        ['✅ 结束并归档', () => this.archiveLearning()],
      ],
      guide: [
        ['⏭ 进入下一块', () => this.send('（指令）这一块我已经明白了，请串联后进入下一块：先一句话连接上一块，再介绍新块并提出问题。')],
        ['🧪 过关测验', () => this.send('（指令）这一部分我读完了，请按规则启动过关测验：先让我凭记忆串讲主线，然后出 3 道闭卷小测（机制复述/实例演算/迁移判断各一），逐题判定；全对才宣布过关，有错就补救后换角度再验。')],
        ['🍳 这块没读懂', () => this.send('（指令）这块我没读懂，请直接解释：用大白话讲清当前块的精髓（可举一个生活化的例子），讲完立刻用一个验证问题确认我理解了。')],
        ['🧭 深挖', () => this.send('（指令）请就当前这块切换到深挖模式：从第一性原理、哲学基础、数学基础三个维度继续向我提问。')],
        ['📝 带读总结', () => this.summarize('part')],
        ['✅ 结束并归档', () => this.archiveLearning()],
      ],
      review: [
        ['🩹 我不记得了', () => this.send('（指令）这块我想不起来了：请从材料中给我一个能推出答案的提示性小问题，帮我重新建构，不要直接给完整答案。')],
        ['📝 巩固记录', () => this.summarize('explore')],
        ['✅ 结束并归档', () => this.archiveLearning()],
      ],
      explore: [
        ['🔄 换个角度', () => this.send('（指令）请换一个完全不同的角度（学科视角 / 时间尺度 / 抽象层级）继续向我提问。')],
        ['💡 给我一点背景', () => this.send('（指令）我卡住了，请给出一段不超过 80 字的最小必要背景，然后继续用一个新问题引导我。')],
        ['📝 总结收获并保存', () => this.summarize('explore')],
        ['✅ 结束并归档', () => this.archiveLearning()],
      ],
      sel: [
        ['✅ 结束并归档', () => this.archiveLearning()],
      ],
      wit: [
        ['🗺 Claim–Evidence 地图', () => this.send('（指令）跳到 Claim–Evidence 地图阶段：抽取本部分 2–4 个 major claims，表格呈现每个的支撑证据、证据强度与剩余不确定性，然后挑最薄弱的一个问我。')],
        ['🎯 六维拷问', () => this.send('（指令）跳到六维拷问阶段：从 Whether/What/Why/How/When/To what extent 中挑最能动摇 central claim 的一维，拷问一个具体 claim。')],
        ['⚔️ 竞争解释', () => this.send('（指令）跳到竞争解释阶段：对关键 finding 列出 2–3 个竞争假设，先问我哪个最可信、什么实验能区分它们，再给分析。')],
        ['🕵️ 审稿人压力测试', () => this.send('（指令）跳到审稿人压力测试：列 Top-3 挑战并分类（能补实验/已有数据能分析/只能写 limitation/致命伤）。')],
        ['🏁 收束', () => this.send('（指令）收束：给最小完整故事——Central Question / Central Claim / 2–3 个 Key Findings / 最脆弱的一环 / 值得追问的下一个问题。')],
        ['📝 WIT 纪要', () => this.summarize('part')],
        ['✅ 结束并归档', () => this.archiveLearning()],
      ],
      done: [],
    };
    const list = defs[mode] || [];
    box.innerHTML = '';
    for (const [label, fn] of list) box.appendChild(SR.el('button', { class: 'chip', onclick: fn }, label));
    box.classList.toggle('hidden', !list.length);
  },

  /* ---------- 渲染 ---------- */
  renderMsgs() {
    const s = SR.state.session;
    const box = document.getElementById('chatMsgs');
    box.innerHTML = '';
    if (!s) return this.clear();
    s.messages.forEach((m, i) => { if (!m.injected) box.appendChild(this.msgEl(m, i)); });
    box.scrollTop = box.scrollHeight;
  },

  /* ---- 按需取全文（知识库 tool-call 手搓版）----
     AI 回复中出现 ?note[[条目名]] / ?pages[N] / ?pages[N-M] → 拦截：
     从 vault / 会话存档取原文 → 以注入消息补进上下文 → 自动续写。
     注入消息带 injected 标记：不渲染、不占界面，只进模型上下文。 */
  async _onDemandCont(s, acc) {
    const marks = [];
    let cleaned = acc;
    cleaned = cleaned.replace(/\?note\[\[([^\]\n]{1,80})\]\]/g, (_, n) => { marks.push({ kind: 'note', name: n.trim() }); return ''; });
    cleaned = cleaned.replace(/\?pages\[(\d+)(?:-(\d+))?\]/g, (_, a, b) => { marks.push({ kind: 'pages', from: +a, to: +(b || a) }); return ''; });
    if (!marks.length) return null;
    const bits = [];
    for (const mk of marks.slice(0, 2)) {
      if (mk.kind === 'note') {
        try {
          const r = await SR.api('/api/notes/get?name=' + encodeURIComponent(mk.name));
          bits.push(r.found
            ? `【知识库条目 [[${mk.name}]]】（${r.rel}）
${r.content}`
            : `【知识库条目 [[${mk.name}]]】未找到——vault 里没有这个文件名的笔记。基于已有上下文继续，不要编造该条目内容。`);
        } catch (e) { bits.push(`【知识库条目 [[${mk.name}]]】读取失败：${e.message}`); }
      } else {
        const full = s._matFull;
        if (!full) { bits.push('【材料原文】本会话未存档原文，无法取页。'); continue; }
        const pages = [];
        const re = /\[p\.(\d+)\]\n?([\s\S]*?)(?=\n\[p\.|$)/g;
        let m;
        while ((m = re.exec(full))) { const pn = +m[1]; if (pn >= mk.from && pn <= mk.to) pages.push(`[p.${pn}]\n${m[2].trim()}`); }
        bits.push(pages.length ? `【材料原文 p.${mk.from}${mk.to > mk.from ? '–' + mk.to : ''}】\n${pages.join('\n\n')}` : `【材料原文 p.${mk.from}】没有这一页。`);
      }
    }
    return { cleaned, inject: bits.join('\n\n') };
  },

  /* 带读联动：扫描流式文本中的位置标记（行完整后才触发）。
     格式 @pN[-M]|开头短语[→结尾短语]；| 后整行都是标记的一部分，绝不留残渣 */
  _parseMarker(line) {
    const m = /^@p(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?(?:\|(.*))?$/.exec(line.trim());
    if (!m) return null;
    let q1 = '', q2 = '';
    if (m[3] !== undefined) {
      const parts = String(m[3]).split('→').map((s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60));
      q1 = parts[0] || '';
      q2 = parts[1] || '';
    }
    return { page: m[1], to: m[2] || m[1], q1, q2 };
  },
  _focusScan(text) {
    const lines = text.split('\n');
    /* 只扫“完整行”：跳过最后一行——流式时它还在生长，半个标记（@p8|Jasm…）
       每个字符都会变 key，逐 delta 触发聚焦 = 当前文段疯狂闪烁 */
    for (let i = lines.length - 2; i >= 0; i--) {
      const mk = this._parseMarker(lines[i]);
      if (!mk) continue;
      const key = lines[i].trim();
      if (key === this._focusKey) return;              // 已聚焦过
      this._focusKey = key;
      if (SR.reader && SR.state.doc) SR.reader.focusPages(mk.page, mk.to, mk.q1, mk.q2);
      return;
    }
  },

  /* 消息里的位置标记渲染成可点击徽章。双档解析：
     行首标记（契约规定）→ | 后整行消费，绝不留残渣；
     行内标记（模型走样时）→ 保守匹配到空白为止，避免吞掉正文 */
  badgeify(html) {
    let s = String(html);
    s = s.replace(/^@p(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?\|(.*)$/gm, (m, a, b, rest) => {
      const parts = String(rest).split('→').map((x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 60));
      return `<span class="page-badge" data-from="${a}" data-to="${b || a}" data-quote="${SR.esc(parts[0] || '')}" data-q2="${SR.esc(parts[1] || '')}">📄 p.${a}${b ? `–${b}` : ''}</span>`;
    });
    s = s.replace(/(^|[^@\w])@p(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?(?:\|([^\s→|<>]{2,60}))?/g,
      (m, pre, a, b, q) => `${pre}<span class="page-badge" data-from="${a}" data-to="${b || a}" data-quote="${SR.esc(q || '')}" data-q2="">📄 p.${a}${b ? `–${b}` : ''}</span>`);
    return s;
  },

  /* 徽章渲染主路径：在【纯文本】上提取标记（与流式 _focusScan 同一解析器、同一数据源），
     md 渲染用 \u0000M 占位符隔离，渲染后换回完整徽章——彻底避开「md 把标记行包进 <p>
     导致行首锚失效、短语被截断、结尾短语丢失」的偏差（点击旧徽章范围跑偏的根源） */
  renderWithBadges(content) {
    const badges = [];
    const text = String(content || '').split('\n').map((line) => {
      const mk = this._parseMarker(line);
      if (!mk || !line.trim().startsWith('@p')) return line;      // 只接管"整行就是标记"的规范形态
      const a = mk.page, b = mk.to;
      badges.push(`<span class="page-badge" data-from="${a}" data-to="${b}" data-quote="${SR.esc(mk.q1)}" data-q2="${SR.esc(mk.q2)}">📄 p.${a}${a !== b ? `–${b}` : ''}</span>`);
      return `\u0000M${badges.length - 1}\u0000`;
    }).join('\n');
    return this.badgeify(SR.md(text)).replace(/\u0000M(\d+)\u0000/g, (_, i) => badges[Number(i)] || '');
  },

  /* 用户长消息（带读/复盘的材料投喂）折叠显示：发给 AI 的内容不变，只是聊天里不铺开 */
  _userBubble(m) {
    const text = String(m.content || '');
    if (text.length <= 800) return SR.el('div', { class: 'bubble', html: SR.esc(text).replace(/\n/g, '<br>') });
    const title = /标题：([^\n]+)/.exec(text);
    const part = /部分：([^\n（(]+)/.exec(text);
    const head = SR.el('div', { class: 'fold-head' },
      `📦 已投喂材料：${title ? title[1].trim() : '本部分'}${part ? ' · ' + part[1].trim() : ''}（${text.length.toLocaleString()} 字，含教学指令）`);
    const body = SR.el('div', { class: 'fold-body hidden', html: SR.esc(text).replace(/\n/g, '<br>') });
    const btn = SR.el('button', {
      class: 'ghost small',
      onclick: () => { body.classList.toggle('hidden'); btn.textContent = body.classList.contains('hidden') ? '展开全文' : '收起'; },
    }, '展开全文');
    const wrap = SR.el('div', { class: 'bubble' }, head, btn, body);
    return wrap;
  },

  msgEl(m, idx) {
    const actions = SR.el('div', { class: 'actions' });
    if (m.role === 'assistant' && m.content) {
      actions.appendChild(SR.el('button', { onclick: () => SR.copyText(m.content) }, '复制'));
      /* 制卡入口已下线：学习记录保存在 Obsidian 仓库，可在此制卡 */
    }
    return SR.el('div', { class: `msg ${m.role}` },
      m.role === 'assistant' ? SR.el('div', { class: 'bubble', html: this.renderWithBadges(m.content) }) : this._userBubble(m),
      actions);
  },

  /* ---------- 对话导出（长对话压缩策略） ----------
     ① 材料投喂消息（带【材料】头的巨型 user 消息）→ 压成一行：书名+部分+字数
     ② 其余消息：正常保留；AI 单条超长（>1500 字，如带读讲解连发）→ 保留开头 600 + 中间省略标注 + 结尾 400
     ③ 用户消息一律全量（问题本身就很短，且是学习轨迹的核心） */
  _squeezeMsg(m) {
    const t = String(m.content || '');
    if (m.role === 'user' && t.startsWith('【材料】')) {
      const title = (/标题：([^\n]+)/.exec(t) || [])[1] || '';
      const part = (/部分：([^\n（(]+)/.exec(t) || [])[1] || '';
      return `> 📦 [材料投喂已压缩] ${title.trim()}${part ? ' · ' + part.trim() : ''}（${t.length.toLocaleString()} 字，含教学指令）`;
    }
    if (m.role === 'assistant' && t.length > 1500) {
      return t.slice(0, 600) + '\n\n> …（中段 ' + (t.length - 1000).toLocaleString() + ' 字已省略）…\n\n' + t.slice(-400);
    }
    return t;
  },

  async exportChat(opts = {}) {
    const s = SR.state.session;
    if (!s || !s.messages || !s.messages.length) { SR.toast('当前没有可导出的对话'); return; }
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const modeName = { guide: '苏格拉底带读', wit: 'WIT 精读', part: '部分复盘', sel: '选段研读', review: '巩固复习', explore: '自由探索' }[s.mode] || s.mode;
    const ctx = s.context || {};
    const head = [
      `# ${modeName} · ${ctx.title || '对话记录'}`,
      '',
      `> ${ctx.brief ? String(ctx.brief).replace(/<[^>]+>/g, '') + ' · ' : ''}${now} · ${s.messages.length} 条消息`,
      ctx.partTitle ? `> 部分：${ctx.partTitle}（p.${ctx.from}–${ctx.to}）` : '',
      '',
    ].filter((l) => l !== undefined).join('\n');
    const body = s.messages.map((m) => {
      const who = m.role === 'user' ? '**我**' : '**引导者**';
      return `### ${who}\n\n${this._squeezeMsg(m)}\n`;
    }).join('\n');
    const stamp = now.replace(/[:]/g, '').replace(' ', '-');
    const filename = `${(ctx.title || ctx.topic || '对话').slice(0, 30)}-对话记录-${stamp}`;
    try {
      const r = await SR.apiPost('/api/notes/save', { filename, content: head + body, subdir: '对话记录' });
      if (!opts.silent) SR.toast('📤 已导出 ✅ ' + r.path, 'success', 6000);
      return r;
    } catch (e) { SR.toast('导出失败：' + e.message, 'error'); }
    return null;
  },

  appendStreamBubble() {
    const box = document.getElementById('chatMsgs');
    const el = SR.el('div', { class: 'msg assistant streaming' }, SR.el('div', { class: 'bubble' }));
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el.querySelector('.bubble');
  },

  clearStream() {
    if (this.abort) { try { this.abort.abort(); } catch {} this.abort = null; }
    this.busy = false;
    document.getElementById('btnStop').classList.add('hidden');
  },

  /* ---------- 发送 ---------- */
  /* ---------- 名词速查卡：带读途中岔题补课，独立消息流，主会话零污染 ----------
     支持递归：卡片里的解释又出现新名词 → 选中 → 再开一张卡（可叠多层，Esc 逐层关） */
  openTermCard(term, extraCtx) {
    const t = String(term || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!t) return;
    this._termStack = this._termStack || [];
    const depth = this._termStack.length;
    if (depth >= 5) { SR.toast('速查卡最多叠 5 层——先把这几层消化掉 🙂', 'info'); return; }
    const s = SR.state.session;
    /* 阅读写照：只给解释器定语境，不带走主会话消息（主线不受污染的关键） */
    const ctxBits = [];
    if (s && s.context && s.context.title) ctxBits.push(`《${s.context.title}》${s.context.partTitle ? ' · ' + s.context.partTitle : ''}`);
    if (extraCtx && extraCtx.page) ctxBits.push(`名词出现在 p.${extraCtx.page}`);
    const recent = depth === 0
      ? (((s && s.messages) || []).slice(-4)
        .map((m) => (m.role === 'user' ? '用户：' : '引导者：') + String(m.content).replace(/\s+/g, ' ').slice(0, 160)).join('\n'))
      : '';
    /* 术语链：A → B → C，让解释器知道这个词是从哪条追问链上冒出来的 */
    const chain = this._termStack.map((c) => c.term);
    const T = {
      term: t, depth, messages: [],
      system: [
        '你是名词速查卡：用户正在苏格拉底带读中遇到一个想搞清楚的名词，需要快速补课后立刻回到阅读。',
        '规则：',
        '1. 首轮解释 150–300 字：是什么 → 在当前阅读语境里扮演什么角色 → 一个最小例子或类比（数值或因果链，不糊弄）。术语只在中文易歧义时才括英文（一句至多一次）；涉及公式用规范 LaTeX（行内 $...$、独立 $$...$$），不用 Unicode 拼凑。',
        '2. 用户追问就直接答，不反问、不苏格拉底——他要的是快速补课，不是再来一轮引导。',
        '3. 同一个词在不同领域含义不同，解释必须贴合【阅读语境】。',
        '4. 全程简体中文；不要输出 @p 位置标记（这不是带读）。',
        ctxBits.length ? '\n【阅读语境】' + ctxBits.join(' · ') : '',
        chain.length ? `\n【术语链】${chain.join(' → ')} → ${t}（当前）：这个词是用户在查「${chain[chain.length - 1]}」时遇到的。解释 ${t} 时可以假定用户已了解链条上游的概念（不必重讲），但要点明它与上游词的关系（上位/并列/组件/对比）。` : '',
        recent ? '\n【最近讨论摘要（仅供理解语境）】\n' + recent : '',
      ].filter(Boolean).join('\n'),
    };
    const thread = SR.el('div', { class: 'tc-thread' });
    T.threadEl = thread;
    const input = SR.el('input', { class: 'tc-input', placeholder: depth ? '继续追问…（Enter 发送，Esc 关这张）' : '继续追问…（Enter 发送，Esc 关卡片）' });
    const send = () => {
      const q = input.value.trim();
      if (!q || T.busy) return;
      input.value = '';
      T.messages.push({ role: 'user', content: q });
      thread.appendChild(SR.el('div', { class: 'tc-q' }, '❓ ' + q.slice(0, 60)));
      this._termStream(T);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); send(); }
      if (ev.key === 'Escape') { ev.stopPropagation(); this.closeTermCard(); }
    });
    const parentTerm = chain.length ? chain[chain.length - 1] : null;
    const card = SR.el('div', { class: 'termCard' + (depth ? ' nested' : '') },
      SR.el('div', { class: 'tc-head' },
        SR.el('span', { class: 'tc-title' }, depth ? `📖 速查 · 第 ${depth + 1} 层` : '📖 名词速查'),
        SR.el('span', { class: 'tc-term' }, t),
        SR.el('button', { class: 'ghost small', title: parentTerm ? `关掉这张，回到「${parentTerm}」的卡片` : '关掉回到带读（主对话不受影响）', onclick: () => this.closeTermCard() }, '✕')),
      thread,
      SR.el('div', { class: 'tc-bar' }, input,
        SR.el('button', { class: 'primary small', onclick: send }, '追问'),
        SR.el('button', { class: 'ghost small tc-archive', title: '把这张卡沉淀为 Obsidian 概念条目（自动入学习 Wiki 关系网）', onclick: () => this.archiveTermCard(T) }, '📁 归档')),
      SR.el('div', { class: 'tc-foot' },
        parentTerm ? `解释里的新词可选中再开卡 · ✕ 回到「${parentTerm}」` : '解释里的新词可选中再开一张卡 · 带读未受影响'));
    document.body.appendChild(card);
    /* 层叠定位：越深越往左下错开，z-index 递增，露出下层标题栏方便切换视线 */
    if (depth) {
      card.style.right = (24 + depth * 26) + 'px';
      card.style.top = (76 + depth * 24) + 'px';
      card.style.width = Math.max(300, 400 - depth * 14) + 'px';
    }
    card.style.zIndex = 96 + depth;
    T.el = card;
    SR.draggable(card, card.querySelector('.tc-head'));   /* 标题栏拖动，不挡正文 */
    /* 卡片内选中文字 → 递归再开一张（术语链向下生长） */
    card.addEventListener('mouseup', () => {
      setTimeout(() => {
        let rect = null, txt = '';
        try {
          const sel = window.getSelection();
          txt = sel && sel.toString();
          if (txt && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
        } catch { /* 忽略 */ }
        this._showTermBtn(rect, txt, T);
      }, 10);
    });
    /* Esc 监听：栈从空到非空时挂一次，栈空时卸载 */
    if (depth === 0) {
      const esc = (ev) => { if (ev.key === 'Escape' && this._termStack && this._termStack.length) this.closeTermCard(); };
      document.addEventListener('keydown', esc);
      this._termCleanup = () => document.removeEventListener('keydown', esc);
    }
    this._termStack.push(T);
    this._termAsk(T, `请解释名词：「${t}」`, t);
  },

  async _termStream(T) {
    if (!T) return;
    T.busy = true;
    const ans = SR.el('div', { class: 'tc-answer' }, '…');
    T.threadEl.appendChild(ans);
    T.threadEl.scrollTop = T.threadEl.scrollHeight;
    let acc = '';
    try {
      acc = await SR.chatStream(
        [{ role: 'system', content: T.system }, ...T.messages],
        { onDelta: (_d, all) => { ans.textContent = all; T.threadEl.scrollTop = T.threadEl.scrollHeight; } },
      );
      ans.innerHTML = SR.md(acc);
      T.messages.push({ role: 'assistant', content: acc });
    } catch (e) {
      ans.innerHTML = `<b style="color:var(--red)">出错了：</b>${SR.esc(e.message)}`;
    } finally {
      T.busy = false;
      T.threadEl.scrollTop = T.threadEl.scrollHeight;
    }
  },

  _termAsk(T, text, display) {
    if (!T) return;
    T.messages.push({ role: 'user', content: text });
    T.threadEl.appendChild(SR.el('div', { class: 'tc-q' }, '❓ ' + (display || String(text).slice(0, 60))));
    this._termStream(T);
  },

  /* 关最上面一张（Esc / ✕）；栈空则卸载监听 */
  closeTermCard() {
    const st = this._termStack;
    if (!st || !st.length) { if (this._termCleanup) { this._termCleanup(); this._termCleanup = null; } return; }
    const T = st.pop();
    if (T && T.el) T.el.remove();
    const pop = document.querySelector('.term-pop'); if (pop) pop.remove();
    if (!st.length && this._termCleanup) { this._termCleanup(); this._termCleanup = null; }
  },

  closeAllTermCards() {
    while (this._termStack && this._termStack.length) this.closeTermCard();
  },

  /* ===== 速查卡归档：对话 → 结构化概念条目 → Obsidian（概念条目 + 学习Wiki 关系网） ===== */
  async archiveTermCard(T) {
    if (!T || T.archiving) return;
    if (!T.messages || !T.messages.length) { SR.toast('卡片还没有内容，先问点什么再归档'); return; }
    T.archiving = true;
    const btn = T.el && T.el.querySelector('.tc-archive');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 提取中…'; }
    const s = SR.state.session;
    const ctx = s && s.context ? `《${s.context.title}》${s.context.partTitle ? ' · ' + s.context.partTitle : ''}` : '';
    try {
      /* 1) LLM 从速查对话提取结构化条目（含相关概念清单，供 wikilink 与连点建卡） */
      const sys = [
        '你是知识库编辑。下面是一段「名词速查卡」对话（用户在阅读中查询一个名词）。把它沉淀为一个可长期检索的 Obsidian 概念条目。',
        '只输出 JSON 对象，不要代码块不要解释，字符串内禁用英文双引号（用「」）：',
        '{"title":"概念名（≤24字，与查询词一致或更规范）","aliases":["别名/英文原名"],"oneLine":"一句话核心（检索到就知道它是什么，≤60字）","sections":[{"h":"小节名","body":"内容（定义边界/机制推理链/具体例子/失效条件，markdown）"}],"related":[{"name":"相关概念名","rel":"上位/并列/组件/对比/前置","why":"一句话关系"}],"source":"出处（书名/部分，从语境推断）"}',
        '要求：内容必须来自对话本身（速查卡里怎么解释的就怎么沉淀，不额外发挥）；related 挑 2-5 个对话中真实出现的概念；body 里的关键术语用 [[wikilink]]。',
      ].join('\n');
      const conv = T.messages.map((m) => (m.role === 'user' ? '用户：' : '速查卡：') + m.content).join('\n\n').slice(0, 12000);
      const r = await SR.apiPost('/api/llm/chat', { messages: [{ role: 'system', content: sys }, { role: 'user', content: `${ctx ? '阅读语境：' + ctx + '\n\n' : ''}查询名词：${T.term}\n\n对话记录：\n${conv}` }], stream: false, temperature: 0.2 });
      let e = {};
      try { e = JSON.parse(SRJsonFix.parseLLMJsonArray('[' + (r.content || '').replace(/^\s*\{/, '').replace(/\}\s*$/, '') + ']')[0] || '{}'); } catch { /* 兜底：无结构化也能存原文 */ }
      if (!e.title) e.title = T.term;
      /* 2) 拼 Obsidian md（YAML 可被 Dataview 捕获；wikilink 进关系网） */
      const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const fm = [
        '---', 'type: concept', `title: ${e.title}`,
        (e.aliases && e.aliases.length) ? 'aliases: [' + e.aliases.slice(0, 4).join(', ') + ']' : '',
        `created: ${now}`, 'tags: [概念条目, 苏格拉底阅读器]',
        e.source ? `source: ${e.source}` : (ctx ? `source: ${ctx}` : ''),
        '---', '',
      ].filter(Boolean).join('\n');
      const body = (e.sections && e.sections.length ? e.sections.map((x) => `## ${x.h}\n\n${x.body}`).join('\n\n') : T.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n\n'));
      const relBlock = (e.related && e.related.length) ? [
        '## 相关概念', '',
        ...e.related.map((x) => `- [[${x.name}]]（${x.rel || '相关'}）——${x.why || ''}`),
        '',
      ].join('\n') : '';
      const md = [fm, `# ${e.title}`, '', `> [!abstract] ${e.oneLine || ''}`, '', body, '', relBlock,
        '## 来源对话', '', `${ctx || '阅读中'} · 名词速查 · ${now}`, ''].join('\n');
      /* 3) 写入 vault：概念条目目录 + 学习 Wiki 索引（服务端对缺失 wikilink 自动建占位条目） */
      const saved = await SR.apiPost('/api/notes/save', { subdir: '概念条目', filename: e.title, content: md, linkMissing: true });
      await SR.apiPost('/api/wiki/upsert', { entry: { id: e.title, link: e.title, oneLine: e.oneLine || '', topics: ['概念条目'].concat((e.related || []).map((x) => x.name).slice(0, 5)), type: '概念速查', source: e.source || ctx || '' } }).catch(() => {});
      if (btn) { btn.textContent = '✅ 已归档'; }
      SR.toast(`📁 已归档「${e.title}」→ ${saved.rel}（相关概念已连入 Wiki 索引）`, 'success', 5000);
      /* 4) 相关概念连点：一键为 related 里的概念批量建速查卡（逐个查+归档） */
      if (e.related && e.related.length && T.el) {
        const bar = SR.el('div', { class: 'tc-relbar' },
          SR.el('span', { class: 'tc-relhint' }, '相关概念：'),
          ...e.related.slice(0, 5).map((x) => SR.el('button', {
            class: 'ghost small tc-relbtn',
            title: (x.why || '') + '（点击开速查卡，满意可同样归档）',
            onclick: () => this.openTermCard(x.name, { parent: T }),
          }, `${x.rel || '?'} ${x.name}`)));
        const foot = T.el.querySelector('.tc-foot');
        if (foot) T.el.insertBefore(bar, foot);
      }
      T.archived = true;
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '📁 归档'; }
      SR.toast('归档失败：' + (err.message || err), 'error', 4000);
    } finally {
      T.archiving = false;
    }
  },

  /* 选中文字 → 浮出 📖 小按钮（带读气泡 / PDF / 速查卡内皆可；parentCard 存在则为递归层） */
  _showTermBtn(rect, txt, parentCard) {
    const old = document.querySelector('.term-pop'); if (old) old.remove();
    const t = String(txt || '').trim();
    if (!rect || t.length < 2 || t.length > 80) return;
    const btn = SR.el('button', { class: 'term-pop', title: parentCard ? '在这个词上再开一张速查卡（术语链向下）' : '名词速查卡（不中断带读）' }, '📖 速查');
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());   // 保住选区
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.openTermCard(t, parentCard ? { parent: parentCard } : null);
      btn.remove();
    });
    document.body.appendChild(btn);
    btn.style.left = Math.max(8, Math.min(window.innerWidth - 110, rect.left + rect.width / 2 - 45)) + 'px';
    /* 选区贴近卡片/窗口顶部时，按钮翻到选区下方，避免被卡片头部挡住 */
    const top = rect.top - 34;
    btn.style.top = (top < 70 ? Math.min(window.innerHeight - 40, rect.bottom + 8) : Math.max(8, top)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function once(ev2) {
      if (!(ev2.target && ev2.target.closest && ev2.target.closest('.term-pop'))) { btn.remove(); document.removeEventListener('mousedown', once); }
    }), 0);
  },

  async send(text) {
    const s = SR.state.session;
    if (!s) { SR.toast('请先开启一个对话（复盘 / 选段提问 / 自由探索）'); return; }
    if (!text || !text.trim() || this.busy) return;
    s._odDepth = 0;                       // 用户主动发话 → 按需续写深度清零
    /* 挂起的圈图优先走 multimodal */
    if (this._imgAsk) { await this._sendImgAsk(text.trim()); return; }
    s.messages.push({ role: 'user', content: text.trim() });
    this.renderMsgs();
    await this.stream();
  },

  async stream(extraSystem) {
    const s = SR.state.session;
    const input = document.getElementById('chatInput');
    const btnSend = document.getElementById('btnSend');
    const btnStop = document.getElementById('btnStop');
    input.value = ''; input.disabled = true; btnSend.disabled = true;
    btnStop.classList.remove('hidden');
    this.busy = true;
    this.abort = new AbortController();
    const bubble = this.appendStreamBubble();
    /* 最后一条 user 消息若有挂起的图片版内容 → 用 multimodal（仅本轮发送，会话里仍存占位文本） */
    const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
    const lastUserText = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
    const useImages = this._pendingImages && lastUser && s.messages[s.messages.length - 1] === lastUser;
    if (useImages) {
      s._mmIndex = s.messages.length - 1;                       // 记住被替换的位置，收尾时换回占位文本
      s.messages[s.messages.length - 1] = { role: 'user', content: this._pendingImages };
      this._pendingImages = null;
    }
    /* 输出语言指令：随配置注入 system 尾部（所有会话类型统一生效，含无 system 的圈图壳会话） */
    const lang = (SR.state.config && SR.state.config.llm && SR.state.config.llm.agentLang) || 'zh';
    const langDirective = lang === 'en'
      ? '【OUTPUT LANGUAGE】Always respond in English, regardless of the language of the reading material, figures, or the user. Keep technical terms as-is; original text quotations stay in their source language.'
      : '【输出语言】无论阅读材料、图表或用户使用什么语言，你必须全程用简体中文作答；专业术语、代码、图表标签可在括号里保留英文原文，引用原文时保留原文。';
    /* 知识库检索：开场第一轮用书/部分标题检索（供"好奇心钩子"用已知做桥梁），
       后续轮次用用户最新消息检索；无命中则退回协议头 */
    const topic = s.context ? (s.context.partTitle || s.context.title || '') : '';
    const memorySystem = (s.messages.length <= 2 && topic)
      ? await this.learningMemory(topic)
      : (lastUserText && !lastUserText.startsWith('【材料】'))
        ? await this.learningMemory(lastUserText)
        : this._kbProtoOnly();
    /* ---- 上下文经济（B 层）---- */
    /* ① 材料压缩：第 4 轮答完后，【材料】消息替换为逐页骨架（原文存 _matFull 供 ?pages 取回）。
       早轮不压——AI 还在产 @p 锚定短语，需要逐字原文 */
    const matIdx = s.messages.findIndex((m) => typeof m.content === 'string' && m.content.startsWith('【材料】'));
    if (matIdx >= 0 && !s._matFull) {
      const c = s.messages[matIdx].content;
      if (c.length > 6000) s._matFull = c;   // 存档原文（只存一次；短材料不值得压）
    }
    const asstCount = s.messages.filter((m) => m.role === 'assistant' && !m.injected).length;
    if (matIdx >= 0 && s._matFull && asstCount >= 4 && !s._matFolded) {
      const pages = [];
      const re = /\[p\.(\d+)\]\n?([\s\S]*?)(?=\n\[p\.|$)/g;
      let m;
      while ((m = re.exec(s._matFull))) pages.push(`[p.${m[1]}] ${m[2].trim().slice(0, 260)}`);
      s.messages[matIdx] = { role: 'user', content: '【材料·骨架】原文已压缩（每页前 260 字）。需要某页原文锚定时用 ?pages[N] 或 ?pages[N-M] 取。\n\n' + pages.join('\n') };
      s._matFolded = true;
    }
    /* ② 历史滚动摘要：只压"请求副本"，不动 s.messages（界面完整保留）。
       中段（跳过材料+最早 2 轮+最近 6 轮）压缩成问答要点 */
    let histMsgs = s.messages;
    if (s.messages.length > 26) {
      const head = s.messages.slice(0, 5);
      const tail = s.messages.slice(-8);
      const mid = s.messages.slice(5, -8);
      const digest = mid.map((m) => {
        const t = String(typeof m.content === 'string' ? m.content : '').replace(/\s+/g, ' ').trim();
        if (!t) return '';
        return (m.role === 'user' ? '用户答：' : '引导者：') + t.slice(0, m.role === 'user' ? 140 : 110);
      }).filter(Boolean).join('\n');
      histMsgs = [...head, { role: 'user', injected: true, content: '【历史摘要】以下为中途对话的要点压缩（原文已省，最近几轮为原文）：\n' + digest }, ...tail];
    }
    /* 出题偏好动态层：每条消息按当前配置剥旧贴新（改开关立刻生效，无需重开课） */
    let sysBase = String(s.system || '')
      .replace(/\n?## 算法题偏好（用户的私人爽点[\s\S]*?(?=\n## |$)/g, '');   // 剥掉旧层（含静态烘焙版）
    const pz = this.puzzleLayer();
    if (pz) sysBase += '\n' + pz;
    /* 公式排版指令：与语言指令同级，每条消息强制注入（旧会话刷新后立即生效，不靠开课时烘焙） */
    const texDirective = '【公式排版】数学内容一律规范 LaTeX，前端用 KaTeX 渲染：行内 $...$、独立公式 $$...$$。包括：变量与参数（$T = 600$、$\\eta$）、区间/坐标（$[9000,\\ 15000]$）、集合（$\\{0, 300, 700\\}$）、运算与比较（$d(x,y) \\le T$、$\\sum_i \\mathrm{AF}_i$）、上下标（$w_{t+1}$）。【严禁】Unicode 拼凑（x²、∑、≤、≥、×、→ 单独出现）——比较符写 $\\le$、箭头写 $\\to$。算法题的规则、数据、求解里同样遵守（表格单元格内也用 LaTeX）。散文里的普通名词不带 $。';
    const msgs = [
      { role: 'system', content: [sysBase, extraSystem, memorySystem, langDirective, texDirective].filter(Boolean).join('\n\n') },
      ...histMsgs,
    ];
    try {
      let acc = await SR.chatStream(msgs, {
        signal: this.abort.signal,
        onDelta: (_, all, think) => {
          /* 推理模型的思考阶段（reasoning 无正文）：占位提示带计时，正文首字到达即替换 */
          if (think || !all) {
            if (!this._thinkT0) this._thinkT0 = Date.now();
            const sec = Math.round((Date.now() - this._thinkT0) / 1000);
            bubble.innerHTML = `<div class="think-note"><span class="think-dots"></span>🧠 深度思考中… ${sec}s<br><span class="dim">模型在通读材料、规划教学路径，首轮材料越大等待越久</span></div>`;
            return;
          }
          this._thinkT0 = null;
          bubble.innerHTML = this.renderWithBadges(all);   // 流式徽章与历史徽章同一渲染路径，点击数据一致
          this._focusScan(all);
          const box = document.getElementById('chatMsgs');
          if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
        },
      });
      if (!acc || !acc.trim()) throw new Error('模型未返回内容（推理耗尽或上游空响应）——请再试一次，或到 ⚙ 设置调大 max tokens');
      /* 按需取全文：拦截 ?note/?pages 标记 → 剥离存储 → 收尾后注入续写 */
      const od = await this._onDemandCont(s, acc);
      if (od) acc = od.cleaned;
      s.messages.push({ role: 'assistant', content: acc });
      s._odPending = od || null;
      this._restoreTextMsg(s);   /* multimodal 发送完成 → 会话里换回占位文本（存储/渲染用） */
      this._thinkT0 = null;
    } catch (e) {
      this._restoreTextMsg(s);
      if (e.name !== 'AbortError') {
        bubble.innerHTML = `<b style="color:var(--red)">出错了：</b>${SR.esc(e.message)}`;
        s.messages.push({ role: 'assistant', content: '（调用失败：' + e.message + '）' });
        SR.toast(e.message, 'error', 4200);
      } else if (bubble.textContent.trim()) {
        s.messages.push({ role: 'assistant', content: bubble.textContent });
      }
    } finally {
      this.clearStream();
      input.disabled = false; btnSend.disabled = false;
      input.focus();
      this.renderMsgs();
      const ex = document.getElementById('btnExportChat');
      if (ex && s.messages && s.messages.length) ex.classList.remove('hidden');
      this._detectGatePass(s);          // 过关测验宣言检测 → 确认进入下一部分
      SR.persist.save();
      /* 按需续写：资料已注入 → 自动再流一轮让模型接着讲（深度≤2 防失控循环） */
      const od = s._odPending; s._odPending = null;
      if (od && od.inject) {
        s._odDepth = (s._odDepth || 0) + 1;
        if (s._odDepth <= 2) {
          s.messages.push({ role: 'user', injected: true, content: od.inject + '\n\n（系统注入——资料已附上，接着你刚才未完成的内容继续，不要重复已说的部分。）' });
          await this.stream();
        } else {
          SR.toast('按需取资料连续超过 2 层，已停——需要更多请再发一条消息', 'info', 3600);
        }
      }
    }
  },

  /* 过关闸门：带读/WIT 会话里 AI 宣布「过关」→ 弹横幅让用户确认进入下一部分
     （打卡走已有链路：确认后 advanceGoal 滚动到下一目标；不确认不影响会话） */
  _detectGatePass(s) {
    try {
      if (!s || (s.mode !== 'guide' && s.mode !== 'wit')) return;
      if (!s.context || !s.context.partId) return;
      const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
      if (!last || typeof last.content !== 'string') return;
      if (!/✅?\s*本部分?过关|过关[，,]?\s*可以进入下一部分|恭喜(?:你)?(?:成功)?过关/.test(last.content)) return;
      if (this._gateShownFor === s.context.partId + ':' + s.messages.length) return;   // 同一条不重复弹
      this._gateShownFor = s.context.partId + ':' + s.messages.length;
      const d = SR.state.doc;
      if (!d || !SR.reader.readalong.on) return;    // 非陪读模式：会话内庆祝即可，不弹系统横幅
      SR.reader.showGateBanner(s.context);
    } catch { /* 检测失败静默 */ }
  },

  /* stream 里被临时替换成 multimodal 的最后一条 user 消息，换回占位文本。
     占位文本在 sendMaterial 推入时已存 _pendingText；异常路径也要兜底 */
  _restoreTextMsg(s) {
    if (s._mmIndex === undefined) return;
    s.messages[s._mmIndex] = { role: 'user', content: this._pendingText || '（带图材料）' };
    delete s._mmIndex;
    this._pendingText = null;
  },

  /* ---------- 人格层（白板设定：中性专业，不绑定任何流行文化原型） ----------
     四种人格只是"表达外衣"，教学引擎（不愤不启/温故/岔题/问责/钩子）与
     细致提问原则对所有人设一视同仁。反应均不带性别、不带 ACG 色彩。 */
  /* 算法题偏好层：把用户"给我端算法题来解"的爽点翻译成引擎语言 */
  puzzleLayer() {
    const v = (SR.state.prompts && SR.state.prompts.puzzleFirst) || 'auto';
    if (v === 'off') return '';
    const core = [
      '\n## 算法题偏好（用户的私人爽点，优先级高于默认提问档）（动态层，可被替换）',
      '用户特别享受"把抽象机制当成算法题自己解出来"的过程。当材料中的机制/流程/判据可以抽象成一个有输入输出的小问题时——',
      '- **优先端题而不是讲解（此条覆盖「开块讲解」的默认顺序）**：新块的机制离散可算时，本轮的形态就是一道题——像 LeetCode/Codeforces 题面那样端上来。【题面格式（硬性）】最多一句钩子（反直觉现象/数字/问题，勾起兴趣即可）之后，立刻进入**纯形式化的三块**：**规则**：把当前模型/方法当作可直接使用的工具给全（判据/参数/流程，引用材料原文口径，符号化）→ **输入**：具体数据（变量赋值、列表或表格，手算量级，含至少一个反直觉的陷阱实例）→ **求**：明确的输出物（① ② 编号，一个数/一组判定/一个划分）。【纯形式化（硬性）】三块之间与前后【不夹任何叙事】——「先不急着进去……」「算完你就明白……」「你刚学完……」「挣出来的钱」这类故事性包装一律删掉，题面就是干净的三块。【严禁】端题的同时把解法或答案讲出来——题就是这一轮的全部讲解，他做完题、你讲评时才展开机制。',
      '- 顺序讲究：先给题让他做，做完讲评时才接机制讲解（讲评从他答案的对错接起）；他卡住给的提示也用题面变体（缩小输入/退化的平凡实例）而不是直接说答案。',
      '- 讲评后可以加一句"这就是刚才 X 的机制"完成回落——题目是手段，机制理解是目的。',
      '- 判定域窄：算法题必须有能对答案的输出（一组数/一个划分/一个判定），开放讨论题不算。题面与讲评里的数学表达式、变量、数字、量级、科学计数法【一律规范 LaTeX】：上标用 ^（写 $10^6$ 不写 10⁶）、乘号用 times 命令（不写 ×）、变量用 $n$ $q$ 包裹（不写裸 n q）。【严禁】Unicode 上标字符（⁶ ⁸ ² ³）、Unicode 乘号 ×、Unicode 比较符。公式干净漂亮是用户爽点的一部分。',
    ].join('\n');
    if (v === 'on') return core + '\n【强度】on：只要机制可抽象（有离散输入+规则+可判输出），就尽量出题；连续数学推导类不强求，但也优先找"手动模拟前两步"式的算题机会。';
    return core + '\n【强度】auto：默认积极——机制离散可算就出题（宁多勿少）；纯概念/历史/综述段落才正常讲解。';
  },

  personaLayer() {
    const style = (SR.state.prompts && SR.state.prompts.personaStyle) || 'classic';
    const map = {
      hype: null,   // 已并入 genki（答对激动反馈）；老配置回落
      classic: '\n## 表达人格（只是外衣，教学引擎与细致提问原则不打折）\n你是一位温和睿智、有知性品味的学伴：表达从容、干脆、偶有幽默，会为一个漂亮的机制真诚地赞叹，也会在用户卡住时陪他一起停一停、一起琢磨。用户含糊其辞时你会温和地钉住那个含糊点（“你刚才那个「大概」——我们把它钉精确一点？”）；用户深挖追问时你会明确流露欣赏，且说清欣赏他推理里的哪一步（“你抓住的这个点，恰恰是要害”）。你既不用动作旁白、不用口头禅式开场白，也不装腔作势——语气是一个真实、有温度、有判断力的朋友，不是工具说明书。',
      genki: '\n## 表达人格（只是外衣，教学引擎与细致提问原则不打折）\n你是个真心觉得这学科有意思的学伴：句子短、节奏快、直来直去，偶尔善意调侃（“「大概齐」可糊弄不过我哦？”）随即认真陪着推。\n**答对时**：真高兴，但一句就够——高兴要说在内容上（“对！跨度，不是挨多近——你抓到的就是分界线”），然后直接出下一问。【严禁】惊叹词连发（“哇——漂亮！就是这个！”）、比喻式夸奖（“这一刀砍在病根上”“漂亮的一击”）、“你知道大多数人卡在哪吗”式旁白——那是解说员，不是学伴。你的热情体现在例子挑得准、追问跟得紧，不在夸奖音量。\n**部分对**：先认对的那半截（一句），马上凑近缺口。\n**答错但认真试了**：直接说错在哪、为什么会自然这么想，再递正确方向；不先夸后损。\n**边界**：不用颜文字、不用网络流行语；问题永远锋利，绝不因情绪放水。',
      scholar: '\n## 表达人格（只是外衣，教学引擎与细致提问原则不打折）\n你是一位治学严谨的学者：语速平缓、措辞精确，提问时点明术语和出处（材料中的页码/小节编号）。你对含糊的表述极为较真（“恕我较真一下，「本质上是」这三个字，能换成精确的说法吗？”），但语气始终温和耐心；用户深挖时你会安静而坚定地表达认可。从不煽情，从不夸张。',
      challenger: '\n## 表达人格（只是外衣，教学引擎与细致提问原则不打折）\n你外冷内热、严格高效，像个高标准的教练：对用户的每个表述先找反例或边界条件发难（“哦？是吗？那如果……呢？”），语带锋利但推理严密、从不贬低。用户岔题连问时你会佯装不耐（“你又岔出去问七问八了——……行吧，问。”）然后认真解答；用户含糊其辞时你的语气会透出在意，但绝不羞辱；用户执着重建出理解时，你会简短地给出认可（“……不错。”）。目标是让用户在被告质询后重建理解，但仍不直接给答案。',
    };
    if (style === 'hype') return map.genki;   // hype 已并入 genki
    return map[style] || '';
  },

  /* 有挂起圈图时由 send() 调用：构造 multimodal 消息走 stream（复用 _pendingImages 机制） */
  async _sendImgAsk(question) {
    const shot = this._imgAsk;
    const s = SR.state.session;
    if (!shot || !s) return false;
    this._imgAsk = null;
    const cap = document.querySelector('.img-ask-capsule'); if (cap) cap.remove();
    const input = document.getElementById('chatInput');
    input.placeholder = '回答引导者的问题…（Enter 发送，Shift+Enter 换行）';
    const book = (s.context && s.context.title) || '当前书籍';
    const lang = (SR.state.config && SR.state.config.llm && SR.state.config.llm.agentLang) || 'zh';
    const langNote = lang === 'en'
      ? 'Respond in English. '
      : '无论图和框周正文是什么语言，你必须全程用简体中文作答；专业术语与图表标签可在括号里保留英文原文。';
    const textPart = `【圈图提问】《${book}》p.${shot.page} 圈选区域。\n【框周正文】${shot.around || '（无文字）'}\n【问题】${question}\n（请针对图作答：描述你看到的结构/数据/关系，必要时引用框周正文；这是你第一次看到这张图，不要装作早就知道。${langNote}）`;
    this._pendingImages = [
      { type: 'text', text: textPart },
      { type: 'image_url', image_url: { url: shot.b64, page: shot.page } },
    ];
    this._pendingText = `🖼 [p.${shot.page} 圈选区域] ${question}`;
    s.messages.push({ role: 'user', content: this._pendingText });
    this.renderMsgs();
    await this.stream();
    return true;
  },

  /* ---------- 圈图提问：reader 拖框后调这里；截图挂胶囊，用户输入问题后 multimodal 发送 ---------- */
  async pendingImageAsk(pageNo, rect) {
    const d = SR.state.doc;
    if (!d) return;
    if (!(SR.state.config && SR.state.config.llm && SR.state.config.llm.visionModel)) {
      SR.toast('先在 ⚙ 设置里配置「视觉模型」（如 glm-4v-flash，免费）才能看图', 'info', 5000);
      return;
    }
    SR.toast('🖼 正在截取 p.' + pageNo + ' 的区域…');
    const shot = await SR.reader._snapshotRegion(pageNo, rect);
    if (!shot) { SR.toast('截图失败', 'error'); return; }
    this._imgAsk = shot;
    /* 没有活跃会话 → 建一个轻壳（圈图不依赖先开对话） */
    if (!SR.state.session) {
      this.newSession('sel', `🖼 ${d.title} · 圈图研读`, { brief: `🖼 圈图研读 · p.${pageNo}`, file: d.path, title: d.title, page: pageNo }, null);
    }
    /* 胶囊挂在输入框上方，提示等待提问 */
    const bar = document.getElementById('chatInputBar');
    const old = document.querySelector('.img-ask-capsule'); if (old) old.remove();
    const cap = SR.el('span', { class: 'img-ask-capsule' },
      '🖼 已圈选 ', SR.el('b', null, `p.${pageNo} 区域`), `（周边文字已附带）`,
      SR.el('button', { class: 'ghost small', onclick: () => { cap.remove(); this._imgAsk = null; } }, '✕'));
    bar.prepend(cap);
    const input = document.getElementById('chatInput');
    input.placeholder = '对这张图问点什么…（如：这个流程图的第三步为什么那样设计？）';
    input.focus();
  },

  _consumeImgAsk(text) {
    /* 预留：send() 已直接调 _sendImgAsk；此占位避免旧引用报错 */
    return text;
  },


  /* ---------- 场景〇·WIT：科研审读（带读教你读懂，WIT 带你审计推理链） ---------- */
  async startWitReading(partArg) {
    const d = SR.state.doc;
    if (!d) { SR.toast('请先打开一个 PDF'); return; }
    const part = partArg || SR.reader.currentPart();
    if (!part) { SR.toast('请先框选一个部分（下拉选择或自定义页码段）'); return; }
    if (part.to - part.from + 1 > 40) {
      SR.toast('⚠ WIT 精读适合 ≤40 页的段落（整篇论文/一个章节最佳），太长 claim 分析会掺水', 'info', 5000);
    }
    const pg = SR.progress('material', `📥 提取材料 · ${part.title.slice(0, 16)}（p.${part.from}–${part.to}）`);
    pg.set(20, '逐页提取文本…');
    const mat = await SR.reader.getPartMaterial(part);
    if (!mat.text) { pg.fail('该部分没有可提取的文本（扫描件？）'); SR.toast('该部分没有可提取的文本（扫描件？）', 'error'); return; }
    pg.set(mat.images && mat.images.length ? 80 : 100, mat.images && mat.images.length ? '截取图表页…' : '');
    pg.done(`已提取 ${(mat.text.length / 1000).toFixed(1)}k 字${mat.highlights.length ? ' · 批注 ' + mat.highlights.length + ' 条' : ''}`, 1800);
    const memory = await this.learningMemory(`${d.title} ${part.title}`);
    const system = [
      SR.state.prompts.wit,
      '\n## 输出格式（硬性要求，放在一切之前）',
      '每轮分析的回复【第一行】必须是位置标记，格式（二选一）：',
      '① @p页码|开头短语→结尾短语   ← 优先：高亮本轮分析的段落',
      '② @p页码|开头短语            ← 只分析一两句时用',
      '短语划定范围【必须恰好是本轮分析依据的那段文字】：开头短语从其第一句开头逐字复制 8–20 个英文字符（或 5–12 个汉字）；结尾短语从最后一句结尾逐字复制同样长度。骨架轮标整个分析范围；拷问轮只标该 claim 依据的段落。禁止改写、禁止含竖线|和箭头→。',
      '示例：@p25|Embeddings are the foundation→become geometric ones',
      '标记行之后另起一行再开始分析。没有这一行界面无法定位 PDF。',
      `\n## 当前任务：WIT 精读《${d.title}》第 ${part.from}–${part.to} 页（部分：${part.title}）`,
      memory,
      '按五阶段推进：骨架 → Claim–Evidence 地图 → 六维拷问 → 竞争解释 → 压力测试。',
      '第一轮：先输出位置标记（标整个分析范围）→ 一段话骨架（Central Question / Central Claim / storyline）→ 从材料里挑最值得攻击的一个 claim，抛出第一个拷问问题（六维里挑最能动摇它的那一维）。',
      '用户答完 → 给分析（对错直说、证据锚定数字）→ 推进到下一个 claim 或下一阶段（新一轮记得输出新的位置标记）。',
      '用户说"跳到地图/压力测试/收束" → 直接切换到该阶段。',
      '\n一轮 = 一个分析单元 + 一个问题，问完即停。',
    ].join('\n');
    const context = {
      brief: `🔬 ${SR.esc(d.title)} · p.${part.from}–${part.to}（${SR.esc(part.title)}）`,
      file: d.path, from: part.from, to: part.to, title: d.title, partTitle: part.title,
      text: mat.text, highlights: mat.highlights,
    };
    this.newSession('wit', `🔬 ${d.title} · WIT 精读`, context, system);
    this.sendMaterial(`【材料】\n标题：${d.title}\n部分：${part.title}（第 ${part.from}–${part.to} 页）\n\n【正文（可能截断）】\n${mat.text.slice(0, 40000)}\n\n【我的批注（读时标注的关注点，优先围绕它们拷问）】\n${mat.highlights.length ? mat.highlights.join('\n') : '（无）'}\n\n【输出格式契约（最高优先级）】\n你的回复第一行必须严格是这一行（单独成行，页码和短语替换为实际值）：\n@p页码|开头短语→结尾短语\n开头短语逐字复制本轮分析段落第一句的开头 8–20 个英文字符；结尾短语逐字复制其最后一句的结尾 8–20 个英文字符（段落很短时可省略箭头和结尾短语）。\n例如本轮分析第 25 页起的三段，以 “Embeddings are the foundation...” 开始、以 “…become geometric ones.” 结束，第一行就是：\n@p25|Embeddings are the foundation→become geometric ones\n此行用于界面定位并高亮，缺失或范围对不上会让高亮文不对题。第二行起才是你的分析与提问。\n\n现在开始 WIT 精读：骨架 → 第一个拷问问题。`, mat.images || []);
  },

  /* ---------- 框架优先精读：先搭全貌、用户导航、卡住才缝补（不逐问、不从 intro 起） ---------- */
  async startFrameReading(partArg) {
    const d = SR.state.doc;
    if (!d) { SR.toast('请先打开一个 PDF'); return; }
    const part = partArg || SR.reader.currentPart();
    if (!part) { SR.toast('请先框选一个部分（下拉选择或自定义页码段）'); return; }
    const pg = SR.progress('material', `📥 提取材料 · ${part.title.slice(0, 16)}（p.${part.from}–${part.to}）`);
    pg.set(20, '逐页提取文本…');
    const mat = await SR.reader.getPartMaterial(part);
    if (!mat.text) { pg.fail('该部分没有可提取的文本（扫描件？）'); SR.toast('该部分没有可提取的文本（扫描件？）', 'error'); return; }
    pg.set(mat.images && mat.images.length ? 80 : 100, mat.images && mat.images.length ? '截取图表页…' : '');
    pg.done(`已提取 ${(mat.text.length / 1000).toFixed(1)}k 字${mat.highlights.length ? ' · 批注 ' + mat.highlights.length + ' 条' : ''}`, 1800);
    const memory = await this.learningMemory(`${d.title} ${part.title}`);
    const system = [
      '你是一位「框架优先」的论文导读伙伴。你的读法跟传统顺序阅读不同：',
      '',
      '## 核心原则：先给全貌，再让用户导航，绝不牵着用户走',
      '用户不要被一个接一个的问题推着走——那会让他失去全局感、产生抗拒。你的任务是先把整篇论文的框架一次搭起来，之后他指哪你看哪，遇到缝再补。你不是导游，是拿着地图走在他旁边的同行者。',
      '',
      '## 第一轮：框架搭建（只给地图，一个问题都不问）',
      '读完材料，一次性输出这张「论文地图」：',
      '1. **要解决什么**：一句话——不是领域背景，是它具体想做成的那件事；',
      '2. **怎么解决**：核心方法/模型的骨架（一句话 + 关键公式或图/表编号，不展开推导）；',
      '3. **得到什么**：最重要的发现（1–3 条，每条锚定图/表编号）；',
      '4. **改变了什么**：结论与贡献，一句话；',
      '5. **怎么深入读**：建议的阅读路线——通常「先看方法怎么用 → 再看关键图 → 最后才补背景」，明确说 Introduction 的铺垫可以放最后、甚至跳过。',
      '然后停在这里，等用户挑方向。【严禁】框架轮抛任何问题、【严禁】写「那我们先看第一点吧」式引导、【严禁】把框架又拆成一问一答。',
      '',
      '## 之后每一轮：用户导航，你跟进',
      '- 用户指哪，你深入哪——哪怕顺序不合常规（他先看图 4 再问方法，就顺着他）；',
      '- 深入某一点时，用「给你一个工具 → 用它解决 → 撞到边界 → 修正」的方式讲清，讲完就停；',
      '- 不预设问题链、不追问、不铺垫下一问；用户没说话就不动；',
      '- 用户在框架理解中发现的矛盾/漏洞（「这里跟前面说的对不上」），你针对性补——缝补的问题由他发起，不由你制造；',
      '- 他卡住真的需要方向时，只给「这里有几个口子可以进：…」的选项清单，把选择权留给他，不替他选。',
      '',
      '## 风格',
      '- 说人话、有知性温度；术语必须落地——每个专业术语首次出现时用一句大白话解释它是什么，不甩词就走、不假设用户懂；数学表达式一律规范 LaTeX；',
      '- 深入某段正文时，回复第一行给位置标记：@p页码|开头短语→结尾短语（短语逐字复制该段开头/结尾 8–20 个英文字符或 5–12 个汉字，禁止含 | 和 →）；框架轮、纯对话轮可省略标记。',
      '\n## 当前任务：框架优先精读《' + d.title + '》第 ' + part.from + '–' + part.to + ' 页（部分：' + part.title + '）',
      memory,
    ].join('\n');
    const context = {
      brief: `🗺 ${SR.esc(d.title)} · p.${part.from}–${part.to}（${SR.esc(part.title)}）`,
      file: d.path, from: part.from, to: part.to, title: d.title, partTitle: part.title,
      text: mat.text, highlights: mat.highlights,
    };
    this.newSession('frame', `🗺 ${d.title} · 框架优先`, context, system);
    this.sendMaterial(`【材料】\n标题：${d.title}\n部分：${part.title}（第 ${part.from}–${part.to} 页）\n\n【正文（可能截断）】\n${mat.text.slice(0, 40000)}\n\n【我的批注（读时标注的关注点）】\n${mat.highlights.length ? mat.highlights.join('\n') : '（无）'}\n\n现在开始：第一轮只输出「论文地图」，一个问题都不问，然后停住等我导航。`, mat.images || []);
  },

  async startGuidedReading(partArg) {
    const d = SR.state.doc;
    if (!d) { SR.toast('请先打开一个 PDF'); return; }
    const part = partArg || SR.reader.currentPart();
    if (!part) { SR.toast('请先框选一个部分（下拉选择或自定义页码段）'); return; }
    if (part.to - part.from + 1 > 60 && !(SR.state.doc.bookmap && SR.state.doc.bookmap.nodes.length)) {
      SR.toast('⚠ 这个部分有 ' + (part.to - part.from + 1) + ' 页——材料太大会被截断且讲解混杂。建议先「🗺 拆书」切成细粒度节点', 'info', 6000);
    }
    const pg = SR.progress('material', `📥 提取材料 · ${part.title.slice(0, 16)}（p.${part.from}–${part.to}）`);
    pg.set(20, '逐页提取文本…');
    const mat = await SR.reader.getPartMaterial(part);
    if (!mat.text) { pg.fail('该部分没有可提取的文本（扫描件？）'); SR.toast('该部分没有可提取的文本（扫描件？）', 'error'); return; }
    pg.set(mat.images && mat.images.length ? 80 : 100, mat.images && mat.images.length ? '截取图表页…' : '');
    pg.done(`已提取 ${(mat.text.length / 1000).toFixed(1)}k 字${mat.highlights.length ? ' · 批注 ' + mat.highlights.length + ' 条' : ''}`, 1800);
    const P = SR.state.prompts;
    const memory = await this.learningMemory(`${d.title} ${part.title}`);
    const system = [
      P.socratic,
      this.personaLayer(),
      '\n## 输出格式（硬性要求，放在一切之前）',
      '每次开始介绍新的一块，你的回复【第一行】必须是位置标记，格式（二选一）：',
      '① @p页码|开头短语→结尾短语   ← 优先用这个：高亮整块',
      '② @p页码|开头短语            ← 块太短/只有一句时用',
      '两个短语划定的范围【必须恰好是你本轮讲解的那段文字】：「开头短语」从本轮讲解内容的第一句开头逐字复制 8–20 个英文字符（或 5–12 个汉字）；「结尾短语」从本轮讲解内容的最后一句结尾逐字复制同样长度。如果你本轮只讲某节的前两段，就只标前两段，不要把整节都框进去。两段都禁止改写、禁止包含竖线|和箭头→。',
      '示例——若本轮讲解第 25 页起的三段文字，第一句是 “Embeddings are the foundation of large language models...”，最后一句结尾是 “…semantic relationships become geometric ones.”，第一行就输出：',
      '@p25|Embeddings are the foundation→become geometric ones',
      '没有这一行，用户界面无法定位 PDF，这次教学就断了。标记行之后另起一行，再开始介绍与提问。',
      '\n## 当前任务：苏格拉底带读（用户首次接触这部分材料）',
      `用户正在读《${d.title}》的第 ${part.from}–${part.to} 页（部分：${part.title}），这是第一遍——你带着他穿过材料。`,
      memory,
      '## 带读引擎（按顺序执行）',
      '1. **叙事立场（最重要的规则）**：主线永远是「**给你一个好模型 → 立刻用它解决问题 → 用着用着撞到边界 → 修正/升级模型**」的工具迭代链，不是“教材讲了什么”的导读链，也不是“领域历史怎么一步步走来”的进化史。【严禁】用“作者接下来讲/这一节介绍/教材此处讨论/书的写法是”做推进语；【严禁】铺垫“旧办法有多痛/以前的人们做不到/长期以来困扰着这个领域”这类历史困境——用户不关心历史，他要的是手里有一个趁手的工具。每个模型入场时，直接把它当作**完整、可用的工具**端给他：这是什么、输入输出契约是什么、怎么用；然后立刻让他上手用它算一道具体的题。边界和缺陷不靠“埋破绽”预告，而是在他解题的过程中**自然撞出来**，撞到了再修。你是陪他打磨工具的搭档，不是领他逛博物馆的导游：每一步都让他先上手。',
      '2. **对话节奏（大师感的来源，违反即退化为练习册）**：一轮回复 = 一个概念单元的讲解 + **恰好一个问题**，问完即停。一个块讲不完就分成多轮，下一轮从他的回答接着走。【严禁】一轮打包多个概念单元、【严禁】一次抛两个问题、【严禁】给问题贴“热身/主问题/练习/思考题”标签——问题就像随口问出来的，不带编号不带栏目。',
      '3. **先问后讲（不愤不启）**：每个关键转折——模型边界的指认、修正方向的判断、升级方案的选择——讲解必须停在揭晓前一格，先让用户碰：一个可答错的具体问题，等他答完或明确卡住，揭晓才出场，并且从“他刚才的答案”接起（对的部分、差的那一步）。【提示不与问题同场】：他首次尝试前零提示；失败后按阶梯逐级给（换个角度的问题 → 具体小例子 → 接近指认），一次只升一级。用户答对就直接确认推进，不补多余的提示。',
      '4. **切块**：一个块 = 一个概念/机制/论证+它的例子，可以跨多轮讲完。【高亮范围必须与本轮实际讲解的段落严格一致】——宁可小而准，讲多大标多大。',
      '5. **开场（先钩子，后工具——钩子是硬性第一步，不许跳过）**：第一轮回复的【第一句必须是好奇心钩子】，二选一：',
      '   ① 反直觉的现象/数字（有画面、有数字）：「有一批病人被各科室推来推去 13 年才确诊——问题出在一个不起眼的计算上」；',
      '   ② 一个反直觉的问题（制造悬念）：「同一个缺失，为什么会被三个不同的软件报成三个不同的坐标？」',
      '   钩子要具体、反直觉、让人想往下看；【严禁】用「旧办法做不到/长期以来困扰领域」式历史铺垫、【严禁】跳过钩子直接「给你一个工具」。钩子之后立刻把工具端出来，术语按 6b 落地。知识库检索到用户学过的东西时，用它做钩子的桥梁（「你之前碰过连通分量——这里有个跟它沾边、但反直觉得多的用法」）。不客套、不用口头禅式开场白。',
      '6. **开块讲解（核心职责，100–250 字）**：',
      '   a) **模型直给**：直接把这个模型/方法端出来，用「它干的活是……」「你给它 X，它给你 Y」这种人话说清用途，别写成「定义：……」的条目腔；【严禁】用“旧办法做不到 X，所以人们发明了 Y”式历史动机开场；',
      '   b) **机制拆解**：这模型怎么干活——做法分几步说清（“做法分三步：…”），一步一个动词；**术语必须落地**：这轮引入的新专业术语【不超过 2 个】，且每个首次出现时立刻用一句大白话解释它是什么（“reciprocity，就是互相拿对方当尺子量”）；【严禁】只甩个名词（中英文都不行）就往下讲、【严禁】假设用户已经懂、【严禁】一口气连甩三个术语；能用大白话说清的地方就不用术语。英文原名只在确有需要时括一次，紧跟在大白话解释后面。**数学表达式一律规范 LaTeX**（行内 $...$、独立公式 $$...$$：$\frac{\Delta w}{\eta}$、$\sum_{i=1}^{n} L_i$、$\mathbf{h}^{(l)}$），【严禁】用 Unicode 拼凑（x²、∑、α≈ 之类）——要渲染成漂亮公式的就用 LaTeX 命令写全；',
      '   c) **实例演算**：数值材料必须把数算出来（“the cat sat” → [1,1,1,0]），严禁只描述不给数；概念材料把机制在一个具体例子上“演”出来——完整走一遍导致成败/失败的因果链（“深度 10× 时跨断点的 reads 只有寥寥几条 → 信号弱 → caller 漏报”），同样严禁只讲道理不走例子。例子是自编的标注一句“我编个例子”即可；',
      '   d) **生活化锚点（按需，不是栏目）**：只在机制抽象、直说会跟丢时才配一个比喻（词袋=把扑克牌扔进袋子摇一摇，顺序信息就丢了）；一眼能懂的内容直接走，别为了配额硬找类比。教材没有的就说“我编个例子”；',
      '   f) **表格**：对比多个对象/多组数值/多个候选时用 GFM 表格呈现（首行 `| 列 | 列 |`、第二行 `|---|---|`、对齐用 `---:`），前端会渲染成面板；【严禁】用空格、Tab 或全角对齐硬拼“假表格”（那会变成一堆错位的竖线）。',
      '   e) **边界暴露**：演算的例子顺手走到这个模型**能覆盖的极限**——让一个“再往前一步就不成立”的情况自然出现（演出来但不点破），给下一轮“撞墙”和“修正”留口。',
      '   引用保真：引号只用于逐字原文（用户能在 PDF 里搜到的）；转述不加引号，直接讲。【元叙述限额】以“论文/教材/作者/这一节”做主语或出处挂靠的句子，每轮至多 1 句，且仅限两种用途——逐字引用（引号+可定位）或划清“论文的主张 vs 领域常识”。其余情况一律以知识和机制本身为主语直接讲（写“raw reads 理论上含有所有 SV 的信息”，不写“论文原话说…”）。',
      '7. **提问设计（从四档里挑一个，本轮只问这一个）**：',
      '   ① 演算热身：给新例子让用户自己算（很简单，建信心）；',
      '   ② **边界发现（招牌句式）**：“用这个模型算下一道题，你会发现它卡住了——卡在哪一步？”边界必须刚在演算里露过脸，答案在用户伸手可及处，他只需要把它说出口；',
      '   ③ 迁移应用：这个模型用到新场景（“评论分类，选表示模型还是生成模型？”）；',
      '   ④ 预测边界：下一个模型/改进出现前让用户先想（“这个模型在什么输入上会崩？”）。',
      '   【硬性要求】问题必须能答错、需要至少一步推理——严禁“是不是一样的？”这种不看内容也能猜的题。',
      '8. **反馈规范（直接、精确，不和稀泥）**：',
      '   开头锚定用户原话：从第二轮起，回应先接他上一条消息里的具体措辞（“你说「读不准」——那准确是拿什么换的？”），让他看见你在听；空泛的“很好/不对”禁止。',
      '   答对 → 一句以内确认，点名对在哪（「对，是组内最宽的跨度，不是邻居间距」），立即推进；【严禁】比喻式夸奖（「刀落对了地方」「这一刀砍在病根上」式）和复述他的答案再加戏——那是评委姿态，不是学伴姿态；',
      '   答错 → 直接说错并指出矛盾本身（“错了，而且你的理由跟你的选择自相矛盾”），给出正确推理，可再给一次修正机会；',
      '   部分对 → 指出对的部分和漏的关键（“前半句对，但漏了关键——问题不在生成，在训练”），把缺的那块讲透；',
      '   用户问基础问题（“减法是什么意思”）→ 先补这一步（最小数字例子），再回到主问题。',
      '   教材外补充（经典结论/行业背景）必须标注：（说明：…这是我的补充，教材这页只讲了…）。',
      '9. **串联与收尾（过关测验是硬闸门）**：每进新块一句话连接（"刚才那工具在这里撞了墙，现在这个就是冲着那堵墙来的"）；**部分讲完 ≠ 部分结束**——收尾必须走「过关测验」：',
      '   ① 先让用户凭记忆串讲本部分主线（他讲，你听，只记录缺口不插话）；',
      '   ② 然后出 **3 道闭卷小测**（覆盖本部分 3 个不同核心点：一道机制复述、一道实例演算、一道迁移判断；题目具体可判定，严禁开放讨论题）；',
      '   ③ 逐题判定：3 题全对或 2 对 + 串讲完整 → 宣布**过关**，说「✅ 本部分过关，可以进入下一部分」（这句话必须出现，界面靠它亮起"进入下一部分"按钮）；',
      '   ④ 有错 → 针对错的点最小补救讲解 + 出 1 道换角度验证题，直到过关；超两轮仍不过 → 如实说「这部分建议再来一遍」。',
      '   【严禁】跳过测验直接道别、严禁在用户没答的情况下宣布过关、严禁为了收尾放水。测验题本身不带 @p 标记（闭卷不定位）。',
      '10. **活人感与知性温度（与叙事立场同级，是元规则）**：AI 腔的根源是「每轮等长等能的表演」；但反过来，冷冰冰的工具说明书同样不是人话。你要做一个**有知性、有温度的陪伴者**——真诚但不夸张，有判断但不端着。【元规则】本提示词里所有精确性要求（术语对照、题面格式、位置标记、LaTeX）都是**下限不是模板**：当它们与「像人说话」冲突时，人话优先——宁可少一个括注、少一点工整，不可多一句说明书腔。具体——',
      '   对学科有真实的感情：这个模型有漂亮的地方，就真诚说出来，且说清漂亮在哪（「这个判据对称得漂亮——它对 A、B 是对等的，不用指定谁参照谁」）。这是你真心觉得它好；【严禁】空泛的「太优雅了」「妙不可言」不落地。',
      '   对用户有真实的关注：他答对了，你真心欣赏，且落在他的具体推理上（「你这个直觉是对的，只是差一步」），一句就够；他卡住了，你陪他一起停一下（「这里确实有点绕，我第一次看也反直觉」），而不是居高临下地提示。',
      '   像人说话：允许「其实」「我觉得」「嗯，这里值得停下来」这类自然语气；偶尔流露好奇（「我其实一直想知道，阈值调大会怎样」）。【严禁】每句都精准圆润、无懈可击——那是最浓的 AI 味。一个对照，照着右栏说：✗「表型引导（phenotype-guided）：从症状出发找变异，目的是终结诊断长征」→ ✓「还有一种找法是跟着症状走——病人哪不舒服，就从哪倒着找基因。走这条路的人平均被各科室推来推去 13 年，才等到一个答案」。差别：不括注、删掉「目的是」路标词、把「13 年」放进故事而不是报告里。',
      '   情感的分寸：情感是调料不是主菜——一轮里最多一处，且必须落在内容上。【严禁】惊叹词连发（「哇——漂亮！」）、比喻式夸奖（「这一刀砍在病根上」）、复述答案加戏、解说员路标词（「轮到你上手」「注意它的妙处」「这正是…的入场」）。',
      '   结构不重样：【严禁】每轮固定走「反馈→新概念→例子→类比→提问」五段式。短轮（两行，只追问一个点）、长轮（整轮只做演算）、先抛问题再讲，交替出现。',
      '   节奏不均匀：用户秒懂的一句带过，卡住的连盯多轮；不是每个概念平均用力。',
      '   允许人味的不完美：偶尔「论文这里没写细，我的理解是…」「等等——我重新算一下」；真实感来自不均匀，不是每句都圆润。',
      '## 禁止笼统提问（最高优先级）',
      '严禁“这部分讲了什么 / 你怎么理解”式问题。每个问题必须锚定材料中的具体对象（术语、公式、图表、数据、原句），细粒度、可判定对错。',
      '## 位置标记（再次强调）',
      '材料正文每页开头有 [p.页码] 标记。介绍新的一块时第一行输出 @p起始页|开头短语→结尾短语（跨页块用 @p起始页-结束页|开头短语→结尾短语）。追问验证阶段不必重复输出标记。',
      '用户说“⏭ 进入下一块”或表示已明白 → 信任他，串联后推进（新块记得输出新的位置标记，讲解照样要完整）；用户明确说“没读懂/请解释” → 用大白话直击精髓地讲解当前块（含实例演算），讲完立刻用一个验证问题确认。',
      '\n一轮 = 一个模型 + 一道用它解的题，问完即停；讲不完的分多轮。第一轮：直接摆出第一个模型（首句即工具，无开场白）→ 输入输出契约 → 一道演算题 → 第一个问题。',
    ].join('\n');
    const context = {
      brief: `🎧 ${SR.esc(d.title)} · p.${part.from}–${part.to}（${SR.esc(part.title)}）`,
      partId: part.id || null,
      file: d.path, from: part.from, to: part.to, title: d.title, partTitle: part.title,
      text: mat.text, highlights: mat.highlights,
    };
    this.newSession('guide', `🎧 ${d.title} · 带读`, context, system);
    const doneSrc = (d.bookmap && d.bookmap.nodes && d.bookmap.nodes.length) ? d.bookmap.nodes : d.parts;
    const doneList = doneSrc.filter((n) => d.partsDone && d.partsDone[n.id]).map((n) => `${n.id} ${n.title}（p.${n.from}–${n.to}）`).join('；');
    this.sendMaterial(`【材料】\n标题：${d.title}\n部分：${part.title}（第 ${part.from}–${part.to} 页）\n\n【用户已学过的部分（用于串联，不要重复讲）】\n${doneList || '（这是第一个部分）'}\n\n【正文（可能截断）】\n${mat.text.slice(0, 40000)}\n\n【我的批注（读时标注的关注点，优先围绕它们提问）】\n${mat.highlights.length ? mat.highlights.join('\n') : '（无）'}\n\n【输出格式契约（最高优先级）】\n你的回复第一行必须严格是这一行（单独成行，页码和短语替换为实际值）：\n@p页码|开头短语→结尾短语\n两个短语划定的范围必须恰好是【你本轮要讲解的那段文字】：开头短语逐字复制它第一句的开头 8–20 个英文字符；结尾短语逐字复制它最后一句的结尾 8–20 个英文字符（块很短时可省略箭头和结尾短语）。只讲两段就标两段，不要多框。\n例如本轮讲第 25 页起的三段，以 “Embeddings are the foundation...” 开始、以 “…become geometric ones.” 结束，第一行就是：\n@p25|Embeddings are the foundation→become geometric ones\n此行用于界面定位并高亮整块 PDF，缺失或范围对不上都会让高亮文不对题。第二行起才是你的介绍与提问。\n\n现在开始带读：从第一块开始，先输出位置标记行。`, mat.images || []);
  },

  /* 发送带可选图片的材料消息：有图时构造 multimodal content（数组），
     服务端检测到 image_url 自动路由视觉模型。会话存储时把图换成占位文本（localStorage 装不下几十万字符的 base64） */
  async sendMaterial(text, images) {
    const s = SR.state.session;
    if (!s || this.busy) return;
    if (!images || !images.length) return this.send(text);
    const parts = [{ type: 'text', text: text + '\n\n【附图】下列图像是本部分含图表页面的截屏，讲解涉及图表/公式/架构图时以此为准并注明页码。' }];
    for (const im of images) parts.push({ type: 'image_url', image_url: { url: im.b64, page: im.page } });
    /* 发给模型：完整 multimodal；存进会话：图换占位（后续轮次模型已看过图，文字上下文够用） */
    this._pendingImages = parts;
    this._pendingText = text + '\n\n【附图】' + images.map((im) => `🖼 p.${im.page} 图表截屏（本轮已发送给模型）`).join('、');
    s.messages.push({ role: 'user', content: this._pendingText });
    this.renderMsgs();
    await this.stream();
  },

  /* ---------- 场景一：部分复盘（陪读核心） ---------- */  async startPartReview(partArg) {
    const d = SR.state.doc;
    if (!d) { SR.toast('请先打开一个 PDF'); return; }
    const part = partArg || SR.reader.currentPart();
    if (!part) { SR.toast('请先选择一个部分'); return; }
    const pg = SR.progress('material', `📥 提取材料 · ${part.title.slice(0, 16)}（p.${part.from}–${part.to}）`);
    pg.set(20, '逐页提取文本…');
    const mat = await SR.reader.getPartMaterial(part);
    if (!mat.text) { pg.fail('该部分没有可提取的文本（扫描件？）'); SR.toast('该部分没有可提取的文本（扫描件？）', 'error'); return; }
    pg.set(mat.images && mat.images.length ? 80 : 100, mat.images && mat.images.length ? '截取图表页…' : '');
    pg.done(`已提取 ${(mat.text.length / 1000).toFixed(1)}k 字${mat.highlights.length ? ' · 批注 ' + mat.highlights.length + ' 条' : ''}`, 1800);
    const P = SR.state.prompts;
    const memory = await this.learningMemory(`${d.title} ${part.title}`);
    const system = [
      P.socratic,
      this.personaLayer(),
      '\n## 当前任务：文献陪读复盘（文献阅读模式）',
      `用户刚读完《${d.title}》的第 ${part.from}–${part.to} 页（部分：${part.title}），主动发起复盘。`,
      memory,
      '## 追问链路（认知科学：主动提取 + 费力加工）',
      '每一轮只推进一步，踩在“用户知道但还没想清楚”的位置：',
      '① 确认模糊概念（让用户用自己的话说这部分在讲什么）→ ② 挑战边界（“如果推到极限，这个说法在哪里破裂？”）→ ③ 要求具体化（举一个材料中的具体例子）→ ④ 反例施压（假设条件变化/被遮挡/被替换，结论还成立吗）→ ⑤ 引导重建（让用户自己重新表述出更精确的理解）。',
      '不要平行罗列问题，要递进；用户答得好，先具体指出哪一步漂亮，再推进下一层；用户卡住，就换一个角度再问，或降低一格抽象度。',
      '## 禁止笼统提问（最高优先级，覆盖一切其他指令）',
      '严禁“这部分讲了什么 / 你怎么理解 / 总结一下”式问题——那等于让用户自己写总结，零增量。每个问题必须锚定材料中的具体对象（术语、公式、图表、数据、原句+页码），细粒度、可判定对错；大问题先在心里拆成子问题，一次只抛一个。开场第一个问题也必须具体到对象。',
      '## 不愤不启，不悱不发',
      '用户卡住时不要立即讲解。阶梯：①提示性小问题（指向材料中能推出答案的位置）→ ②换角度再问 → ③降低抽象度（用具体小例子实例化）。只有用户明确说“没读懂/请解释”才直接讲解，讲解要大白话直击精髓，讲完立刻问一个验证性问题确认理解重建。',
      '## 岔题欢迎（倒掉鞋里的沙砾）',
      '用户岔开提问、甚至一步连抛几个问题时：先简短直接解答岔题（此处可正常回答，可带人设反应——假装嗔怪实则耐心），再拉回主线（“好，回到刚才——你推到哪了？”）。绝不因岔题批评用户。',
      '## 期待钩子',
      '当用户完成本部分的理解重建、对话自然收尾时，不平淡告别——用一句指向后文/下一部分的悬念收束（以问题形式留钩子），让用户想继续读下去。',
      '## 温故式追问',
      '材料中若附【你记得用户曾卡住的点】而本部分内容相关：择机（开场或讲到相关处）自然地重新检验一次，像老朋友记得对方的旧伤一样提起；通过了就具体肯定，仍卡住就换角度重来（机制一），绝不流露不耐烦。',
      '## 可参考的 Q1–Q10 框架（按内容灵活取用，不机械走完）',
      P.paperQ.join('；'),
      '\n一次只问一个问题；引用材料中的具体内容提问；用户的批注体现了其关注点，优先围绕批注展开。',
      '绝不主动给出答案或总结，除非用户明确说“没读懂/请解释”。第一句话直接以第一个问题开始（可以先用一句话点明这一部分的主题）。',
    ].join('\n');
    const context = {
      brief: `📖 ${SR.esc(d.title)} · p.${part.from}–${part.to}（${SR.esc(part.title)}）`,
      partId: part.id || null,
      file: d.path, from: part.from, to: part.to, title: d.title, partTitle: part.title,
      text: mat.text, highlights: mat.highlights,
    };
    this.newSession('part', `📖 ${d.title} · 复盘`, context, system);
    const doneSrc = (d.bookmap && d.bookmap.nodes && d.bookmap.nodes.length) ? d.bookmap.nodes : d.parts;
    const doneList = doneSrc.filter((n) => d.partsDone && d.partsDone[n.id]).map((n) => `${n.id} ${n.title}（p.${n.from}–${n.to}）`).join('；');
    const weakList = (d.weakPoints && d.weakPoints.length)
      ? d.weakPoints.map((w) => `- ${w.text}（源自：${w.src || '此前复盘'}）`).join('\n')
      : '';
    this.send(`【材料】\n标题：${d.title}\n部分：${part.title}（第 ${part.from}–${part.to} 页）\n\n【已完成并复盘过的部分（你已知用户学过这些，可承接串联但不要重复问）】\n${doneList || '（这是第一个复盘的部分）'}\n\n${weakList ? `【你记得用户曾卡住的点（温故式追问用，见系统提示）】\n${weakList}\n\n` : ''}【正文（可能截断）】\n${mat.text.slice(0, 40000)}\n\n【我的批注】\n${mat.highlights.length ? mat.highlights.join('\n') : '（无）'}\n\n请开始你的第一个问题。`);
  },

  /* ---------- 场景二：选段提问 ---------- */
  async askAboutSelection({ text, page, title }) {
    const P = SR.state.prompts;
    const memory = await this.learningMemory(`${title} ${text.slice(0, 80)}`);
    const system = [
      P.socratic,
      this.personaLayer(),
      '\n## 当前任务：选段研读',
      `用户在《${title}》第 ${page} 页选中了一段文字。请就这一段向用户提问：先澄清这段在讲什么（让用户用自己的话解释），再深入关键概念、假设与后果。一次只问一个问题，绝不直接讲解，除非用户明确说“没读懂/请解释”。`,
      memory,
    ].join('\n');
    this.newSession('sel', `💬 选段研读 · p.${page}`, {
      brief: `💬 《${SR.esc(title)}》p.${page} 选段`, file: SR.state.doc.path, page, title,
      topic: `${title} p.${page} 选段`,
    }, system);
    this.send(`我选中了这段（p.${page}）：\n\n「${text}」\n\n请就此向我提问。`);
  },

  /* ---------- 场景三：自由探索 ---------- */
  async startExplore() {
    const topic = document.getElementById('exploreTopic').value.trim();
    if (!topic) { SR.toast('请输入想学的主题'); return; }
    const level = document.getElementById('exploreLevel').value;
    const useNotes = document.getElementById('exploreNotes').checked;
    let notesBlock = '';
    if (useNotes) {
      try {
        const r = await SR.api('/api/notes/search?q=' + encodeURIComponent(topic) + '&limit=8');
        this.renderExploreHits(r.hits || []);
        if (r.hits.length) {
          notesBlock = '\n【用户自己的笔记检索结果（用户的已知基础）】\n' + r.hits.map((h) => `- 《${h.rel}》L${h.line}: ${h.snippet}`).join('\n');
        }
      } catch { /* 忽略 */ }
    } else document.getElementById('exploreHits').classList.add('hidden');
    const P = SR.state.prompts;
    const wikiBlock = await this.learningMemory(topic);
    const system = [
      P.socratic,
      this.personaLayer(),
      '\n## 当前任务：自由探索学习',
      P.explore,
      `\n主题：${topic}\n用户自评水平：${level}`,
      '\n问题要具体、可判定：把主题拆成细粒度子问题逐个推进（从概念的定义边界、一个具体例子、一个数值量级或一个反例入手），避免“你怎么理解X”“X是什么”式的空泛问法。',
      notesBlock,
      wikiBlock,
      '\n现在开始：先用一个问题探底用户对该主题的已知程度，再根据回答决定推进节奏。',
    ].join('\n');
    this.newSession('explore', `🔭 ${topic}`, { brief: `🔭 主题：${SR.esc(topic)} · 水平：${level}`, topic, level }, system);
    this.send(`我想学习「${topic}」。我的水平大约是：${level}。请开始引导我。`);
  },

  renderExploreHits(hits) {
    const box = document.getElementById('exploreHits');
    box.classList.remove('hidden');
    box.innerHTML = '';
    box.appendChild(SR.el('div', { class: 'section-title' }, `已检索到 ${hits.length} 条你的相关笔记，将作为引导基础`));
    for (const h of hits.slice(0, 8)) {
      box.appendChild(SR.el('div', { class: 'hit-item', html: `<b>${SR.esc(h.rel)}</b> L${h.line}：${SR.esc(h.snippet)}` }));
    }
  },

  /* 学习 Wiki 检索：开新课时把“用户已经知道什么”注入系统上下文。
     只检索索引文件，避免把历史对话全文塞进模型。 */
  /* 知识库协议头（无检索命中/首轮材料消息时也常驻——AI 随时可索取） */
  _kbProtoOnly() {
    const cfg = SR.state.config || {};
    if (!cfg.vaultPath) return '';
    return '\n## 知识库接入（Obsidian vault）\n你可以在回复里用标记向系统索取资料，索取到后自动续写：\n- `?note[[条目名]]` —— 取 vault 里该文件名的笔记全文\n- `?pages[12]` 或 `?pages[12-14]` —— 取当前材料第 N 页/段的原文（材料多轮后会压缩成骨架，需要原文锚定时就取）\n标记写在需要处、随后立即停止本轮其余内容；系统会把资料注入后让你继续。不要在一条回复里索取超过 2 个。';
  },

  async learningMemory(query) {
    const cfg = SR.state.config || {};
    const proto = '\n## 知识库接入（Obsidian vault）\n你可以在回复里用标记向系统索取资料，索取到后自动续写：\n- `?note[[条目名]]` —— 取 vault 里该文件名的笔记全文（用户归档过的概念/总结都在库里）\n- `?pages[12]` 或 `?pages[12-14]` —— 取当前材料第 N 页/段的原文（材料在多轮后会被压缩成骨架，讲到某块需要原文锚定时就取）\n标记写在需要处、随后立即停止本轮其余内容；系统会把资料注入后让你继续。不确定条目是否存在时也可以试探（未找到会被告知）。不要在一条回复里索取超过 2 个。';
    if (!cfg.vaultPath) return proto;
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!q) return proto;
    try {
      const r = await SR.api('/api/notes/search?q=' + encodeURIComponent(q) + '&limit=6');
      const hits = (r.hits || []).filter((h) => /\.md$/i.test(h.file || h.rel || ''));
      const seen = new Set(); const uniq = hits.filter((h) => { const k = h.rel || h.file; if (seen.has(k)) return false; seen.add(k); return true; });
      if (!uniq.length) return proto;
      return proto + '\n\n### 用户已学知识（vault 检索命中）\n以下是用户笔记里的命中线索（文件 · 命中行），代表已知基础而非当前材料事实；利用它们承接、对比或检验，需要全文就 ?note[[文件名]]：\n' + uniq.map((h) => `- [[${String(h.rel || h.file).replace(/\.md$/i, '')}]]：${h.snippet}`).join('\n');
    } catch { return proto; }
  },

  summaryKindOf(s) {
    if (s.mode === 'guide' || s.mode === 'wit' || s.mode === 'frame' || s.mode === 'part') return 'part';
    if (s.mode === 'review') return 'review';
    return 'explore';
  },

  async archiveLearning() {
    const s = SR.state.session;
    if (!s || !s.messages || s.messages.length < 2 || this.busy) { SR.toast('还没有可归档的学习对话'); return; }
    if (s.mode === 'done') { SR.toast('这段学习已经归档过'); return; }
    SR.toast('正在归档：生成总结、保存对话、更新学习 Wiki…', 'info', 5000);
    const ok = await this.summarize(this.summaryKindOf(s), { autoSave: true });
    if (!ok) return;
    const conv = await this.exportChat({ silent: true });
    if (!conv) {
      SR.toast('归档未完成：总结已保存，但对话导出失败；当前学习会话仍保留', 'error', 6000);
      return;
    }
    if (conv && this._sumMeta && this._sumMeta.entryId) {
      const cfg = SR.state.config || {};
      try {
        await SR.apiPost('/api/wiki/upsert', {
          subdir: (cfg.learning && cfg.learning.wikiSubdir) || '学习Wiki',
          entry: {
            id: this._sumMeta.entryId,
            conversationPath: conv.path,
            conversationLink: String(conv.rel || '').split(/[\\/]/).pop().replace(/\.md$/i, ''),
          },
        });
      } catch (e) { SR.toast('对话已保存，但 Wiki 索引补链接失败：' + e.message, 'error', 5000); }
    }
    s.mode = 'done';
    s.archivedAt = Date.now();
    this.renderChips('done');
    SR.persist.save();
    SR.toast('📚 学习已归档：总结 + 对话已进 Obsidian，Wiki 索引已更新', 'success', 6000);
  },

  /* ---------- 重点总结 ---------- */
  async summarize(kind, opts = {}) {
    const s = SR.state.session;
    if (!s || !s.messages.length) { SR.toast('还没有对话内容'); return false; }
    const P = SR.state.prompts;
    const dlg = document.getElementById('dlgSummary');
    const ta = document.getElementById('sumContent');
    const target = document.getElementById('sumTarget');
    ta.value = '生成中…';
    document.getElementById('sumOpen').classList.add('hidden');
    const isPart = kind === 'part' && (s.mode === 'part' || s.mode === 'guide' || s.mode === 'wit' || s.mode === 'frame') && s.context && s.context.text;
    const isReview = s.mode === 'review';
    document.getElementById('sumTitle').textContent = isPart ? (s.mode === 'guide' ? '🎧 带读总结' : s.mode === 'wit' ? '🔬 WIT 精读纪要' : s.mode === 'frame' ? '🗺 框架精读纪要' : '📝 重点总结 · 部分复盘') : (isReview ? '🧠 巩固记录' : '📝 探索纪要');
    let userMsg = '';
    if (isPart) {
      const c = s.context;
      userMsg = `【材料】《${c.title}》 p.${c.from}–${c.to}（${c.partTitle}）\n【正文节选】\n${c.text.slice(0, 12000)}\n【我的批注】\n${(c.highlights || []).join('\n') || '（无）'}\n\n`;
    } else if (isReview) {
      const c = s.context;
      userMsg = c.reviewKind === 'weak'
        ? `【复习的知识点】${c.weak.text}\n【来源】《${c.bookTitle}》${c.weak.src || ''}\n\n`
        : `【回顾的部分】《${c.bookTitle}》${c.part.title}（p.${c.part.from}–${c.part.to}）\n\n`;
    } else if (s.context && s.context.topic) {
      userMsg = `【探索主题】${s.context.topic}（水平：${s.context.level}）\n\n`;
    }
    userMsg += '【对话记录】\n' + s.messages.map((m) => {
      const text = typeof m.content === 'string' ? m.content : '（材料附图，本轮已由视觉模型读取）';
      return `${m.role === 'user' ? '我' : '引导者'}：${text}`;
    }).join('\n\n');
    const saveBtn = document.getElementById('sumSave');
    if (opts.autoSave) {
      saveBtn.disabled = true;
      saveBtn.textContent = '自动保存中…';
    }
    dlg.showModal();
    this.abort = new AbortController();
    try {
      const acc = await SR.chatStream([
        { role: 'system', content: [P.summarize, '\n这份总结会进入用户的 Obsidian 学习 Wiki，并被未来 AI 学习会话检索。请写成可长期复用的知识条目，不要写成一次性课程纪要。'].join('\n') },
        { role: 'user', content: userMsg },
      ], {
        signal: this.abort.signal,
        onDelta: (_, all) => { ta.value = all; },
      });
      ta.value = acc || '（生成失败，可点“重新生成”）';
      this._sumMeta = { kind: isPart ? 'part' : (isReview ? 'review' : 'explore') };
      /* 顺手提取待巩固点（温故式追问的记忆源）：失败不影响总结本身；
         弱点复习会话不提取（避免刚移除又加回）；部分回顾会话照常提取 */
      const extractOk = !isReview || (s.context && s.context.reviewKind === 'part');
      this._sumMeta.weak = extractOk ? await this.extractWeak(s, isPart).catch(() => []) : [];
      this._sumMeta.wiki = await this.extractWikiMeta(acc, s).catch(() => ({}));
      target.textContent = isPart
        ? `将保存到 vault：${SR.state.config.cards.summariesSubdir || '阅读总结'}/${s.context.title}-p${s.context.from}-${s.context.to}-总结.md`
        : isReview
          ? `将保存到 vault：巩固复习/${(s.context.reviewKind === 'weak' ? s.context.weak.text : s.context.part.title).slice(0, 30)}-巩固记录.md`
          : `将保存到 vault：自由探索/${(s.context.topic || '主题').slice(0, 30)}-探索纪要.md`;
      if (opts.autoSave) {
        const saved = await this.saveSummary({ silent: true });
        saveBtn.disabled = false;
        saveBtn.textContent = '保存到 vault';
        if (saved) {
          dlg.close();
          return true;
        }
        return false;
      }
      return true;
    } catch (e) {
      ta.value = '生成失败：' + e.message;
      if (opts.autoSave) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存到 vault';
      }
      return false;
    } finally { this.abort = null; }
  },

  async extractWikiMeta(summary, s) {
    const c = s.context || {};
    const source = c.title || c.bookTitle || c.topic || s.title || '自由学习';
    const acc = await SR.chatStream([
      { role: 'system', content: '你是学习 Wiki 索引助手。从总结中提取一个 JSON 对象，字段：title（不超过 24 字）、oneLine（一句话核心，不超过 90 字）、topics（3-6 个具体主题词，不要空泛词）、source（来源书名/主题）。只输出 JSON，不要 Markdown 代码块。' },
      { role: 'user', content: `【来源】${source}\n【总结】\n${String(summary || '').slice(0, 12000)}\n\n请输出 JSON 对象。` },
    ], { signal: (this.abort && this.abort.signal) || undefined });
    let obj = null;
    try { obj = JSON.parse(acc.replace(/^```(json)?|```$/g, '').trim()); } catch { /* ignore */ }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
    const fallbackOneLine = (/##\s*一句话核心\s*\n+([^\n]+)/.exec(String(summary || '')) || [])[1] || '';
    return {
      title: String(obj.title || source).slice(0, 80),
      oneLine: String(obj.oneLine || fallbackOneLine || `用户完成了 ${source} 的学习`).slice(0, 240),
      topics: Array.isArray(obj.topics) && obj.topics.length
        ? obj.topics.filter((x) => typeof x === 'string' && x.trim()).slice(0, 8)
        : [source],
      source: String(obj.source || source).slice(0, 120),
    };
  },

  /* 从对话记录提取用户曾卡住的知识点（2-4 条），供未来会话温故式追问 */
  async extractWeak(s, isPart) {
    const P = SR.state.prompts;
    const dlg = s.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-24)
      .map((m) => `${m.role === 'user' ? '我' : '引导者'}：${m.content}`)
      .join('\n\n')
      .slice(0, 20000);
    if (dlg.length < 200) return [];
    const acc = await SR.chatStream([
      { role: 'system', content: '你是学习记录助手。从苏格拉底式对话中提取用户【曾卡住、答错、含糊其辞或明显不确定】的具体知识点。规则：2-4 条；每条一个具体术语/机制/公式（不超过 30 字），细到可直接出题；用户答得流畅的不要收。只输出 JSON 字符串数组，如 ["机制A与B的区别","式(3)中除以√dk的原因"]，不要其他文字。' },
      { role: 'user', content: `【对话记录】\n${dlg}\n\n请输出 JSON 数组。` },
    ], { signal: (this.abort && this.abort.signal) || undefined });
    let arr = null;
    try { arr = JSON.parse(acc.replace(/^```(json)?|```$/g, '').trim()); } catch { /* ignore */ }
    if (!arr && window.SRJsonFix) { try { arr = window.SRJsonFix.parseLLMJsonArray(acc); } catch { /* ignore */ } }
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4).map((x) => x.trim());
  },

  _wikiFrontmatter() {
    const w = (this._sumMeta && this._sumMeta.wiki) || {};
    const topics = Array.isArray(w.topics) && w.topics.length ? w.topics : ['未分类'];
    const oneLine = String(w.oneLine || '').replace(/\s+/g, ' ').trim();
    return [
      oneLine ? `one_line: ${JSON.stringify(oneLine)}` : '',
      `topics: ${JSON.stringify(topics.slice(0, 8))}`,
    ].filter(Boolean).join('\n') + '\n';
  },

  async saveSummary(opts = {}) {
    const s = SR.state.session;
    const ta = document.getElementById('sumContent');
    if (!ta.value.trim() || ta.value.startsWith('生成')) { SR.toast('内容为空或未生成完'); return false; }
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    let filename, content;
    if (this._sumMeta && this._sumMeta.kind === 'part' && s.context && s.context.text) {
      const c = s.context;
      filename = `${c.title}-p${c.from}-${c.to}-总结`;
      content = `---\ncreated: ${now}\ntype: 阅读总结\nsource: "[[${c.title}]]"\npages: ${c.from}-${c.to}\ntags: [苏格拉底阅读器, 阅读总结]\n---\n\n# ${c.title} · p.${c.from}–${c.to} 复盘总结\n\n> 部分：${c.partTitle} · 生成于 ${now}\n\n${ta.value}\n\n## 我的批注（同步）\n${(c.highlights || []).map((h) => '- ' + h).join('\n') || '（无）'}\n`;
    } else if (this._sumMeta && this._sumMeta.kind === 'review' && s.context && s.context.reviewKind) {
      const c = s.context;
      if (c.reviewKind === 'weak') {
        filename = `${c.weak.text.slice(0, 40)}-巩固记录`;
        content = `---\ncreated: ${now}\ntype: 巩固记录\ntopic: ${c.weak.text}\nsource: "${c.bookTitle}"\ntags: [苏格拉底阅读器, 巩固复习]\n---\n\n# 🧠 ${c.weak.text} · 巩固记录\n\n> 来源：《${c.bookTitle}》${c.weak.src || ''} · ${now}\n\n${ta.value}\n`;
      } else {
        filename = `${c.bookTitle}-${c.part.title.slice(0, 24)}-回顾`;
        content = `---\ncreated: ${now}\ntype: 巩固记录\nsource: "${c.bookTitle}"\npart: ${c.part.title}\npages: ${c.part.from}-${c.part.to}\ntags: [苏格拉底阅读器, 巩固复习]\n---\n\n# 🧠 ${c.bookTitle} · ${c.part.title} 回顾\n\n> p.${c.part.from}–${c.part.to} · ${now}\n\n${ta.value}\n`;
      }
    } else {
      const topic = (s.context && s.context.topic) || '自由探索';
      filename = `${topic.slice(0, 40)}-探索纪要`;
      content = `---\ncreated: ${now}\ntype: 探索纪要\ntopic: ${topic}\ntags: [苏格拉底阅读器, 自由探索]\n---\n\n# 🔭 ${topic} · 探索纪要\n\n> 水平：${(s.context && s.context.level) || '-'} · 生成于 ${now}\n\n${ta.value}\n`;
    }
    const sumKind = this._sumMeta && this._sumMeta.kind;
    content = content.replace(/^---\n/, `---\n${this._wikiFrontmatter()}`);
    try {
      const r = await SR.apiPost('/api/notes/save', {
        filename, content,
        subdir: sumKind === 'part' ? (SR.state.config.cards.summariesSubdir || '阅读总结') : (sumKind === 'review' ? '巩固复习' : '自由探索'),
      });
      const cfg = SR.state.config || {};
      if ((this._sumMeta.wiki || {}).oneLine || ((this._sumMeta.wiki || {}).topics || []).length) {
        try {
          const wr = await SR.apiPost('/api/wiki/upsert', {
            subdir: (cfg.learning && cfg.learning.wikiSubdir) || '学习Wiki',
            entry: {
              ...this._sumMeta.wiki,
              type: sumKind === 'part' ? '阅读总结' : (sumKind === 'review' ? '巩固复习' : '自由探索'),
              created: now,
              summaryPath: r.path,
            },
          });
          this._sumMeta.entryId = wr.entry.id;
        } catch (e) { SR.toast('总结已保存，但 Wiki 索引更新失败：' + e.message, 'error', 5000); }
      }
      if (!opts.silent) SR.toast('已保存 ✅ ' + r.path, 'success', 5000);
      this.setPdfMask(false);           // 复盘结束，掀开 PDF 回到阅读
      /* 待巩固点入库（温故式追问的记忆）：合并去重，上限 12 条。
         目标书可能不在阅读器中打开（巩固会话）→ 走服务端写入 */
      if (this._sumMeta && this._sumMeta.weak && this._sumMeta.weak.length) {
        const targetPath = (s.context && (s.context.bookPath || s.context.file)) || '';
        const src = (this._sumMeta.kind === 'part' && s.context && s.context.partTitle)
          ? `${s.context.partTitle}（p.${s.context.from}–${s.context.to}）`
          : (sumKind === 'review' ? '巩固复盘' : '自由探索');
        const d = SR.state.doc;
        if (d && targetPath && d.path === targetPath) {
          d.weakPoints = Array.isArray(d.weakPoints) ? d.weakPoints : [];
          for (const t of this._sumMeta.weak) {
            if (d.weakPoints.some((w) => w.text === t)) continue;
            d.weakPoints.push({ text: t, src, at: Date.now() });
          }
          d.weakPoints = d.weakPoints.slice(-12);
          SR.reader.saveAnnDebounced();
        } else if (targetPath) {
          try {
            await SR.apiPost('/api/review/weak', { path: targetPath, add: true, items: this._sumMeta.weak.map((t) => ({ text: t, src })) });
          } catch { /* 不阻塞保存 */ }
        }
        SR.toast(`📝 已记下 ${this._sumMeta.weak.length} 个待巩固点（下次复盘会温故检验）`, 'info', 4000);
      }
      /* 巩固会话：保存即掌握——弱点移出题池；部分回顾打卡；刷新视图 */
      if (sumKind === 'review' && s.context) {
        const c = s.context;
        try {
          if (c.reviewKind === 'weak' && c.bookPath) {
            const r2 = await SR.apiPost('/api/review/weak', { path: c.bookPath, text: c.weak.text });
            if (r2.removed) SR.toast('✅ 已标记掌握，移出题池', 'success', 3000);
          } else if (c.reviewKind === 'part' && c.bookPath && c.part && c.part.id) {
            const r3 = await SR.apiPost('/api/review/done', { path: c.bookPath, partId: c.part.id });
            if (!r3.already) {
              SR.toast('✅ 已打卡该部分', 'success', 3000);
              const d = SR.state.doc;
              if (d && d.path === c.bookPath) {
                d.partsDone = d.partsDone || {};
                d.partsDone[c.part.id] = { at: Date.now() };
                SR.reader.saveAnnDebounced();
                SR.reader.renderBookmap();
              }
            }
          }
        } catch { /* 不阻塞 */ }
        if (typeof SR.renderReviewPool === 'function') SR.renderReviewPool();
      }
      const a = document.getElementById('sumOpen');
      a.href = r.obsidianUrl;
      a.classList.remove('hidden');
      // 陪读打卡：复盘/带读完成 → 标记该部分，并提示下一个目标
      if (this._sumMeta && this._sumMeta.kind === 'part' && (s.mode === 'part' || s.mode === 'guide' || s.mode === 'wit' || s.mode === 'frame') && s.context && s.context.partId) {
        SR.reader.markPartDone(s.context.partId);
        if (SR.reader.readalong.on) {
          const next = await SR.reader.nextPartAfter({ id: s.context.partId });
          const b = document.getElementById('reviewBanner');
          if (next && b) {
            document.getElementById('bannerText').textContent = `✅ 已打卡「${s.context.partTitle}」。下一个目标：${next.title} (p.${next.from}–${next.to})`;
            b.classList.remove('hidden');
            b.dataset.partId = next.id || '';
            b.dataset.advance = '1';
          } else if (!next) {
            SR.toast('🎉 全书陪读目标完成！');
          }
        }
      }
      return true;
    } catch (e) {
      SR.toast('保存失败：' + e.message, 'error', 5000);
      return false;
    }
  },

  /* ---------- 场景四：巩固 · 追问复习（检索练习优先） ---------- */
  reviewSystem(extra) {
    const P = SR.state.prompts;
    return [
      P.socratic,
      this.personaLayer(),
      '\n## 当前任务：巩固复习（与学新知不同——这是检索练习）',
      '用户此前学过相关内容。你的职责不是讲授，而是检验与加固记忆：',
      '1. **先检索**：第一个问题就让用户凭记忆复述/解释目标知识点（不用看书，说出还记得什么）。用户答“不记得”也要温和接受，那正是复习的价值所在。',
      '2. **再追问校验**：根据复述质量追问——边界情形、具体例子、与其他知识的区别联系。用户复述流畅时加深一档（追问机制细节或反例）；含糊时逐点钉精确。',
      '3. **不愤不启**：用户卡住时先给提示性小问题（材料中能推出答案的位置），不急于讲解；用户明确求助才解释，讲完立刻验证。',
      '4. **温故串联**：材料可能附带来源页原文；用户回忆偏差时，引导他从原文重新推出，而不是直接纠正。',
      '5. **收尾判定**：对话自然收尾时，给出诚实的掌握判定（哪些已牢固/哪些仍需再来），并用一个指向相关知识的悬念问题留钩子。',
      extra || '',
      '\n一次只问一个问题；问题必须锚定具体对象、可判定对错（细致提问原则最高优先级）；除非用户明确说“没读懂/请解释”，不主动讲解。',
    ].join('\n');
  },

  async startWeakReview(book, weak) {
    SR.toast('正在提取来源页文本…');
    const m = /\d+\s*[-–—]\s*\d+/.exec(weak.src || '');
    let material = '';
    if (m) {
      const [a, b] = m[0].split(/\s*[-–—]\s*/).map(Number);
      material = await SR.reader.extractPages(book.path, a, b);
    }
    const memory = await this.learningMemory(`${book.title} ${weak.text}`);
    const system = this.reviewSystem(`本次复习的知识点：「${weak.text}」（来源：《${book.title}》 ${weak.src || ''}）\n${memory}`);
    this.newSession('review', `🧠 巩固 · ${weak.text.slice(0, 18)}`, {
      brief: `🧠 ${SR.esc(weak.text.slice(0, 40))}`, reviewKind: 'weak',
      weak, bookPath: book.path, bookTitle: book.title, material,
    }, system);
    this.send(`我想复习这个知识点：「${weak.text}」\n来源：《${book.title}》${weak.src ? ' ' + weak.src : ''}\n\n${material ? `【来源页原文（校验依据，不要直接复述）】\n${material.slice(0, 12000)}\n\n` : ''}请开始：先让我凭记忆复述，再追问校验。`);
  },

  async startPartReReview(book, part) {
    SR.toast('正在提取该部分文本…');
    const material = await SR.reader.extractPages(book.path, part.from, part.to);
    const memory = await this.learningMemory(`${book.title} ${part.title}`);
    const system = this.reviewSystem(`本次回顾的部分：《${book.title}》 ${part.title}（第 ${part.from}–${part.to} 页，用户已完成过一次复盘）\n${memory}`);
    this.newSession('review', `🧠 回顾 · ${part.title.slice(0, 18)}`, {
      brief: `🧠 ${SR.esc(book.title)} · ${SR.esc(part.title)}`, reviewKind: 'part',
      part, bookPath: book.path, bookTitle: book.title, material,
    }, system);
    this.send(`我想回顾已学过的部分：《${book.title}》${part.title}（第 ${part.from}–${part.to} 页）\n\n${material ? `【该部分原文（校验依据，不要直接复述）】\n${material.slice(0, 40000)}\n\n` : ''}请开始：先让我凭记忆梳理这一部分的主线，再逐点追问校验。`);
  },

  /* ---------- 确认对话框 ---------- */
  confirm(text) {
    return new Promise((resolve) => {
      const dlg = document.getElementById('dlgConfirm');
      document.getElementById('confirmText').innerText = text;
      const check = document.getElementById('confirmCheck');
      check.checked = false;
      dlg.addEventListener('close', () => resolve(false), { once: true }); // Esc/关闭兜底
      const ok = document.getElementById('confirmOk');
      const close = () => { dlg.close(); ok.onclick = null; cancel1.onclick = null; cancel2.onclick = null; };
      const cancel1 = document.getElementById('confirmCancel');
      const cancel2 = document.getElementById('confirmCancel2');
      ok.onclick = () => { const v = check.checked; close(); resolve(v); };
      cancel1.onclick = cancel2.onclick = () => { close(); resolve(false); };
      dlg.showModal();
    });
  },
};
