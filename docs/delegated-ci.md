# Delegated CI Configuration Guide

> **What is Delegated CI?** It allows GHAGGA to run safe CI jobs (lint, tests) on your Pull Requests without requiring you to set up GitHub Actions workflows in your repository.

## Why Use Delegated CI?

| Without Delegated CI | With Delegated CI |
|----------------------|-------------------|
| You maintain CI workflows in every repo | GHAGGA manages the runner for you |
| CI runs on your GitHub minutes | CI runs on unlimited free public repo minutes |
| Private repos use your 2000 min/month quota | Private repo code analyzed on public runner safely |
| Manual workflow synchronization | Zero maintenance |

**Key benefits:**
- **Zero configuration in your repo** — GHAGGA manages the `ghagga-runner` repository
- **Private repo support** — code runs on public runners safely via ephemeral tokens
- **Instant feedback** — lint/tests run alongside AI review
- **Free forever** — uses GitHub Actions unlimited minutes for public repos

---

## Prerequisites

1. **GHAGGA GitHub App** installed on your repository
2. A public **`ghagga-runner`** repository (auto-created by GHAGGA when you enable the static analysis runner)

> **Note**: Delegated CI shares the same runner infrastructure as static analysis. If you've already enabled the runner for Semgrep/Trivy, you're ready to configure Delegated CI.

---

## Configuration (Dashboard)

Navigate to **Dashboard → Settings → [Select Repository] → Delegated CI**

The Delegated CI section is always visible, regardless of whether you use global or custom settings. It's repo-scoped and never inherited from installation-level settings.

### Step 1: Enable Delegated CI

Toggle the **"Enabled"** switch in the header. This creates a fresh policy with default triggers enabled:

```
enabled: true
allowPullRequestTrigger: true
allowManualTrigger: true
jobs: []
```

> **Tip**: Toggling off preserves your job configuration. You can re-enable without recreating jobs.

### Step 2: Configure Triggers

| Trigger | Description | Default |
|---------|-------------|---------|
| **Run on Pull Requests** | Automatically run CI when a PR is opened or updated | ✓ Enabled |
| **Allow Manual Trigger** | Allow re-running CI via PR comments (`ghagga review`) | ✓ Enabled |

Both triggers are recommended for most workflows.

### Step 3: Add Jobs

Click **"+ Add Job"** to configure each CI job. You can add up to **10 jobs** per repository.

#### Job Fields

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| **Job Key** | Yes | Unique identifier for this job (used in logs and callbacks) | `lint-check` |
| **Display Name** | Yes | Human-readable name shown in reports | `ESLint Check` |
| **Profile** | Yes | Execution profile (see below) | `Node.js Lint` |
| **Classification** | Yes | Safety level for this job | `Safe / Delegable` |
| **Enabled** | No | Toggle this job on/off | ✓ |
| **Max Duration (minutes)** | No | Override profile default (1-30 min) | `10` |
| **Allow Cache** | No | Enable dependency caching (faster subsequent runs) | ✓ |

### Step 4: Save

Click **"Save Settings"** at the bottom of the Settings page.

---

## Execution Profiles

Delegated CI runs **GHAGGA-curated execution profiles**. Arbitrary shell commands and custom scripts are not supported in MVP — this is a security boundary.

| Profile | Command | Use Case | Default Timeout |
|---------|---------|----------|-----------------|
| **Node.js Lint** | `npm run lint` / `pnpm lint` | JavaScript/TypeScript linting (ESLint, Biome, etc.) | 10 min |
| **Node.js Unit Tests** | `npm test` / `pnpm test` | Jest, Vitest, Mocha tests | 30 min |
| **Python Lint** | `ruff check . && black --check .` | Python linting and formatting | 10 min |
| **Python Pytest** | `pytest` | Python unit tests with pytest | 30 min |
| **Go Test** | `go test ./...` | Go unit tests | 30 min |

### Profile Detection

Your project must have the corresponding package manager / tool configured:

| Profile | Expected Files |
|---------|----------------|
| Node.js Lint / Unit Tests | `package.json` with `lint` or `test` scripts |
| Python Lint / Pytest | `pyproject.toml`, `requirements.txt`, or `setup.py` |
| Go Test | `go.mod` |

If the expected tool is not installed, the job will fail with a clear error message.

---

## Job Classifications

| Classification | Behavior | When to Use |
|----------------|----------|-------------|
| **Safe / Delegable** | Job runs on public `ghagga-runner` | Lint, tests, static analysis — no secrets needed |
| **Sensitive / Not Delegable** | Job is rejected (future: requires private runner) | Jobs that need secrets, deploy keys, or write access |

> **Recommendation**: Start with `Safe / Delegable` for all lint and test jobs. Use `Sensitive / Not Delegable` only if your tests require database credentials or API keys.

