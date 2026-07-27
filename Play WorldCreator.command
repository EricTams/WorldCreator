#!/bin/bash
# Double-click me in Finder to play. Closing this window stops the game server.
cd "$(dirname "$0")" || exit 1

# Vite needs node on PATH; Finder-launched scripts don't get a login shell's PATH.
for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node/$(cat "$HOME/.nvm/alias/default" 2>/dev/null)/bin"; do
  [ -x "$candidate/node" ] && PATH="$candidate:$PATH"
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Couldn't find node. Install it from https://nodejs.org and try again."
  read -r -p "Press return to close."
  exit 1
fi

[ -d node_modules ] || npm install || { read -r -p "npm install failed. Press return to close."; exit 1; }

echo "Starting WorldCreator — the browser will open in a moment."
echo "Leave this window open while you play; close it or press Ctrl-C to stop."
exec npm run play
