// 打包用保守 minify：去注释（保留 URL 的 //）、压空白。语法检查由调用方做。
const fs = require('fs');
const p = process.argv[2];
let s = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
if (p.endsWith('.css')) {
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
} else {
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // 行注释：行首注释直接删；行中注释要求 // 前不是冒号(协议)或引号内——保守只删「前邻空白 + //」且该行不含引号包住 // 的情况
  s = s.split('\n').map((line) => {
    if (/^\s*\/\//.test(line)) return '';
    const i = line.indexOf('//');
    if (i < 0) return line;
    const before = line.slice(0, i);
    if (/:\/\//.test(line)) return line;                       // 含 URL 整行保留
    if ((before.match(/["']/g) || []).length % 2 === 1) return line;  // // 在引号里，保留
    return before.replace(/\s+$/, '');
  }).join('\n');
}
s = s.replace(/\n\s*\n+/g, '\n').replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '');
fs.writeFileSync(p, s);
