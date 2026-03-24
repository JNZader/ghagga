# Documentation Onboarding Specification

## Purpose

This specification defines the requirements and scenarios for a comprehensive documentation overhaul focused on user onboarding for GHAGGA's SaaS (GitHub App) distribution mode. It covers the new SaaS getting-started guide, landing page changes, navigation restructuring, Dashboard URL linkification, cost transparency, and cross-document consistency.

All requirements are documentation-only — no application code, database, or API changes.

---

## Requirements

### R1 (P0): SaaS Getting Started Guide

A new file `docs/saas-getting-started.md` MUST exist as the definitive step-by-step guide for users of the hosted SaaS (GitHub App) distribution mode.

The guide MUST include the following sections in order:

1. **Title and introduction** — one-paragraph summary of what the user will achieve
2. **Prerequisites** — GitHub account, a repository (public or private), ability to create a PR
3. **Step 1: Install the GitHub App** — MUST include the actual GitHub App install URL as a clickable link. MUST describe what permissions the App requests and why.
4. **Step 2: Open the Dashboard** — MUST include the Dashboard URL (`https://ghagga.javierzader.com/app/`) as a clickable link. MUST describe the GitHub OAuth Device Flow login process.
5. **Step 3: Configure your LLM provider** — MUST explain that GitHub Models is the free default (no API key needed). SHOULD list all 6 providers with a table. MUST explain how to add a BYOK API key via Dashboard Settings.
6. **Step 4: Enable the Runner (optional)** — MUST explain what the runner provides (static analysis). MUST explain the "Enable Runner" button in Global Settings. MUST note this step is optional — reviews work without it (LLM-only).
7. **Step 5: Open a PR and get your first review** — MUST describe what to expect: timing (~1-2 minutes), what the review comment looks like, where to find it.
8. **Post-install warning** — MUST include a prominent callout: after installing the App, reviews will NOT work until at least one LLM provider is configured in the Dashboard.
9. **What happens without configuration** — MUST explain the three states: (a) no LLM key = no AI review, (b) no runner = no static analysis (LLM-only review), (c) both configured = full review.
10. **Troubleshooting** — MUST cover at minimum: "No review comment posted", "Review comment is empty", "Runner not discovered", "OAuth re-authentication needed".
11. **Next steps** — SHOULD link to review modes, memory system, and configuration docs.

The guide SHOULD match the quality and detail of `docs/self-hosted.md` (step-by-step with verification checkpoints).

The guide MUST NOT duplicate the self-hosted setup instructions. If a user wants self-hosted, the guide MUST redirect them with a clear link to `docs/self-hosted.md`.

#### Scenario: New user follows SaaS guide end-to-end

- GIVEN a user with a GitHub account and a repository with at least one open PR
- WHEN the user follows `docs/saas-getting-started.md` from Step 1 through Step 5
- THEN the user receives an AI code review comment on their PR within 5 minutes of starting the guide
- AND every step has a verification checkpoint ("you should now see...")

#### Scenario: User arrives at SaaS guide but wants self-hosted

- GIVEN a user reading `docs/saas-getting-started.md`
- WHEN the user determines they need a self-hosted deployment (e.g., air-gapped environment, custom backend)
- THEN the guide provides a clearly visible link to `docs/self-hosted.md` within the introduction or prerequisites section
- AND the user is not required to read the entire SaaS guide to find the self-hosted link

#### Scenario: User installs App but skips LLM configuration

- GIVEN a user who completed Step 1 (install App) but skipped Step 3 (configure LLM)
- WHEN the user opens a PR on a repository where the App is installed
- THEN the post-install warning in the guide explains this exact scenario
- AND the guide describes what the user will observe (no review comment, or a comment indicating no provider configured)

#### Scenario: User configures LLM but skips Runner setup

- GIVEN a user who completed Steps 1-3 but skipped Step 4 (Enable Runner)
- WHEN the user opens a PR
- THEN the user receives an AI-only review (no static analysis findings)
- AND the guide explains this is expected and how to enable static analysis later

#### Scenario: User needs to re-authenticate for public_repo scope

- GIVEN a user whose GitHub OAuth token was created before the `public_repo` scope was added to GHAGGA
- WHEN the user clicks "Enable Runner" in the Dashboard
- THEN the guide explains the re-authentication prompt and that it is a one-time step
- AND the guide links to the security documentation for scope justification

#### Scenario: User wants free-only setup (GitHub Models)

- GIVEN a user who does not want to pay for any LLM API keys
- WHEN the user follows the guide and reaches Step 3
- THEN the guide clearly identifies GitHub Models as the free default provider
- AND the guide explains that selecting "GitHub" as the provider requires no API key — only GitHub OAuth login
- AND the guide states the default model is `gpt-4o-mini`

---

### R2 (P0): Post-Install Warning

A prominent warning callout MUST appear in multiple documents stating that after installing the GitHub App, reviews will NOT work until at least one LLM provider is configured in the Dashboard.

The warning MUST appear in:
- `docs/saas-getting-started.md` (within the guide flow, after Step 1 or as a dedicated section)
- `docs/quick-start.md` (in the SaaS section)
- `README.md` (in the SaaS/GitHub App option)

The warning SHOULD use Docsify's `>` blockquote syntax with a `**Warning**` or `**Important**` prefix for visual prominence.

The warning MUST include a link to the Dashboard for the user to configure the provider.

#### Scenario: User encounters post-install warning in SaaS guide

- GIVEN a user reading `docs/saas-getting-started.md`
- WHEN the user reads the section after installing the GitHub App (Step 1)
- THEN a visually prominent warning states that reviews require LLM configuration
- AND the warning links to the Dashboard URL

#### Scenario: User encounters post-install warning in quick-start

- GIVEN a user reading `docs/quick-start.md`
- WHEN the user reads the SaaS/GitHub App section
- THEN the same warning is present (content may be abbreviated)
- AND the warning links to the full SaaS guide for detailed steps

#### Scenario: User encounters post-install warning in README

- GIVEN a user reading the root `README.md`
- WHEN the user reads the SaaS/GitHub App quick start option
- THEN a brief warning or note mentions that LLM configuration in the Dashboard is required after install

---

### R3 (P0): Dashboard URL Linkification

Every textual reference to "Open the Dashboard" or "the Dashboard" in the documentation MUST include a clickable hyperlink to `https://ghagga.javierzader.com/app/`.

Files that MUST be updated:
- `docs/quick-start.md` — line 66 ("Open the Dashboard")
- `docs/runner-architecture.md` — line 22 ("Open the Dashboard")
- `docs/configuration.md` — any Dashboard reference in the new SaaS callout