---

## Example Configurations

### Node.js Project (Lint + Tests)

```
Job 1:
  Job Key: eslint
  Display Name: ESLint
  Profile: Node.js Lint
  Classification: Safe / Delegable
  Max Duration: 10 min
  Allow Cache: ✓

Job 2:
  Job Key: unit-tests
  Display Name: Unit Tests
  Profile: Node.js Unit Tests
  Classification: Safe / Delegable
  Max Duration: 15 min
  Allow Cache: ✓
```

### Python Project (Lint + Tests)

```
Job 1:
  Job Key: ruff
  Display Name: Ruff + Black
  Profile: Python Lint
  Classification: Safe / Delegable
  Max Duration: 5 min
  Allow Cache: ✓

Job 2:
  Job Key: pytest
  Display Name: Pytest
  Profile: Python Pytest
  Classification: Safe / Delegable
  Max Duration: 20 min
  Allow Cache: ✓
```

### Monorepo (Multiple Stacks)

```
Job 1: frontend-lint (Node.js Lint)
Job 2: frontend-tests (Node.js Unit Tests)
Job 3: backend-lint (Python Lint)
Job 4: backend-tests (Python Pytest)
Job 5: go-service-tests (Go Test)
```

---

## Limitations (MVP)

| Limitation | Value | Rationale |
|------------|-------|-----------|
| Max jobs per repository | 10 | Prevent abuse |
| Max duration per job | 30 minutes | GitHub Actions timeout |
| Custom commands | ❌ Not supported | Security boundary |
| Artifact uploads | ❌ Not supported | Future feature |
| Private runners | ❌ Not supported | Future feature |
| Environment secrets | ❌ Not copied | Security boundary |

---

## Security Model

Delegated CI is designed with **defense in depth** — multiple layers protect your private repo code:

### What GHAGGA CAN Do

- ✅ Clone your private repo using an **ephemeral GitHub installation token** (expires in 11 minutes)
- ✅ Execute curated profiles (lint, test) in an isolated workspace
- ✅ Post results back to your PR

### What GHAGGA CANNOT Do

- ❌ Access your repo secrets, environment variables, or deploy keys
- ❌ Push commits or modify your repository
- ❌ Run arbitrary shell commands or custom workflows
- ❌ Persist your code after the job completes (workspace is destroyed)

### Trust Boundary

The `ghagga-delegated-ci.yml` workflow is the security boundary. Only accept changes from the [official template repository](https://github.com/JNZader/ghagga-runner-template).

For a deep dive, see [Security Policy — Delegated CI Safety Boundaries](security.md#delegated-ci-safety-boundaries).

---

## Troubleshooting

### Jobs not running?

1. **Verify Delegated CI is enabled** — Check the toggle shows "Enabled"
2. **Check at least one job exists** — The empty state message will show if no jobs are configured
3. **Ensure jobs are enabled** — Each job has its own Enabled/Disabled toggle
4. **Verify triggers** — "Run on Pull Requests" must be checked for automatic runs

### Job rejected with reason code?

Delegated CI rejects jobs before execution if policy checks fail. Common reason codes:

| Reason Code | Cause | Fix |
|-------------|-------|-----|
| `delegated_ci_disabled` | Policy `enabled: false` | Toggle "Enabled" in Dashboard |
| `job_disabled` | Job `enabled: false` | Enable the specific job |
| `job_sensitive` | Classification is `sensitive/no-delegable` | Change to `safe/delegable` or wait for private runners |
| `profile_unsupported` | Profile not in curated list | Select a valid profile |
| `trigger_not_allowed` | Manual trigger on a PR without permission | Use "Run on Pull Requests" or comment as a contributor |

Contact support with the `reasonCode` for further assistance.

### Job fails with "command not found"?

The execution profile expects certain tools to be installed:

| Profile | Expected Commands |
|---------|-------------------|
| Node.js Lint | `npm` or `pnpm`, plus a `lint` script in `package.json` |
| Node.js Unit Tests | `npm` or `pnpm`, plus a `test` script in `package.json` |
| Python Lint | `ruff`, `black` (auto-installed via pip) |
| Python Pytest | `pytest` (auto-installed via pip) |
| Go Test | `go` |

Add the missing tools or scripts to your project.

### Timeout exceeded?

- Increase **Max Duration** (up to 30 minutes)
- Enable **Allow Cache** for faster dependency installation
- Split large test suites into multiple jobs

---

## Related Documentation

- [Runner Architecture](runner-architecture.md) — How delegated execution works under the hood
- [Security Policy](security.md) — Delegated CI safety boundaries
- [Static Analysis](static-analysis.md) — Semgrep, Trivy, CPD, and 12 more tools
- [SaaS Getting Started](saas-getting-started.md) — Full setup guide
