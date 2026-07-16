---
"ghagga-triage-engine": patch
---

Fix the GitLab forge adapter's `listIssues` (used by `ghagga triage --new`): it passed `-F json` to `glab issue list`, but `-F/--output-format` is a different flag (details/ids/urls) that silently falls back to glab's human text table, so `JSON.parse` threw `Unexpected token 'S', "Showing …"`. `glab issue list` needs `-O/--output json`. The whole `--new` / list-all path was broken for GitLab (the feature's primary forge); single-issue `triage <iid>` was unaffected (`issue view` correctly uses `-F json`). Verified end-to-end against a real GitLab repo.
