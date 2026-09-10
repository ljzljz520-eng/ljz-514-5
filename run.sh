#!/usr/bin/env bash
# 会展中心逛展路径工具 —— 一键启动（仅需 Python 3，无第三方依赖）
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
echo "==============================================="
echo "  会展中心逛展路径工具"
echo "  打开浏览器访问: http://localhost:${PORT}"
echo "  按 Ctrl+C 停止服务"
echo "==============================================="
exec python3 backend/server.py
