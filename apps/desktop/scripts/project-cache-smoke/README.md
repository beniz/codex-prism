# Project thumbnail cache smoke test

Run from the repository root in a Linux desktop session with Python GI and
WebKitGTK 4.1:

```sh
CODEX_PRISM_WATCH=0 corepack pnpm --filter @codex-prism/desktop exec vite --port 1450
GDK_BACKEND=x11 GDK_SCALE=1 /usr/bin/python3 apps/desktop/scripts/project-cache-smoke/webkit.py
```

Two generated PDFs exercise the real preview loader and MuPDF renderer. Cold
loading must create one worker for both images. The harness then reloads the
page (discarding frontend memory) and verifies that saved images display with
zero PDF reads and zero workers.

The native transport is a localStorage fixture; core Rust tests separately
exercise disk persistence across Backend instances and rejection of changed
PDFs. This is not a packaged application restart test. No user projects,
compilation, or agents are involved. A screenshot is saved under /tmp.
