#!/usr/bin/env bash
#
# 前台启动 Feiyu Hub（调试用；生产环境请用 systemd / install.sh）
# Ctrl+C 退出。
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

find_node() {
  local cand v
  for cand in "$(command -v node 2>/dev/null || true)" \
              /usr/local/nodejs/bin/node \
              /usr/local/bin/node \
              /usr/bin/node \
              "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -n "$cand" ] || continue
    [ -x "$cand" ] || continue
    v="$("$cand" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    case "$v" in ''|*[!0-9]*) continue ;; esac
    if [ "$v" -ge 18 ]; then printf '%s' "$cand"; return 0; fi
  done
  return 1
}

NODE="$(find_node || true)"
[ -n "$NODE" ] || { echo "ERROR: 需要 Node.js 18+"; exit 1; }

[ -f "$DIR/config.json" ] || { echo "ERROR: 缺少 $DIR/config.json，先把 config.example.json 复制一份"; exit 1; }

echo "启动 $DIR/server.mjs (node $("$NODE" -v))"
exec "$NODE" "$DIR/server.mjs"
