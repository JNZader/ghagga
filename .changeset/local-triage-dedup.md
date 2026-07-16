---
"ghagga-triage-engine": minor
"ghagga": minor
---

Add memory-backed issue dedup to the local `ghagga triage` command. Before running the LLM analysis, an incoming issue is checked against previously-triaged issues (stored locally under `~/.config/ghagga/memory.db`, scoped per repo) via the backend-agnostic keyword-overlap dedup engine; a likely duplicate short-circuits to a DUPLICATE draft (no LLM spend) citing the matched issues, and non-duplicates are persisted for future matching. Opt-out via `"dedup": { "enabled": false }` in the triage config. Self-identity is keyed on the stable repo+iid (robust to title edits), stored content is length-bounded, and a broken/corrupt memory DB degrades gracefully to running without dedup.
