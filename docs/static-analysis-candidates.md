# Static Analysis — Tool Candidates

> Reference document for evaluating new static analysis tools to integrate into GHAGGA's inline static-analysis workflow. See [current tools](static-analysis.md) and the [architecture overview](architecture.md#inline-static-analysis-workflow).

## Current Toolset (16 tools — plugin registry)

| Tool | Category | What It Finds | Status |
|------|----------|---------------|--------|
| **Semgrep** 1.90.0 | SAST (pattern matching) | Security vulnerabilities, dangerous APIs, hardcoded secrets | Always-on |
| **Trivy** 0.69.3 | SCA + IaC | Known CVEs in dependencies, container/IaC misconfigs | Always-on |
| **PMD/CPD** 7.8.0 | Code quality | Duplicated code blocks (copy-paste detection) | Always-on |
| **Gitleaks** | Secrets scanning | API keys, tokens, passwords in code and git history | Always-on |
| **ShellCheck** | Shell analysis | Shell script bugs, unquoted variables, portability issues | Always-on |
| **markdownlint** | Documentation quality | Markdown formatting and style issues | Always-on |
| **Lizard** | Code complexity | Cyclomatic complexity, function length metrics | Always-on |
| **Ruff** | Python linting | Python code quality (800+ rules, replaces Flake8) | Auto-detect |
| **Bandit** | Python security | Python-specific security (shell=True, insecure crypto) | Auto-detect |
| **golangci-lint** | Go linting + security | Go code quality + gosec security rules | Auto-detect |
| **Biome** | JS/TS linting | JavaScript/TypeScript code quality | Auto-detect |
| **PMD** | Java/Apex linting | Java code quality and style rules | Auto-detect |
| **Psalm** | PHP analysis | PHP type checking + taint analysis for security | Auto-detect |
| **clippy** | Rust linting | Rust code quality and idiom checks | Auto-detect |
| **Hadolint** | Dockerfile linting | Dockerfile best practices and security anti-patterns | Auto-detect |
| **zizmor** 1.23.1 | GitHub Actions security | Template injection, unpinned actions, excessive permissions, credential leaks | Auto-detect |

## Integration Requirements

For a tool to work with GHAGGA's runner architecture, it must:

1. **Run as CLI** — no persistent server, no SaaS dependency
2. **Produce machine-readable output** — JSON or SARIF
3. **Run in GitHub Actions** — `ubuntu-latest` with 7GB RAM, 2 CPUs
4. **Complete in <3 minutes** — runner has a 10-minute total budget
5. **Be free for open-source** — no per-seat or per-scan licensing

Findings must normalize to `ReviewFinding`:

```typescript
interface ReviewFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  source: FindingSource; // tool identifier
}
```

---

## Candidate Tools

### Tier 1 — Strong Fit (CLI-first, free, fills gaps)

#### Gitleaks — Secrets Detection

| Attribute | Detail |
|-----------|--------|
| **Category** | Secrets scanning (API keys, tokens, passwords in code and git history) |
| **Why add it** | Purpose-built with 150+ rules and entropy detection. Semgrep has basic secret rules but Gitleaks is strictly better for this category |
| **Languages** | Language-agnostic (regex + entropy on any text) |
| **Output** | JSON, SARIF, CSV, JUnit |
| **License** | MIT |
| **Install** | Single Go binary, ~10MB |
| **Speed** | Seconds (scans git history or staged files) |
| **Runner fit** | Excellent — zero dependencies, instant execution |
| **Overlap** | Low — Semgrep has ~5 secret rules; Gitleaks has 150+ |
| **Command** | `gitleaks detect --source=. --report-format=json --report-path=/tmp/gitleaks-result.json` |

#### OSV-Scanner — Dependency Vulnerabilities (Google)

| Attribute | Detail |
|-----------|--------|
| **Category** | SCA (open source dependency vulnerability scanning) |
| **Why add it** | Uses OSV.dev, the most comprehensive open-source vuln DB (aggregates NVD, GitHub Advisories, ecosystem DBs). **PR-diff mode** flags only NEW vulnerabilities introduced by a PR — reduces noise vs Trivy |
| **Languages** | 11+ ecosystems: Go, Java, JS, Python, Rust, Ruby, PHP, Dart, C/C++, Elixir |
| **Output** | JSON, SARIF |
| **License** | Apache 2.0 |
| **Install** | Single Go binary |
| **Speed** | Seconds |
| **Runner fit** | Excellent — no account, no rate limits |
| **Overlap** | Moderate with Trivy SCA. Richer vuln DB, unique PR-diff filtering |
| **Command** | `osv-scanner scan --format json --output /tmp/osv-result.json .` |

