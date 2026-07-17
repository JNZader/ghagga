---
"ghagga-triage-engine": minor
---

REPRODUCE can now deduce the app route from an issue's `módulo::X` label when the body has no `Ruta:` line (e.g. issues created from meeting notes rather than the in-app feedback widget). It uses the `/app/<module>` heuristic, overridable per-module via a new optional `moduleRoutes` config map (e.g. `{ "equipos": "/app/tanques" }`). A `Ruta:` line in the body still takes precedence.
