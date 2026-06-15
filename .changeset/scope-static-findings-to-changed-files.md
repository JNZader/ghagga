---
"ghagga-core": patch
---

Scope static-analysis findings to the changed files (Trivy/SCA exempt) so reviews no longer fail on unrelated repo-wide pre-existing findings.

Static tools (Semgrep, CPD, …) scan the whole repo, so reviewing a 1-file change could surface — and FAIL on — pre-existing findings from unrelated files. The static-only verdict now only counts findings located in the changed files (the diff set, after blast-radius filtering; out-of-diff dependents are intentionally NOT included — a static finding in an unchanged file is pre-existing and must not fail the change). Dependency/SCA findings (Trivy, `dependency-vulnerability`) are exempt: they live in lockfiles/manifests that are usually not in the diff but still represent real risk for the change. Out-of-scope non-SCA findings remain visible in the report but no longer drive the verdict to FAILED.
