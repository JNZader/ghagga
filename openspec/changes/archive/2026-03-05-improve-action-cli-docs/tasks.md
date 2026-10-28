# Tasks: Improve GitHub Action & CLI Documentation

> **Change**: `improve-action-cli-docs`
> **Type**: Docs-only (no code changes)
> **Design phase**: Skipped (structural template defined in proposal)
> **Total tasks**: 11 across 4 phases

---

## Phase 1: Bug Fixes (P0)

Independent, surgical fixes. Each task is one commit. No dependencies between them.

---

- [x] **1.1** Fix `@ghagga/cli` → `ghagga` in `apps/cli/README.md`

  **Description**: Replace all 10 occurrences of the wrong scoped package name with the correct published name. The npm package is `ghagga` (verified: `apps/cli/package.json` `"name": "ghagga"`), not `@ghagga/cli`.

  **Files**: `apps/cli/README.md`

  **Changes**:
  - `npx @ghagga/cli` → `npx ghagga` (9 occurrences: lines 6, 7, 27, 36, 39, 42, 45, 51, 52)
  - `npm install -g @ghagga/cli` → `npm install -g ghagga` (1 occurrence: line 60)

  **Dependencies**: None

  **Effort**: S

  **Acceptance criteria** (spec R11):
  - `grep -c "@ghagga/cli" apps/cli/README.md` returns 0
  - All `npx ghagga` and `npm install -g ghagga` commands reference the correct package name

---

- [x] **1.2** Fix `--config` inline JSON examples in `docs/cli.md` and `docs/configuration.md`

  **Description**: The `--config` flag expects a file path, not inline JSON (source: `apps/cli/src/commands/review.ts` L166-177 calls `resolve(configPath)` then `readFileSync`). Two files contain the broken pattern `--config '{"reviewLevel": "strict"}'`.

  **Files**: `docs/cli.md`, `docs/configuration.md`

  **Changes**:
  - `docs/cli.md` line 104: Replace `ghagga review --mode workflow --config '{"reviewLevel": "strict"}'` with a two-part example showing `.ghagga.json` content + `ghagga review --mode workflow --config .ghagga.json`
  - `docs/configuration.md` line 107: Replace `ghagga review --config '{"reviewLevel": "strict"}'` with similar two-part example: show the file, then `ghagga review --config .ghagga.json`

  **Dependencies**: None

  **Effort**: S

  **Acceptance criteria** (spec R12):
  - `grep -r "--config '{" docs/ README.md` returns 0 matches
  - Both locations show: (1) `.ghagga.json` file content block, (2) CLI command with `--config .ghagga.json`

---

- [x] **1.3** Fix consensus example missing `provider: anthropic` in `docs/github-action.md`

  **Description**: The "Consensus Mode for Security-Sensitive Code" example (lines 74-79) passes `api-key: ${{ secrets.ANTHROPIC_API_KEY }}` but omits `provider: anthropic`. Without it, the Action defaults to `provider: github` and ignores the API key entirely (source: `apps/action/src/index.ts` L66-81).

  **Files**: `docs/github-action.md`

  **Changes**:
  - Add `provider: anthropic` to the `with:` block of the consensus example (between `api-key:` and `mode:` lines)

  **Dependencies**: None

  **Effort**: S

  **Acceptance criteria** (spec R13):
  - The consensus example YAML includes both `api-key: ${{ secrets.ANTHROPIC_API_KEY }}` and `provider: anthropic`
  - No Action example in the file passes a non-GitHub API key without the corresponding `provider` input

---

## Phase 2: GitHub Action Guide Rewrite (P0 + P1)

Major rewrite of `docs/github-action.md` plus consistency updates to `README.md`. Task 2.1 is the bulk of the work; 2.2 is a follow-up sync.

---

