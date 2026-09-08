// 视觉能力实测：生成"左红右蓝"PNG，走本地代理发给当前模型
const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const W = 128, H = 128;
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 3);
  raw[row] = 0; // filter none
  for (let x = 0; x < W; x++) {
    const i = row + 1 + x * 3;
    if (x < W / 2) { raw[i] = 255; raw[i + 1] = 0; raw[i + 2] = 0; }   // 左半红
    else { raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 255; }             // 右半蓝
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const b64 = png.toString('base64');
fs.writeFileSync('/tmp/sr-vision-test.png', png);
console.log('测试图生成:', W + 'x' + H, Math.round(b64.length / 1024) + 'KB(base64)');

(async () => {
  const res = await fetch('http://127.0.0.1:3777/api/llm/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张图片的左半边和右半边各是什么颜色？只答颜色。' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ],
      }],
    }),
  });
  console.log('HTTP', res.status);
  const t = await res.text();
  const deltas = [];
  for (const line of t.split('\n')) {
    if (line.startsWith('data:')) { try { const j = JSON.parse(line.slice(5).trim()); if (j.delta) deltas.push(j.delta); if (j.error) console.log('错误帧:', j.error); } catch {} }
  }
  const out = deltas.join('');
  console.log('模型回答:', out.slice(0, 300) || '(空)');
  const ok = /左.*红|red/i.test(out) && /右.*蓝|blue/i.test(out);
  console.log(/error/i.test(t) && !out ? '✗ 接口拒绝或出错（不支持视觉输入）' : ok ? '✓ 视觉能力正常（颜色判对）' : '⚠ 收到回答但内容未对上（可能未真正读图）');
})();
