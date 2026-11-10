---
"ghagga-core": minor
"ghagga": minor
"ghagga-db": minor
---

Add output style calibration: every prose review voice (simple, workflow specialists and synthesis, consensus stances, diagnostic, fan-out lenses) now appends a compact OUTPUT_STYLE_CALIBRATION directive — one-line MESSAGE/SUGGESTION, verdict-first bold SUMMARY, file:line references, zero filler — targeting ~30-40% fewer output tokens. On by default; disable with `--no-compress-output` or `.ghagga.json` `"compressOutput": false` to restore byte-identical prompts. Refuter and contrarian voices stay excluded.

Also measure the output-token split for the previously unmeasured modes: simple, diagnostic, and fan-out now report `metadata.outputTokensUsed` (fan-out sums across lenses, contrarians, and refuters), and the cost footer renders the measured split, falling back to the "estimated 70/30" label on providers that report no split (gateway).
