# Parallel PDF rendering smoke test

Run from the repository root in a desktop Linux session with Python GI and WebKitGTK 4.1:

```sh
CODEX_PRISM_WATCH=0 corepack pnpm --filter @codex-prism/desktop exec vite --port 1450
GDK_BACKEND=x11 GDK_SCALE=1 /usr/bin/python3 apps/desktop/scripts/pdf-pool-smoke/webkit.py
GDK_BACKEND=x11 GDK_SCALE=1 /usr/bin/python3 apps/desktop/scripts/pdf-pool-smoke/webkit.py --single
```

The harness generates two chat PDFs and an expensive page in memory. It verifies
that the newly selected chat renders on a second worker before the busy worker
finishes, that only two workers are created, and that repeated switches between
cached chats require no new raster renders. It uses the real PDF viewer and MuPDF
workers. The second command switches documents within one viewer, matching
chats on the same root file; the first keeps separate viewers mounted. Neither
opens user projects or starts a compiler or agent.

Output includes switching timings and a screenshot under `/tmp`. These are
synthetic WebKit measurements, not native wheel-to-pixel latency. Run without a
concurrent build and restart Vite after code changes when watching is disabled.

The command uses X11/XWayland for reproducible window presentation. A native
Wayland run in this environment sometimes stalled before IntersectionObserver
reported visible pages; it is not covered by the passing smoke result.
