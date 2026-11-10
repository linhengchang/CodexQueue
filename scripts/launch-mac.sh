#!/bin/zsh -l
cd -- "${0:A:h:h}"
# Finder has a minimal PATH. Prefer a modern installed Node without depending on npm aliases.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node(NOn); do
    major=$($candidate -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)
    if [[ "$major" -ge 20 ]]; then export PATH="${candidate:h}:$PATH"; break; fi
  done
fi
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 20 ? 1 : 0)' ; then
  /usr/bin/osascript -e 'display alert "Auto Work" message "请先安装 Node.js 20 或更新版本。"'
  exit 1
fi
node scripts/start.mjs >> data-launch.log 2>&1
result=$?
if [[ $result -ne 0 ]]; then
  /usr/bin/osascript -e 'display alert "Auto Work 启动失败" message "请查看项目目录中的 data-launch.log。首次使用请先安装依赖，参阅 README.md。"'
fi
exit $result
