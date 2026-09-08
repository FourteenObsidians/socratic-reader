/* LLM 输出的 JSON 容错解析：修复未转义引号/尾逗号/裸换行，逐对象打捞
   独立模块：浏览器挂 window.SRJsonFix，Node 可直接 require 用于测试 */
(function (g) {
  'use strict';

  /* 字符串内部出现裸 " 时：向后看最近的结构字符来判断是"值的结束引号"还是"内容引号"，
     内容引号转义成 \"；同时把字符串内裸换行转成 \n */
  function repairJson(s) {
    s = String(s || '');
    s = s.replace(/,\s*([\]}])/g, '$1'); // 尾逗号
    let out = '';
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (!inStr) {
        if (c === '"') inStr = true;
        out += c;
        continue;
      }
      if (c === '\\') { out += c + (s[i + 1] || ''); i++; continue; }
      if (c === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        const nx = s[j];
        if (j >= s.length || nx === ',' || nx === '}' || nx === ']' || nx === ':') { inStr = false; out += c; }
        else out += '\\"';
        continue;
      }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
    }
    return out;
  }

  /* 从 LLM 文本里尽力取出一个对象数组；返回数组（可能为空） */
  function parseLLMJsonArray(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    let body = (a >= 0 && b > a) ? s.slice(a, b + 1) : s;
    for (const candidate of [body, repairJson(body)]) {
      try {
        const r = JSON.parse(candidate);
        if (Array.isArray(r)) return r;
        if (r && typeof r === 'object') return [r];
      } catch { /* 下一种 */ }
    }
    // 整体失败 → 花括号配平逐个打捞
    const objs = [];
    let depth = 0, start = -1, inStr = false;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') { if (depth === 0) start = i; depth++; }
      else if (c === '}') { depth--; if (depth === 0 && start >= 0) { objs.push(body.slice(start, i + 1)); start = -1; } }
    }
    const out = [];
    for (const o of objs) {
      let ok = null;
      try { ok = JSON.parse(o); } catch { try { ok = JSON.parse(repairJson(o)); } catch { ok = null; } }
      if (ok && typeof ok === 'object' && !Array.isArray(ok)) out.push(ok);
    }
    return out;
  }

  g.SRJsonFix = { repairJson, parseLLMJsonArray };
})(typeof window !== 'undefined' ? window : globalThis);
