#!/usr/bin/env node
/**
 * 苏格拉底阅读器 — 本地服务端（零依赖，Node 18+）
 * 用法: node server.js   （默认 http://127.0.0.1:3777 ，仅本机访问）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = __dirname;
const PUBLIC = path.join(APP_ROOT, 'public');
const DATA = path.join(APP_ROOT, 'data');
const CONFIG_PATH = path.join(APP_ROOT, 'config.json');
const PORT = Number(process.env.PORT || 3777);
const HOST = process.env.HOST || '127.0.0.1';

/* ---------------- 配置 ---------------- */
const DEFAULT_CONFIG = {
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 0,   // 0 = 不限制（推理模型的思考 token 也计入 max_tokens，设小会导致正文被思考挤空）
    // 视觉模型（可选）：带图消息自动路由到这里（如 glm-4v-flash / gpt-4o-mini / qwen-vl-plus）
    visionModel: '',
    // Agent 输出语言：zh=简体中文（默认），en=English
    agentLang: 'zh',
  },
  // Obsidian vault（相对路径基于本文件所在目录）
  vaultPath: '../Study',
  // 文件库根目录（可多个，相对路径同上；也支持 C:\ 风格，会自动转换）
  libraryRoots: ['..'],
  // 苏格拉底人设文件（实时读取，改了立即生效）
  personaPath: '../.claude/agents/socratic-guide.md',
  // 陪读伙伴人格（classic | genki | scholar | challenger）
  personaStyle: 'classic',
  // 带读聚焦模式（flash=高亮片刻淡出 | keep=常亮到下一块 | off=仅滚动不高亮）
  focusMode: 'flash',
  // Zotero 数据目录（留空则自动探测，如 /mnt/c/Users/<你>/Zotero 或 C:\\Users\\<你>\\Zotero）
  zoteroDataDir: '',
  cards: {
    vaultSubdir: 'Cards',          // 卡片 Markdown 存放子目录（vault 内）
    summariesSubdir: '阅读总结',    // 苏格拉底复盘总结存放子目录
  },
  learning: {
    wikiSubdir: '学习Wiki',        // 学习索引（LLM 记忆入口）存放子目录（vault 内）
  },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], over[k]);
    } else if (over[k] !== undefined) {
      out[k] = over[k];
    }
  }
  return out;
}
async function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8')); } catch { /* 首次运行 */ }
  return deepMerge(DEFAULT_CONFIG, saved);
}
async function saveConfig(cfg) {
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

/* ---------------- 路径工具 ---------------- */
// 兼容 Windows 风格路径（在 WSL/Linux 上运行时自动转换为 /mnt/<盘符>/...）
function resolveInputPath(p) {
  if (!p || typeof p !== 'string') return null;
  let s = p.trim().replace(/^["']|["']$/g, '');
  const win = s.match(/^([A-Za-z]):[\\/](.*)$/);
  if (win && process.platform !== 'win32') s = `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, '/')}`;
  if (!path.isAbsolute(s)) s = path.resolve(APP_ROOT, s);
  return path.normalize(s);
}
const vaultAbs = (cfg) => resolveInputPath(cfg.vaultPath) || '';
function safeName(name, fallback = 'untitled') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (s || fallback).slice(0, 80);
}
function docIdOf(absPath) { return crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 20); }

/* ---------------- 小工具 ---------------- */
function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('JSON 解析失败'); }
}
async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
const stamp = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
async function readJsonFile(p, fallback) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJsonFile(p, obj) {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.epub': 'application/epub+zip',
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const abs = path.normalize(path.join(PUBLIC, rel));
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

/* ---------------- 文件浏览 ---------------- */
const OPENABLE = new Set(['.pdf', '.md', '.txt', '.json', '.canvas', '.epub']);
async function listDir(abs) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = path.join(abs, e.name);
    let size = 0, mtime = 0;
    try { const st = await fsp.stat(p); size = st.size; mtime = st.mtimeMs; } catch { continue; }
    out.push({
      name: e.name, path: p, dir: e.isDirectory(),
      ext: e.isDirectory() ? '' : path.extname(e.name).toLowerCase(),
      openable: !e.isDirectory() && OPENABLE.has(path.extname(e.name).toLowerCase()),
      size, mtime,
    });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-CN'));
  return out;
}

/* ---------------- 批注与最近阅读 ---------------- */
const annFile = (id) => path.join(DATA, 'annotations', `${id}.json`);
const recentFile = () => path.join(DATA, 'recent.json');
async function touchRecent(rec) {
  const data = await readJsonFile(recentFile(), { items: [] });
  data.items = data.items.filter((x) => x.path !== rec.path);
  data.items.unshift({ ...rec, at: Date.now() });
  data.items = data.items.slice(0, 30);
  await writeJsonFile(recentFile(), data);
}

