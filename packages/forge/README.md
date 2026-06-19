# ghagga-forge

`ghagga-forge` is GHAGGA's forge-agnostic port layer: the canonical, provider-neutral domain types and abstract ports (forge adapter, CI runner, credential provider, webhook codec, adapter registry) that the core review engine and the server talk to instead of any concrete forge SDK. It keeps GHAGGA decoupled from GitHub, GitLab, or Gitea specifics so the same review pipeline can target any forge. The package depends on `ghagga-core` in TYPE position only, and `ghagga-core` must never depend on it (R-AGNOSTIC).
