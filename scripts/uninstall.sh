#!/usr/bin/env bash
#
# Feiyu Hub — 卸载脚本
#
#   ./uninstall.sh            停服务、删 systemd 单元，保留安装目录和 config.json
#   ./uninstall.sh --purge    连安装目录一起删（config.json 也会没，先自己备份）
#
set -euo pipefail

SERVICE_NAME="feiyu-hub"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="$(cd "$SCRIPT_DIR/.." && pwd)"
PURGE=0

say() { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) say "未知参数: $1"; exit 2 ;;
  esac
done

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO="sudo"
fi

if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  say "停止并移除 systemd 服务"
  $SUDO systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
  $SUDO systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
  $SUDO rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  $SUDO systemctl daemon-reload
else
  say "没有找到 systemd 单元，跳过"
fi

# 兜底：杀掉可能残留的前台进程
if pgrep -f "$PREFIX/server.mjs" >/dev/null 2>&1; then
  say "停止残留进程"
  pkill -f "$PREFIX/server.mjs" 2>/dev/null || true
fi

if [ "$PURGE" -eq 1 ]; then
  say "删除安装目录 $PREFIX"
  cd /
  if [ -n "$SUDO" ]; then sudo rm -rf "$PREFIX"; else rm -rf "$PREFIX"; fi
else
  say "保留安装目录：$PREFIX"
  say "彻底删除请再执行：./uninstall.sh --purge"
fi

say "完成"