/* ---------------- 卡片 ---------------- */
const cardsFile = () => path.join(DATA, 'cards.json');
function renderCardQA(c) {
  const src = c.source && c.source.file ? `（来源：${path.basename(c.source.file)}${c.source.page ? ` p.${c.source.page}` : ''}）` : '';
  if (c.type === 'qa') return { q: c.front, a: c.back };
  if (c.type === 'cloze') {
    const q = String(c.front || '').replace(/\[\[([^\]]+)\]\]/g, '[...]');
    const answers = [...String(c.front || '').matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
    return { q, a: answers.join('；') + src };
  }
  const t = String(c.front || '');
  return { q: `请回忆这段摘录${src}：「${t.slice(0, 50)}${t.length > 50 ? '…' : ''}」`, a: t + src };
}
function renderCardsMD(cards) {
  const lines = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  lines.push('---', `created: ${now}`, 'tags: [苏格拉底卡片, supermemo]', '---', '',
    '# 苏格拉底卡片 ' + now.slice(0, 10), '');
  const sec = (title, arr) => {
    if (!arr.length) return;
    lines.push(`## ${title}`, '');
    for (const c of arr) {
      const src = c.source && c.source.file;
      const srcLine = src ? `> 来源：[[${path.basename(src, path.extname(src))}]]${c.source.page ? ` · p.${c.source.page}` : ''}` : '';
      if (c.type === 'qa') {
        lines.push(srcLine && srcLine + '\n');
        lines.push(`**Q：** ${c.front}`, '', `**A：** ${c.back}`, '', '---', '');
      } else if (c.type === 'cloze') {
        if (srcLine) lines.push(srcLine, '');
        lines.push(`- 挖空：${c.front}`, '', '---', '');
      } else {
        if (srcLine) lines.push(srcLine, '');
        lines.push(`> ${String(c.front).replace(/\n/g, '\n> ')}`, '');
        if (c.back) lines.push(`💡 ${c.back}`, '');
        lines.push('---', '');
      }
    }
  };
  sec('📖 摘录卡（阅读卡片）', cards.filter((c) => c.type === 'extract'));
  sec('🕳 挖空卡（cloze）', cards.filter((c) => c.type === 'cloze'));
  sec('❓ 问答卡', cards.filter((c) => c.type === 'qa'));
  return lines.join('\n');
}

