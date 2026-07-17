---
"ghagga-core": patch
---

Multi-voice review modes (workflow, consensus, fan-out) now validate FULFILLED voice responses before counting them as successes. A voice whose generateFn resolves with empty/whitespace-only text, or whose entire body is a JSON error envelope (`is_error: true`, or Claude CLI's `{"type":"result","subtype":"error_*"}` shape), is routed into the existing failure path (✗ progress event, `[FAILED]` synthesis note, `[FAILED:reason]` modelsUsed tag, tokens not counted) instead of polluting the synthesis/vote/merge step. Previously a gateway returning HTTP 200 with a raw CLI error envelope was logged as `✓ — 0 tokens` and a 5-voice review silently ran with 4 voices. The heuristic is narrow: only the whole trimmed text parsing as such a JSON object counts, so legitimate reviews that merely contain the word "error" (or embed an error JSON snippet in prose) are never rejected.