The new `docs/saas-getting-started.md` MUST use the linked Dashboard URL in all references.

Within `landing/index.html`, the Dashboard link SHOULD use the relative path `app/` (already present, no change needed for the existing link).

#### Scenario: User clicks Dashboard link in quick-start

- GIVEN a user reading `docs/quick-start.md`
- WHEN the user encounters the text "Open the Dashboard"
- THEN the text is a clickable hyperlink to `https://ghagga.javierzader.com/app/`

#### Scenario: User clicks Dashboard link in runner-architecture

- GIVEN a user reading `docs/runner-architecture.md`
- WHEN the user encounters the text "Open the Dashboard"
- THEN the text is a clickable hyperlink to `https://ghagga.javierzader.com/app/`

#### Scenario: Dashboard URL consistency across all docs

- GIVEN all Markdown files in the `docs/` directory
- WHEN any file contains the phrase "Open the Dashboard" or "the Dashboard" as a navigation instruction
- THEN the phrase MUST be a Markdown link pointing to `https://ghagga.javierzader.com/app/`
- AND no occurrence of "Open the Dashboard" exists as plain unlinked text

---

### R4 (P1): Landing Page Install CTA

The landing page (`landing/index.html`) MUST be updated to include a primary Call-to-Action for installing the GitHub App.

The landing page MUST:
1. Display an "Install GitHub App" button as the **primary CTA** (most visually prominent button in the hero section)
2. Link the Install CTA to the GitHub App installation URL
3. Move the existing "Documentation" button to a secondary visual style
4. Retain the "Open Dashboard" button in a secondary position

The landing page SHOULD:
1. Include a "How to Get Started" section below the hero with 3-4 numbered visual steps (Install → Configure → Review)
2. Include a "Free & Open Source" or "Pricing" section that clarifies the cost model
3. Maintain responsive design — all new sections MUST work on mobile viewports (≤768px)

The landing page MUST NOT:
1. Break the existing ambient background, grid pattern, or animation styles
2. Remove any existing content sections (features, pipeline, stats, footer)

#### Scenario: Visitor sees Install CTA on landing page

- GIVEN a visitor arriving at the GHAGGA landing page (`https://ghagga.javierzader.com/`)
- WHEN the page loads
- THEN the hero section displays "Install GitHub App" as the primary (most prominent) button
- AND "Documentation" and "Open Dashboard" are visible as secondary buttons

#### Scenario: Visitor clicks Install CTA

- GIVEN a visitor on the landing page
- WHEN the visitor clicks the "Install GitHub App" button
- THEN the browser navigates to the GitHub App installation page

#### Scenario: Visitor sees getting-started steps

- GIVEN a visitor on the landing page
- WHEN the visitor scrolls below the hero section
- THEN a "How to Get Started" section is visible with numbered steps
- AND the steps summarize: Install → Configure → Review

#### Scenario: Visitor wants to know if GHAGGA is free

- GIVEN a visitor on the landing page who is evaluating GHAGGA's cost
- WHEN the visitor looks for pricing information
- THEN a section clearly states GHAGGA is free and open source
- AND it explains that GitHub Models provides free LLM access
- AND it explains that other providers require the user's own API key

#### Scenario: Mobile visitor sees landing page

- GIVEN a visitor on a mobile device (viewport ≤768px)
- WHEN the landing page loads
- THEN all CTAs are visible and tappable
- AND the getting-started steps section stacks vertically
- AND no horizontal overflow occurs

---

### R5 (P1): Choose Your Path Decision Matrix

A decision matrix MUST be added to `docs/quick-start.md` to help users select the right distribution mode.

The matrix MUST:
1. Present all distribution modes: SaaS (GitHub App), GitHub Action, CLI, Self-Hosted (Docker)
2. Visually indicate SaaS as the **recommended** default (e.g., "(Recommended)" label, bold text, or emoji marker)
3. Include for each mode: one-line description, who it's for, time to first review, prerequisites, link to detailed guide
4. Appear at the **top** of the quick-start page, before the individual mode sections

The SaaS mode MUST be the only mode marked as "Recommended" in the decision matrix table. The GitHub Action section heading MUST NOT include "(Recommended)". It MAY use a neutral label or no label.

The table row for SaaS MUST retain the "⭐ Recommended" marker.
The Action section heading MUST be changed from `## GitHub Action (Recommended)` to `## GitHub Action`.

A similar but abbreviated matrix SHOULD be added to the root `README.md` in the Quick Start section.

#### Scenario: New user selects distribution mode from quick-start

- GIVEN a new user reading `docs/quick-start.md`
- WHEN the user views the top of the page
- THEN a decision matrix is the first content after the page title
- AND the SaaS mode is visually marked as recommended
- AND each mode links to its detailed guide

#### Scenario: User identifies the right mode based on needs

- GIVEN a user who wants the easiest possible setup
- WHEN the user reads the decision matrix
- THEN the "SaaS (GitHub App)" row shows "~5 min" time to first review, "GitHub account" as the only prerequisite, and a link to `saas-getting-started.md`

#### Scenario: Decision matrix in README

- GIVEN a user reading the root `README.md`
- WHEN the user reaches the Quick Start section
- THEN a decision matrix or summary table is present
- AND it lists SaaS as the first option (before Action, CLI, Docker)

#### Scenario: User reads quick-start and identifies recommended mode

- GIVEN a user reading `docs/quick-start.md`
- WHEN the user reads the decision matrix table AND the individual section headings
- THEN exactly ONE mode is labeled "Recommended" (SaaS)
- AND no contradictory "Recommended" labels exist on other modes

#### Scenario: Action section is neutral

- GIVEN a user reading the GitHub Action section of `docs/quick-start.md`
- WHEN the user reads the section heading
- THEN the heading is `## GitHub Action` (no "Recommended" label)

---

### R6 (P1): Sidebar Navigation Update

The Docsify sidebar (`docs/_sidebar.md`) MUST be updated to include the SaaS getting-started guide.

The sidebar MUST:
1. Add a link to `saas-getting-started.md` in the "Getting Started" section
2. Position the SaaS guide link **before** or immediately after "Quick Start" for maximum visibility
3. Use a clear label (e.g., "SaaS Guide" or "GitHub App Guide")

The sidebar MAY:
1. Reorganize the "Distribution" section to mirror the getting-started flow
2. Add a visual indicator (e.g., "NEW" badge via text) for the SaaS guide temporarily

#### Scenario: User navigates to SaaS guide from sidebar