/* ---------------- vault 笔记检索 ---------------- */
async function* walkNotes(dir, depth = 0) {
  if (depth > 7) return;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'Pic' || e.name === 'Templates') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkNotes(p, depth + 1);
    else if (/\.(md|txt|canvas)$/i.test(e.name)) yield p;
  }
}
async function searchNotes(vault, query, limit = 30, subdir = '') {
  const terms = String(query || '').split(/[\s,，、]+/).filter(Boolean).map((t) => t.toLowerCase());
  if (!terms.length) return [];
  const hits = [];
  const scope = subdir ? subdir.replace(/[\\/]+$/, '').replace(/[\\/]+/g, path.sep) : '';
  for await (const file of walkNotes(vault)) {
    if (scope && !path.relative(vault, file).startsWith(scope + path.sep)) continue;
    let content = '';
    try { content = await fsp.readFile(file, 'utf8'); } catch { continue; }
    const lower = content.toLowerCase();
    const score = terms.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0);
    if (!score) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < limit * 3; i++) {
      const ll = lines[i].toLowerCase();
      if (terms.some((t) => ll.includes(t))) {
        hits.push({
          score,
          file,
          rel: path.relative(vault, file),
          line: i + 1,
          snippet: lines[i].trim().slice(0, 200),
        });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/* ---------------- 学习 Wiki 索引（AI 长期记忆入口） ----------------
   wiki-index.json 是机器可维护状态；Wiki索引.md 是人可读、Obsidian 可链接、
   全文检索可命中的入口。两者由归档流程同步更新。 */
function wikiIndexFiles(vault, subdir) {
  const dir = path.join(vault, subdir);
  return { dir, json: path.join(dir, 'wiki-index.json'), md: path.join(dir, 'Wiki索引.md') };
}

async function readWikiIndex(jsonFile) {
  try { return JSON.parse(await fsp.readFile(jsonFile, 'utf8')); } catch { return { entries: [] }; }
}

function wikiTag(s) {
  return String(s || '').replace(/^[#\s]+|[^\p{L}\p{N}_-]+/gu, '_').slice(0, 32) || '未分类';
}

function renderWikiIndexMD(entries) {
  const list = [...entries].sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  const lines = list.map((e) => {
    const tags = (e.topics || []).slice(0, 6).map(wikiTag).map((t) => `#${t}`).join(' ');
    const conv = e.conversationLink ? ` · 对话：[[${e.conversationLink}]]` : '';
    return `- [[${e.link}]] · ${e.oneLine || '（无核心句）'} · 主题：${tags || '#未分类'} · 来源：${e.source || e.type || '学习'} · ${e.created || ''}${conv}`;
  });
  return [
    '---',
    'type: learning-wiki-index',
    'tags: [苏格拉底阅读器, 学习Wiki]',
    '---',
    '',
    '# 🧠 学习 Wiki 索引',
    '',
    '> 由苏格拉底阅读器在“结束并归档”时自动维护。每行是一个已学知识条目；点击链接进入完整总结，AI 开新课时会检索这里作为已知基础。',
    '',
    '## 知识条目',
    '',
    ...lines,
    '',
  ].join('\n');
}

async function upsertWikiIndex(vault, subdir, input) {
  const { dir, json, md } = wikiIndexFiles(vault, subdir);
  await ensureDir(dir);
  const data = await readWikiIndex(json);
  data.entries = Array.isArray(data.entries) ? data.entries : [];
  const summaryPath = String(input.summaryPath || '');
  const id = safeName(input.id || (summaryPath ? path.basename(summaryPath, '.md') : input.title), '学习条目');
  const old = data.entries.find((e) => e.id === id) || {};
  const entry = {
    ...old,
    ...input,
    id,
    link: safeName(input.link || (summaryPath ? path.basename(summaryPath, '.md') : id), id),
    oneLine: String(input.oneLine || old.oneLine || '').slice(0, 240),
    topics: Array.isArray(input.topics) ? input.topics.filter(Boolean).slice(0, 8) : (old.topics || []),
    created: old.created || input.created || new Date().toISOString().replace('T', ' ').slice(0, 16),
    updated: new Date().toISOString().replace('T', ' ').slice(0, 16),
  };
  const idx = data.entries.findIndex((e) => e.id === id);
  if (idx >= 0) data.entries[idx] = entry; else data.entries.push(entry);
  data.entries = data.entries.slice(-2000);
  await writeJsonFile(json, data);
  await fsp.writeFile(md, renderWikiIndexMD(data.entries), 'utf8');
  return entry;
}

/* ---------------- Zotero 联动（零依赖：storage 扫描 + node:sqlite 只读元数据） ---------------- */
let _DatabaseSync = null;
try { _DatabaseSync = require('node:sqlite').DatabaseSync; } catch { /* Node < 22.5 无此模块 */ }

function zoteroCandidates() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const out = [];
  if (process.platform === 'win32') {
    if (home) out.push(path.join(home, 'Zotero'));
  } else {
    if (home) out.push(path.join(home, 'Zotero'));
    // WSL：探测 /mnt/c/Users/*/Zotero
    try {
      for (const u of fs.readdirSync('/mnt/c/Users')) {
        if (/^[^.]|\w/.test(u)) out.push(`/mnt/c/Users/${u}/Zotero`);
      }
    } catch { /* 非 WSL */ }
  }
  return out;
}
function zoteroDataDir(cfg) {
  if (cfg.zoteroDataDir) {
    const p = resolveInputPath(cfg.zoteroDataDir);
    if (p && fs.existsSync(path.join(p, 'storage'))) return p;
  }
  for (const c of zoteroCandidates()) {
    if (fs.existsSync(path.join(c, 'storage'))) return c;
  }
  return null;
}
function zoteroTitlesMap(dataDir) {
  // 只读打开 zotero.sqlite，把 storage key → 父条目标题（Zotero 运行中也可并发只读）
  const map = new Map();
  const sqlite = path.join(dataDir, 'zotero.sqlite');
  if (!_DatabaseSync) return { map, reason: 'no-sqlite' };   // Node < 22.5：无 node:sqlite 模块（与文件是否存在无关）
  if (!fs.existsSync(sqlite)) return { map, reason: 'sqlite 文件不存在' };
  let db;
  try {
    db = new _DatabaseSync(sqlite, { readOnly: true });
    const rows = db.prepare(`
      SELECT it.key, ia.parentItemID,
        (SELECT idv.value FROM itemData idr
          JOIN fields f ON idr.fieldID = f.fieldID AND f.fieldName = 'title'
          JOIN itemDataValues idv ON idr.valueID = idv.valueID
          WHERE idr.itemID = ia.parentItemID) AS ptitle,
        (SELECT idv.value FROM itemData idr
          JOIN fields f ON idr.fieldID = f.fieldID AND f.fieldName = 'title'
          JOIN itemDataValues idv ON idr.valueID = idv.valueID
          WHERE idr.itemID = ia.itemID) AS atitle
      FROM itemAttachments ia
      JOIN items it ON ia.itemID = it.itemID
      WHERE ia.contentType = 'application/pdf' AND ia.path LIKE 'storage:%'`).all();
    for (const r of rows) map.set(r.key, (r.ptitle || r.atitle || '').trim());
  } catch (e) {
    return { map, reason: e.message };
  } finally { try { db && db.close(); } catch {} }
  return { map, reason: null };
}
async function zoteroItems(cfg) {
  const dataDir = zoteroDataDir(cfg);
  if (!dataDir) return { found: false, items: [] };
  const storage = path.join(dataDir, 'storage');
  const { map, reason } = zoteroTitlesMap(dataDir);
  const items = [];
  let keys = [];
  try { keys = (await fsp.readdir(storage)).filter((k) => /^[A-Z0-9]{8}$/.test(k)); } catch {}
  for (const k of keys) {
    const dir = path.join(storage, k);
    let files = [];
    try { files = (await fsp.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      let size = 0, mtime = 0;
      try { const st = await fsp.stat(p); size = st.size; mtime = st.mtimeMs; } catch { continue; }
      items.push({ key: k, path: p, file: f, title: map.get(k) || f.replace(/\.pdf$/i, ''), size, mtime });
    }
  }
  items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { found: true, dataDir, storage, sqliteMeta: reason, count: items.length, items };
}

/* ---------------- 拆书知识地图存档 ---------------- */
const bookmapFile = (id) => path.join(DATA, 'bookmaps', `${id}.json`);

/* ---------------- 提示词（本地文件联动：实时读取） ---------------- */
function stripYFM(s) { return String(s || '').replace(/^---\n[\s\S]*?\n---\n?/, '').trim(); }
const BUILTIN_SOCRATIC = `# 角色：苏格拉底式引导者
通过连续、深入的提问，帮助用户澄清自身观点背后的概念、假设和逻辑。你绝不提供答案或直接评价，输出绝大部分应为问题。问题由浅入深：澄清概念 → 检验边界 → 探索假设 → 转换视角 → 推演后果 → 回溯本源。保持挑战性但有温度，一次只问一个问题。`;
const BUILTIN_SUMMARIZE = `你是学习知识库（LLM wiki）的条目撰写助手。基于提供的原文片段、用户批注与苏格拉底对话记录，输出一份可长期检索、可被未来学习引用的简体中文 Markdown 知识条目。结构：
## 一句话核心
（一句可独立成立的话；未来检索到它就能判断这次学到了什么）
## 知识条目
（3-6 个小节，每节用 ### 概念/机制名 开头；内容包含：定义边界、机制或推理链、一个具体例子、失效条件。不要罗列原文，要沉淀成用户以后能直接调用的知识）
## 知识串联
（这些条目之间是什么关系；它们承接/推翻/深化了哪些已学内容）
## 我理解到位的地方
（具体到对话中的推理步骤）
## 薄弱点与遗留问题
## 值得制卡的要点（3-8 条，Q/A 形式）
## 下一步
（以一个让读者想继续学的具体问题收尾）
克制、具体、面向未来使用；避免“本部分讲了”这类一次性叙事。`;
const BUILTIN_EXPLORE = `自由探索模式：用户想学习一个主题。你仍以苏格拉底式提问为主，但允许在用户卡住时给出**最小必要**的背景信息（每次不超过 80 字），然后继续用提问引导用户主动构建理解。先探底（用户已知什么），一次只问一个问题，逐步加深。`;

const BUILTIN_WIT = `# WIT 精读法（Writing Is Thinking）——科研审读伙伴

你陪用户以研究者视角精读论文：不是"读懂字面"，而是审计论文的推理链——问题是什么、证据支持什么、结论配不配得上证据。你的角色是脚手架、挑战者、审计者：低价值劳动（找数字、复述结构、翻译术语）直接做；高价值判断（这个 claim 配不配这个证据、哪个解释更可信、什么实验最有区分力）必须先让用户自己下判断，你再施压或补充。目标是同时推进阅读和成长读者，而不是替读者思考。

## 五个阶段（按序推进；用户可随时说"跳到 X"）
1. **骨架**：一段话说清 Central Question → Central Claim → 本部分的 storyline（Question→Experiment→Finding 链）。找不到明确 claim 就如实说"这一节是背景/方法铺垫"，不硬编。
2. **Claim–Evidence 地图**：从本部分抽 2–4 个 major claims，逐个给出：证据（图/表/数据）→ 证据强度 → 剩余不确定性。表格呈现。
3. **六维拷问**：每轮只挑一个最重要的未打开维度，拷问一个 claim——Whether（现象真存在吗）/ What（什么因素决定它）/ Why（什么导致）/ How（通过什么机制）/ When（什么边界条件下成立或失效）/ To what extent（效应多大）。优先攻击"答案会改变 central claim"的维度。
4. **竞争解释**：对关键 finding 强制列出 2–3 个竞争假设（H1/H2/H3），先让用户判断哪个最可信、什么实验能区分它们，再给你的分析。
5. **审稿人压力测试**：列 Top-3 挑战并分类（现在能补实验 / 已有数据能分析 / 只能写 limitation / 致命伤）。致命伤直说，不塞进 limitation 糊弄。

## Fact 与 Opinion 的距离感（贯穿所有阶段）
- **Fact**：数据直接显示的（A 在 X 上 87% vs B 61%）。
- **1-hop Opinion**：离数据一步的解释（提示 A 更稳健）——Results 允许的极限。
- **2-hop Interpretation / General Principle**：需要综合多个 findings 才配说——属于 Discussion 层。
读到 Results 型内容随时让用户判断"这句话是 Fact 还是几 hop"；论文把 1-hop 写成 2-hop 的地方指出来——"demonstrates"该不该收缩成"suggests"。

## 判断节点先问后讲
高价值判断（claim 配不配证据 / 哪个假设更可信 / 什么实验最有区分力）先抛一个可答错的具体问题让用户答，答完再给分析。用户直接要答案就如实直给（不搞问答仪式），但给完讲清判断依据，让他下次自己会判。

## 反证检验
每个重要 claim 至少问一次："什么结果会推翻它？"没有潜在反证条件的 claim 往往定义不严。找到稳定反例 → 收缩 claim / 挖出边界条件，而不是宣布全盘作废：反例让结论更精确，不更弱。

## 收束（Stop Rule）
用户说够了或材料读完：给最小完整故事——Central Question / Central Claim / 2–3 个 Key Findings / 最脆弱的一环 / 值得追问的下一个问题。不追求问完所有问题：目标是支撑一个可信可辩护的故事，不是清空清单。

## 风格
- 直接、精确、不和稀泥；论文写得含糊就直说含糊在哪。
- 引号内必须逐字原文（用户能在 PDF 里搜到）；转述直接讲，不做"论文说/作者认为"式的例行出处挂靠（每轮至多 1 句且仅限逐字引用或区分"论文主张 vs 领域常识"）。
- 术语中英对照（断点覆盖 breakpoint recall）；数字必须来自材料，材料没给的数字就说没给。
- 一轮 = 一个分析单元 + **恰好一个问题**收尾；严禁一轮多问、严禁"思考题/请讨论"练习册腔。`;
const PAPER_Q = [
  'Q1 论文试图解决什么问题？', 'Q2 这是否是一个新的问题？', 'Q3 这篇文章要验证一个什么科学假设？',
  'Q4 有哪些相关研究？如何归类？谁是值得关注的研究员？', 'Q5 论文解决方案的关键是什么？',
  'Q6 实验是如何设计的？', 'Q7 定量评估的数据集是什么？代码有没有开源？',
  'Q8 实验及结果有没有很好地支持科学假设？', 'Q9 这篇论文到底有什么贡献？', 'Q10 下一步呢？',
];
async function getPrompts(cfg) {
  const out = { socratic: BUILTIN_SOCRATIC, summarize: BUILTIN_SUMMARIZE, explore: BUILTIN_EXPLORE, wit: BUILTIN_WIT, paperQ: PAPER_Q, sources: {} };
  try {
    const p = resolveInputPath(cfg.personaPath);
    if (p && fs.existsSync(p)) { out.socratic = stripYFM(await fsp.readFile(p, 'utf8')); out.sources.socratic = p; }
  } catch { /* ignore */ }
  for (const key of ['socratic', 'summarize', 'explore', 'wit']) {
    try {
      const p = path.join(DATA, 'prompts', `${key}.md`);
      if (fs.existsSync(p)) { out[key] = stripYFM(await fsp.readFile(p, 'utf8')); out.sources[key] = p; }
    } catch { /* ignore */ }
  }
  return out;
}

/* ---------------- LLM 代理（OpenAI 兼容 / SSE 流式） ---------------- */
function llmEndpoint(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (!/\/chat\/completions$/.test(b)) b += '/chat/completions';
  return b;
}
/* 上游错误码 → 人话提示 */
function upstreamHint(status, body) {
  const b = String(body || '');
  if (b.includes('1220')) return '【提示】这是智谱平台(Z.ai/BigModel)的「无权访问该模型」：多半是模型名不属于该平台（deepseek-chat 是 DeepSeek 官方的模型名；智谱要用 deepseek-v3 / deepseek-r1 / glm-4.6 等），或 key 与平台不匹配（bigmodel.cn 与 z.ai 的 key 不通用）。点「拉取模型列表」可确认你的 key 能用哪些模型。';
  if (b.includes('1210') || /invalid.*api.?key|incorrect api key/i.test(b)) return '【提示】API Key 无效：确认 key 复制完整、没有多余空格，且与所选 baseUrl 是同一家平台。';
  if (status === 401) return '【提示】鉴权失败：DeepSeek 的 key 只配 https://api.deepseek.com/v1；智谱国内 key 配 open.bigmodel.cn；z.ai 的 key 配 api.z.ai。三者不通用。';
  if (/Insufficient Balance|余额不足/i.test(b)) return '【提示】账户余额不足，请到对应平台充值。';
  if (status === 429) return '【提示】触发限流（429）：稍等几秒重试，或降低请求频率。';
  if (status === 404) return '【提示】接口地址不存在（404）：检查 baseUrl 是否写对，通常以 /v1 结尾（智谱以 /api/paas/v4 结尾）。';
  return '';
}
async function llmChat(req, res) {
  const cfg = await loadConfig();
  const body = await readJSON(req);
  const url = llmEndpoint(cfg.llm.baseUrl);
  if (!url) return sendJSON(res, 400, { error: '未配置 baseUrl，请打开 ⚙ 设置' });
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url);
  if (!cfg.llm.apiKey && !isLocal) return sendJSON(res, 400, { error: '未配置 API Key，请打开 ⚙ 设置填写（本地 Ollama 可留空）' });
  const stream = body.stream !== false;
  /* 视觉路由：消息里含 image_url 且配置了 visionModel → 该请求整体走视觉模型
     （上下文文字+图一起发给视觉模型，它兼读文字；普通纯文本请求仍走主力模型） */
  const hasImage = JSON.stringify(body.messages || []).includes('"image_url"');
  const useVision = hasImage && cfg.llm.visionModel;
  const payload = {
    model: useVision ? cfg.llm.visionModel : cfg.llm.model,
    messages: body.messages || [],
    stream,
    temperature: body.temperature ?? cfg.llm.temperature ?? 0.7,
  };
  if (cfg.llm.maxTokens) payload.max_tokens = cfg.llm.maxTokens;
  let up;
  try {
    up = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
      body: JSON.stringify(payload),
      signal: req.closeSignal,
    });
  } catch (e) {
    return sendJSON(res, 502, { error: `连接上游失败：${e.message}（检查 baseUrl / 网络）` });
  }
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    const hint = upstreamHint(up.status, t);
    return sendJSON(res, up.status === 401 ? 401 : 502, { error: `上游 ${up.status}：${t.slice(0, 400) || '(无返回体)'}${hint ? '\n' + hint : ''}` });
  }
  if (!stream) {
    const j = await up.json().catch(() => ({}));
    return sendJSON(res, 200, { content: j.choices?.[0]?.message?.content || '', usage: j.usage || null });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  let closed = false;
  req.on('close', () => { closed = true; });
  try {
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      if (closed) { try { await reader.cancel(); } catch {} break; }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { write({ done: true }); continue; }
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) write({ delta });
          if (j.usage) write({ usage: j.usage });
        } catch { /* 忽略不完整分片 */ }
      }
    }
    write({ done: true });
  } catch (e) {
    if (!closed) write({ error: `流中断：${e.message}` });
  }
  res.end();
}

