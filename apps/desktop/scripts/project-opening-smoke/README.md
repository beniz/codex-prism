# Staged project opening smoke test

Run Vite on port 1450, then run the WebKitGTK test:

```sh
CODEX_PRISM_WATCH=0 corepack pnpm --filter @codex-prism/desktop exec vite --port 1450
GDK_BACKEND=x11 GDK_SCALE=1 /usr/bin/python3 apps/desktop/scripts/project-opening-smoke/webkit.py
```

Uses the real workspace, document store and MuPDF with a simulated native
transport: 250 TeX files, a 200 ms scan, 20 ms reads, and a generated existing PDF.
Checks workspace presence before source readiness, bounded reads, and PDF display
without compiling. Reports two-animation-frame shell timing and source readiness.
These are synthetic browser timings, not native filesystem/IPC measurements;
window focus and WebKit timer throttling can materially affect the results.

No user projects are opened or modified.