- GIVEN a user browsing the Docsify documentation site
- WHEN the user looks at the sidebar navigation
- THEN the SaaS guide is visible in the "Getting Started" section
- AND it appears within the first 4 items of the sidebar

#### Scenario: Sidebar structure remains valid Docsify Markdown

- GIVEN the updated `docs/_sidebar.md`
- WHEN Docsify renders the sidebar
- THEN all links resolve to existing files
- AND no broken links are introduced
- AND the indentation hierarchy is correct

---

### R7 (P2): Cost Transparency

The cost model MUST be clearly documented so users understand what is free and what requires payment.

The following information MUST be stated explicitly:
1. "GHAGGA is free and open source (MIT license)"
2. "The hosted SaaS is free to use"
3. "GitHub Models provides free LLM access with `gpt-4o-mini` — no API key required"
4. "Other providers (Anthropic, OpenAI, Google, Qwen, Ollama) require your own API key — you pay those providers directly"
5. "Static analysis (Semgrep, Trivy, CPD) runs on GitHub Actions runners — free unlimited minutes for public repos"

This information MUST appear in:
- `docs/saas-getting-started.md` (detailed, within the LLM configuration step and/or a dedicated section)
- `landing/index.html` (summarized in a pricing/cost section)
- `docs/github-action.md` — Actions minutes cost model (free public, 2000 min free private)
- `docs/cli.md` — free with GitHub Models, free with Ollama, BYOK for others

This information SHOULD appear in:
- `docs/quick-start.md` (brief note in the decision matrix or BYOK section)

#### Scenario: User determines cost before installing

- GIVEN a potential user evaluating GHAGGA
- WHEN the user reads the SaaS getting-started guide
- THEN the guide states GHAGGA is free and open source
- AND the guide identifies GitHub Models as free (no API key)
- AND the guide explains that other LLM providers are BYOK (user pays provider directly)

#### Scenario: User understands static analysis cost

- GIVEN a user reading about the runner setup
- WHEN the user reads Step 4 (Enable Runner) in the SaaS guide
- THEN the guide states that static analysis runs on GitHub Actions free minutes
- AND the guide notes this applies to public repos (unlimited free minutes)

#### Scenario: Landing page communicates free tier

- GIVEN a visitor on the landing page
- WHEN the visitor looks for pricing information
- THEN a visible section states "Free & Open Source" or equivalent
- AND it summarizes: GHAGGA is free, GitHub Models is free, BYOK for other providers

#### Scenario: User finds cost info in Action guide

- GIVEN a user reading `docs/github-action.md`
- WHEN the user looks for cost information
- THEN a Cost section states: free for public repos, private repos consume GitHub Actions minutes (2,000 free/month)
- AND GitHub Models LLM is free

#### Scenario: User finds cost info in CLI guide

- GIVEN a user reading `docs/cli.md`
- WHEN the user looks for cost information
- THEN a Cost section states: free with GitHub Models and Ollama, BYOK for others

---

### R8 (P2): Configuration Page SaaS Callout

A callout MUST be added to the top of `docs/configuration.md` (before the Environment Variables section) that directs SaaS users to the Dashboard.

The callout MUST:
1. State that SaaS users configure everything in the Dashboard, not via environment variables
2. Include a clickable link to the Dashboard (`https://ghagga.javierzader.com/app/`)
3. Clarify that the environment variables documented on the page are for CLI and self-hosted modes only

The callout SHOULD use Docsify's `>` blockquote syntax for visual prominence.

#### Scenario: SaaS user lands on configuration page

- GIVEN a SaaS user navigating to `docs/configuration.md`
- WHEN the page renders
- THEN the first visible content (after the title) is a callout directing SaaS users to the Dashboard
- AND the callout includes a clickable Dashboard link
- AND the callout states that environment variables below are for self-hosted/CLI only

#### Scenario: Self-hosted user is not confused by callout

- GIVEN a self-hosted user reading `docs/configuration.md`
- WHEN the user reads the SaaS callout
- THEN the callout clearly scopes itself to "SaaS users" and does not imply that the environment variables section is deprecated or irrelevant

---

### R9 (P2): README SaaS Option

The root `README.md` Quick Start section MUST be updated to include the SaaS (GitHub App) option as the first listed option.

The README MUST:
1. Add a new section before the current "Option 1: GitHub Action" with title "Option 0: GitHub App (SaaS) — Recommended"
2. Include the GitHub App install URL as a clickable link
3. Include a 3-5 line summary of the SaaS flow (Install → Dashboard → Configure → PR → Review)
4. Include the post-install warning (abbreviated form)
5. Link to the full `docs/saas-getting-started.md` guide
6. Renumber existing options (current "Option 1" becomes "Option 1" stays, numbering shifts if needed, or use "Option 0" to avoid renumbering)

#### Scenario: User finds SaaS option in README

- GIVEN a user reading the root `README.md`
- WHEN the user scrolls to the Quick Start section
- THEN the first option listed is the SaaS (GitHub App) mode
- AND it is labeled as "Recommended"
- AND it includes an install link

#### Scenario: Existing README options remain intact

- GIVEN the updated `README.md`
- WHEN the user reads past the SaaS option
- THEN the GitHub Action, CLI, and Self-Hosted options are still present
- AND their content is unchanged (except for possible renumbering)

---

### R10 (P2): Docs Landing Page Orientation

The docs overview page (`docs/README.md`) MUST be updated with a "New here?" orientation section.

The section MUST:
1. Appear near the top, before or after "How It Works"
2. Direct new users to the appropriate guide based on their intended distribution mode
3. Recommend the SaaS guide as the default starting point

The section SHOULD:
1. Use a brief callout or table format
2. Link to: `saas-getting-started.md`, `quick-start.md`, `self-hosted.md`

#### Scenario: New user finds orientation on docs landing

- GIVEN a new user arriving at the docs site (`https://ghagga.javierzader.com/docs/`)
- WHEN the docs landing page renders
- THEN a "New here?" or "Start here" section is visible near the top
- AND it recommends the SaaS guide for most users
- AND it links to alternative guides for Action, CLI, and Self-Hosted

#### Scenario: Returning user is not blocked by orientation

- GIVEN a returning user who knows which docs page they need
- WHEN they visit the docs landing page
- THEN the orientation section is brief and non-intrusive (not a full-page modal or blocking element)
- AND the existing "Quick Links" section remains accessible

---

### R11 (P0): Fix Bug — Wrong CLI Package Name in `apps/cli/README.md`

All `npx @ghagga/cli` references in `apps/cli/README.md` MUST be changed to `npx ghagga`. All `npm install -g @ghagga/cli` references MUST be changed to `npm install -g ghagga`.

