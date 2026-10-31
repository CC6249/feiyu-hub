#!/usr/bin/env bash
#
# Feiyu Hub — 一键安装脚本（Linux / NAS：fnOS、Debian、Ubuntu、群晖 Docker 宿主机等）
#
#   sudo ./install.sh                 装到 /opt/feiyu-hub，注册 systemd 开机自启
#   ./install.sh --prefix ~/hub       装到自定义目录（无 sudo 时自动落到 ~/.local/share/feiyu-hub）
#   ./install.sh --port 18800         首次安装时改面板端口
#   ./install.sh --no-service         不装 systemd，只铺文件
#   ./install.sh --no-start           不启动、不自检
#   ./install.sh --force              覆盖已有 config.json（会丢配置，慎用）
#
# 依赖：Node.js >= 18（脚本会自动找 node，含 fnOS 的 /usr/local/nodejs/bin/node）
#
set -euo pipefail

VERSION="1.0.0"
SERVICE_NAME="feiyu-hub"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PREFIX=""
PORT=""
ENABLE_SERVICE=1
START_NOW=1
FORCE=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)      PREFIX="${2:-}"; shift 2 ;;
    --port)        PORT="${2:-}"; shift 2 ;;
    --no-service)  ENABLE_SERVICE=0; shift ;;
    --no-start)    START_NOW=0; shift ;;
    --force)       FORCE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             say "未知参数: $1"; usage; exit 2 ;;
  esac
done

[ -f "$SRC_DIR/server.mjs" ] || die "在 $SRC_DIR 找不到 server.mjs，请在解压后的发行包目录里运行本脚本"

# ---------------------------------------------------------------- 1. Node

step "1/6 检查 Node.js"

find_node() {
  local cand v
  for cand in "$(command -v node 2>/dev/null || true)" \
              /usr/local/nodejs/bin/node \
              /usr/local/bin/node \
              /usr/bin/node \
              /snap/bin/node \
              /opt/homebrew/bin/node \
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
if [ -z "$NODE" ]; then
  say "没有找到 Node.js 18+。"
  say "fnOS:   sudo apt install -y nodejs   （或用应用中心装的 node，路径一般是 /usr/local/nodejs/bin/node）"
  say "Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  die "请先装好 Node.js 再回来跑本脚本"
fi
say "node: $NODE ($("$NODE" -v))"

# -------------------------------------------------------------- 2. 权限

step "2/6 确定安装位置"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO="sudo"; fi
fi

if [ -z "$PREFIX" ]; then
  if [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; then
    PREFIX="/opt/feiyu-hub"
  else
    PREFIX="$HOME/.local/share/feiyu-hub"
    say "当前用户没有 sudo 免密权限，改安到用户目录"
  fi
fi

say "安装目录: $PREFIX"

# -------------------------------------------------------------- 3. 铺文件

step "3/6 复制程序文件"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for item in server.mjs public scripts config.example.json README.md AGENTS.md CLAUDE.md VERSION LICENSE skills; do
  if [ -e "$SRC_DIR/$item" ]; then cp -R "$SRC_DIR/$item" "$TMP/"; fi
done

if [ -n "$SUDO" ]; then
  sudo mkdir -p "$PREFIX"
  sudo cp -R "$TMP"/* "$PREFIX"/
  sudo chown -R "$(id -un):$(id -gn)" "$PREFIX"
else
  mkdir -p "$PREFIX"
  cp -R "$TMP"/* "$PREFIX"/
fi

chmod +x "$PREFIX/scripts/"*.sh 2>/dev/null || true
say "已复制到 $PREFIX"

# -------------------------------------------------------------- 4. 配置

step "4/6 准备 config.json"

if [ -f "$PREFIX/config.json" ] && [ "$FORCE" -ne 1 ]; then
  say "已存在 config.json，保留不动（要覆盖加 --force）"
else
  cp "$PREFIX/config.example.json" "$PREFIX/config.json"
  say "已从 config.example.json 生成 config.json"
fi

if [ -n "$PORT" ]; then
  "$NODE" -e '
    const fs = require("fs");
    const p = process.argv[1], port = Number(process.argv[2]);
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    c.port = port;
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  ' "$PREFIX/config.json" "$PORT"
  say "面板端口已设为 $PORT"
  say "注意：只改了面板端口。proxy 卡片的 proxyPort（示例里是 18766/18767）不会跟着变，"
  say "      如果这两个端口已被别的程序占用，启动时会明确报错，改 config.json 里对应的 proxyPort 即可。"
fi

read_port() {
  "$NODE" -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.stdout.write(String(c.port || 18765));
    } catch { process.stdout.write("18765"); }
  ' "$PREFIX/config.json"
}
PANEL_PORT="$(read_port)"
say "面板端口: $PANEL_PORT"

# ---------------------------------------------------------- 5. systemd

step "5/6 注册开机自启"

if [ "$ENABLE_SERVICE" -ne 1 ]; then
  say "按 --no-service 跳过"
elif [ ! -d /run/systemd/system ]; then
  say "这台机器没有 systemd（容器环境？），跳过。手动启动：bash $PREFIX/scripts/start.sh"
elif [ -z "$SUDO" ] && [ "$(id -u)" -ne 0 ]; then
  say "没有 sudo，跳过 systemd。手动启动：bash $PREFIX/scripts/start.sh"
else
  RUN_USER="$(id -un)"
  RUN_GROUP="$(id -gn)"
  $SUDO tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<UNIT
[Unit]
Description=Feiyu Hub dashboard (port ${PANEL_PORT})
Documentation=file://${PREFIX}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${PREFIX}
Environment=FEIYU_CONFIG=${PREFIX}/config.json
Environment=NODE_ENV=production
ExecStart=${NODE} ${PREFIX}/server.mjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  $SUDO systemctl restart "${SERVICE_NAME}.service"
  sleep 2
  say "服务状态: $($SUDO systemctl is-active ${SERVICE_NAME}.service 2>/dev/null || echo unknown)"
  say "看日志:   sudo journalctl -u ${SERVICE_NAME} -f"
fi

# -------------------------------------------------------------- 6. 自检

step "6/6 自检"

if [ "$START_NOW" -ne 1 ]; then
  say "按 --no-start 跳过自检"
  exit 0
fi

if [ "$ENABLE_SERVICE" -eq 1 ] && [ -d /run/systemd/system ] && { [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; }; then
  sleep 1
else
  say "未托管到 systemd，请在另一个终端先跑: bash $PREFIX/scripts/start.sh"
  say "然后执行: $NODE $PREFIX/scripts/verify.mjs --url http://127.0.0.1:${PANEL_PORT}"
  exit 0
fi

set +e
"$NODE" "$PREFIX/scripts/verify.mjs" --url "http://127.0.0.1:${PANEL_PORT}"
RC=$?
set -e

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<这台机器的IP>"

say ""
say "────────────────────────────────────────────"
say " 面板地址:  http://${IP}:${PANEL_PORT}"
say " 配置文件:  ${PREFIX}/config.json"
say " 手机使用:  浏览器打开上面的地址 → 添加到主屏幕"
say "────────────────────────────────────────────"

exit $RC
