#!/bin/zsh
set -euo pipefail
cd -- "${0:A:h:h}"
mkdir -p .build-cache 'Auto Work.app/Contents/MacOS'
xcrun swiftc -O -module-cache-path "$PWD/.build-cache" -framework Cocoa desktop/Launcher.swift -o 'Auto Work.app/Contents/MacOS/AutoWork'