The published npm package name is `ghagga` (verified: `apps/cli/package.json` `"name": "ghagga"`). The `@ghagga/cli` scoped name does not exist and will cause `npm ERR! 404 Not Found` for every user who copies the example.

**Affected occurrences** (9 total in `apps/cli/README.md`):
- Line 6: `npx @ghagga/cli login`
- Line 7: `npx @ghagga/cli review`
- Line 27: `npx @ghagga/cli login`
- Line 36: `npx @ghagga/cli review`
- Line 39: `npx @ghagga/cli review --mode workflow`
- Line 42: `npx @ghagga/cli review --mode consensus`
- Line 45: `npx @ghagga/cli review --mode workflow --verbose`
- Line 51: `npx @ghagga/cli status`
- Line 52: `npx @ghagga/cli logout`
- Line 60: `npm install -g @ghagga/cli`

#### Scenario: User runs npx command from README

- GIVEN a user reading `apps/cli/README.md`
- WHEN the user copies and runs any `npx` command from the Quick Start section
- THEN the command MUST use `npx ghagga` (not `npx @ghagga/cli`)
- AND the command resolves to the published `ghagga` npm package
- AND the command executes successfully (assuming Node.js >= 20 is installed)

#### Scenario: User installs globally from README

- GIVEN a user reading the "Global Installation" section of `apps/cli/README.md`
- WHEN the user copies and runs the install command
- THEN the command MUST be `npm install -g ghagga`
- AND the `ghagga` binary is available in the user's PATH after installation

#### Scenario: No @ghagga/cli references remain

- GIVEN the updated `apps/cli/README.md`
- WHEN searching the file for the string `@ghagga/cli`
- THEN zero matches are found

---

### R12 (P0): Fix Bug — `--config` Inline JSON Example

The `--config` CLI flag expects a **file path**, not an inline JSON string. All documentation examples that pass inline JSON to `--config` MUST be corrected.

**Source code evidence** (`apps/cli/src/commands/review.ts` lines 166-177):
```typescript
function loadConfigFile(repoPath: string, configPath?: string): GhaggaConfig {
  const filePath = configPath
    ? resolve(configPath)
    : join(repoPath, '.ghagga.json');
  // ...
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as GhaggaConfig;
}
```

The function calls `resolve(configPath)` then `readFileSync(filePath)`. Passing `'{"reviewLevel": "strict"}'` as the path will cause `ENOENT: no such file or directory`.

**Affected locations**:
- `docs/cli.md` line 104: `ghagga review --mode workflow --config '{"reviewLevel": "strict"}'`
- `docs/configuration.md` line 107: `ghagga review --config '{"reviewLevel": "strict"}'`

Each MUST be replaced with a two-part example:
1. Show the `.ghagga.json` file content
2. Show the CLI command referencing the file path: `ghagga review --config .ghagga.json`

#### Scenario: User uses --config with file path

- GIVEN a user reading the config example in `docs/cli.md` or `docs/configuration.md`
- WHEN the user copies the `--config` example
- THEN the example shows `--config .ghagga.json` (a file path)
- AND a preceding code block shows the contents of `.ghagga.json`
- AND the example works when executed (given the file exists)

#### Scenario: No inline JSON in --config examples

- GIVEN all Markdown files in the repository
- WHEN searching for `--config '{"` or `--config "{`
- THEN zero matches are found

---

### R13 (P0): Fix Bug — Consensus Example Missing `provider: anthropic`

The consensus mode example in `docs/github-action.md` (lines 74-79) passes `api-key: ${{ secrets.ANTHROPIC_API_KEY }}` but omits `provider: anthropic`. The Action defaults to `provider: github`, so the Anthropic API key is ignored and the review either uses the GitHub token (wrong model) or fails.

**Source code evidence** (`apps/action/src/index.ts` lines 66-81):
```typescript
if (provider === 'github') {
  apiKey = apiKeyInput || githubToken;  // Ignores ANTHROPIC key
} else if (provider === 'ollama') {
  apiKey = apiKeyInput || 'ollama';
} else {
  apiKey = apiKeyInput;
  if (!apiKey) {
    core.setFailed(`API key is required for provider "${provider}".`);
  }
}
```

Without `provider: anthropic`, the Action uses `provider: github` (default) and ignores the `api-key` input entirely, falling back to `githubToken`.

The example MUST add `provider: anthropic`.

#### Scenario: User copies consensus example from Action guide

- GIVEN a user reading the "Consensus Mode for Security-Sensitive Code" example in `docs/github-action.md`
- WHEN the user copies the YAML workflow snippet
- THEN the snippet includes both `api-key: ${{ secrets.ANTHROPIC_API_KEY }}` and `provider: anthropic`
- AND the Action correctly uses Anthropic as the LLM provider

#### Scenario: All Action examples with non-github API keys include provider

- GIVEN all Action YAML examples in `docs/github-action.md`
- WHEN an example passes a non-GitHub API key (e.g., `secrets.ANTHROPIC_API_KEY`, `secrets.OPENAI_API_KEY`)
- THEN the example MUST also include the corresponding `provider` input
- AND no example relies on the default `github` provider while passing a third-party API key

---

### R14 (P0): GitHub Action Guide — Prerequisites Section

The `docs/github-action.md` guide MUST include a Prerequisites section at the top (after the title/introduction, before the step-by-step flow).

The Prerequisites section MUST list:
1. A **GitHub repository** (public or private)
2. **Write access** to the repository's `.github/workflows/` directory (or repo admin access)
3. Familiarity with the **pull request workflow** (the Action triggers on PR events)

The Prerequisites section SHOULD include:
- A "Not looking for the Action?" callout linking to alternative modes (SaaS, CLI, Self-Hosted)

#### Scenario: User checks prerequisites before starting

- GIVEN a user reading `docs/github-action.md`
- WHEN the user reads the Prerequisites section
- THEN the section lists the 3 required prerequisites
- AND the user can self-assess whether they can proceed

#### Scenario: User without repo admin access

- GIVEN a user who has read-only access to a GitHub repository
- WHEN the user reads the Prerequisites section
- THEN the requirement for write access to `.github/workflows/` is clearly stated
- AND the user understands they need to request access or use a different repo

---

### R15 (P0): GitHub Action Guide — Step-by-Step Getting Started Flow

The `docs/github-action.md` guide MUST include a numbered step-by-step getting started flow, modeled after `docs/saas-getting-started.md`.

The flow MUST include these steps in order:

**Step 1: Create the workflow file**
- MUST show the complete YAML content for `.github/workflows/review.yml`
- MUST explain each section (trigger, job, steps)
- MUST include a verification checkpoint: "You should now have a file at `.github/workflows/review.yml`"

