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
4. **Step 2: Open the Dashboard** — MUST include the Dashboard URL (`https://jnzader.github.io/ghagga/app/`) as a clickable link. MUST describe the GitHub OAuth Device Flow login process.
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

Every textual reference to "Open the Dashboard" or "the Dashboard" in the documentation MUST include a clickable hyperlink to `https://jnzader.github.io/ghagga/app/`.

Files that MUST be updated:
- `docs/quick-start.md` — line 66 ("Open the Dashboard")
- `docs/runner-architecture.md` — line 22 ("Open the Dashboard")
- `docs/configuration.md` — any Dashboard reference in the new SaaS callout

The new `docs/saas-getting-started.md` MUST use the linked Dashboard URL in all references.

Within `landing/index.html`, the Dashboard link SHOULD use the relative path `app/` (already present, no change needed for the existing link).

#### Scenario: User clicks Dashboard link in quick-start

- GIVEN a user reading `docs/quick-start.md`
- WHEN the user encounters the text "Open the Dashboard"
- THEN the text is a clickable hyperlink to `https://jnzader.github.io/ghagga/app/`

#### Scenario: User clicks Dashboard link in runner-architecture

- GIVEN a user reading `docs/runner-architecture.md`
- WHEN the user encounters the text "Open the Dashboard"
- THEN the text is a clickable hyperlink to `https://jnzader.github.io/ghagga/app/`

#### Scenario: Dashboard URL consistency across all docs

- GIVEN all Markdown files in the `docs/` directory
- WHEN any file contains the phrase "Open the Dashboard" or "the Dashboard" as a navigation instruction
- THEN the phrase MUST be a Markdown link pointing to `https://jnzader.github.io/ghagga/app/`
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

- GIVEN a visitor arriving at the GHAGGA landing page (`https://jnzader.github.io/ghagga/`)
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

---

### R8 (P2): Configuration Page SaaS Callout

A callout MUST be added to the top of `docs/configuration.md` (before the Environment Variables section) that directs SaaS users to the Dashboard.

The callout MUST:
1. State that SaaS users configure everything in the Dashboard, not via environment variables
2. Include a clickable link to the Dashboard (`https://jnzader.github.io/ghagga/app/`)
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

- GIVEN a new user arriving at the docs site (`https://jnzader.github.io/ghagga/docs/`)
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

---

## Acceptance Criteria Summary

| ID  | Requirement                 | Acceptance Criteria                                                                  |
| --- | --------------------------- | ------------------------------------------------------------------------------------ |
| R1  | SaaS Getting Started Guide  | New user follows guide from install to first review without consulting other pages   |
| R2  | Post-Install Warning        | Warning appears in 3 documents (saas guide, quick-start, README) with Dashboard link |
| R3  | Dashboard URL Linkification | Zero occurrences of unlinked "Open the Dashboard" in docs                            |
| R4  | Landing Page Install CTA    | "Install GitHub App" is the primary (most prominent) CTA button                      |
| R5  | Choose Your Path Matrix     | Decision matrix at top of quick-start with SaaS marked as recommended                |
| R6  | Sidebar Navigation          | SaaS guide appears in first 4 items of sidebar Getting Started section               |
| R7  | Cost Transparency           | Free/paid model clearly stated in SaaS guide and landing page                        |
| R8  | Configuration Callout       | SaaS callout with Dashboard link at top of configuration.md                          |
| R9  | README SaaS Option          | SaaS listed as first (Option 0) in README Quick Start                                |
| R10 | Docs Landing Orientation    | "New here?" section on docs README with guide links                                  |
| CC1 | Link Integrity              | Zero broken links across all modified files                                          |
| CC2 | Docsify Compatibility       | All new files render correctly in Docsify                                            |
| CC3 | Consistency                 | Post-install warning and cost info are consistent across all documents               |