- [x] **2.1** Rewrite `docs/github-action.md` — full onboarding guide

  **Description**: Complete rewrite of `docs/github-action.md` from 117 lines of reference material to a ~280-320 line guided onboarding experience. Use `docs/saas-getting-started.md` as the structural template.

  **Files**: `docs/github-action.md`

  **Structure** (all sections required):
  1. **Title + introduction** — one-line value proposition + "Not looking for the Action?" callout with links to SaaS/CLI/Self-Hosted
  2. **Prerequisites** — GitHub repo, write access to `.github/workflows/`, PR workflow familiarity (spec R14)
  3. **Step 1: Create the workflow file** — full YAML with explanation of each section; verification: file exists at path (spec R15)
  4. **Step 2: Commit and push** — git commands; verification: Actions tab shows workflow (spec R15)
  5. **Step 3: Open a Pull Request** — explain PR triggers, first-time setup note; verification: running workflow visible (spec R15)
  6. **Step 4: See the review** — what the comment looks like, first-run timing, verification: `github-actions[bot]` comment appears (spec R15)
  7. **How It Works** — Mermaid flowchart: `PR event → Action triggers → checkout → static analysis → LLM review → post comment` (spec R18)
  8. **Inputs** — existing table (retain from current file, already correct)
  9. **Outputs** — existing table (retain from current file)
  10. **Review Status and CI** — document `core.setFailed()` behavior, blocking vs advisory patterns, `continue-on-error: true` example (spec R17)
  11. **Variants** — Node.js (default) vs Docker (retain from current file)
  12. **Configuration** — note that `.ghagga.json` is NOT supported, all config via Action inputs (spec R18)
  13. **Examples** — retain existing good examples, fix consensus bug (already done in T1.3), add `continue-on-error` example, add `permissions` example
  14. **What to Expect** — describe PR comment format: status emoji, summary, findings with severity/file/line (spec R18)
  15. **Troubleshooting** — 5 items: token permissions, no comment, first-run slowness, action doesn't trigger, FAILED status (spec R16)
  16. **Cost** — free for public repos, private = 2000 free min/month, GitHub Models free, BYOK for others (spec R18, R7-mod)
  17. **Next Steps** — links to CLI guide, config docs, review modes, self-hosted (spec R18)

  **Source code references to verify claims**:
  - `action.yml` — inputs/outputs truth
  - `apps/action/src/index.ts` L188-193 — `core.setFailed()` on FAILED
  - `apps/action/src/index.ts` L159 — `enableMemory: false` (no memory in Action mode)

  **Dependencies**: T1.3 (consensus bug fix is incorporated into this rewrite)

  **Effort**: L

  **Acceptance criteria** (spec R14, R15, R16, R17, R18, CC5):
  - File has all 17 sections listed above
  - 4 numbered steps with verification checkpoints (✅ markers)
  - Mermaid diagram renders correctly (fenced `mermaid` block)
  - Troubleshooting has 5+ items with symptom/cause/fix format
  - `core.setFailed()` documented with `continue-on-error: true` example
  - `.ghagga.json` NOT supported is stated explicitly
  - Cost section present
  - Next Steps with links to `cli.md`, `configuration.md`, `saas-getting-started.md`
  - File length: 280-350 lines

---

- [x] **2.2** Update `README.md` Action section for consistency

  **Description**: Ensure the `README.md` "Option 1: GitHub Action" section (lines ~80-115) is consistent with the rewritten `docs/github-action.md`. The README section is a compact summary — it should NOT duplicate the full guide but should have correct examples and link to the guide.

  **Files**: `README.md`

  **Changes**:
  - Verify the basic setup YAML example matches the guide
  - Verify input/output tables match the guide
  - Add note about `core.setFailed()` behavior (brief, link to full guide)
  - Add link to full guide: `See [GitHub Action Guide](docs/github-action.md) for the complete setup guide with troubleshooting.`
  - Check for any `--config` inline JSON bugs in the Action section (fix if found)

  **Dependencies**: T2.1

  **Effort**: S

  **Acceptance criteria**:
  - README Action section links to `docs/github-action.md`
  - No broken or incorrect examples in the README Action section
  - Brief mention of `FAILED` status behavior or link to guide

---

## Phase 3: CLI Guide Rewrite (P0 + P1)

Major rewrite of `docs/cli.md` plus fixes to `apps/cli/README.md` and `README.md` CLI section. T3.1 is the bulk; T3.2 and T3.3 are follow-up syncs.

---

