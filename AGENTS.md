# Zotero Client Development Guidelines

## Running Tests

Always run tests using the following command to prevent the Zotero window from stealing focus on Wayland desktops:

```bash
WAYLAND_DISPLAY= GDK_BACKEND=x11 xvfb-run -a test/runtests.sh -f
```

This forces Zotero to use the X11 backend and render in a virtual framebuffer (Xvfb) instead of the real Wayland compositor. Without this, Firefox/Gecko ignores Xvfb's `$DISPLAY` and connects to the Wayland session directly.

Pass additional flags as normal, e.g.:

Don't use grep to filter out failures, just use tail to grab the last 100 lines of the test run, otherwise you miss on traces.

```bash
WAYLAND_DISPLAY= GDK_BACKEND=x11 xvfb-run -a test/runtests.sh -f -d 5              # debug logging
WAYLAND_DISPLAY= GDK_BACKEND=x11 xvfb-run -a test/runtests.sh -f -g "some pattern" # grep for specific tests
WAYLAND_DISPLAY= GDK_BACKEND=x11 xvfb-run -a test/runtests.sh -f zoteroPane        # run specific test file (without Test.js suffix)
```

Temporary debug logging:
- If you need to add temporary debug lines, prefix them with `AGENT-TEMP` so they're easy to grep and remove later.
  - Example: `Zotero.debug("AGENT-TEMP: my marker", 2)`
- Use a debug level (1–5) as the second argument.
- Run tests with `-d <level>` (1–5) to display those lines (e.g. `-d 2`).
- Remove `AGENT-TEMP` debug logging before committing.

## Writing Tests

After writing tests and confirming they pass, refactor them to use `beforeEach`/`afterEach` properly:

- **Extract shared setup** into `beforeEach` — e.g., creating objects, selecting collections, grabbing references like `collectionTreeRow` or `rowProvider` that every test in the `describe` block needs.
- **Put cleanup in `afterEach`** — resetting state (search filters, caches, prefs) should not be inline in tests. `afterEach` runs even when a test fails, preventing leaked state from breaking subsequent tests.
- **Use `before`** for expensive one-time setup (loading the Zotero pane, creating fixtures shared across all tests).
- **Use scoped `var` declarations** at the `describe` level for shared references set in `beforeEach`.

## Amp Orb Build Helper

`./build_and_run.sh` is an orb-specific helper that remains present but intentionally untracked and ignored after setup switches the repository to `zotero/main`.

- Run Zotero with `./build_and_run.sh [Zotero arguments...]`.
- Capture a Zotero window with `./build_and_run.sh --screenshot PATH [Zotero arguments...]`.
- Do not delete or commit the helper when working on upstream Zotero changes.
