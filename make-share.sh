#!/usr/bin/env bash
# 打包分享版：排除 config.json（API Key）与 data/（个人学习数据）。
# 用法:
#   ./make-share.sh            → socratic-reader-share.zip（pdf.js 走 CDN，需联网首载）
#   ./make-share.sh --offline  → 先 vendor pdf.js（含中文 cMap）再打包，完全离线可用
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--offline" ]]; then
  echo "→ vendor pdf.js（本地化，含 CJK cMap）…"
  mkdir -p public/vendor
  TMP=$(mktemp -d)
  ( cd "$TMP" && npm pack pdfjs-dist@3.11.174 --silent )
  tar -xzf "$TMP"/pdfjs-dist-*.tgz -C "$TMP"
  cp "$TMP"/package/build/pdf.min.js public/vendor/
  cp "$TMP"/package/build/pdf.worker.min.js public/vendor/
  rm -rf public/vendor/cmaps && cp -r "$TMP"/package/cmaps public/vendor/cmaps
  rm -rf "$TMP"
  echo "  ✓ $(du -sh public/vendor | cut -f1)"
fi

# 压缩：去注释/空白 + zip -9。保留 server.js 与 README（对方要读/改），
# 代码文件 minify 后可读性损失可接受（源码在你这）
STAGE=$(mktemp -d)
cp -r public "$STAGE/"
cp server.js package.json README.md "$STAGE/"
for f in "$STAGE"/public/js/*.js "$STAGE"/public/style.css; do
  node tools/minify.js "$f"
done
node tools/minify.js "$STAGE/server.js"
for f in "$STAGE"/public/js/*.js "$STAGE/server.js"; do node --check "$f" || { echo "✗ $f minify 后语法错误"; exit 1; }; done

OUT=socratic-reader-share.zip
rm -f "$OUT"
( cd "$STAGE" && zip -r9 -X "${OLDPWD}/$OUT" server.js package.json README.md public -x '*.DS_Store' ) >/dev/null

# 附带你调优的苏格拉底人格（苏格拉底·七 六机制）：打进 data/prompts/socratic.md，
# 对方解压即自动生效（getPrompts 的覆盖层），零配置；不在本地 data/ 留副本，避免遮蔽 personaPath 热加载
PERSONA=$(node -e 'try{console.log(require("./config.json").personaPath||"")}catch{}')
[ -z "$PERSONA" ] && PERSONA='../.claude/agents/socratic-guide.md'
if [ -f "$PERSONA" ]; then
  mkdir -p "$STAGE/data/prompts"
  cp "$PERSONA" "$STAGE/data/prompts/socratic.md"
  ( cd "$STAGE" && zip -9 "${OLDPWD}/$OUT" data/prompts/socratic.md ) >/dev/null
  echo "  ✓ 已附带苏格拉底人格（$(wc -l < "$PERSONA" | tr -d ' ') 行，含六机制）"
else
  echo "  ⚠ 未找到人格文件（$PERSONA），包内将使用内置简版人格"
fi
rm -rf "$STAGE"

echo "✓ $(pwd)/$OUT（$(du -h "$OUT" | cut -f1)，原 92K）"
unzip -l "$OUT" | grep -E "config.json|annotations|bookmaps|recent" && echo "✗ 泄漏了私密文件！" || echo "✓ 已确认不含 config.json 与个人数据（Key/批注/拆书缓存安全）"