- [x] **3.1** Rewrite `docs/cli.md` — full onboarding guide

  **Description**: Complete rewrite of `docs/cli.md` from 111 lines of reference material to a ~280-320 line guided onboarding experience.

  **Files**: `docs/cli.md`

  **Structure** (all sections required):
  1. **Title + introduction** — one-line value proposition + "Not looking for the CLI?" callout with links to SaaS/Action/Self-Hosted
  2. **Prerequisites** — Node.js >= 20, Git, GitHub account (spec R19). Note: `quick-start.md` says "22+" but `package.json` says ">=20" — use 20 as source of truth
  3. **Step 1: Install** — show `npm install -g ghagga` and `npx ghagga` options; verification: `ghagga --version` (spec R20)
  4. **Step 2: Login** — `ghagga login`, explain Device Flow, token stored at `~/.config/ghagga/config.json`; verification: `ghagga status` shows "Logged in" (spec R20)
  5. **Step 3: Review your code** — `ghagga review`, note about needing staged/uncommitted changes; verification: review output in terminal (spec R20)
  6. **Step 4: Explore options** — workflow mode, JSON output, verbose; link to options reference (spec R20)
  7. **How It Works** — Mermaid flowchart: `ghagga review → git diff → detect stack → static analysis → LLM → format → terminal` (spec R24)
  8. **Commands** — all 4 commands documented (spec R21):
     - `login` — Device Flow auth, stores token, grants GitHub Models access
     - `logout` — clears `~/.config/ghagga/config.json`
     - `status` — shows auth, config path, provider, model
     - `review [path]` — full options table (retain existing), add `[path]` arg docs
  9. **Options reference** — existing table (retain, already correct including all 6 providers)
  10. **Environment Variables** — `GHAGGA_API_KEY`, `GHAGGA_PROVIDER`, `GHAGGA_MODEL`, `GITHUB_TOKEN`; document priority chain: CLI flag > env var > stored config > defaults (spec R23)
  11. **Config File** — `.ghagga.json` format, priority chain, `--config <path>` usage with file path (spec R23)
  12. **Config Storage** — `~/.config/ghagga/config.json` (or `$XDG_CONFIG_HOME/ghagga/config.json`) (spec R23)
  13. **Exit Codes** — retain existing table
  14. **Static Analysis** — retain existing info (tools optional, silently skipped)
  15. **Example Output** — markdown format example + JSON format example (spec R23)
  16. **Troubleshooting** — 6 items: command not found, no API key, no changes detected, not a git repo, tools skipped, login failure (spec R22)
  17. **Cost** — GitHub Models free, Ollama free, BYOK for others (spec R24, R7-mod)
  18. **Next Steps** — links to Action guide, config docs, review modes, Ollama setup (spec R24)

  **Source code references to verify claims**:
  - `apps/cli/src/index.ts` L77-79 — `[path]` argument with default `.`
  - `apps/cli/src/index.ts` L124-129 — `GITHUB_TOKEN` fallback
  - `apps/cli/src/lib/config.ts` L30-34 — XDG config path
  - `apps/cli/src/commands/status.ts` — status output format
  - `apps/cli/src/commands/review.ts` L166-177 — config file loading
  - `apps/cli/src/commands/review.ts` L271-280 — markdown output format
  - `apps/cli/src/commands/review.ts` L363-377 — exit code mapping

  **Dependencies**: T1.2 (`--config` fix is incorporated into this rewrite)

  **Effort**: L

  **Acceptance criteria** (spec R19, R20, R21, R22, R23, R24, CC5):
  - File has all 18 sections listed above
  - 4 numbered steps with verification checkpoints (✅ markers)
  - All 4 commands documented (`login`, `logout`, `status`, `review`)
  - `[path]` positional argument documented
  - `GITHUB_TOKEN` fallback documented
  - `~/.config/ghagga/config.json` path documented
  - `--verbose` behavior described
  - Mermaid diagram renders correctly
  - Troubleshooting has 6+ items with symptom/cause/fix format
  - Example output shown (markdown + JSON)
  - Cost section present
  - Next Steps with links to `github-action.md`, `configuration.md`, `saas-getting-started.md`
  - File length: 280-350 lines

---

- [x] **3.2** Update `apps/cli/README.md` — fix remaining issues beyond package name

  **Description**: After T1.1 fixes the package name, this task addresses the remaining issue: missing providers in the Options section.

  **Files**: `apps/cli/README.md`

  **Changes**:
  - Options section line 74: Add `ollama, qwen` to provider list → `LLM provider: github, anthropic, openai, google, ollama, qwen`

  **Dependencies**: T1.1

  **Effort**: S

  **Acceptance criteria** (spec R25):
  - The `--provider` line in the Options section lists all 6 providers: `github`, `anthropic`, `openai`, `google`, `ollama`, `qwen`

---

- [x] **3.3** Update `README.md` CLI section for consistency

  **Description**: Ensure the `README.md` "Option 2: CLI" section (lines ~116-175) is consistent with the rewritten `docs/cli.md`.

  **Files**: `README.md`

  **Changes**:
  - Verify CLI examples use `ghagga` (not `@ghagga/cli`) — should already be correct
  - Verify options table matches the guide (all 6 providers, `--verbose`)
  - Fix `--config` example if the inline JSON bug exists here (check lines ~157-175)
  - Add link to full guide: `See [CLI Guide](docs/cli.md) for the complete setup guide with troubleshooting.`

  **Dependencies**: T3.1

  **Effort**: S

  **Acceptance criteria**:
  - README CLI section links to `docs/cli.md`
  - No broken or incorrect examples in the README CLI section
  - No `--config` inline JSON pattern

