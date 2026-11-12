# PDF cancellation smoke test

Run from the repository root in a desktop Linux session with Python GI and WebKitGTK 4.1:

```sh
CODEX_PRISM_WATCH=0 corepack pnpm --filter @codex-prism/desktop exec vite --port 1450
/usr/bin/python3 apps/desktop/scripts/pdf-cancellation-smoke/webkit.py
```

The harness generates all PDF and source fixtures in memory. It checks that 100
cancelled queued renders never reach MuPDF, an active cancellation still permits
mandatory document cleanup, and superseded first-change analysis cannot navigate
the wrong artifact. It also verifies that delayed navigation overrides scrolling
once, as requested, and exercises rapid scrolling and zoom changes.

Output includes analysis duration, frame gaps, dispatched/cancelled counts, and a
screenshot under `/tmp`. Run timing comparisons without a concurrent build; these
are synthetic WebKit measurements, not native wheel-to-pixel latency. The test
never opens user projects or starts a compiler or agent.
