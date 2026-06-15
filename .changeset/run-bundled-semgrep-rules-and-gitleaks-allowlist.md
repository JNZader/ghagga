---
"ghagga-core": patch
---

Run ghagga's bundled semgrep ruleset in the active pipeline + add gitleaks allowlist for test fixtures.

The active `semgrepPlugin` previously ran only `--config auto`, so ghagga's own curated rules (`semgrep-rules.yml`: command-injection, eval usage, SQL string concat, etc.) never executed. It now passes both `--config auto` and `--config <bundled semgrep-rules.yml>` (semgrep unions multiple configs), so the curated rules always run, even offline.

The `gitleaksPlugin` previously ran with no config or allowlist, so fake tokens in test fixtures were flagged as real secrets. It now passes `--config=<bundled gitleaks-config.toml>` which extends the default ruleset (`[extend] useDefault = true`) and adds a conservative `[allowlist]` of test/fixture path patterns. Tradeoff: a real secret hardcoded inside a test file may be missed.

Both bundled config files are copied into `dist/tools/` by a post-build step and resolved relative to the plugin's own location, so they work in dev and in the published package. Both plugins degrade gracefully (default behavior) if the bundled file is missing at runtime.
