# Run through non-interactive SSH. Keep stdout exclusively for the WebSocket.
if command -v codex >/dev/null 2>&1; then
    exec codex app-server proxy "$@"
fi

for candidate in "$HOME/.local/bin/codex" "$HOME/.codex/bin/codex"; do
    if [ -x "$candidate" ]; then
        PATH="${candidate%/*}:$PATH" exec "$candidate" app-server proxy "$@"
    fi
done

# nvm npm launchers also need the node executable from the same installation.
# Prefer the most recently installed CLI when several Node versions have one.
chosen=
for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/codex; do
    if [ -x "$candidate" ] && { [ -z "$chosen" ] || [ "$candidate" -nt "$chosen" ]; }; then
        chosen=$candidate
    fi
done
if [ -n "$chosen" ]; then
    PATH="${chosen%/*}:$PATH" exec "$chosen" app-server proxy "$@"
fi
for candidate in /opt/homebrew/bin/codex /usr/local/bin/codex; do
    if [ -x "$candidate" ]; then
        PATH="${candidate%/*}:$PATH" exec "$candidate" app-server proxy "$@"
    fi
done
exit 127
