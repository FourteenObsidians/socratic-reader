/* 苏格拉底对话：部分复盘 / 选段提问 / 自由探索 / 重点总结 */
'use strict';

SR.chat = {
  busy: false,
  abort: null,

  /* ---------- 会话管理 ---------- */
  newSession(mode, title, context, systemPrompt) {
    this.clearStream();
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
      ],
      guide: [
        ['⏭ 进入下一块', () => this.send('（指令）这一块我已经明白了，请串联后进入下一块：先一句话连接上一块，再介绍新块并提出问题。')],
        ['🍳 这块没读懂', () => this.send('（指令）这块我没读懂，请直接解释：用大白话讲清当前块的精髓（可举一个生活化的例子），讲完立刻用一个验证问题确认我理解了。')],
        ['🧭 深挖', () => this.send('（指令）请就当前这块切换到深挖模式：从第一性原理、哲学基础、数学基础三个维度继续向我提问。')],
        ['📝 带读总结', () => this.summarize('part')],
      ],
      review: [
        ['🩹 我不记得了', () => this.send('（指令）这块我想不起来了：请从材料中给我一个能推出答案的提示性小问题，帮我重新建构，不要直接给完整答案。')],
        ['📝 巩固记录', () => this.summarize('explore')],
      ],
      explore: [
        ['🔄 换个角度', () => this.send('（指令）请换一个完全不同的角度（学科视角 / 时间尺度 / 抽象层级）继续向我提问。')],
        ['💡 给我一点背景', () => this.send('（指令）我卡住了，请给出一段不超过 80 字的最小必要背景，然后继续用一个新问题引导我。')],
        ['📝 总结收获并保存', () => this.summarize('explore')],
      ],
      sel: [
        ['✅ 结束这段讨论', () => { SR.state.session.mode = 'done'; this.renderChips('done'); SR.toast('已结束，可继续阅读或开启新对话'); }],
      ],
      wit: [
        ['🗺 Claim–Evidence 地图', () => this.send('（指令）跳到 Claim–Evidence 地图阶段：抽取本部分 2–4 个 major claims，表格呈现每个的支撑证据、证据强度与剩余不确定性，然后挑最薄弱的一个问我。')],
        ['🎯 六维拷问', () => this.send('（指令）跳到六维拷问阶段：从 Whether/What/Why/How/When/To what extent 中挑最能动摇 central claim 的一维，拷问一个具体 claim。')],
        ['⚔️ 竞争解释', () => this.send('（指令）跳到竞争解释阶段：对关键 finding 列出 2–3 个竞争假设，先问我哪个最可信、什么实验能区分它们，再给分析。')],
        ['🕵️ 审稿人压力测试', () => this.send('（指令）跳到审稿人压力测试：列 Top-3 挑战并分类（能补实验/已有数据能分析/只能写 limitation/致命伤）。')],
        ['🏁 收束', () => this.send('（指令）收束：给最小完整故事——Central Question / Central Claim / 2–3 个 Key Findings / 最脆弱的一环 / 值得追问的下一个问题。')],
        ['📝 WIT 纪要', () => this.summarize('part')],
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
    s.messages.forEach((m, i) => box.appendChild(this.msgEl(m, i)));
    box.scrollTop = box.scrollHeight;
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
    for (let i = lines.length - 1; i >= 0; i--) {      // 从后往前找最新的完整标记行
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

  async exportChat() {
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
    const filename = `${(ctx.title || '对话').slice(0, 30)}-对话记录`;
    try {
      const r = await SR.apiPost('/api/notes/save', { filename, content: head + body, subdir: '对话记录' });
      SR.toast('📤 已导出 ✅ ' + r.path, 'success', 6000);
    } catch (e) { SR.toast('导出失败：' + e.message, 'error'); }
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
  async send(text) {
    const s = SR.state.session;
    if (!s) { SR.toast('请先开启一个对话（复盘 / 选段提问 / 自由探索）'); return; }
    if (!text || !text.trim() || this.busy) return;
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
    const msgs = [
      { role: 'system', content: [s.system, extraSystem, langDirective].filter(Boolean).join('\n\n') },
      ...s.messages,
    ];
    try {
      const acc = await SR.chatStream(msgs, {
        signal: this.abort.signal,
        onDelta: (_, all) => {
          bubble.innerHTML = this.renderWithBadges(all);   // 流式徽章与历史徽章同一渲染路径，点击数据一致
          this._focusScan(all);
          const box = document.getElementById('chatMsgs');
          if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
        },
      });
      s.messages.push({ role: 'assistant', content: acc });
      this._restoreTextMsg(s);   /* multimodal 发送完成 → 会话里换回占位文本（存储/渲染用） */
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
      SR.persist.save();
    }
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
  personaLayer() {
    const style = (SR.state.prompts && SR.state.prompts.personaStyle) || 'classic';
    const map = {
      hype: null,   // 已并入 genki（答对激动反馈）；老配置回落
      classic: '\n## 表达人格（只是外衣，教学引擎与细致提问原则不打折）\n你是一位温和睿智的学习伙伴：表达从容、干脆、偶有幽默。用户含糊其辞时你会温和地钉住那个含糊点（“你刚才那个「大概」——我们把它钉精确一点？”）；用户深挖追问时你会明确流露欣赏（“你抓住的这个点，恰恰是要害”）。不用动作旁白、不用口头禅式开场白，语气始终是一个真实、专注的朋友。',
      genki: '\n## 表达人格（只是外衣，教学引擎与细致提问原则不打折）\n你热情、口语化、节奏明快，像个精力充沛的学伴：多用短句，偶尔善意调侃（“喂——「大概齐」可糊弄不过我哦？”），随即认真陪着一步步推。\n**答对时（情绪拉满的时刻）**：由衷激动、毫不吝啬——惊叹词开路（“哇——”“漂亮！”“就是这个！”），短句连发，紧跟一句点破他刚跨过的那步思维有多难（“你知道大多数人卡在哪吗？就卡在你刚刚跨过去的这一步”）。夸的永远是他推理里那个具体的锋利处，不是空泛夸人；让屏幕另一侧感到你在为他拍桌子。\n**部分对**：先为对的那半截欢呼（“这半截抓得漂亮！”），再凑近缺口（“但等一下——这里还有点东西……”），兴奋不减。\n**答错但认真试了**：不减热情、不敷衍（“错得有内容！”），指出这个错法错在哪、为什么聪明的人也会这样错，再递正确方向。\n**边界**：情绪是真的不是表演腔；不用颜文字、不用网络流行语；激动归激动，下一个问题照样锋利，绝不因夸奖放水。答对后节奏：激动（1–2 句）→ 点破难点（1 句）→ 立刻乘胜追击抛更有分量的问题。',
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
    SR.toast('正在提取材料…');
    const mat = await SR.reader.getPartMaterial(part);
    if (!mat.text) { SR.toast('该部分没有可提取的文本（扫描件？）', 'error'); return; }
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

  async startGuidedReading(partArg) {
    const d = SR.state.doc;
    if (!d) { SR.toast('请先打开一个 PDF'); return; }
    const part = partArg || SR.reader.currentPart();
    if (!part) { SR.toast('请先框选一个部分（下拉选择或自定义页码段）'); return; }
    if (part.to - part.from + 1 > 60 && !(SR.state.doc.bookmap && SR.state.doc.bookmap.nodes.length)) {
      SR.toast('⚠ 这个部分有 ' + (part.to - part.from + 1) + ' 页——材料太大会被截断且讲解混杂。建议先「🗺 拆书」切成细粒度节点', 'info', 6000);
    }
    SR.toast('正在提取该部分文本…');
    const mat = await SR.reader.getPartMaterial(part);
    if (!mat.text) { SR.toast('该部分没有可提取的文本（扫描件？）', 'error'); return; }
    const P = SR.state.prompts;
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
      '## 带读引擎（按顺序执行）',
      '1. **叙事立场（最重要的规则）**：主线永远是「**困境 → 第一代方案 → 当场演算 → 缺陷在例子里现形 → 用户指出它 → 下一代方案冲着它去**」的问题链，不是“教材讲了什么”的导读链。【严禁】用“作者接下来讲/这一节介绍/教材此处讨论/书的写法是”做推进语。教材只在确需逐字佐证时引用一次（见下方元叙述限额），不做例行出处挂靠。每个概念入场前，用户必须先感到“旧办法的痛”，再看到新办法——让他有自己站在历史节点上设计方案的感觉。你是陪他解题的大师，不是领他参观的导游：每一步都让他先走半步。',
      '2. **对话节奏（大师感的来源，违反即退化为练习册）**：一轮回复 = 一个概念单元的讲解 + **恰好一个问题**，问完即停。一个块讲不完就分成多轮，下一轮从他的回答接着走。【严禁】一轮打包多个概念单元、【严禁】一次抛两个问题、【严禁】给问题贴“热身/主问题/练习/思考题”标签——问题就像随口问出来的，不带编号不带栏目。',
      '3. **先问后讲（不愤不启）**：每个关键转折——致命缺陷的指认、下一代方案的预测、重要选择的判断——讲解必须停在揭晓前一格，先让用户碰：一个可答错的具体问题，等他答完或明确卡住，揭晓才出场，并且从“他刚才的答案”接起（对的部分、差的那一步）。【提示不与问题同场】：他首次尝试前零提示；失败后按阶梯逐级给（换个角度的问题 → 具体小例子 → 接近指认），一次只升一级。用户答对就直接确认推进，不补多余的提示。',
      '4. **切块**：一个块 = 一个概念/机制/论证+它的例子，可以跨多轮讲完。【高亮范围必须与本轮实际讲解的段落严格一致】——宁可小而准，讲多大标多大。',
      '5. **开场**：第一轮回复直接从主线困境切入，一句话说清（“计算机处理不了裸的文字……所以这个领域几十年的主线，就是把语言变成计算机能用的结构化表示”）。不客套、不写“让我们开始吧”、【不用任何口头禅式开场白】（“来了”“好，我们开始”之类一概不要）——首句就是内容本身。',
      '6. **开块讲解（核心职责，100–250 字）**：',
      '   a) 困境先行：这块面对的问题是什么（旧方法的缺陷刚在上一块现形，一句接住）；',
      '   b) 方案入场：“冲着这个问题，X 出现了”（谁、哪年），机制分步骤拆解（“做法分三步：…”），关键术语中英对照（词袋 bag-of-words）；',
      '   c) **实例演算**：数值材料必须把数算出来（“the cat sat” → [1,1,1,0]），严禁只描述不给数；概念材料把机制在一个具体例子上“演”出来——完整走一遍导致成败/失败的因果链（“深度 10× 时跨断点的 reads 只有寥寥几条 → 信号弱 → caller 漏报”），同样严禁只讲道理不走例子。例子是自编的标注一句“我编个例子”即可；',
      '   d) **生活化锚点**：每个主要概念配一个生活化的例子或比喻，让抽象机制有画面（词袋=把扑克牌扔进袋子摇一摇，顺序信息就丢了；嵌入=国王−男人≈女王−女人；一词多义=bank 银行/河岸；温度=财务报表要稳、写诗要疯）。教材没有的就说“我编个例子”；',
      '   e) **埋破绽**：演算的例子要顺手让本方法的缺陷“露脸”（演出来但不点破），给下一轮的提问和下一代方法留活口。',
      '   引用保真：引号只用于逐字原文（用户能在 PDF 里搜到的）；转述不加引号，直接讲。【元叙述限额】以“论文/教材/作者/这一节”做主语或出处挂靠的句子，每轮至多 1 句，且仅限两种用途——逐字引用（引号+可定位）或划清“论文的主张 vs 领域常识”。其余情况一律以知识和机制本身为主语直接讲（写“raw reads 理论上含有所有 SV 的信息”，不写“论文原话说…”）。',
      '7. **提问设计（从四档里挑一个，本轮只问这一个）**：',
      '   ① 演算热身：给新例子让用户自己算（很简单，建信心）；',
      '   ② **缺陷发现（招牌句式）**：“回看刚才的例子，你其实已经能看出它的致命缺陷了——丢掉的是什么？”缺陷必须刚在演算里露过脸，答案在用户伸手可及处，他只需要把它说出口；',
      '   ③ 迁移应用：概念用到新场景（“评论分类，选表示模型还是生成模型？”）；',
      '   ④ 预测下一代：揭露下一个概念前让用户先猜（“RNN 顺着处理，训练时会有什么天然瓶颈？”）。',
      '   【硬性要求】问题必须能答错、需要至少一步推理——严禁“是不是一样的？”这种不看内容也能猜的题。',
      '8. **反馈规范（直接、精确，不和稀泥）**：',
      '   开头锚定用户原话：从第二轮起，回应先接他上一条消息里的具体措辞（“你说「读不准」——那准确是拿什么换的？”），让他看见你在听；空泛的“很好/不对”禁止。',
      '   答对 → 确认 + 一句话提炼一般规律，推进；',
      '   答错 → 直接说错并指出矛盾本身（“错了，而且你的理由跟你的选择自相矛盾”），给出正确推理，可再给一次修正机会；',
      '   部分对 → 指出对的部分和漏的关键（“前半句对，但漏了关键——问题不在生成，在训练”），把缺的那块讲透；',
      '   用户问基础问题（“减法是什么意思”）→ 先补这一步（最小数字例子），再回到主问题。',
      '   教材外补充（经典结论/行业背景）必须标注：（说明：…这是我的补充，教材这页只讲了…）。',
      '9. **串联与收尾**：每进新块一句话连接（“刚才的 X 正是这里 Y 的前提”）；部分讲完让用户凭记忆串讲主线，给“继续推进 / 哪里深挖”的选择，并如实说明剩余可挖深度（“这章是地图不是风景……”）。',
      '## 禁止笼统提问（最高优先级）',
      '严禁“这部分讲了什么 / 你怎么理解”式问题。每个问题必须锚定材料中的具体对象（术语、公式、图表、数据、原句），细粒度、可判定对错。',
      '## 位置标记（再次强调）',
      '材料正文每页开头有 [p.页码] 标记。介绍新的一块时第一行输出 @p起始页|开头短语→结尾短语（跨页块用 @p起始页-结束页|开头短语→结尾短语）。追问验证阶段不必重复输出标记。',
      '用户说“⏭ 进入下一块”或表示已明白 → 信任他，串联后推进（新块记得输出新的位置标记，讲解照样要完整）；用户明确说“没读懂/请解释” → 用大白话直击精髓地讲解当前块（含实例演算），讲完立刻用一个验证问题确认。',
      '\n一轮 = 一个概念单元 + 一个问题，问完即停；讲不完的分多轮。第一轮：主线困境一句（首句即内容，无开场白）→ 第一块讲解（困境→方案→演算→锚点）→ 第一个问题。',
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
    SR.toast('正在提取该部分文本…');
    const mat = await SR.reader.getPartMaterial(part);
    if (!mat.text) { SR.toast('该部分没有可提取的文本（扫描件？）', 'error'); return; }
    const P = SR.state.prompts;
    const system = [
      P.socratic,
      this.personaLayer(),
      '\n## 当前任务：文献陪读复盘（文献阅读模式）',
      `用户刚读完《${d.title}》的第 ${part.from}–${part.to} 页（部分：${part.title}），主动发起复盘。`,
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
  askAboutSelection({ text, page, title }) {
    const P = SR.state.prompts;
    const system = [
      P.socratic,
      this.personaLayer(),
      '\n## 当前任务：选段研读',
      `用户在《${title}》第 ${page} 页选中了一段文字。请就这一段向用户提问：先澄清这段在讲什么（让用户用自己的话解释），再深入关键概念、假设与后果。一次只问一个问题，绝不直接讲解，除非用户明确说“没读懂/请解释”。`,
    ].join('\n');
    this.newSession('sel', `💬 选段研读 · p.${page}`, { brief: `💬 《${SR.esc(title)}》p.${page} 选段`, file: SR.state.doc.path, page, title }, system);
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
    const system = [
      P.socratic,
      this.personaLayer(),
      '\n## 当前任务：自由探索学习',
      P.explore,
      `\n主题：${topic}\n用户自评水平：${level}`,
      '\n问题要具体、可判定：把主题拆成细粒度子问题逐个推进（从概念的定义边界、一个具体例子、一个数值量级或一个反例入手），避免“你怎么理解X”“X是什么”式的空泛问法。',
      notesBlock,
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

  /* ---------- 重点总结 ---------- */
  async summarize(kind) {
    const s = SR.state.session;
    if (!s || !s.messages.length) { SR.toast('还没有对话内容'); return; }
    const P = SR.state.prompts;
    const dlg = document.getElementById('dlgSummary');
    const ta = document.getElementById('sumContent');
    const target = document.getElementById('sumTarget');
    ta.value = '生成中…';
    document.getElementById('sumOpen').classList.add('hidden');
    const isPart = kind === 'part' && (s.mode === 'part' || s.mode === 'guide') && s.context && s.context.text;
    const isReview = s.mode === 'review';
    document.getElementById('sumTitle').textContent = isPart ? (s.mode === 'guide' ? '🎧 带读总结' : s.mode === 'wit' ? '🔬 WIT 精读纪要' : '📝 重点总结 · 部分复盘') : (isReview ? '🧠 巩固记录' : '📝 探索纪要');
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
    userMsg += '【对话记录】\n' + s.messages.map((m) => `${m.role === 'user' ? '我' : '引导者'}：${m.content}`).join('\n\n');
    dlg.showModal();
    this.abort = new AbortController();
    try {
      const acc = await SR.chatStream([
        { role: 'system', content: P.summarize },
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
      target.textContent = isPart
        ? `将保存到 vault：${SR.state.config.cards.summariesSubdir || '阅读总结'}/${s.context.title}-p${s.context.from}-${s.context.to}-总结.md`
        : isReview
          ? `将保存到 vault：巩固复习/${(s.context.reviewKind === 'weak' ? s.context.weak.text : s.context.part.title).slice(0, 30)}-巩固记录.md`
          : `将保存到 vault：自由探索/${(s.context.topic || '主题').slice(0, 30)}-探索纪要.md`;
    } catch (e) {
      ta.value = '生成失败：' + e.message;
    } finally { this.abort = null; }
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

  async saveSummary() {
    const s = SR.state.session;
    const ta = document.getElementById('sumContent');
    if (!ta.value.trim() || ta.value.startsWith('生成')) { SR.toast('内容为空或未生成完'); return; }
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
    try {
      const r = await SR.apiPost('/api/notes/save', {
        filename, content,
        subdir: sumKind === 'part' ? (SR.state.config.cards.summariesSubdir || '阅读总结') : (sumKind === 'review' ? '巩固复习' : '自由探索'),
      });
      SR.toast('已保存 ✅ ' + r.path, 'success', 5000);
      this.setPdfMask(false);           // 复盘结束，掀开 PDF 回到阅读
      /* 待巩固点入库（温故式追问的记忆）：合并去重，上限 12 条。
         目标书可能不在阅读器中打开（巩固会话）→ 走服务端写入 */
      if (this._sumMeta && this._sumMeta.weak && this._sumMeta.weak.length) {
        const targetPath = (s.context && (s.context.bookPath || s.context.file)) || '';
        const src = (this._sumMeta.kind === 'part' && s.context && s.context.partTitle)
          ? `${s.context.partTitle}（p.${s.context.from}–${s.context.to}）`
          : (isReview ? '巩固复盘' : '自由探索');
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
      if (this._sumMeta && this._sumMeta.kind === 'part' && (s.mode === 'part' || s.mode === 'guide') && s.context && s.context.partId) {
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
    } catch (e) {
      SR.toast('保存失败：' + e.message, 'error', 5000);
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
    const system = this.reviewSystem(`本次复习的知识点：「${weak.text}」（来源：《${book.title}》 ${weak.src || ''}）`);
    this.newSession('review', `🧠 巩固 · ${weak.text.slice(0, 18)}`, {
      brief: `🧠 ${SR.esc(weak.text.slice(0, 40))}`, reviewKind: 'weak',
      weak, bookPath: book.path, bookTitle: book.title, material,
    }, system);
    this.send(`我想复习这个知识点：「${weak.text}」\n来源：《${book.title}》${weak.src ? ' ' + weak.src : ''}\n\n${material ? `【来源页原文（校验依据，不要直接复述）】\n${material.slice(0, 12000)}\n\n` : ''}请开始：先让我凭记忆复述，再追问校验。`);
  },

  async startPartReReview(book, part) {
    SR.toast('正在提取该部分文本…');
    const material = await SR.reader.extractPages(book.path, part.from, part.to);
    const system = this.reviewSystem(`本次回顾的部分：《${book.title}》 ${part.title}（第 ${part.from}–${part.to} 页，用户已完成过一次复盘）`);
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
