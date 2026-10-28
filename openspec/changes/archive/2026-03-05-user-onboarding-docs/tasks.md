# Tasks: User Onboarding Documentation Overhaul

> **Status**: ARCHIVED — All 13/13 tasks complete
> **Archived**: 2026-03-05
> **Verification**: PASS WITH WARNINGS (see `verify-report.md`)

> **GitHub App install URL** (confirmed from `templates/ghagga-runner-README.md`):
> `https://github.com/apps/ghagga-review/installations/new`
>
> **Dashboard URL**: `https://jnzader.github.io/ghagga/app/`
> **Docs URL**: `https://jnzader.github.io/ghagga/docs/`

### Commits

| Hash      | Message                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `046944a` | docs(sdd): add user-onboarding-docs change artifacts                     |
| `302d189` | docs(onboarding): add SaaS getting started guide and onboarding overhaul |
| `3e00003` | docs(sdd): archive auto-runner-creation change                           |

---

## Phase 1: Core SaaS Guide (P0)

The critical missing piece. No other task depends on the exact content of the SaaS guide, but all cross-references in later phases link to it — so it must exist first.
- [x] **1.1** Create `docs/saas-getting-started.md` — the full step-by-step SaaS guide
  - **Files**: `docs/saas-getting-started.md` (new)
  - **Dependencies**: None
  - **Effort**: L
  - **What to do**:
    - Create `docs/saas-getting-started.md` with the following structure:
      1. Title: "Getting Started with GHAGGA (SaaS / GitHub App)"
      2. One-paragraph intro: what the user will achieve (zero to first review in ~5 min)
      3. Prerequisites: GitHub account, a repo (public or private), ability to create/open a PR
      4. "Not looking for SaaS?" callout linking to `self-hosted.md`, `github-action.md`, `cli.md`
      5. **Step 1: Install the GitHub App** — link to `https://github.com/apps/ghagga-review/installations/new`, describe permission selection (all repos vs select repos), explain what permissions the App requests (Contents: read, Pull requests: read+write, Metadata: read)
      6. **Post-install warning** (blockquote with `> **Important**`): "After installing the App, reviews will NOT work until you configure at least one LLM provider in the Dashboard. Continue to Step 2."
      7. **Step 2: Open the Dashboard** — link to `https://jnzader.github.io/ghagga/app/`, describe GitHub OAuth Device Flow login (click Login → enter code on GitHub → authorize)
      8. **Step 3: Configure your LLM Provider** — explain Dashboard → Settings → Provider. Table of all 6 providers with model, cost (free/BYOK), and notes. Emphasize: GitHub Models is the free default — select "GitHub" provider, no API key needed. For BYOK: paste API key in the Dashboard Settings field; keys are encrypted with AES-256-GCM.
      9. **Step 4: Enable the Runner (optional)** — explain Dashboard → Global Settings → "Enable Runner" button. What it does: creates `ghagga-runner` public repo from template for static analysis (Semgrep, Trivy, CPD). Note: optional — without it, reviews are LLM-only (no static analysis findings). Note: if OAuth scope re-auth is prompted, it's a one-time step.
      10. **Step 5: Open a PR** — tell user to create or push to a PR on a repo where the App is installed. What to expect: review comment in ~1-2 min, describe what the comment looks like (status, findings, suggestions).
      11. **What happens without configuration** — 3 states table: (a) No LLM key → no AI review posted, (b) LLM key but no runner → AI-only review (no static analysis), (c) Both → full review with static analysis + AI.
      12. **Troubleshooting** section covering: "No review comment posted" (check LLM provider config, check App is installed on that repo), "Review comment is empty or minimal" (check runner is enabled for static analysis), "Runner not discovered" (repo must be named `ghagga-runner`, must be public), "OAuth re-authentication" (one-time scope upgrade for `public_repo`).
      13. **Cost summary** — GHAGGA is free and open source (MIT). GitHub Models is free (no API key). Other providers are BYOK. Static analysis runs on free GitHub Actions minutes.
      14. **Next steps** — links to Review Modes, Memory System, Configuration, Runner Architecture docs. - Use Docsify-compatible Markdown: standard headings, tables, blockquotes, code blocks - Match the quality/depth of `docs/self-hosted.md` (~150-250 lines)
  - **Acceptance criteria**:
    - [ ] File exists at `docs/saas-getting-started.md`
    - [ ] Contains all 5 numbered steps with verification checkpoints
    - [ ] Post-install warning is present as a blockquote
    - [ ] GitHub App install URL is `https://github.com/apps/ghagga-review/installations/new`
    - [ ] Dashboard URL is `https://jnzader.github.io/ghagga/app/` (linked)
    - [ ] Troubleshooting section covers at least 4 common issues
    - [ ] Cost model is clearly stated
    - [ ] "Not looking for SaaS?" redirects to other guides