#### Bearer — SAST with Privacy/Data Flow

| Attribute | Detail |
|-----------|--------|
| **Category** | SAST (security + privacy, data flow analysis) |
| **Why add it** | Maps data flows for PII/GDPR risks. Catches logging sensitive fields, sending PII to third parties, insecure data storage. OWASP Top 10 + CWE mapping |
| **Languages** | Go, Java, JavaScript/TypeScript, PHP, Python, Ruby |
| **Output** | JSON, SARIF |
| **License** | MIT (OSS CLI). Acquired by Cycode in 2023; CLI remains free |
| **Install** | Binary or Docker image |
| **Speed** | ~30-60 seconds for medium repos |
| **Runner fit** | Excellent — pure CLI, no server |
| **Overlap** | Moderate with Semgrep. Unique value: data flow + privacy risk detection |
| **Command** | `bearer scan . --format json --output /tmp/bearer-result.json` |

#### Hadolint — Dockerfile Linting

| Attribute | Detail |
|-----------|--------|
| **Category** | Dockerfile best practices + security anti-patterns |
| **Why add it** | Catches layer caching issues, unpinned versions, running as root, unnecessary packages. Embeds ShellCheck for RUN instructions |
| **Languages** | Dockerfile only |
| **Output** | JSON, SARIF, checkstyle, codeclimate |
| **License** | GPL-3.0 |
| **Install** | Single binary (~10MB) |
| **Speed** | Milliseconds |
| **Runner fit** | Excellent — trivial to add |
| **Overlap** | Low — Trivy catches Dockerfile misconfigs but Hadolint is deeper on best practices |
| **Command** | `hadolint --format json Dockerfile > /tmp/hadolint-result.json` |

#### ShellCheck — Shell Script Analysis

| Attribute | Detail |
|-----------|--------|
| **Category** | Shell script static analysis (bash/sh linting) |
| **Why add it** | Catches unquoted variables, undefined vars, deprecated syntax, portability issues |
| **Languages** | bash, sh, dash, ksh |
| **Output** | JSON, checkstyle, diff, GCC |
| **License** | GPL-3.0 |
| **Install** | Pre-installed on GitHub Actions runners (zero setup cost) |
| **Speed** | Milliseconds |
| **Runner fit** | Excellent — already available, no install needed |
| **Overlap** | Zero. Hadolint calls ShellCheck internally for Dockerfile RUN, but standalone ShellCheck covers all `.sh` files |
| **Command** | `shellcheck --format=json *.sh > /tmp/shellcheck-result.json` |

#### Ruff — Python Linting + Formatting

| Attribute | Detail |
|-----------|--------|
| **Category** | Linting (Python code quality) |
| **Why add it** | 150-200x faster than Flake8. Replaces Flake8, isort, pyupgrade, and large chunks of Pylint. 800+ rules |
| **Languages** | Python only |
| **Output** | JSON, SARIF, GitHub annotations |
| **License** | MIT |
| **Install** | Single Rust binary |
| **Speed** | Sub-second on 250k LOC |
| **Runner fit** | Excellent |
| **Overlap** | Zero with current tools. Pair with Bandit for Python security |
| **Command** | `ruff check --output-format json . > /tmp/ruff-result.json` |

#### Bandit — Python Security

| Attribute | Detail |
|-----------|--------|
| **Category** | SAST (Python-specific security) |
| **Why add it** | Python-specific: subprocess with shell=True, assert in production, insecure crypto, hardcoded passwords. Semgrep covers Python but Bandit is deeper on Python idioms |
| **Languages** | Python only |
| **Output** | JSON, SARIF, HTML, XML, YAML, CSV |
| **License** | Apache 2.0 |
| **Install** | `pip install bandit` |
| **Speed** | Seconds |
| **Runner fit** | Excellent |
| **Overlap** | Moderate with Semgrep Python rules. Bandit catches Python-specific patterns Semgrep misses |
| **Command** | `bandit -r . -f json -o /tmp/bandit-result.json` |