**Step 2: Commit and push**
- MUST show the git commands to commit and push the workflow file
- MUST include a verification checkpoint: "In your GitHub repository, navigate to Actions tab — you should see the 'Code Review' workflow"

**Step 3: Open a Pull Request**
- MUST explain that the Action triggers on `pull_request` events
- MUST note: for first-time setup, the user needs to open a new PR (or push to an existing one) after the workflow is merged to the default branch
- MUST include a verification checkpoint: "The Actions tab should show a running workflow"

**Step 4: See the review**
- MUST describe what the PR comment looks like (status, findings, timing)
- MUST note first-run timing: ~3-5 minutes (tool installation), subsequent runs ~1-2 minutes
- MUST include a verification checkpoint: "A new comment from `github-actions[bot]` should appear on your PR"

#### Scenario: New user follows Action guide end-to-end

- GIVEN a user with a GitHub repository and write access
- WHEN the user follows `docs/github-action.md` from Step 1 through Step 4
- THEN the user receives an AI code review comment on their PR
- AND every step has a verification checkpoint ("you should now see...")

#### Scenario: User's first run takes longer than expected

- GIVEN a user who completed Steps 1-3 for the first time
- WHEN the Action runs for the first time
- THEN the guide explains that first-run takes ~3-5 minutes (tool installation)
- AND the guide explains that subsequent runs use cache and take ~1-2 minutes

#### Scenario: User merges workflow to non-default branch

