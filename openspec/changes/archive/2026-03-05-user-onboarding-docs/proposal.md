# Proposal: User Onboarding Documentation Overhaul

> **Status**: ARCHIVED
> **Archived date**: 2026-03-05
> **Verification**: PASS WITH WARNINGS (all warnings non-critical)
>
> **Commits**:
> - `046944a` — docs(sdd): add user-onboarding-docs change artifacts
> - `302d189` — docs(onboarding): add SaaS getting started guide and onboarding overhaul
> - `3e00003` — docs(sdd): archive auto-runner-creation change

> **Files created** (1): `docs/saas-getting-started.md`
> **Files modified** (7): `README.md`, `docs/quick-start.md`, `docs/_sidebar.md`, `docs/README.md`, `docs/configuration.md`, `docs/runner-architecture.md`, `landing/index.html`

## Intent

The SaaS GitHub App is GHAGGA's primary distribution mode — the lowest-friction path for most users. Yet the self-hosted guide has 424 lines of step-by-step instructions while the SaaS path has **zero** dedicated getting-started documentation. A first-time user who installs the GitHub App today lands in a dead end: no guide tells them what to configure, the Dashboard URL isn't linked where it's referenced, the landing page has no "Install App" CTA, and the cost model (free by default!) is never clearly stated.

This change creates the missing SaaS onboarding flow, restructures the existing docs around a "choose your path" model, and updates the landing page to convert visitors into installers — so that a new user can go from zero to their first AI code review in under 5 minutes.

## Scope

### In Scope

1. **New `docs/saas-getting-started.md`** — THE definitive step-by-step SaaS guide (Install App → Dashboard → Configure LLM → Enable Runner → Open PR → Get Review)
2. **Landing page overhaul** (`landing/index.html`) — "Install GitHub App" primary CTA, "How to Get Started" visual steps, pricing/cost transparency section
3. **Quick Start restructure** (`docs/quick-start.md`) — "Choose your path" decision matrix with SaaS as the recommended default, post-install warning callout
4. **Sidebar update** (`docs/_sidebar.md`) — Add `saas-getting-started` prominently in Getting Started section
5. **Docs overview update** (`docs/README.md`) — "Start here" orientation for new users with path selection
6. **README update** (`README.md`) — Add "Option 0: SaaS/GitHub App" before current options, App install link
7. **Dashboard URL linkification** — Make every mention of "Open the Dashboard" a clickable link across `docs/runner-architecture.md`, `docs/quick-start.md`, and any other references
8. **Configuration callout** (`docs/configuration.md`) — Add "SaaS users: configure via Dashboard, not env vars" callout at the top
9. **Cost/pricing clarity** — Document free vs paid across SaaS guide, landing page, and quick-start (GHAGGA is free + open source; GitHub Models is free; other providers are BYOK)

### Out of Scope

- **Video tutorials or animated GIFs** — text + screenshots are sufficient for v1; video can follow later
- **Interactive onboarding wizard** in Dashboard — a separate engineering change, not a docs change
- **GitHub Action or CLI guide rewrites** — these paths are already well-documented; only cross-references and the decision matrix touch them
- **Self-hosted guide changes** — `docs/self-hosted.md` is comprehensive; no changes needed
- **New Dashboard features** (e.g., post-install wizard, setup progress indicator) — separate proposal
- **Internationalization** — English only for now

## Approach

### Strategy: Documentation-as-Funnel

Model the documentation structure as a conversion funnel:

```
Landing Page  →  Choose Your Path  →  SaaS Guide  →  First Review
(visitor)        (quick-start)        (step-by-step)   (success!)
     ↓                ↓                    ↓
  Install CTA    Decision Matrix    Post-install Warning
                                    + Dashboard Link
```

### Execution Plan

1. **Write `saas-getting-started.md` first** — this is the critical missing piece. Model the quality and structure after `self-hosted.md` (step-by-step with prerequisites, verification steps, troubleshooting). The guide covers:
   - Prerequisites (GitHub account, a repo with a PR or ability to create one)
   - Step 1: Install the GitHub App (with actual install URL)
   - Step 2: Open the Dashboard and log in with GitHub
   - Step 3: Configure your LLM provider (default: GitHub Models = free, or BYOK)
   - Step 4: Enable the Runner (optional — for static analysis)
   - Step 5: Open a PR and get your first review
   - What to expect (timing, what the comment looks like)
   - Troubleshooting (no review posted? check LLM config; empty review? check runner)
   - "What happens without config" warning box

2. **Restructure `quick-start.md`** — Replace the current "GitHub Action (Recommended)" header with a decision matrix:

   | If you want...                 | Use this              | Time to first review | Requires           |
   | ------------------------------ | --------------------- | -------------------- | ------------------ |
   | Easiest setup — install and go | **SaaS (GitHub App)** | ~5 min               | GitHub account     |
   | CI/CD integration — no server  | **GitHub Action**     | ~10 min              | Repo admin access  |
   | Local review — no cloud        | **CLI**               | ~5 min               | Node.js 22+        |
   | Full control — self-hosted     | **Docker**            | ~30 min              | Docker, PostgreSQL |

