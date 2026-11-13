# Chat tab switching smoke test

Run Vite on port 1450, then the WebKitGTK harness:

```sh
CODEX_PRISM_WATCH=0 corepack pnpm --filter @codex-prism/desktop exec vite --port 1450
GDK_BACKEND=x11 GDK_SCALE=1 /usr/bin/python3 apps/desktop/scripts/chat-switch-smoke/webkit.py
```

Uses the real chat drawer with two generated 60-message math-rich conversations.
After both transcripts finish formatting, clicks tabs three times and measures
through two animation frames. Host calls use a fixture; no agent, compiler or
user project is used. Results are synthetic local WebKit timings, not guarantees
for every machine. The screenshot is saved under /tmp.
