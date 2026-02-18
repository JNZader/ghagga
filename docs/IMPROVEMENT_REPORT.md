# GHAGGA - Reporte de Mejoras

> Generado 2026-02-18 | Analisis con 5 agentes especializados (Security, Code Quality, Architecture, Performance, Testing)

---

## Resumen Ejecutivo

| Agente | Hallazgos |
|--------|-----------|
| Security Auditor | 3 Critical, 5 High, 8 Medium, 6 Low |
| Code Quality Reviewer | 3 Critical, 12 Major, 10 Minor, 7 Suggestions |
| Architecture Explorer | 8 areas con recomendaciones |
| Performance Engineer | 3 Critical, 7 High, 8 Medium |
| Test Engineer | 6 gaps prioritarios, 0% frontend coverage |

---

## 1. BUGS REALES

### BUG-1: getRepoConfig consulta tabla/columna inexistente

- **Archivo:** `supabase/functions/webhook/handlers/pull_request.ts:410-413`
- **Detectado por:** Code Quality + Performance (convergencia independiente)
- **Problema:** La query usa `repository_configs` y `full_name` en vez de `repo_configs` y `repo_full_name`
- **Impacto:** La configuracion del dashboard (provider, model, rules, enabled/disabled) NUNCA se carga en el webhook. Siempre usa defaults. La UI de Settings es inoperante para reviews.

### BUG-2: Regex global con .test() produce falsos negativos

- **Archivo:** `supabase/functions/_shared/memory/privacy.ts:10-18, 47-57`
- **Detectado por:** Security + Code Quality (convergencia independiente)
- **Problema:** `.test()` con flag `/g` avanza `lastIndex`, alternando true/false en llamadas sucesivas
- **Impacto:** API keys y datos privados pueden NO ser detectados y quedar persistidos en observaciones de memoria

### BUG-3: Token budget hardcodeado para Claude

- **Archivo:** `supabase/functions/webhook/handlers/pull_request.ts:1007`
- **Detectado por:** Architecture Explorer
- **Problema:** `budgeter.allocate('claude-sonnet-4-20250514')` ignora el provider real seleccionado

---

## 2. SEGURIDAD

### S1 - CRITICAL: CORS wildcard

- **Archivo:** `supabase/functions/_shared/cors.ts:2`
- **Problema:** `Access-Control-Allow-Origin: *` permite requests desde cualquier origen
- **Fix:** Restringir a dominios del dashboard

### S2 - CRITICAL: Gemini API key en URL

- **Archivo:** `supabase/functions/_shared/providers/gemini.ts:147`
- **Problema:** Key en query param se loguea en proxies, CDNs, logs
- **Fix:** Usar header `x-goog-api-key`

### S3 - CRITICAL: timingSafeEqual filtra longitud

- **Archivo:** `supabase/functions/webhook/index.ts:73-84`
- **Problema:** Early return en length mismatch permite timing oracle
- **Fix:** Usar comparacion constant-time real

### S4 - HIGH: Encrypted keys visibles via RLS SELECT

- **Archivo:** `supabase/migrations/010_multi_tenant.sql:77-95`
- **Problema:** Columnas `*_api_key_encrypted` accesibles desde frontend
- **Fix:** Revocar SELECT en columnas encrypted o usar view

### S5 - HIGH: register-user usa username mutable

- **Archivo:** `supabase/functions/register-user/index.ts:45-48`
- **Problema:** Mapeo por username (mutable) en vez de github_user_id (inmutable)
- **Fix:** Buscar instalaciones por owner_id numerico

### S6 - HIGH: Sin rate limiting

- **Archivos:** Todos los edge functions
- **Fix:** Rate limit por user/installation ID

### S7 - HIGH: SSRF via semgrep_service_url

- **Archivo:** `supabase/functions/_shared/static-analysis/semgrep-client.ts:72`
- **Fix:** Validar URL contra allowlist, bloquear IPs privadas

### S8 - HIGH: Inyeccion en filtro search

- **Archivo:** `dashboard/src/lib/hooks/useReviews.ts:61-63`
- **Fix:** Sanitizar caracteres especiales de PostgREST/LIKE

### S9 - MEDIUM: Sin validacion de metodo HTTP

- **Archivos:** `manage-api-keys/index.ts`, `register-user/index.ts`
- **Fix:** Rechazar metodos != POST

### S10 - MEDIUM: Sin security headers

- **Archivos:** Todas las responses de edge functions
- **Fix:** Agregar X-Content-Type-Options, X-Frame-Options, Referrer-Policy

### S11 - MEDIUM: Sin validacion UUID en manage-api-keys

- **Archivo:** `supabase/functions/manage-api-keys/index.ts:56`
- **Fix:** Validar formato UUID antes de query

### S12 - MEDIUM: Sin validacion de formato de API key

