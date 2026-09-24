#!/bin/zsh

set -e

# 取脚本自身所在目录作为项目根目录，这样从任何位置运行（例如在 Finder 里双击）都能工作。
LEAF_DIR="$(cd "$(dirname "$0")" && pwd)"
LEAF_URL="http://127.0.0.1:41731/"

cd "$LEAF_DIR"

if [[ -d "$LEAF_DIR/src-tauri/target/release/bundle/macos/Leaf.app" ]]; then
  open "$LEAF_DIR/src-tauri/target/release/bundle/macos/Leaf.app"
  exit 0
fi

if [[ ! -d node_modules ]]; then
  echo "Leaf 首次启动，正在安装依赖……"
  npm install
fi

echo "正在启动 Leaf……"
echo "关闭 Leaf 时，请在此窗口按 Control+C。"
echo

if curl --silent --fail "$LEAF_URL" >/dev/null 2>&1; then
  open "$LEAF_URL"
  echo "Leaf 已经在运行。"
  exit 0
fi

npm run dev -- --host 127.0.0.1 --port 41731 --strictPort &
LEAF_PID=$!

cleanup() {
  kill "$LEAF_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for attempt in {1..50}; do
  if curl --silent --fail "$LEAF_URL" >/dev/null 2>&1; then
    open "$LEAF_URL"
    wait "$LEAF_PID"
    exit $?
  fi
  sleep 0.1
done

echo "Leaf 启动失败：本地服务没有及时响应。"
exit 1
