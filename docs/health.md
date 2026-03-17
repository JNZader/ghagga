# Health Check

Run a project health assessment from the command line. The `ghagga health` command performs static analysis, computes a health score (0-100), tracks historical trends, and provides actionable recommendations.

---

## Usage

```bash
ghagga health [path]
```

| Option | Default | Description |
|--------|---------|-------------|
| `[path]` | `.` | Path to repository or subdirectory |
| `--top <n>` | `5` | Number of top issues to display |
| `--output json` | — | Inherits global `--output` flag for JSON output |

---

## Health Score

The health score is a number from 0 to 100 based on the severity and count of issues found by static analysis. Higher is better.

### Grading Scale

| Grade | Score | Meaning |
|-------|-------|---------|
| **A** | 80-100 | Excellent — few or no issues |
| **B** | 60-79 | Good — minor issues present |
| **C** | 40-59 | Fair — several issues need attention |
| **D** | 20-39 | Poor — significant issues detected |
| **F** | 0-19 | Critical — immediate action required |

---

## Trend Analysis

Each time you run `ghagga health`, the score is recorded locally. Subsequent runs show improvement or decline compared to the last run:

```
Health Score: 74/100 (B) — +6 since last run
```

This helps you track whether your codebase is getting healthier over time.

---

## Recommendations

The health command provides actionable suggestions grouped by category (security, complexity, duplication, etc.). Recommendations are ordered by impact — fixing the top items yields the biggest score improvement.

---

## History

Health scores are stored locally in the GHAGGA config directory (`~/.config/ghagga/`), isolated per project. History is keyed by repository path, so different projects maintain independent trend data.

---

## Examples

### Basic Usage

```bash
ghagga health
```

```
Health Score: 74/100 (B) — +6 since last run

Top Issues:
  1. [HIGH] 3 functions exceed cyclomatic complexity threshold (Lizard)
  2. [MEDIUM] 2 known CVEs in dependencies (Trivy)
  3. [MEDIUM] 1 duplicated code block (CPD)
  4. [LOW] 5 markdown formatting issues (markdownlint)
  5. [LOW] 2 shell script warnings (ShellCheck)

Recommendations:
  - Refactor complex functions in src/pipeline.ts and src/agents/workflow.ts
  - Update lodash to 4.17.21+ to resolve CVE-2024-XXXX
  - Extract duplicated logic in src/utils/ into a shared helper
```

### JSON Output

```bash
ghagga health --output json
```

```json
{
  "score": 74,
  "grade": "B",
  "trend": "+6",
  "issues": [
    {
      "severity": "HIGH",
      "tool": "lizard",
      "category": "complexity",
      "message": "3 functions exceed cyclomatic complexity threshold",
      "files": ["src/pipeline.ts", "src/agents/workflow.ts"]
    }
  ],
  "recommendations": [
    "Refactor complex functions in src/pipeline.ts and src/agents/workflow.ts"
  ],
  "timestamp": "2026-03-08T12:00:00Z"
}
```

### CI Integration

Use the health command in CI to enforce a minimum score:

```bash
SCORE=$(ghagga health --output json | jq '.score')
if [ "$SCORE" -lt 60 ]; then
  echo "Health score $SCORE is below threshold (60)"
  exit 1
fi
```

---

## Next Steps

- **[CLI Guide](cli.md)** — Full CLI reference
- **[Static Analysis](static-analysis.md)** — 16 tools, tier system, per-tool control
- **[Configuration](configuration.md)** — Environment variables and config files
