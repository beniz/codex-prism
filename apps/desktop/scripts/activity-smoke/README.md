# Composer activity smoke test

Run in a desktop Linux session with Python GI and WebKitGTK 4.1:

```sh
CODEX_PRISM_WATCH=0 corepack pnpm --filter @codex-prism/desktop exec vite --port 1450
GDK_BACKEND=x11 GDK_SCALE=1 /usr/bin/python3 apps/desktop/scripts/activity-smoke/webkit.py
```

Uses the real chat drawer, review panel, and stores with in-memory native-service
fixtures. It checks agent tool activity, Keep progress while switching chats,
independent Keep buttons, document refresh, review readiness, and typing without
activity notifications or stolen focus. No agents, compilers, or user projects
are accessed. Output includes `/tmp/codex-prism-activity.png` for visual inspection.
