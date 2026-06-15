---
"ghagga-core": patch
---

Run ghagga's bundled semgrep ruleset in the active pipeline + add gitleaks allowlist for test fixtures.

The active `semgrepPlugin` previously ran only `--config auto`, so ghagga's own curated rules (`semgrep-rules.yml`: command-injection, eval usage, SQL string concat, etc.) never executed. It now passes both `--config auto` and `--config <bundled semgrep-rules.yml>` (semgrep unions multiple configs), so the curated rules always run, even offline.

The `gitleaksPlugin` previously ran with no config or allowlist, so fake tokens in test fixtures were flagged as real secrets. It now passes `--config=<bundled gitleaks-config.toml>` which extends the default ruleset (`[extend] useDefault = true`) and adds a conservative `[allowlist]` of test/fixture path patterns. Tradeoff: a real secret hardcoded inside a test file may be missed.

Both bundled config files are copied into `dist/tools/` by a post-build step and resolved relative to the plugin's own location, so they work in dev and in the published package. Both plugins degrade gracefully (default behavior) if the bundled file is missing at runtime.

Tuned two bundled rules for precision after a dogfood showed the ruleset tripled findings (49 → 149), driven by noise:

- `hardcoded-secret-generic` no longer matches arbitrary `$VAR = "..."` string constants. It now fires only when EITHER the assigned name matches a secret-ish keyword (`secret|token|api_key|password|credential|private_key|...`) OR the string value matches a high-signal secret shape (`AKIA…`, `sk-…`, `ghp_…`, a JWT, or a ≥32-char base64/hex blob). On `packages/core/src` this cut a fully-unfiltered `$VAR="..."` from 455 matches to 6 — all real secret-shaped test fixtures (~98.7% fewer). The JSON-object-key form was dropped because it is unparseable in java/kotlin/python/go/rust and a single parse failure disables the whole rule.
- `command-injection-node` now also catches destructured/aliased child_process usage: `import { exec } from 'node:child_process'; exec(x)`, `import cp from 'child_process'; cp.exec(x)`, and the `require()` namespace/destructure equivalents. The bare/aliased branches are scoped with `pattern-inside` to files that actually import child_process so unrelated `.exec()` calls (RegExp/Mongoose) are not flagged.