- [x] **1.2** Add post-install warning and Dashboard URL link to `docs/quick-start.md`
  - **Files**: `docs/quick-start.md` (modified)
  - **Dependencies**: None (can be done in parallel with 1.1)
  - **Effort**: S
  - **What to do**:
    - In the "SaaS Mode — Runner Setup" section (line 62), add a post-install warning blockquote before the runner steps: `> **Important**: After installing the GitHub App, you must configure an LLM provider in the [Dashboard](https://jnzader.github.io/ghagga/app/) before reviews will work. See the [SaaS Getting Started Guide](saas-getting-started.md) for the full setup flow.`
    - On line 66, change `**Open the Dashboard**` to `**[Open the Dashboard](https://jnzader.github.io/ghagga/app/)**`
  - **Acceptance criteria**:
    - [ ] Post-install warning blockquote present in SaaS section
    - [ ] "Open the Dashboard" on line 66 is a clickable link to Dashboard URL
    - [ ] Warning links to both Dashboard and SaaS guide

- [x] **1.3** Linkify Dashboard URL in `docs/runner-architecture.md`
  - **Files**: `docs/runner-architecture.md` (modified)
  - **Dependencies**: None
  - **Effort**: S
  - **What to do**:
    - On line 22, change `Open the Dashboard` to `[Open the Dashboard](https://jnzader.github.io/ghagga/app/)`
  - **Acceptance criteria**:
    - [ ] "Open the Dashboard" on line 22 is a clickable Markdown link
    - [ ] URL is `https://jnzader.github.io/ghagga/app/`

---

## Phase 2: Landing Page & Navigation (P1)

These tasks make the SaaS path discoverable. The landing page is the highest-traffic entry point; the sidebar and decision matrix guide users once they're in the docs.
- [x] **2.1** Update `landing/index.html` — Install CTA, Getting Started steps, pricing section
  - **Files**: `landing/index.html` (modified)
  - **Dependencies**: 1.1 (need the SaaS guide to exist for the link target)
  - **Effort**: L
  - **What to do**:
    - **Hero CTA changes**: Replace current CTAs with 3 buttons:
      1. Primary: "Install GitHub App" → `https://github.com/apps/ghagga-review/installations/new` (use existing `.btn-primary` style)
      2. Secondary: "Documentation" → `docs/` (use existing `.btn-secondary` style)
      3. Secondary: "Open Dashboard" → `app/` (use existing `.btn-secondary` style) - **New "How to Get Started" section**: Add below the features grid, before the pipeline section. 3-4 numbered steps in a horizontal layout (matching the `.pipe-step` visual style):
      4. "Install" — Install the GitHub App on your repos
      5. "Configure" — Log in to the Dashboard, pick your LLM provider
      6. "Review" — Open a PR and get AI-powered review in ~1-2 min - **New "Free & Open Source" section**: Add below the stats strip, before the footer. Brief section:
      - "GHAGGA is free and open source (MIT license)"
      - "GitHub Models provides free AI reviews — no API key needed"
      - "Bring your own key for Anthropic, OpenAI, Google, Qwen, or Ollama"
      - "Static analysis runs on free GitHub Actions minutes" - **Responsive**: All new sections must follow existing responsive patterns (stack vertically on ≤768px). Add corresponding `@media` rules using the same breakpoint pattern. - **Preserve**: Do NOT remove or reorder existing sections (features, pipeline, stats). Do NOT change the ambient background, grid pattern, or animations.
  - **Acceptance criteria**:
    - [ ] "Install GitHub App" is the primary CTA in the hero (`.btn-primary` style)
    - [ ] Install CTA links to `https://github.com/apps/ghagga-review/installations/new`
    - [ ] "Documentation" and "Open Dashboard" are secondary buttons
    - [ ] "How to Get Started" section exists with 3 numbered steps
    - [ ] "Free & Open Source" section exists with cost clarity
    - [ ] All new sections are responsive (test: no horizontal scroll at 375px width)
    - [ ] Existing sections (features, pipeline, stats, footer) are untouched