3. **Update landing page** — Add "Install GitHub App" as primary CTA (purple button), move "Documentation" to secondary. Add a "How to Get Started" 3-step visual below the hero. Add a "Free & Open Source" section clarifying the cost model.

4. **Link all Dashboard references** — Find every "Open the Dashboard" text and make it `[Open the Dashboard](https://jnzader.github.io/ghagga/app/)`.

5. **Update sidebar, README, docs/README.md** — Add SaaS guide links and "Start here" orientation.

6. **Add SaaS callout to configuration.md** — Callout box at the top: "Using SaaS? Configure everything in the [Dashboard](https://jnzader.github.io/ghagga/app/) → Settings. Environment variables below are for self-hosted deployments only."

## Affected Areas

| Area                           | Impact   | Description                                                    |
| ------------------------------ | -------- | -------------------------------------------------------------- |
| `docs/saas-getting-started.md` | **New**  | Definitive SaaS getting-started guide (~150-200 lines)         |
| `docs/quick-start.md`          | Modified | Add decision matrix, post-install warning, SaaS as recommended |
| `docs/_sidebar.md`             | Modified | Add SaaS guide link in Getting Started section                 |
| `docs/README.md`               | Modified | Add "Start here" section with path selection                   |
| `docs/configuration.md`        | Modified | Add SaaS callout at top                                        |
| `docs/runner-architecture.md`  | Modified | Linkify Dashboard URL                                          |
| `landing/index.html`           | Modified | Add Install CTA, getting-started steps, pricing section        |
| `README.md`                    | Modified | Add Option 0 (SaaS), install link, reorder options             |

## Risks

| Risk                                                       | Likelihood | Mitigation                                                                                                                                               |
| ---------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App install URL is wrong or changes                 | Medium     | Verify URL from actual GitHub App settings before publishing; use the canonical format `https://github.com/apps/{app-slug}/installations/new`            |
| SaaS backend is down and new users follow the guide        | Low        | Add a note about checking [GitHub status](https://github.com/JNZader/ghagga) for known issues; the guide itself is static docs so it's always accessible |
| Landing page layout breaks on mobile after adding sections | Medium     | Test responsive breakpoints; all new sections must use the existing responsive CSS patterns                                                              |
| Inconsistency between README and docs descriptions         | Low        | Write docs first, then copy relevant sections to README to ensure single source of truth                                                                 |
| Dashboard URL or App URL changes in the future             | Low        | Use relative links where possible (e.g., `app/` instead of full URL in landing page); document the canonical URLs in one place                           |
| Existing quick-start links break                           | Low        | Keep the same filename `quick-start.md`; only restructure content, don't rename or remove anchors                                                        |

## Rollback Plan

All changes are documentation-only (Markdown files + static HTML). Rollback is trivial:
1. `git revert <commit>` to undo all changes in a single commit
2. No database migrations, no API changes, no configuration changes
3. The landing page is static HTML on GitHub Pages — revert deploys automatically on push to main
4. Docs site (Docsify) regenerates from Markdown files — no build step to worry about

If a partial rollback is needed (e.g., landing page change is good but SaaS guide needs revision), individual files can be reverted independently since changes are scoped per file.

## Dependencies

- **GitHub App install URL** — Must be verified from the actual GitHub App settings. Expected format: `https://github.com/apps/ghagga-review/installations/new` (the slug `ghagga-review` needs confirmation)
- **Dashboard is deployed and functional** — The SaaS guide directs users to `https://jnzader.github.io/ghagga/app/`; this must be live and working
- **Backend (SaaS) is running** — The guide assumes the Render-deployed backend is accepting webhooks. If the backend is down, the guide is technically accurate but the user can't complete the flow
- **No concurrent docs restructuring** — If other changes are modifying the same files (sidebar, README), merge conflicts are possible but manageable

## Success Criteria

- [ ] A new user can follow `docs/saas-getting-started.md` from GitHub App install to their first review without getting stuck or needing to consult other pages
- [ ] Landing page has "Install GitHub App" as the primary CTA (most prominent button)
- [ ] `docs/quick-start.md` has a "Choose your path" decision matrix with SaaS as the recommended default
- [ ] Dashboard URL (`https://jnzader.github.io/ghagga/app/`) is a clickable link everywhere it's referenced in docs
- [ ] Pricing/cost model is clearly documented: GHAGGA is free & open source; GitHub Models is free (no API key); other providers are BYOK
- [ ] `docs/_sidebar.md` has the SaaS guide prominently placed in the Getting Started section
- [ ] `README.md` lists SaaS/GitHub App as Option 0 (before GitHub Action, CLI, and Self-Hosted)
- [ ] `docs/configuration.md` has a callout directing SaaS users to the Dashboard instead of env vars
- [ ] All new and modified docs are consistent with current architecture (runner auto-creation via Dashboard, 3 distribution modes)
- [ ] No broken links introduced by the changes
