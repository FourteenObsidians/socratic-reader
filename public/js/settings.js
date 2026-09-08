/* 设置：LLM 预设（deepseek / zai / openrouter …）+ 本地文件联动路径 */
'use strict';

SR.settings = {
  PRESETS: {
    deepseek:    { label: 'DeepSeek 官方',        baseUrl: 'https://api.deepseek.com/v1',            model: 'deepseek-chat' },
    zai:         { label: 'Z.ai（智谱·国际）',      baseUrl: 'https://api.z.ai/api/paas/v4',           model: 'deepseek-v3' },
    bigmodel:    { label: '智谱 BigModel（国内）',   baseUrl: 'https://open.bigmodel.cn/api/paas/v4',   model: 'glm-4.6' },
    openrouter:  { label: 'OpenRouter',            baseUrl: 'https://openrouter.ai/api/v1',           model: 'deepseek/deepseek-chat' },
    openai:      { label: 'OpenAI 官方',           baseUrl: 'https://api.openai.com/v1',              model: 'gpt-4o-mini' },
    ollama:      { label: 'Ollama 本地（免 key）',  baseUrl: 'http://localhost:11434/v1',              model: 'qwen2.5:7b' },
    custom:      { label: '自定义',                baseUrl: '',                                       model: '' },
  },

  init() {
    const sel = document.getElementById('setPreset');
    sel.innerHTML = Object.entries(this.PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    sel.onchange = () => {
      const p = this.PRESETS[sel.value];
      if (sel.value !== 'custom') {
        document.getElementById('setBaseUrl').value = p.baseUrl;
        document.getElementById('setModel').value = p.model;
      }
    };
    document.getElementById('btnSetClose').onclick = document.getElementById('btnSetCancel').onclick =
      () => document.getElementById('dlgSettings').close();
    document.getElementById('btnSetSave').onclick = () => this.save();
    document.getElementById('btnTest').onclick = () => this.test();
    document.getElementById('btnModels').onclick = () => this.models();
  },

  open() {
    const c = SR.state.config;
    document.getElementById('setBaseUrl').value = c.llm.baseUrl;
    const keyEl = document.getElementById('setApiKey');
    if (c.llm.apiKey === '__KEEP__') { keyEl.value = ''; keyEl.placeholder = '已配置（留空保持不变）'; }
    else { keyEl.value = c.llm.apiKey || ''; keyEl.placeholder = 'sk-…（OpenAI 兼容密钥；本地 Ollama 可留空）'; }
    document.getElementById('setModel').value = c.llm.model;
    document.getElementById('setVisionModel').value = c.llm.visionModel || '';
    document.getElementById('setTemp').value = c.llm.temperature;
    document.getElementById('setMaxTokens').value = c.llm.maxTokens;
    document.getElementById('setVault').value = c.vaultPath;
    document.getElementById('setCardsDir').value = c.cards.vaultSubdir;
    document.getElementById('setSumDir').value = c.cards.summariesSubdir;
    document.getElementById('setRoots').value = (c.libraryRoots || []).join('\n');
    document.getElementById('setPersona').value = c.personaPath;
    document.getElementById('setPersonaStyle').value = c.personaStyle || 'classic';
    document.getElementById('setFocusMode').value = c.focusMode || 'flash';
    document.getElementById('setZoteroDir').value = c.zoteroDataDir || '';
    document.getElementById('testResult').textContent = '';
    this.checkVault();
    this.checkZotero();
    document.getElementById('dlgSettings').showModal();
  },

  async checkZotero() {
    const el = document.getElementById('zoteroState');
    try {
      const r = await SR.api('/api/zotero/status');
      el.textContent = r.found ? `✅ 已找到：${r.dataDir}（sqlite ${r.sqliteCapable ? '可读' : '不可用，将用文件名'}）` : '⚠️ 未找到，请手动填写';
      el.style.color = r.found ? 'var(--green)' : 'var(--red)';
    } catch (e) { el.textContent = '检查失败：' + e.message; }
  },

  async checkVault() {
    const el = document.getElementById('vaultState');
    try {
      const r = await SR.api('/api/status');
      el.textContent = r.vault.exists ? `✅ 已找到：${r.vault.resolved}` : `⚠️ 未找到：${r.vault.resolved || r.vault.configured}`;
      el.style.color = r.vault.exists ? 'var(--green)' : 'var(--red)';
    } catch (e) { el.textContent = '检查失败：' + e.message; }
  },

  collect() {
    return {
      llm: {
        baseUrl: document.getElementById('setBaseUrl').value.trim(),
        apiKey: document.getElementById('setApiKey').value.trim(),
        model: document.getElementById('setModel').value.trim(),
        visionModel: document.getElementById('setVisionModel').value.trim(),
        temperature: Number(document.getElementById('setTemp').value) || 0.7,
        maxTokens: Math.max(0, Number(document.getElementById('setMaxTokens').value) || 0),   // 0 = 不限制
      },
      vaultPath: document.getElementById('setVault').value.trim(),
      libraryRoots: document.getElementById('setRoots').value.split('\n').map((s) => s.trim()).filter(Boolean),
      personaPath: document.getElementById('setPersona').value.trim(),
      personaStyle: document.getElementById('setPersonaStyle').value,
      focusMode: document.getElementById('setFocusMode').value,
      zoteroDataDir: document.getElementById('setZoteroDir').value.trim(),
      cards: {
        vaultSubdir: document.getElementById('setCardsDir').value.trim() || 'Cards',
        summariesSubdir: document.getElementById('setSumDir').value.trim() || '阅读总结',
      },
    };
  },

  async save() {
    try {
      const r = await SR.apiPost('/api/config', this.collect());
      SR.state.config = r.config;
      SR.state.prompts = await SR.api('/api/prompts');
      await this.checkVault();
      await this.checkZotero();
      SR.library.refresh();
      SR.zotero.render().catch(() => {});
      SR.toast('设置已保存 ✅', 'success');
      document.getElementById('dlgSettings').close();
    } catch (e) {
      SR.toast('保存失败：' + e.message, 'error');
    }
  },

  async test() {
    const el = document.getElementById('testResult');
    el.textContent = '测试中…';
    el.style.color = 'var(--muted)';
    try {
      // 先应用当前填写的值再测试
      await SR.apiPost('/api/config', this.collect());
      SR.state.config = await SR.api('/api/config');
      const r = await SR.apiPost('/api/llm/test', {});
      el.textContent = `✅ 连接成功：${r.model} · ${r.latencyMs}ms · 回复「${(r.reply || '').slice(0, 20)}」`;
      el.style.color = 'var(--green)';
    } catch (e) {
      el.textContent = '❌ ' + e.message;
      el.style.color = 'var(--red)';
    }
  },

  async models() {
    const dl = document.getElementById('modelList');
    try {
      await SR.apiPost('/api/config', this.collect());
      SR.state.config = await SR.api('/api/config');
      const r = await SR.api('/api/llm/models');
      dl.innerHTML = (r.models || []).map((m) => `<option value="${SR.esc(m)}">`).join('');
      SR.toast(`拉取到 ${r.models.length} 个模型，点击模型输入框选择`, 'success');
    } catch (e) {
      SR.toast('拉取失败：' + e.message, 'error');
    }
  },
};