- [x] **2.2** Add "Choose your path" decision matrix to `docs/quick-start.md`
  - **Files**: `docs/quick-start.md` (modified)
  - **Dependencies**: 1.1 (SaaS guide must exist for the link), 1.2 (should be applied on top of 1.2's changes)
  - **Effort**: M
  - **What to do**:
    - Replace the current opening line ("Choose your preferred distribution mode...") with a decision matrix table at the top of the page, right after the `# Quick Start` heading:

      ```markdown
      ## Choose Your Path

      | If you want... | Use | Time | Requires | Guide |
      |---|---|---|---|---|
      | **Easiest setup — install and go** | **SaaS (GitHub App)** ⭐ Recommended | ~5 min | GitHub account | [SaaS Guide](saas-getting-started.md) |
      | CI/CD integration — runs in your pipeline | GitHub Action | ~10 min | Repo admin access | [Action Guide](github-action.md) |
      | Local review from your terminal | CLI | ~5 min | Node.js 22+ | [CLI Guide](cli.md) |
      | Full control — your own server | Self-Hosted (Docker) | ~30 min | Docker, PostgreSQL | [Self-Hosted Guide](self-hosted.md) |
      ```

    - Keep all existing sections below the matrix (GitHub Action, CLI, Self-Hosted, SaaS Mode — Runner Setup, BYOK)
    - Add a brief note after the table: "All modes use the same review engine under the hood. [Learn more about the architecture](architecture.md)."
  - **Acceptance criteria**:
    - [ ] Decision matrix table is the first content after `# Quick Start`
    - [ ] SaaS is marked as "⭐ Recommended"
    - [ ] All 4 modes listed with time, requirements, and guide link
    - [ ] Existing sections preserved below the matrix
    - [ ] All links in the matrix resolve to existing docs

- [x] **2.3** Update `docs/_sidebar.md` — add SaaS guide link
  - **Files**: `docs/_sidebar.md` (modified)
  - **Dependencies**: 1.1 (file must exist)
  - **Effort**: S
  - **What to do**:
    - Add `[SaaS Guide (GitHub App)](saas-getting-started.md)` to the Getting Started section, between "Quick Start" and "Configuration":

      ```markdown
      - Getting Started
        - [Overview](README.md)
        - [Quick Start](quick-start.md)
        - [SaaS Guide (GitHub App)](saas-getting-started.md)
        - [Configuration](configuration.md)
      ```
    - Also add the SaaS guide to the Distribution section:

      ```markdown
      - Distribution
        - [SaaS (GitHub App)](saas-getting-started.md)
        - [GitHub Action](github-action.md)
        - [CLI](cli.md)
        - [Self-Hosted (Docker)](self-hosted.md)
      ```

  - **Acceptance criteria**:
    - [ ] SaaS guide appears in "Getting Started" section (position 3, after Quick Start)
    - [ ] SaaS guide appears in "Distribution" section (position 1, before GitHub Action)
    - [ ] Link resolves to `saas-getting-started.md`
    - [ ] Sidebar renders correctly in Docsify (valid Markdown indentation)

---

## Phase 3: README & Remaining Docs (P2)

Cross-references, callouts, and orientation — bringing all entry points into alignment.
- [x] **3.1** Add SaaS option (Option 0) to `README.md` Quick Start section
  - **Files**: `README.md` (modified)
  - **Dependencies**: 1.1 (SaaS guide must exist for the link)
  - **Effort**: M
  - **What to do**:
    - Insert a new section before the current "### Option 1: GitHub Action" (line 63):

      ```markdown
      ### Option 0: GitHub App (SaaS) — ⭐ Recommended

      The easiest way to get started. Install the App, configure in the Dashboard, get reviews.

      1. **[Install the GHAGGA GitHub App](https://github.com/apps/ghagga-review/installations/new)** on your repositories
      2. **[Open the Dashboard](https://jnzader.github.io/ghagga/app/)** and log in with GitHub
      3. **Configure your LLM provider** — GitHub Models is free (no API key needed), or bring your own key
      4. **Open a PR** — get an AI-powered review in ~1-2 minutes

      > **Important**: After installing the App, reviews won't work until you configure an LLM provider in the [Dashboard](https://jnzader.github.io/ghagga/app/). See the [full SaaS guide](https://jnzader.github.io/ghagga/docs/#/saas-getting-started) for detailed steps.

      ---
      ```
    - Do NOT renumber existing options (keep "Option 1", "Option 2", "Option 3" as-is to avoid breaking any external links to anchors)
  - **Acceptance criteria**:
    - [ ] "Option 0: GitHub App (SaaS)" section exists before Option 1
    - [ ] Labeled as "⭐ Recommended"
    - [ ] Install URL is `https://github.com/apps/ghagga-review/installations/new` (linked)
    - [ ] Dashboard URL is linked
    - [ ] Post-install warning blockquote is present
    - [ ] Links to full SaaS guide
    - [ ] Existing options 1-3 are unchanged

- [x] **3.2** Add SaaS callout to top of `docs/configuration.md`
  - **Files**: `docs/configuration.md` (modified)
  - **Dependencies**: None
  - **Effort**: S
  - **What to do**:
    - Insert after `# Configuration` (line 1) and before `## Environment Variables` (line 3):

      ```markdown
      > **Using the SaaS (GitHub App)?** Configure everything in the [Dashboard](https://jnzader.github.io/ghagga/app/) → Settings. The environment variables and config file below are for **CLI** and **self-hosted** deployments only.
      ```

  - **Acceptance criteria**:
    - [ ] Callout blockquote is the first content after `# Configuration`
    - [ ] Dashboard URL is a clickable link
    - [ ] Clearly scopes env vars to CLI/self-hosted only
    - [ ] Does not imply env vars are deprecated

- [x] **3.3** Update `docs/README.md` with "Start here" orientation
  - **Files**: `docs/README.md` (modified)
  - **Dependencies**: 1.1 (SaaS guide must exist)
  - **Effort**: S
  - **What to do**:
    - Insert a "New here?" section after the title block and before "## How It Works" (line 8):

      ```markdown
      ## New Here? Start with Your Guide

      | Your situation | Start here |
      |---|---|
      | **I want the easiest setup** | [SaaS Guide (GitHub App)](saas-getting-started.md) ⭐ Recommended |
      | I want CI/CD integration | [GitHub Action](github-action.md) |
      | I want local CLI reviews | [CLI](cli.md) |
      | I want to self-host | [Self-Hosted (Docker)](self-hosted.md) |
      | I just want to explore | Keep reading below, then check [Quick Start](quick-start.md) |
      ```

  - **Acceptance criteria**:
    - [ ] "New Here?" section exists before "How It Works"
    - [ ] SaaS guide is listed first and marked as recommended
    - [ ] All links resolve to existing docs
    - [ ] Section is brief (table format, not a wall of text)

- [x] **3.4** Add cost transparency to `docs/quick-start.md` BYOK section
  - **Files**: `docs/quick-start.md` (modified)
  - **Dependencies**: 2.2 (should be applied on top of decision matrix changes)
  - **Effort**: S
  - **What to do**:
    - In the existing "## BYOK — Bring Your Own Key" section (line 76), add a brief cost clarity note before the provider table:

      ```markdown
      > **Free by default**: GHAGGA is free and open source. GitHub Models provides free LLM access (`gpt-4o-mini`) — no API key needed. The providers below are optional if you want different models.
      ```
    - After the provider table, add:

      ```markdown
      Static analysis tools (Semgrep, Trivy, CPD) are always free — they run on GitHub Actions runners (unlimited free minutes for public repos).
      ```

  - **Acceptance criteria**:
    - [ ] "Free by default" callout exists in BYOK section
    - [ ] GitHub Models identified as the free default
    - [ ] Static analysis cost noted as free
    - [ ] No contradictions with SaaS guide cost info

---

## Phase 4: Verification

- [x] **4.1** Verify all internal links resolve
  - **Files**: All modified files
  - **Dependencies**: All previous tasks
  - **Effort**: S
  - **What to do**:
    - Check every `[text](path.md)` link in all modified/new files resolves to an existing file in `docs/`
    - Check every `[text](https://...)` link is a valid URL
    - Specifically verify:
      - `saas-getting-started.md` exists and is linked from sidebar, quick-start, README, docs/README
      - `https://github.com/apps/ghagga-review/installations/new` is used consistently
      - `https://jnzader.github.io/ghagga/app/` is used for all Dashboard references - Verify no "Open the Dashboard" text exists as plain (unlinked) text in any doc
  - **Acceptance criteria**:
    - [ ] Zero broken internal links
    - [ ] Zero unlinked "Open the Dashboard" references
    - [ ] GitHub App install URL is consistent across all files
    - [ ] Dashboard URL is consistent across all files

- [x] **4.2** Verify Docsify rendering and sidebar navigation
  - **Files**: `docs/index.html`, `docs/_sidebar.md`, `docs/saas-getting-started.md`
  - **Dependencies**: All previous tasks
  - **Effort**: S
  - **What to do**:
    - Serve docs locally (`npx docsify-cli serve docs/` or equivalent) and verify:
      - Sidebar shows SaaS guide in correct position
      - SaaS guide page loads and renders all sections (headings, tables, blockquotes, links)
      - Navigation from sidebar to SaaS guide works
      - All other sidebar links still work
  - **Acceptance criteria**:
    - [ ] SaaS guide renders in Docsify without errors
    - [ ] Sidebar navigation works for all links
    - [ ] Tables, blockquotes, and code blocks render correctly

- [x] **4.3** Verify landing page responsiveness
  - **Files**: `landing/index.html`
  - **Dependencies**: 2.1
  - **Effort**: S
  - **What to do**:
    - Open `landing/index.html` in a browser and test:
      - Desktop (1200px+): 3 CTAs visible in hero, getting-started steps horizontal
      - Tablet (768px): Steps begin to stack, all CTAs visible
      - Mobile (375px): Everything stacks vertically, no horizontal overflow, CTAs are full-width - Verify Install CTA is the most visually prominent button
  - **Acceptance criteria**:
    - [ ] No horizontal overflow at any viewport width down to 375px
    - [ ] Install CTA is visually primary (purple gradient, largest)
    - [ ] Getting-started steps and pricing section render at all breakpoints

---

## Summary

| Phase                              | Tasks  | Focus                                                          | Effort           |
| ---------------------------------- | ------ | -------------------------------------------------------------- | ---------------- |
| Phase 1: Core SaaS Guide (P0)      | 3      | SaaS guide + post-install warning + Dashboard links            | 1L + 2S          |
| Phase 2: Landing & Navigation (P1) | 3      | Landing page CTA + decision matrix + sidebar                   | 1L + 1M + 1S     |
| Phase 3: README & Remaining (P2)   | 4      | README option + config callout + docs orientation + cost notes | 1M + 3S          |
| Phase 4: Verification              | 3      | Link check + Docsify rendering + responsive test               | 3S               |
| **Total**                          | **13** |                                                                | **2L + 2M + 9S** |

### Implementation Order

```
Phase 1 (parallel):
  1.1 saas-getting-started.md ──┐
  1.2 quick-start.md warning ───┤ (can all start together)
  1.3 runner-architecture.md ───┘

Phase 2 (after 1.1):
  2.1 landing/index.html ───────┐
  2.2 quick-start.md matrix ────┤ (can run in parallel)
  2.3 _sidebar.md ──────────────┘

Phase 3 (after 1.1):
  3.1 README.md option 0 ──────┐
  3.2 configuration.md callout ─┤ (can run in parallel)
  3.3 docs/README.md orient. ───┤
  3.4 quick-start.md cost ──────┘

Phase 4 (after all):
  4.1 Link verification ────────┐
  4.2 Docsify rendering ────────┤ (sequential)
  4.3 Landing responsive ───────┘
```

**Critical path**: Task 1.1 (SaaS guide) is the bottleneck — most other tasks link to it. Start there.