---

### Tier 2 — Good Fit (language-specific, adds value for specific stacks)

#### Biome — JS/TS Linting + Formatting

| Attribute | Detail |
|-----------|--------|
| **Category** | Linting + formatting (code quality, NOT security) |
| **Languages** | JavaScript, TypeScript, JSX/TSX, JSON, CSS, GraphQL, HTML |
| **Output** | JSON, SARIF (v2.4+) |
| **License** | MIT |
| **Speed** | 50x faster than ESLint + Prettier |
| **Runner fit** | Excellent — single Rust binary |
| **Overlap** | Replaces ESLint for code quality rules. NOT a security tool |
| **Note** | Choose Biome OR Oxlint for JS/TS quality — not both |

#### Oxlint — JS/TS Linting (VoidZero/Evan You)

| Attribute | Detail |
|-----------|--------|
| **Category** | Linting (JavaScript/TypeScript code quality) |
| **Languages** | JavaScript, TypeScript, JSX/TSX |
| **Output** | JSON, GitHub annotations, checkstyle, JUnit. No native SARIF yet |
| **License** | MIT |
| **Speed** | 50-100x faster than ESLint. 126k files in 7 seconds |
| **Runner fit** | Excellent — single Rust binary |
| **Overlap** | Direct competitor to Biome. 520+ ESLint rules implemented |
| **Note** | Missing native SARIF is a gap vs Biome |

#### ESLint + Security Plugins

| Attribute | Detail |
|-----------|--------|
| **Category** | Linting + SAST-lite (with `eslint-plugin-security`) |
| **Languages** | JavaScript, TypeScript |
| **Output** | JSON. SARIF via `@microsoft/eslint-formatter-sarif` |
| **License** | MIT |
| **Runner fit** | Good — needs `npm install` + config |
| **Overlap** | Semgrep covers JS/TS security. ESLint security plugins add Node.js-specific rules (eval, RegEx DoS, path traversal) |

#### SpotBugs + FindSecBugs — Java Bytecode Analysis

| Attribute | Detail |
|-----------|--------|
| **Category** | SAST (Java bytecode: bugs + 144 security vulnerability types) |
| **Languages** | Java, Kotlin, Groovy, Scala (JVM bytecode) |
| **Output** | XML, SARIF |
| **License** | LGPL |
| **Runner fit** | Good — requires compiled bytecode (needs `mvn package` first) |
| **Overlap** | PMD covers Java source style. SpotBugs covers bytecode-level bugs + security. Complementary, not redundant |

#### PHPStan — PHP Static Analysis

| Attribute | Detail |
|-----------|--------|
| **Category** | Type checking / bug detection (PHP) |
| **Languages** | PHP only |
| **Output** | JSON |
| **License** | MIT |
| **Runner fit** | Excellent — Composer install, fast |
| **Overlap** | Zero with current tools. Not security-focused |

#### Psalm — PHP Static Analysis + Taint Analysis

| Attribute | Detail |
|-----------|--------|
| **Category** | Type checking + security taint analysis (PHP) |
| **Languages** | PHP only |
| **Output** | JSON, SARIF |
| **License** | MIT |
| **Runner fit** | Excellent |
| **Overlap** | Overlaps with PHPStan. Unique killer feature: `--taint-analysis` for SQL injection, XSS detection in PHP |

#### golangci-lint — Go Linting Orchestrator

| Attribute | Detail |
|-----------|--------|
| **Category** | Linting + security (Go, with gosec integration) |
| **Languages** | Go only |
| **Output** | JSON, checkstyle, tab, GitHub Actions |
| **License** | GPL-3.0 |
| **Runner fit** | Excellent — single binary, runs gosec + 100+ linters in parallel |
| **Overlap** | Low. Semgrep has Go rules but golangci-lint is Go-native and deeper |

#### Checkov — Infrastructure as Code

