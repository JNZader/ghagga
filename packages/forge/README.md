# ghagga-forge

`ghagga-forge` is GHAGGA's forge-agnostic port layer: the canonical, provider-neutral domain types and abstract ports (forge adapter, CI runner, credential provider, webhook codec, adapter registry) that the core review engine and the server talk to instead of any concrete forge SDK. Shipped adapters are GitHub and GitLab only. Gitea exists as a forge kind on the port types; there is no Gitea adapter. The package depends on `ghagga-core` in TYPE position only, and `ghagga-core` must never depend on it (R-AGNOSTIC).
