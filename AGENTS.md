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