| Attribute | Detail |
|-----------|--------|
| **Category** | IaC security (Terraform, CloudFormation, K8s, Docker, Ansible, ARM) |
| **Languages** | HCL, JSON, YAML, Dockerfile |
| **Output** | JSON, SARIF, JUnit, CycloneDX |
| **License** | Apache 2.0 |
| **Runner fit** | Excellent — pip install, CLI |
| **Overlap** | High with Trivy `--scanners misconfig`. Checkov has broader IaC coverage (~1000+ checks vs Trivy's ~700) |

#### KICS — Infrastructure as Code (Checkmarx)

| Attribute | Detail |
|-----------|--------|
| **Category** | IaC security scanning |
| **Languages** | 22+ platforms: Terraform, CloudFormation, K8s, Docker, Ansible, OpenAPI, Helm, Pulumi |
| **Output** | JSON, SARIF + 10 more formats. Best output variety of all IaC tools |
| **License** | Apache 2.0 |
| **Runner fit** | Excellent — binary or Docker |
| **Overlap** | High with Trivy and Checkov. Largest IaC query library (2,400+ vs Trivy ~700, Checkov ~1,000) |
| **Note** | Pick ONE IaC scanner: Trivy (already have), Checkov, or KICS. Don't stack all three |

---

### Tier 3 — Poor Fit (SaaS dependency, server required, or licensing issues)

These tools **cannot run in GHAGGA's ephemeral runner model** or have significant licensing constraints.

#### SonarQube / SonarCloud

| Attribute | Detail |
|-----------|--------|
| **Category** | SAST + Code Quality |
| **Why skip** | **Requires a persistent SonarQube server** or SonarCloud SaaS. Cannot produce standalone JSON/SARIF without a server endpoint. The tool uploads results to its platform; it doesn't generate local reports |
| **License** | SSALv1 (source-available, NOT OSI open source). Community edition limited |
| **Verdict** | Incompatible with ephemeral runner. The entire value prop (dashboards, quality gates, history) requires a running server |

#### CodeQL (GitHub)

| Attribute | Detail |
|-----------|--------|
| **Category** | SAST (deep semantic / dataflow / taint analysis) |
| **Why conditional** | Best-in-class for inter-procedural taint tracking. Catches complex injection paths Semgrep misses. BUT: (1) downloads ~1GB CodeQL bundle, (2) builds a database first (minutes on large repos), (3) **license restricts commercial use** outside GitHub Advanced Security ($30/committer/month) |
| **Output** | SARIF |
| **Languages** | C/C++, C#, Go, Java/Kotlin, JavaScript/TypeScript, Python, Ruby, Swift |
| **Verdict** | High value but impractical for per-PR runs. Better as a **scheduled nightly scan** via GitHub's native Code Scanning, not embedded in the runner. License is a blocker for commercial SaaS |

#### DeepSource

| Attribute | Detail |
|-----------|--------|
| **Category** | SAST + Code Quality |
| **Why skip** | **CLI is just an API client** — analysis runs on DeepSource's servers. Cannot run analysis locally without their backend |
| **License** | Free tier exists, but fundamentally SaaS-dependent |
| **Verdict** | Incompatible with ephemeral runner. No local analysis capability |

#### Snyk

| Attribute | Detail |
|-----------|--------|
| **Category** | SCA + SAST + Container + IaC |
| **Why skip** | **Requires Snyk account + API token**. Every scan calls home to Snyk's SaaS for vulnerability DB lookup. Free tier: 200 tests/month (hit quickly on active repos). Trivy + OSV-Scanner covers the same ground for free without rate limits |
| **License** | Proprietary SaaS |
| **Verdict** | Works in CI but SaaS-dependent with rate limits. Trivy is a better free alternative for SCA |

#### Cycode

| Attribute | Detail |
|-----------|--------|
| **Category** | ASPM (Application Security Posture Management) — secrets, SCA, SAST, IaC, CI/CD security |
| **Why skip** | **Enterprise SaaS platform**. Acquired Bearer (the OSS CLI) in 2023, but Cycode itself is a managed platform with no standalone CLI mode. Bearer CLI remains usable independently (see Tier 1) |
| **License** | Commercial. No free tier for the full platform |
| **Verdict** | Use Bearer CLI directly (Tier 1) instead. Cycode's platform value is in centralized management, not CLI analysis |

#### Aikido Security

| Attribute | Detail |
|-----------|--------|
| **Category** | DevSecOps platform (SAST, SCA, DAST, IaC, secrets, container scanning) |
| **Why skip** | **SaaS-only platform**. Orchestrates open-source tools (Semgrep, Trivy, Gitleaks, etc.) behind a managed UI. No standalone CLI for local execution. Essentially does what GHAGGA already does — aggregate tools — but as a paid managed service |
| **License** | Commercial. Free tier for small teams (limited repos) |
| **Verdict** | Architecturally redundant — GHAGGA IS the orchestrator. Adding Aikido would be nesting an orchestrator inside an orchestrator |

#### Grype (Anchore)

| Attribute | Detail |
|-----------|--------|
| **Category** | SCA (container images + filesystems) |
| **Why lower priority** | High overlap with Trivy. Both scan the same lockfiles for the same CVEs. Grype's unique value is SBOM-centric workflows (Syft → Grype). Unless you need SBOMs, Trivy + OSV-Scanner is sufficient |
| **License** | Apache 2.0 |
| **Verdict** | Only add for SBOM-centric compliance workflows. Otherwise redundant with Trivy |

---

## Recommended Additions by Priority

Tools that fill genuine gaps beyond the current 16-tool registry:

| Priority | Tool | Gap Filled | Effort | Status |
|----------|------|-----------|--------|--------|
| ~~**P0**~~ | ~~**Gitleaks**~~ | ~~Secrets in code/git history~~ | — | **Implemented** (v2.5.0) |
| ~~**P1**~~ | ~~**ShellCheck**~~ | ~~Shell script bugs~~ | — | **Implemented** (v2.5.0) |
| ~~**P1**~~ | ~~**Hadolint**~~ | ~~Dockerfile quality~~ | — | **Implemented** (v2.5.0) |
| **P2** | **OSV-Scanner** | Richer vuln DB + PR-diff mode (only new vulns) | Low — single binary |  |
| **P2** | **Bearer** | Data flow / privacy / GDPR risk detection | Medium — needs Docker or binary |  |
| ~~**P3**~~ | ~~**Ruff**~~ | ~~Python code quality~~ | — | **Implemented** (v2.5.0) |
| ~~**P3**~~ | ~~**Bandit**~~ | ~~Python security~~ | — | **Implemented** (v2.5.0) |
| ~~**P3**~~ | ~~**Biome**~~ | ~~JS/TS code quality~~ | — | **Implemented** (v2.5.0) |

## Language-Specific Recommendations

Which tools to add based on the languages in the reviewed repo:

| Language | Security | Quality | Already Covered |
|----------|----------|---------|-----------------|
| **JavaScript/TypeScript** | Semgrep | Biome or Oxlint | Semgrep (SAST), Trivy (SCA), CPD |
| **Python** | Bandit | Ruff | Semgrep (SAST), Trivy (SCA), CPD |
| **Java/Kotlin** | SpotBugs + FindSecBugs | PMD (already have) | Semgrep (SAST), Trivy (SCA), CPD |
| **Go** | golangci-lint (includes gosec) | golangci-lint | Semgrep (SAST), Trivy (SCA), CPD |
| **PHP** | Psalm (taint analysis) | PHPStan | Semgrep (SAST), Trivy (SCA), CPD |
| **Ruby** | Semgrep + Brakeman | — | Semgrep (SAST), Trivy (SCA), CPD |
| **Shell** | ShellCheck | ShellCheck | — |
| **Dockerfile** | Hadolint | Hadolint | Trivy (partial misconfig) |
| **IaC (Terraform/K8s)** | Trivy (already have) | — | Trivy `--scanners misconfig` |
| **Any (secrets)** | Gitleaks | — | Semgrep (5 basic rules) |

## Architecture Note

Since v2.5.0, the tool registry uses an open `Record<ToolName, ToolResult>` type, so adding a new tool no longer requires changes to the `StaticAnalysisResult` interface. New tools are registered via the plugin registry configuration.

```typescript
type ToolName = 'semgrep' | 'trivy' | 'cpd' | string;
type StaticAnalysisResult = Record<ToolName, ToolResult>;
```

## References

- [Wiz — Top 28 Open-Source Code Security Tools (2026)](https://www.wiz.io/blog/top-open-source-code-security-tools)
- [Semgrep vs CodeQL vs SonarQube comparison](https://sanj.dev/post/ai-code-security-tools-comparison)
- [OSV-Scanner v2.0 (March 2025)](https://google.github.io/osv-scanner/)
- [Bearer CLI](https://github.com/Bearer/bearer)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
- [Ruff](https://astral.sh/ruff)
- [Biome v2](https://biomejs.dev/)
- [Hadolint](https://github.com/hadolint/hadolint)
