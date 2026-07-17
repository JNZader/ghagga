---
"ghagga-core": minor
"ghagga-triage-engine": minor
---

Add `codex` and `claude` CLI adapters to the cli-bridge (selectable via a new optional `cli` config field on the triage config; default stays `opencode`), giving triage/review a reliable gpt-5.x (codex) or Claude (claude CLI) backend instead of the flaky opencode-go path.

SECURITY: while adding them, fixed a command-injection RCE that affected ALL cli-bridge adapters (opencode/copilot/gemini too): commands were built as shell strings with `JSON.stringify`-quoted args and run via `execSync` → `/bin/sh -c`. `JSON.stringify` does not escape `$`/backtick, so an untrusted issue body containing `$(...)` or backticks executed on the host. All adapters now use `execFileSync(command, argsArray)` with no shell — the prompt is an inert argv element. Verified with a security regression test.