- **Archivo:** `supabase/functions/manage-api-keys/index.ts:116-118`
- **Fix:** Validar prefijos por provider (sk-ant-, sk-, AIza)

### S13 - LOW: Non-null assertions en env vars

- **Archivos:** `manage-api-keys/index.ts:40-41`, `register-user/index.ts:28-29`
- **Fix:** Validacion explicita con error descriptivo

---

## 3. PERFORMANCE

### P1 - CRITICAL: Sin timeouts en llamadas LLM

- **Archivos:** `anthropic.ts:153`, `openai.ts:157`, `gemini.ts:149`
- **Impacto:** Puede colgar la funcion 150s
- **Fix:** AbortController con timeout configurable

### P2 - CRITICAL: useStats descarga TODAS las reviews

- **Archivo:** `dashboard/src/lib/hooks/useStats.ts:40-43`
- **Impacto:** Crash con 1000+ reviews
- **Fix:** Agregar filtro temporal y/o limit

### P3 - HIGH: Check enabled despues de toda la inicializacion

- **Archivo:** `supabase/functions/webhook/handlers/pull_request.ts:932`
- **Ahorro:** 750-1600ms cuando disabled
- **Fix:** Mover check antes de credential loading y memory init

### P4 - HIGH: Installation token nunca cacheado

- **Archivo:** `pull_request.ts:264-314`
- **Ahorro:** 300-500ms por warm call

### P5 - HIGH: .ghagga.json re-fetcheado en cada PR

- **Archivo:** `pull_request.ts:376-426`
- **Ahorro:** 200-500ms por call

### P6 - HIGH: Credential loading y memory init secuenciales

- **Archivo:** `pull_request.ts:882-929`
- **Ahorro:** 200-500ms parallelizable

### P7 - HIGH: Observations guardadas una por una

- **Archivo:** `pull_request.ts:1078-1079`
- **Fix:** Batch insert

### P8 - MEDIUM: SELECT * en memory_observations con embeddings

- **Archivo:** `memory/service.ts:213`
- **Fix:** Select solo columnas necesarias

### P9 - MEDIUM: 47 regex AI attribution testeadas individualmente

- **Archivo:** `static-analysis/ai-attribution.ts:11-47`
- **Fix:** Combinar en regex unica

### P10 - MEDIUM: Sin paginacion en GitHub getPullRequestFiles

- **Archivo:** `pull_request.ts:128-137`
- **Fix:** Loop de paginacion con per_page=100

---

## 4. ARQUITECTURA

### A1: pull_request.ts god object (1119 lineas)

Contiene GitHubClient, JWT, config loading, 3 review modes, formatting, memory, static analysis. Deberia extraerse en modulos.

### A2: ReviewService existe pero no se usa

`review/index.ts` tiene ReviewService bien estructurada. El webhook usa funciones inline duplicadas.

### A3: AIProvider definida en 2 lugares incompatibles

`anthropic.ts:17` (con apiKey?) vs `consensus/engine.ts:20` (sin apiKey?). El consensus nunca pasa credenciales per-repo.

### A4: RepoConfig definido 3 veces

`types/database.ts`, `pull_request.ts:37-45`, `useSettings.ts:4-26` - sin mecanismo de sync.

### A5: Supabase client duplicado en hooks

`useMemory.ts` y `useMemoryObservations.ts` crean sus propias instancias.

### A6: fetchRepos descarga todas las reviews para unique names

`useReviews.ts:33-40` - deberia consultar repo_configs.

---

## 5. TESTING

### Cobertura actual

| Area | Source Files | Test Files | Cobertura |
|------|-------------|------------|-----------|
| Backend _shared/ | ~30 | 19 | ~85% modulos |
| Backend Edge Functions | 4 | 5 | ~50% (manage-api-keys + register-user sin tests) |
| Frontend Dashboard | 20+ | 0 | 0% |
| CI test gating | 2 workflows | 0 test steps | Tests no bloquean deploy |

### Gaps criticos sin tests

1. `crypto/encryption.ts` - Bug corrompe TODAS las API keys
2. `manage-api-keys/index.ts` - Auth bypass riesgo
3. `providers/credentials.ts` - Fallo silencioso
4. `register-user/index.ts` - Acceso a repos
5. Todo el frontend (sin framework de tests)
6. CI no ejecuta tests

---

## 6. PLAN DE ACCION (IMPLEMENTADO)

### Wave 1: Bugs + Security Critical - DONE
BUG-1, BUG-2, BUG-3, S1, S2, S3, S4, S8, S9, S10, S11, S12, S13

### Wave 2: Performance Critical - DONE
P1, P2, P3, P10

### Wave 3: Performance High + Security High - DONE
P6, P7, P8, S5, S7

### Wave 4: Architecture Quick Wins - DONE
A3 (unificar AIProvider), A5 (fix Supabase client), A6 (fetchRepos)
