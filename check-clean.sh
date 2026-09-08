#!/usr/bin/env bash
# 推送前隐私自检：确认没有任何私密内容进入 git 索引/历史
# 用法：./check-clean.sh   （每次 push 前跑一下，或挂在 pre-push 钩子里）
set -euo pipefail
cd "$(dirname "$0")"

FAIL=0
# ① 索引里不该有隐私文件
LEAK=$(git ls-files | grep -E "^(config\.json|data/|.*\.zip)$" || true)
if [ -n "$LEAK" ]; then echo "✗ 索引中有私密文件："; echo "$LEAK"; FAIL=1; fi
# ② 历史提交里不该出现隐私路径
HIST=$(git log --all --diff-filter=A --name-only --pretty=format: 2>/dev/null | sort -u | grep -E "^(config\.json|data/)" || true)
if [ -n "$HIST" ]; then echo "✗ 历史中有私密文件："; echo "$HIST"; FAIL=1; fi
# ③ 已跟踪文件里不应含真实 API Key 形态（sk- / bigmodel 的 key 格式 / Bearer）
KEY=$(git grep -lE "sk-[A-Za-z0-9]{20}|[0-9a-f]{32}\.[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9]{20}" -- . 2>/dev/null || true)
if [ -n "$KEY" ]; then echo "✗ 疑似密钥泄漏在：$KEY"; FAIL=1; fi

[ "$FAIL" = 0 ] && echo "✓ 干净：无 config.json / data / zip / 密钥形态" || exit 1
