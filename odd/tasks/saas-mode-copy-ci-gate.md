# SaaS mode copy + CI Gate

## Objective

Tell the dashboard that Settings only persist simple/workflow/consensus, and add a CI wrap-up job that always reports so `main` can require it.

## Out of scope

- Adding fan-out/hybrid-4r radios
- Requiring Security Audit or Docker on PRs
- Auto-merge

## Tasks

- [x] T1 Settings.tsx and GlobalSettings.tsx helper: keep the 3-mode cost line; add that SaaS settings persist only these three and fan-out is `/ghagga fan-out`. Update Settings.test.tsx if it asserts the caption.
- [x] T2 `.github/workflows/ci.yml`: job `CI Gate` (`if: always()`, needs changes/check/lint/test). Fail if changes failed, or if check/lint/test is anything other than success|skipped. Do not gate on Security Audit.