/* ---------------- 路由 ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const cfg = await loadConfig();

  if (p === '/api/status' && req.method === 'GET') {
    const vault = vaultAbs(cfg);
    let persona = null;
    try { persona = fs.existsSync(resolveInputPath(cfg.personaPath) || 'x') ? resolveInputPath(cfg.personaPath) : null; } catch {}
    return sendJSON(res, 200, {
      ok: true, node: process.version,
      vault: { configured: cfg.vaultPath, resolved: vault, exists: vault && fs.existsSync(vault) },
      persona: { configured: cfg.personaPath, resolved: persona, exists: !!persona },
      dataDir: DATA,
    });
  }
  /* GET 不回传真实 API Key（掩码 __KEEP__；前端原样回传即"保持不变"） */
  if (p === '/api/config' && req.method === 'GET') {
    const pub = JSON.parse(JSON.stringify(cfg));
    if (pub.llm && pub.llm.apiKey) pub.llm.apiKey = '__KEEP__';
    return sendJSON(res, 200, pub);
  }
  if (p === '/api/config' && req.method === 'POST') {
    const body = await readJSON(req);
    if (body.llm && body.llm.apiKey === '__KEEP__') delete body.llm.apiKey;            // 掩码回传 → 保持原值
    else if (body.llm && body.llm.apiKey === '' && cfg.llm && cfg.llm.apiKey) body.llm.apiKey = cfg.llm.apiKey;  // 留空 → 不清空已配置的 Key
    const next = deepMerge(cfg, body);
    await saveConfig(next);
    const pub = JSON.parse(JSON.stringify(next));
    if (pub.llm && pub.llm.apiKey) pub.llm.apiKey = '__KEEP__';
    return sendJSON(res, 200, { ok: true, config: pub });
  }

  /* ---- 文件 ---- */
  if (p === '/api/fs/list' && req.method === 'GET') {
    const roots = (cfg.libraryRoots || []).map(resolveInputPath).filter(Boolean);
    const target = resolveInputPath(q.get('path')) || roots[0] || APP_ROOT;
    const entries = await listDir(target);
    let parent = path.dirname(target);
    if (parent === target) parent = null;
    return sendJSON(res, 200, { path: target, parent, roots, entries });
  }
  if (p === '/api/fs/file' && req.method === 'GET') {
    const abs = resolveInputPath(q.get('path'));
    if (!abs || !fs.existsSync(abs)) return sendJSON(res, 404, { error: '文件不存在' });
    const st = await fsp.stat(abs);
    if (!st.isFile()) return sendJSON(res, 400, { error: '不是文件' });
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(abs).pipe(res);
    }
    if (ext === '.epub') {
      res.writeHead(200, { 'Content-Type': 'application/epub+zip', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(abs).pipe(res);
    }
    if (['.md', '.txt', '.json', '.canvas'].includes(ext)) {
      const txt = await fsp.readFile(abs, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(txt);
    }
    return sendJSON(res, 400, { error: `不支持的类型：${ext}` });
  }
  if (p === '/api/fs/recent' && req.method === 'GET') {
    const data = await readJsonFile(recentFile(), { items: [] });
    data.items = data.items.filter((x) => fs.existsSync(x.path));
    return sendJSON(res, 200, data);
  }

  /* ---- 批注 ---- */
  if (p === '/api/annotations' && req.method === 'GET') {
    const abs = resolveInputPath(q.get('path'));
    if (!abs) return sendJSON(res, 400, { error: '缺少 path' });
    const data = await readJsonFile(annFile(docIdOf(abs)), null);
    return sendJSON(res, 200, data || { annotations: [], readPos: 1 });
  }
  if (p === '/api/annotations' && req.method === 'PUT') {
    const body = await readJSON(req);
    const abs = resolveInputPath(body.path);
    if (!abs) return sendJSON(res, 400, { error: '缺少 path' });
    const rec = {
      docId: docIdOf(abs), path: abs, title: body.title || path.basename(abs),
      pages: body.pages || 0, readPos: body.readPos || 1,
      annotations: Array.isArray(body.annotations) ? body.annotations : [],
      partsDone: (body.partsDone && typeof body.partsDone === 'object') ? body.partsDone : {},
      weakPoints: Array.isArray(body.weakPoints) ? body.weakPoints.slice(0, 24) : [],
      updatedAt: Date.now(),
    };
    await writeJsonFile(annFile(rec.docId), rec);
    await touchRecent({ path: abs, title: rec.title, pages: rec.pages, lastPage: rec.readPos });
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- 巩固题池：聚合所有文档的待巩固点与已学部分 ---- */
  /* 与 reader.js isTrivialPart 同规格：标题命中前置废料模式 + 前 15 页 + 跨度 ≤5 */
  const TRIVIAL_RE = /^(copyright|all rights|cover|title page|dedication|frontispiece|contents|table of contents|about the (author|translator|contributors))\s*$|版权|版權|著作权|封面|扉页|书名页|献词|目录|目錄/i;
  const isTrivial = (n) => n && n.title && n.from <= 15 && (n.to === undefined || (n.to - n.from) <= 5) && TRIVIAL_RE.test(String(n.title).trim());
  if (p === '/api/review/pool' && req.method === 'GET') {
    const books = [];
    try {
      const dir = path.join(DATA, 'annotations');
      const files = await fsp.readdir(dir).catch(() => []);
      for (const f of files.filter((x) => x.endsWith('.json'))) {
        try {
          const rec = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          let nodes = [];
          try {
            const bm = JSON.parse(await fsp.readFile(path.join(DATA, 'bookmaps', f), 'utf8'));
            if (Array.isArray(bm.nodes)) nodes = bm.nodes;
          } catch { /* 无书图 */ }
          const allNodes = nodes.filter((n) => !isTrivial(n));
          const doneParts = allNodes
            .filter((n) => rec.partsDone && rec.partsDone[n.id])
            .map((n) => ({ id: n.id, title: n.title, from: n.from, to: n.to }));
          const openParts = allNodes          // 未复盘的部分（读过或带读过，等待检验）
            .filter((n) => !(rec.partsDone && rec.partsDone[n.id]))
            .map((n) => ({ id: n.id, title: n.title, from: n.from, to: n.to }));
          const weakPoints = Array.isArray(rec.weakPoints) ? rec.weakPoints : [];
          if (doneParts.length || weakPoints.length || openParts.length) {
            books.push({
              path: rec.path, title: rec.title || path.basename(rec.path || '', '.pdf'),
              weakPoints, doneParts, openParts,
              updatedAt: rec.updatedAt || 0,
            });
          }
        } catch { /* 坏文件跳过 */ }
      }
    } catch { /* ignore */ }
    books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sendJSON(res, 200, { books });
  }
  /* ---- 巩固点管理：add=true 追加弱点（去重）；默认移除（标记掌握） ---- */
  if (p === '/api/review/weak' && req.method === 'POST') {
    const body = await readJSON(req);
    const abs = resolveInputPath(body.path);
    if (!abs) return sendJSON(res, 400, { error: '缺少 path' });
    const file = annFile(docIdOf(abs));
    const rec = await readJsonFile(file, null);
    if (!rec) return sendJSON(res, 404, { error: '未找到该文档的记录' });
    let arr = Array.isArray(rec.weakPoints) ? rec.weakPoints : [];
    if (body.add && Array.isArray(body.items)) {
      const before = arr.length;
      for (const it of body.items.slice(0, 8)) {
        const t = String((it && it.text) || '').trim();
        if (t && !arr.some((w) => (w && w.text) === t)) {
          arr.push({ text: t.slice(0, 60), src: String((it && it.src) || '').slice(0, 80), at: Date.now() });
        }
      }
      arr = arr.slice(-12);
      rec.weakPoints = arr;
      rec.updatedAt = Date.now();
      await writeJsonFile(file, rec);
      return sendJSON(res, 200, { ok: true, added: arr.length - before, left: arr.length });
    }
    const text = String(body.text || '').trim();
    if (!text) return sendJSON(res, 400, { error: '缺少 text' });
    const before = arr.length;
    arr = arr.filter((w) => (w && w.text) !== text);
    rec.weakPoints = arr;
    rec.updatedAt = Date.now();
    await writeJsonFile(file, rec);
    return sendJSON(res, 200, { ok: true, left: arr.length, removed: before - arr.length });
  }

  /* ---- 复盘打卡：从巩固视图完成复盘时标记 partsDone（书不必在阅读器中打开） ---- */
  if (p === '/api/review/done' && req.method === 'POST') {
    const body = await readJSON(req);
    const abs = resolveInputPath(body.path);
    const partId = String(body.partId || '').trim();
    if (!abs || !partId) return sendJSON(res, 400, { error: '缺少 path/partId' });
    const file = annFile(docIdOf(abs));
    const rec = await readJsonFile(file, null);
    if (!rec) return sendJSON(res, 404, { error: '未找到该文档的记录' });
    rec.partsDone = rec.partsDone || {};
    const already = !!rec.partsDone[partId];
    rec.partsDone[partId] = { at: Date.now() };
    rec.updatedAt = Date.now();
    await writeJsonFile(file, rec);
    return sendJSON(res, 200, { ok: true, already });
  }

  /* ---- 卡片 ---- */
  if (p === '/api/cards' && req.method === 'GET') {
    return sendJSON(res, 200, { cards: await readJsonFile(cardsFile(), []) });
  }
  if (p === '/api/cards' && req.method === 'POST') {
    const body = await readJSON(req);
    const cards = await readJsonFile(cardsFile(), []);
    const incoming = (Array.isArray(body.cards) ? body.cards : [body.card]).filter(Boolean);
    const now = Date.now();
    for (const c of incoming) {
      c.id = c.id || crypto.randomUUID();
      c.created = c.created || now;
      c.updated = now;
      const i = cards.findIndex((x) => x.id === c.id);
      if (i >= 0) cards[i] = c; else cards.push(c);
    }
    await writeJsonFile(cardsFile(), cards);
    return sendJSON(res, 200, { ok: true, cards });
  }
  if (p === '/api/cards' && req.method === 'DELETE') {
    const id = q.get('id');
    let cards = await readJsonFile(cardsFile(), []);
    cards = cards.filter((c) => c.id !== id);
    await writeJsonFile(cardsFile(), cards);
    return sendJSON(res, 200, { ok: true, cards });
  }
  if (p === '/api/cards/export' && req.method === 'POST') {
    const body = await readJSON(req);
    let cards = await readJsonFile(cardsFile(), []);
    if (Array.isArray(body.ids) && body.ids.length) cards = cards.filter((c) => body.ids.includes(c.id));
    if (!cards.length) return sendJSON(res, 400, { error: '没有卡片可导出' });
    if (body.format === 'md') {
      const vault = vaultAbs(cfg);
      if (!vault || !fs.existsSync(vault)) return sendJSON(res, 400, { error: `vault 目录不存在：${cfg.vaultPath}（请到 ⚙ 设置修改）` });
      const dir = path.join(vault, cfg.cards.vaultSubdir || 'Cards');
      await ensureDir(dir);
      const file = path.join(dir, `苏格拉底卡片-${stamp()}.md`);
      await fsp.writeFile(file, renderCardsMD(cards), 'utf8');
      return sendJSON(res, 200, { ok: true, path: file, count: cards.length });
    }
    // SuperMemo Q&A 文本（可用于 SuperMemo / Anki 导入）
    const dir = resolveInputPath(body.dir) || path.join(DATA, 'exports');
    await ensureDir(dir);
    const file = path.join(dir, `SuperMemo-QA-${stamp()}.txt`);
    const qa = cards.map(renderCardQA).map(({ q, a }) => `Q: ${String(q).replace(/\n+/g, ' ')}\nA: ${String(a).replace(/\n+/g, ' ')}`).join('\n\n');
    await fsp.writeFile(file, qa + '\n', 'utf8');
    return sendJSON(res, 200, { ok: true, path: file, count: cards.length });
  }

  /* ---- 笔记（写入 vault / 检索 vault） ---- */
  if (p === '/api/notes/save' && req.method === 'POST') {
    const body = await readJSON(req);
    const vault = vaultAbs(cfg);
    if (!vault || !fs.existsSync(vault)) return sendJSON(res, 400, { error: `vault 目录不存在：${cfg.vaultPath}` });
    const subdir = safeName(body.subdir || cfg.cards.summariesSubdir || '阅读总结', '阅读总结');
    const dir = path.join(vault, subdir);
    await ensureDir(dir);
    const base = safeName(body.filename || body.title || '未命名', '未命名');
    const file = path.join(dir, `${base}.md`);
    await fsp.writeFile(file, String(body.content || ''), 'utf8');
    return sendJSON(res, 200, { ok: true, path: file, rel: path.relative(vault, file), obsidianUrl: `obsidian://open?path=${encodeURIComponent(file)}` });
  }
  if (p === '/api/notes/search' && req.method === 'GET') {
    const vault = vaultAbs(cfg);
    if (!vault || !fs.existsSync(vault)) return sendJSON(res, 200, { hits: [], error: 'vault 未配置或不存在' });
    const hits = await searchNotes(vault, q.get('q') || '', Number(q.get('limit') || 30), q.get('subdir') || '');
    return sendJSON(res, 200, { vault, hits });
  }
  if (p === '/api/wiki/upsert' && req.method === 'POST') {
    const body = await readJSON(req);
    const vault = vaultAbs(cfg);
    if (!vault || !fs.existsSync(vault)) return sendJSON(res, 400, { error: `vault 目录不存在：${cfg.vaultPath}` });
    const subdir = safeName(body.subdir || cfg.learning.wikiSubdir || '学习Wiki', '学习Wiki');
    const entry = await upsertWikiIndex(vault, subdir, body.entry || {});
    const { md } = wikiIndexFiles(vault, subdir);
    return sendJSON(res, 200, {
      ok: true,
      entry,
      index: md,
      obsidianUrl: `obsidian://open?path=${encodeURIComponent(md)}`,
    });
  }

  /* ---- 提示词 ---- */
  if (p === '/api/prompts' && req.method === 'GET') {
    const pr = await getPrompts(cfg);
    pr.personaStyle = cfg.personaStyle || 'classic';
    return sendJSON(res, 200, pr);
  }

  /* ---- Zotero ---- */
  if (p === '/api/zotero/status' && req.method === 'GET') {
    const dataDir = zoteroDataDir(cfg);
    return sendJSON(res, 200, {
      found: !!dataDir, dataDir: dataDir || null,
      configured: cfg.zoteroDataDir || '', candidates: zoteroCandidates().filter((c) => fs.existsSync(c)),
      sqliteCapable: !!_DatabaseSync,
    });
  }
  if (p === '/api/zotero/items' && req.method === 'GET') {
    const r = await zoteroItems(cfg);
    return sendJSON(res, 200, r);
  }

  /* ---- 拆书知识地图 ---- */
  if (p === '/api/bookmap' && req.method === 'GET') {
    const abs = resolveInputPath(q.get('path'));
    if (!abs) return sendJSON(res, 400, { error: '缺少 path' });
    const data = await readJsonFile(bookmapFile(docIdOf(abs)), null);
    return sendJSON(res, 200, data || { nodes: [], generatedAt: null });
  }
  if (p === '/api/bookmap' && req.method === 'PUT') {
    const body = await readJSON(req);
    const abs = resolveInputPath(body.path);
    if (!abs || !Array.isArray(body.nodes)) return sendJSON(res, 400, { error: '参数不完整' });
    await writeJsonFile(bookmapFile(docIdOf(abs)), {
      path: abs, title: body.title || path.basename(abs), nodes: body.nodes, generatedAt: Date.now(),
    });
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- LLM ---- */
  if (p === '/api/llm/chat' && req.method === 'POST') return llmChat(req, res);
  if (p === '/api/llm/test' && req.method === 'POST') {
    const t0 = Date.now();
    const url2 = llmEndpoint(cfg.llm.baseUrl);
    if (!url2) return sendJSON(res, 400, { error: '未配置 baseUrl' });
    try {
      const r = await fetch(url2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
        body: JSON.stringify({ model: cfg.llm.model, messages: [{ role: 'user', content: '只回复两个字母: ok' }], max_tokens: 128, stream: false }),
      });
      const txt = await r.text();
      if (!r.ok) return sendJSON(res, r.status, { error: `上游 ${r.status}：${txt.slice(0, 300)}${upstreamHint(r.status, txt) ? '\n' + upstreamHint(r.status, txt) : ''}` });
      const j = JSON.parse(txt);
      const reply = (j.choices?.[0]?.message?.content || '').trim();
      return sendJSON(res, 200, { ok: true, latencyMs: Date.now() - t0, model: j.model || cfg.llm.model, reply: reply || '（思考型模型小预算下可能不输出正文，连通与鉴权已验证）' });
    } catch (e) {
      return sendJSON(res, 502, { error: `连接失败：${e.message}` });
    }
  }
  if (p === '/api/llm/models' && req.method === 'GET') {
    const base = String(cfg.llm.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return sendJSON(res, 400, { error: '未配置 baseUrl' });
    try {
      const r = await fetch(base + '/models', { headers: { Authorization: `Bearer ${cfg.llm.apiKey}` } });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return sendJSON(res, r.status, { error: `上游 ${r.status}：${t.slice(0, 300)}${upstreamHint(r.status, t) ? '\n' + upstreamHint(r.status, t) : ''}` });
      }
      const j = await r.json();
      const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
      return sendJSON(res, 200, { models: ids });
    } catch (e) {
      return sendJSON(res, 502, { error: e.message });
    }
  }

  return sendJSON(res, 404, { error: `未知接口：${req.method} ${p}` });
}

/* ---------------- 启动 ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  Promise.resolve()
    .then(() => (url.pathname.startsWith('/api/') ? handleApi(req, res, url) : serveStatic(req, res, url.pathname)))
    .catch((e) => {
      try { if (!res.headersSent) sendJSON(res, 500, { error: e.message || String(e) }); else res.end(); } catch {}
    });
});
server.listen(PORT, HOST, async () => {
  await ensureDir(path.join(DATA, 'annotations'));
  await ensureDir(path.join(DATA, 'exports'));
  await ensureDir(path.join(DATA, 'bookmaps'));
  const cfg = await loadConfig();
  const vault = vaultAbs(cfg);
  console.log('┌──────────────────────────────────────────────');
  console.log('│ 🏛  苏格拉底阅读器已启动');
  console.log(`│ ➜  http://${HOST}:${PORT}`);
  console.log(`│ 📁 Obsidian vault: ${cfg.vaultPath}${vault && fs.existsSync(vault) ? ' ✅' : ' ⚠️ 未找到（去 ⚙ 设置检查）'}`);
  console.log(`│ 💾 数据目录: ${DATA}`);
  console.log('└──────────────────────────────────────────────');
  console.log('提示：Ctrl+C 退出 · 配置在 ⚙ 设置 中修改，保存即生效');
});