- GIVEN a user who creates the workflow file on a feature branch
- WHEN the user opens a PR for that branch
- THEN the guide explains that the workflow runs on the PR itself (the workflow file is in the PR's head branch)

---

### R16 (P1): GitHub Action Guide — Troubleshooting Section

The `docs/github-action.md` guide MUST include a Troubleshooting section with at least 5 common issues.

The section MUST cover:

1. **"Resource not accessible by integration"** (token permissions)
   - Cause: `GITHUB_TOKEN` lacks write permission for PR comments
   - Fix: Add `permissions: pull-requests: write` to the workflow job, or check repo Settings → Actions → General → Workflow permissions

2. **"No review comment posted"**
   - Cause: PR has no file changes (empty diff), or Action was skipped
   - Fix: Ensure the PR has at least one file change; check the `status` output

3. **"First run takes 3-5 minutes"**
   - Cause: Static analysis tools (Semgrep, Trivy, CPD) are being installed for the first time
   - Expected behavior: subsequent runs use `@actions/cache` and take ~1-2 minutes

4. **"Action doesn't trigger"**
   - Cause: Wrong trigger event (e.g., `push` instead of `pull_request`)
   - Fix: Use `on: pull_request: types: [opened, synchronize, reopened]`

5. **"CI check fails with FAILED status"**
   - Cause: The Action calls `core.setFailed()` when review status is FAILED
   - This is intentional: it signals that the review found critical issues
   - Workaround: Add `continue-on-error: true` to the step if you want advisory-only reviews

Each troubleshooting item MUST include: symptom (what the user sees), cause, and fix/workaround.

#### Scenario: User sees "Resource not accessible by integration"

- GIVEN a user whose workflow runs but the Action fails with a permissions error
- WHEN the user consults the Troubleshooting section
- THEN the section describes the symptom, cause (missing `pull-requests: write`), and fix
- AND the fix includes the exact YAML to add (`permissions:`)

#### Scenario: User's CI fails unexpectedly due to FAILED review status

- GIVEN a user whose PR check status shows "failed" after a GHAGGA review
- WHEN the user consults the Troubleshooting section
- THEN the section explains that `core.setFailed()` is called for FAILED reviews
- AND the section shows the `continue-on-error: true` workaround with a YAML example

#### Scenario: User's Action doesn't trigger at all

- GIVEN a user whose workflow was committed but the Action never runs
- WHEN the user consults the Troubleshooting section
- THEN the section lists common trigger misconfiguration (wrong event, wrong branch filter)
- AND provides the correct `on: pull_request` configuration

---

### R17 (P1): GitHub Action Guide — FAILED Status / `core.setFailed()` Documentation

The `docs/github-action.md` guide MUST document the behavior of the `FAILED` review status in the context of CI checks.

The documentation MUST state:
1. When the review pipeline returns `status: FAILED`, the Action calls `core.setFailed()` (source: `apps/action/src/index.ts` line 188-193)
2. This causes the GitHub Actions check to show as **failed** (red X), which may block merging if branch protection rules require passing checks
3. This is intentional behavior — `FAILED` means the review found critical issues

The documentation MUST show the `continue-on-error: true` workaround:
```yaml
- uses: JNZader/ghagga@v2
  id: review
  continue-on-error: true  # Don't fail CI on review findings
```

The documentation SHOULD explain the two usage patterns:
- **Blocking** (default): review failures block merging — for teams that want strict enforcement
- **Advisory** (`continue-on-error: true`): review findings are informational — for teams adopting gradually

#### Scenario: User configures advisory-only reviews

- GIVEN a user who wants GHAGGA reviews as informational (non-blocking)
- WHEN the user reads the FAILED status documentation
- THEN the documentation shows the `continue-on-error: true` workaround
- AND explains that this allows the PR check to pass regardless of review status

#### Scenario: User configures blocking reviews

- GIVEN a user who wants review failures to block merging
- WHEN the user reads the FAILED status documentation
- THEN the documentation confirms this is the default behavior
- AND explains how branch protection rules interact with the FAILED status

---

### R18 (P1): GitHub Action Guide — Cost Clarity, Expected Output, Diagram, Next Steps

The `docs/github-action.md` guide MUST include:

**Cost section:**
- GitHub Actions minutes: free unlimited for public repos; private repos get 2,000 free minutes/month (then paid)
- GitHub Models LLM: free (default provider, no API key needed)
- Other providers: BYOK — user pays provider directly

**"What to expect" section:**
- Description of the PR comment format: status emoji, summary, findings list with severity/file/line, static analysis results
- Approximate timing: first run ~3-5 min, subsequent ~1-2 min

**Mermaid flow diagram:**
- MUST show the flow: PR event → Action triggers → checkout code → run static analysis → call LLM → post PR comment
- MUST use `mermaid` fenced code block syntax

**Next Steps section:**
- MUST link to: CLI guide, configuration guide, review modes documentation
- SHOULD link to: self-hosted guide for users who need more control

**`.ghagga.json` NOT supported note:**
- MUST state that the Action does NOT read `.ghagga.json` config files
- MUST state that all configuration is via Action inputs (in the workflow YAML)

#### Scenario: User wants to know if the Action is free

- GIVEN a user evaluating the GitHub Action
- WHEN the user reads the Cost section
- THEN the section states: free for public repos (unlimited minutes), free GitHub Models LLM
- AND for private repos: 2,000 free min/month, then paid by GitHub
- AND other LLM providers require the user's own API key

#### Scenario: User looks for a flow diagram

- GIVEN a user wanting to understand how the Action works
- WHEN the user reads the "How It Works" section
- THEN a Mermaid diagram visualizes the flow from PR event to posted comment

#### Scenario: User expects .ghagga.json to work in Action mode

- GIVEN a user who uses `.ghagga.json` with the CLI
- WHEN the user reads the Action guide
- THEN the guide explicitly states that `.ghagga.json` is not supported in Action mode
- AND all configuration is done via Action inputs in the workflow YAML

---

### R19 (P0): CLI Guide — Prerequisites Section

The `docs/cli.md` guide MUST include a Prerequisites section at the top (after the title/introduction, before the step-by-step flow).

The Prerequisites section MUST list:
1. **Node.js >= 20** (verified: `apps/cli/package.json` `"engines": { "node": ">=20.0.0" }`)
2. **Git** (required for `git diff` computation)
3. **A GitHub account** (required for `ghagga login` and free GitHub Models access)

The Prerequisites section SHOULD:
- Note that `docs/quick-start.md` says "Node.js 22+" but `package.json` says ">=20.0.0" — the spec MUST use the `package.json` value (>=20) as the source of truth
- Include a "Not looking for the CLI?" callout linking to alternative modes

#### Scenario: User checks prerequisites before installing

- GIVEN a user reading `docs/cli.md`
- WHEN the user reads the Prerequisites section
- THEN the section lists Node.js >= 20, Git, and a GitHub account
- AND the user can self-assess whether they can proceed

#### Scenario: User has Node.js 18

- GIVEN a user with Node.js 18 installed
- WHEN the user reads the Prerequisites section
- THEN the requirement for Node.js >= 20 is clearly stated
- AND the user understands they need to upgrade before proceeding

---

### R20 (P0): CLI Guide — Step-by-Step Getting Started Flow

The `docs/cli.md` guide MUST include a numbered step-by-step getting started flow.

**Step 1: Install**
- MUST show both `npm install -g ghagga` and `npx ghagga` options
- MUST include a verification checkpoint: `ghagga --version` or `npx ghagga --version`

**Step 2: Login**
- MUST show `ghagga login`
- MUST explain the GitHub Device Flow (code + browser authorization)
- MUST explain that this stores the token at `~/.config/ghagga/config.json`
- MUST include a verification checkpoint: `ghagga status` shows "Logged in"

**Step 3: Review your code**
- MUST show `ghagga review` (simplest case)
- MUST note that staged or uncommitted changes are required (otherwise "No changes detected")
- MUST include a verification checkpoint: review output appears in terminal

**Step 4: Explore options**
- MUST show at least 3 example variations (workflow mode, JSON output, verbose)
- SHOULD link to the full options reference below

#### Scenario: New user follows CLI guide end-to-end

- GIVEN a user with Node.js >= 20, Git, and a GitHub account
- WHEN the user follows `docs/cli.md` from Step 1 through Step 4
- THEN the user sees an AI code review in their terminal
- AND every step has a verification checkpoint

#### Scenario: User has no staged changes

- GIVEN a user who installed and logged in but has no staged/uncommitted changes
- WHEN the user runs `ghagga review`
- THEN the guide explains that the CLI shows "No changes detected"
- AND the guide suggests: stage some changes with `git add` or make uncommitted edits

---

### R21 (P1): CLI Guide — Document All 4 Commands

The `docs/cli.md` guide MUST document all 4 CLI commands: `login`, `logout`, `status`, `review`.

Currently only `review` is detailed. The other 3 commands MUST each have:
- **Description**: what the command does
- **Usage**: command syntax
- **Behavior**: what happens when you run it

**`login`:**
- Authenticates with GitHub using Device Flow
- Stores token at `~/.config/ghagga/config.json` (XDG Base Directory)
- Grants free access to GitHub Models LLM

**`logout`:**
- Clears stored credentials from `~/.config/ghagga/config.json`
- Source: `clearConfig()` in `apps/cli/src/lib/config.ts` calls `saveConfig({})`

**`status`:**
- Shows current auth status (logged in/out, username)
- Shows config file path
- Shows default provider and model
- Source: `apps/cli/src/commands/status.ts`

**`review`:**
- Already documented; MUST retain all existing documentation
- MUST add documentation for the `[path]` positional argument (defaults to `.`)

#### Scenario: User checks authentication status

- GIVEN a user who has run `ghagga login`
- WHEN the user reads the `status` command documentation and runs `ghagga status`
- THEN the documentation describes the expected output: config path, auth status, provider, model

#### Scenario: User wants to clear credentials

- GIVEN a user who wants to remove stored credentials
- WHEN the user reads the `logout` command documentation
- THEN the documentation explains that `ghagga logout` clears `~/.config/ghagga/config.json`

#### Scenario: User reviews a specific directory

- GIVEN a user who wants to review changes in a subdirectory
- WHEN the user reads the `review` command documentation
- THEN the `[path]` positional argument is documented with default value `.`
- AND the user can run `ghagga review ./src` to review only `./src`

---

### R22 (P1): CLI Guide — Troubleshooting Section

The `docs/cli.md` guide MUST include a Troubleshooting section with at least 6 common issues.

1. **"command not found: ghagga"**
   - Cause: npm global bin directory not in PATH, or not installed
   - Fix: use `npx ghagga` instead, or check `npm config get prefix` and add to PATH

2. **"No API key available for provider 'github'"** or "Authentication required"
   - Cause: not logged in
   - Fix: run `ghagga login`

3. **"No changes detected"**
   - Cause: no staged or uncommitted changes in the working tree
   - Fix: make some code changes or stage with `git add`

4. **"Could not get git diff"** or "Not a git repository"
   - Cause: running `ghagga review` outside a git repository
   - Fix: navigate to a git repository root

5. **Static analysis tools silently skipped**
   - Cause: Semgrep/Trivy/CPD not installed locally
   - Expected behavior: tools are skipped silently, review still works (LLM-only)
   - Fix: install tools with `brew install semgrep trivy pmd` (or equivalent)

6. **Login fails / device flow timeout**
   - Cause: browser didn't open, or user didn't authorize in time
   - Fix: manually navigate to the URL shown, enter the code; retry with `ghagga login`

Each troubleshooting item MUST include: symptom, cause, and fix.

#### Scenario: User sees "command not found"

- GIVEN a user who installed `ghagga` globally but `ghagga` is not found
- WHEN the user consults the Troubleshooting section
- THEN the section explains the PATH issue and suggests `npx ghagga` as workaround

#### Scenario: User sees "No changes detected"

- GIVEN a user who runs `ghagga review` in a clean working tree
- WHEN the user consults the Troubleshooting section
- THEN the section explains that staged or uncommitted changes are required
- AND suggests `git add` or making edits

#### Scenario: User wonders why Semgrep isn't running

- GIVEN a user who doesn't have Semgrep installed locally
- WHEN the user runs `ghagga review` and sees no static analysis findings
- THEN the Troubleshooting section explains that tools are silently skipped if not installed
- AND shows how to install them

---

### R23 (P1): CLI Guide — Config Details, Example Output, Environment Variables

The `docs/cli.md` guide MUST include:

**Config storage location:**
- Auth credentials stored at `~/.config/ghagga/config.json` (or `$XDG_CONFIG_HOME/ghagga/config.json`)
- Source: `apps/cli/src/lib/config.ts` lines 30-34

**`[path]` positional argument:**
- MUST document that `ghagga review [path]` accepts an optional path (default: `.`)
- Source: `apps/cli/src/index.ts` line 79: `.argument('[path]', 'Path to the repository', '.')`

**`--verbose` behavior:**
- MUST describe that `--verbose` / `-v` shows real-time progress of each pipeline step
- SHOULD show example verbose output

**`GITHUB_TOKEN` env var fallback:**
- MUST document that if `provider` is `github` and no `--api-key` is provided, the CLI falls back to `GITHUB_TOKEN` env var, then stored token
- Source: `apps/cli/src/index.ts` lines 124-129

**Environment variables priority:**
- MUST document the full resolution chain: CLI flag > env var (`GHAGGA_PROVIDER`, `GHAGGA_MODEL`, `GHAGGA_API_KEY`) > stored config > defaults

**Example output:**
- MUST show an example of markdown format output (the default terminal output)
- MUST show an example of JSON format output (`--format json`)
- Examples SHOULD be realistic (show status, findings, timing)

#### Scenario: User wants to see JSON output

- GIVEN a user reading the example output section
- WHEN the user looks for JSON format documentation
- THEN a complete JSON output example is shown
- AND the user can pipe it to `jq` or other tools

#### Scenario: User wants to use GITHUB_TOKEN instead of login

- GIVEN a CI/CD environment where `GITHUB_TOKEN` is already set
- WHEN the user reads the environment variables documentation
- THEN the documentation explains that `GITHUB_TOKEN` is used as fallback for the `github` provider
- AND the user can skip `ghagga login` in CI by setting `GITHUB_TOKEN`

#### Scenario: User wants to know where credentials are stored

- GIVEN a security-conscious user
- WHEN the user reads the config documentation
- THEN the exact path `~/.config/ghagga/config.json` is documented
- AND the XDG Base Directory override is mentioned

---

### R24 (P1): CLI Guide — Cost Clarity, Mermaid Diagram, Next Steps

The `docs/cli.md` guide MUST include:

**Cost section:**
- GitHub Models: free (default, requires `ghagga login`)
- Ollama: free (local, 100% offline, no API key)
- Other providers: BYOK — user pays provider directly
- Static analysis: free (local tool execution, no cloud calls)

**Mermaid flow diagram:**
- MUST show: `ghagga review` → compute git diff → run static analysis (if tools installed) → send to LLM → format output → display in terminal
- MUST use `mermaid` fenced code block syntax

**Next Steps section:**
- MUST link to: GitHub Action guide, configuration guide, review modes documentation
- SHOULD link to: BYOK providers, Ollama setup

#### Scenario: User wants to know CLI cost

- GIVEN a user evaluating the CLI
- WHEN the user reads the Cost section
- THEN the section states: free with GitHub Models, free with Ollama (local)
- AND other providers require the user's own API key

#### Scenario: User wants to understand CLI flow

- GIVEN a user wanting to understand how the CLI works
- WHEN the user reads the diagram section
- THEN a Mermaid diagram visualizes the flow from `ghagga review` to terminal output

---

### R25 (P1): CLI README — Fix Missing Providers in Options

The `apps/cli/README.md` Options section (lines 69-83) MUST list all 6 supported providers.

Currently the Options text shows:
```
-p, --provider <provider>  LLM provider: github, openai, anthropic, google
```

Missing: `ollama` and `qwen`.

MUST be updated to:
```
-p, --provider <provider>  LLM provider: github, anthropic, openai, google, ollama, qwen
```

This matches the BYOK section below it (which already lists ollama) and the `docs/cli.md` options table.

#### Scenario: User looks for Ollama in Options section

- GIVEN a user reading the Options section of `apps/cli/README.md`
- WHEN the user looks for the `--provider` option
- THEN `ollama` and `qwen` are listed among the supported providers

---

## Cross-Cutting Concerns

### CC1: Link Integrity

All new and modified Markdown files MUST NOT introduce broken links. Every `[text](url)` link MUST resolve to an existing file (for relative links) or a valid URL (for absolute links).

#### Scenario: No broken internal links

- GIVEN all Markdown files in `docs/`
- WHEN all `[text](relative-path.md)` links are resolved
- THEN every linked file exists in the `docs/` directory

#### Scenario: No broken external links

- GIVEN all Markdown files in `docs/` and `README.md`
- WHEN all `[text](https://...)` links are checked
- THEN every URL returns a 2xx or 3xx HTTP status (allowing for GitHub rate limits)

### CC2: Docsify Compatibility

All new Markdown files MUST render correctly in Docsify (the docs site engine).

The files MUST:
1. Use standard Markdown syntax compatible with Docsify's Markdown-it parser
2. Use Docsify's `>` blockquote syntax for callouts (no custom Docsify plugins required)
3. Not require any new Docsify plugins or configuration changes to `docs/index.html`

#### Scenario: New SaaS guide renders in Docsify

- GIVEN the file `docs/saas-getting-started.md`
- WHEN loaded via the Docsify documentation site
- THEN all headings, tables, code blocks, blockquotes, and links render correctly
- AND the sidebar correctly navigates to the page

### CC3: Consistency Across Documents

Information that appears in multiple documents (post-install warning, cost model, decision matrix) MUST be consistent.

Where the same concept appears in abbreviated form (e.g., README vs full guide), the abbreviated version MUST NOT contradict the detailed version.

#### Scenario: Post-install warning is consistent

- GIVEN the post-install warning text in `saas-getting-started.md`, `quick-start.md`, and `README.md`
- WHEN comparing the core message across all three
- THEN all three convey the same information: reviews require LLM configuration after install
- AND all three link to the Dashboard

#### Scenario: Cost information is consistent

- GIVEN cost/pricing statements in `saas-getting-started.md`, `landing/index.html`, and `quick-start.md`
- WHEN comparing the core facts
- THEN all documents agree on: GHAGGA is free, GitHub Models is free, other providers are BYOK

### CC4: Bug-Free Code Examples

All code examples across ALL documentation files MUST be executable without errors when copied verbatim (given the documented prerequisites are met).

**Specific prohibitions:**
- MUST NOT contain `@ghagga/cli` as a package name (correct: `ghagga`)
- MUST NOT pass inline JSON to `--config` (correct: pass a file path)
- MUST NOT pass a provider-specific API key without the corresponding `provider` input
- MUST NOT list providers that don't exist, or omit providers that do exist

#### Scenario: All CLI examples use correct package name

- GIVEN all Markdown files in the repository
- WHEN searching for `@ghagga/cli`
- THEN zero matches are found (excluding changelogs and the openspec change folder itself)

#### Scenario: All --config examples use file paths

- GIVEN all Markdown files in the repository
- WHEN searching for `--config` followed by a JSON string literal
- THEN zero matches are found

#### Scenario: All Action examples have matching provider and api-key

- GIVEN all Action YAML examples in documentation
- WHEN an example includes a non-GitHub `api-key`
- THEN the corresponding `provider` input is explicitly set

### CC5: Structural Quality Standard

Both the `docs/github-action.md` and `docs/cli.md` guides MUST follow the same structural quality standard as `docs/saas-getting-started.md`:

1. Prerequisites section
2. Numbered step-by-step flow with verification checkpoints
3. Mermaid flow diagram
4. Reference tables (inputs/options)
5. Troubleshooting section (4+ scenarios)
6. Cost clarity section
7. Example output or "What to expect" section
8. Next Steps links

Each guide SHOULD be between 200-350 lines (matching the range of existing quality guides: SaaS at 220, Self-Hosted at 424).

#### Scenario: GitHub Action guide matches quality standard

- GIVEN the updated `docs/github-action.md`
- WHEN evaluating against the quality checklist (8 items above)
- THEN all 8 structural elements are present

#### Scenario: CLI guide matches quality standard

- GIVEN the updated `docs/cli.md`
- WHEN evaluating against the quality checklist (8 items above)
- THEN all 8 structural elements are present

### CC1 (Extended): Link Integrity — Action and CLI Guides

All links in modified files MUST be valid. In particular:
- `docs/github-action.md` MUST link to `cli.md`, `configuration.md`, `saas-getting-started.md`
- `docs/cli.md` MUST link to `github-action.md`, `configuration.md`, `saas-getting-started.md`
- `apps/cli/README.md` MUST link to the GitHub repository and documentation site

#### Scenario: Cross-links between Action and CLI guides

- GIVEN the updated `docs/github-action.md` and `docs/cli.md`
- WHEN following links between them
- THEN `github-action.md` links to `cli.md` and vice versa
- AND all links resolve to existing files

---

## Acceptance Criteria Summary

| ID | Priority | Requirement | Acceptance Criteria |
|----|----------|-------------|-------------------|
| R1 | P0 | SaaS Getting Started Guide | New user follows guide from install to first review without consulting other pages |
| R2 | P0 | Post-Install Warning | Warning appears in 3 documents (saas guide, quick-start, README) with Dashboard link |
| R3 | P0 | Dashboard URL Linkification | Zero occurrences of unlinked "Open the Dashboard" in docs |
| R4 | P1 | Landing Page Install CTA | "Install GitHub App" is the primary (most prominent) CTA button |
| R5 | P1 | Choose Your Path Matrix | Decision matrix at top of quick-start with SaaS as only "Recommended" mode |
| R6 | P1 | Sidebar Navigation | SaaS guide appears in first 4 items of sidebar Getting Started section |
| R7 | P2 | Cost Transparency | Free/paid model clearly stated in SaaS guide, landing page, Action guide, and CLI guide |
| R8 | P2 | Configuration Callout | SaaS callout with Dashboard link at top of configuration.md |
| R9 | P2 | README SaaS Option | SaaS listed as first (Option 0) in README Quick Start |
| R10 | P2 | Docs Landing Orientation | "New here?" section on docs README with guide links |
| R11 | P0 | Fix `@ghagga/cli` package name | Zero `@ghagga/cli` references in `apps/cli/README.md` |
| R12 | P0 | Fix `--config` inline JSON | Zero `--config '{"...'` patterns in any doc file |
| R13 | P0 | Fix consensus missing provider | All Action examples with non-GitHub API keys include `provider` |
| R14 | P0 | Action prerequisites | Prerequisites section with 3 items at top of guide |
| R15 | P0 | Action step-by-step flow | 4 numbered steps with verification checkpoints |
| R16 | P1 | Action troubleshooting | 5+ troubleshooting scenarios with symptom/cause/fix |
| R17 | P1 | Action FAILED status docs | `core.setFailed()` behavior documented, `continue-on-error` shown |
| R18 | P1 | Action cost/output/diagram/next | Cost section, Mermaid diagram, expected output, Next Steps |
| R19 | P0 | CLI prerequisites | Prerequisites with Node.js >=20, Git, GitHub account |
| R20 | P0 | CLI step-by-step flow | 4 numbered steps with verification checkpoints |
| R21 | P1 | CLI all 4 commands | `login`, `logout`, `status`, `review` each documented |
| R22 | P1 | CLI troubleshooting | 6+ troubleshooting scenarios with symptom/cause/fix |
| R23 | P1 | CLI config/output/env vars | Config path, `[path]` arg, example output, env var docs |
| R24 | P1 | CLI cost/diagram/next | Cost section, Mermaid diagram, Next Steps |
| R25 | P1 | CLI README missing providers | `ollama` and `qwen` in Options section |
| CC1 | — | Link Integrity | Zero broken links across all modified files |
| CC1-ext | — | Link Integrity (Action/CLI) | Cross-links between Action and CLI guides valid |
| CC2 | — | Docsify Compatibility | All new files render correctly in Docsify |
| CC3 | — | Consistency | Post-install warning and cost info are consistent across all documents |
| CC4 | — | Bug-Free Code Examples | Zero broken examples across all docs |
| CC5 | — | Structural Quality | Both Action and CLI guides have all 8 quality elements |