---

## Phase 4: Cross-References & Cleanup (P1)

Final consistency pass. Must run after all rewrites are done.

---

- [x] **4.1** Fix contradictory "Recommended" labels in `docs/quick-start.md`

  **Description**: The decision matrix table (line 7) marks SaaS as "⭐ Recommended", but the Action section heading (line 14) says `## GitHub Action (Recommended)`. Remove "Recommended" from the Action heading. Also fix "Node.js 22+" to "Node.js >= 20" in the CLI table row to match `package.json`.

  **Files**: `docs/quick-start.md`

  **Changes**:
  - Line 14: `## GitHub Action (Recommended)` → `## GitHub Action`
  - Line 9: `Node.js 22+` → `Node.js >= 20` (if present, to match `package.json` `"node": ">=20.0.0"`)

  **Dependencies**: None (can run in parallel with Phase 2/3, but logically belongs in cleanup)

  **Effort**: S

  **Acceptance criteria** (spec R5-mod):
  - Only SaaS row has "Recommended" label in decision matrix
  - Action section heading is `## GitHub Action` (no Recommended)
  - Node.js version matches `package.json` requirement (>= 20)

---

- [x] **4.2** Verify cross-links, consistency, and zero remaining bugs

  **Description**: Final verification pass across all modified files. This is a read-and-check task, not a writing task. Fix any issues found.

  **Files**: All 7 files modified in this change:
  - `docs/github-action.md`
  - `docs/cli.md`
  - `apps/cli/README.md`
  - `README.md`
  - `docs/quick-start.md`
  - `docs/configuration.md`

  **Verification checklist**:
  1. **Bug-free examples (CC4)**:
     - `grep -r "@ghagga/cli" apps/cli/README.md` → 0 matches
     - `grep -r "--config '{" docs/ README.md` → 0 matches
     - All Action YAML examples with non-GitHub API keys include `provider`
  2. **Cross-links (CC1-ext)**:
     - `docs/github-action.md` links to `cli.md`, `configuration.md`, `saas-getting-started.md`
     - `docs/cli.md` links to `github-action.md`, `configuration.md`, `saas-getting-started.md`
     - All relative links resolve to existing files
  3. **Consistency**:
     - Provider lists are identical across all files (6 providers: github, anthropic, openai, google, ollama, qwen)
     - Node.js version requirement is consistent (>= 20)
     - Cost info is consistent between guides
     - No contradictory "Recommended" labels
  4. **Structural quality (CC5)**:
     - `docs/github-action.md` has all 8 quality elements (prerequisites, steps, diagram, inputs, troubleshooting, cost, output, next steps)
     - `docs/cli.md` has all 8 quality elements
     - Both guides are 200-350 lines

  **Dependencies**: T2.1, T2.2, T3.1, T3.2, T3.3, T4.1

  **Effort**: M

  **Acceptance criteria** (all cross-cutting concerns):
  - All 4 verification checklist sections pass
  - Zero bugs remain in code examples
  - Zero broken cross-links
  - All modified files are self-consistent and mutually consistent

---

## Summary

| Phase                 | Tasks            | Focus                                          | Effort           |
| --------------------- | ---------------- | ---------------------------------------------- | ---------------- |
| Phase 1: Bug Fixes    | T1.1, T1.2, T1.3 | 3 P0 bugs across 4 files                       | 3× S             |
| Phase 2: Action Guide | T2.1, T2.2       | Rewrite `docs/github-action.md` + README sync  | L + S            |
| Phase 3: CLI Guide    | T3.1, T3.2, T3.3 | Rewrite `docs/cli.md` + README/CLI README sync | L + 2× S         |
| Phase 4: Cleanup      | T4.1, T4.2       | Quick-start fix + final verification           | S + M            |
| **Total**             | **11 tasks**     |                                                | **2L + 1M + 8S** |

## Dependency Graph

```
T1.1 ──────────────────────────── T3.2
T1.2 ──────────── T3.1 ────┐
T1.3 ──── T2.1 ────┐       ├──── T4.2 (verify all)
                    ├── T2.2│
                    │       │
                    │  T3.3─┘
                    │
T4.1 ──────────────────────────── T4.2
```

**Recommended execution order**:
1. T1.1, T1.2, T1.3 (parallel — independent bug fixes)
2. T2.1, T3.1 (parallel — independent guide rewrites)
3. T2.2, T3.2, T3.3 (parallel — sync tasks after rewrites)
4. T4.1 (quick-start fix)
5. T4.2 (final verification — must be last)
