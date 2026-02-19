# GHAGGA - Informe Exhaustivo de Auditoria

**Proyecto:** Multi-Agent GitHub Code Reviewer
**Fecha:** 2026-02-18
**Analistas:** 5 agentes especializados (Security, Code Quality, Database, Frontend, DevOps)

---

## Resumen Ejecutivo

| Area | Criticos | Altos | Medios | Bajos | Total |
|------|----------|-------|--------|-------|-------|
| Seguridad | 4 | 6 | 8 | 5 | 23 |
| Calidad de Codigo | 4 | 8 | 8 | 7 | 27 |
| Base de Datos | 4 | 7 | 11 | 10 | 32 |
| Frontend/Dashboard | 5 | 14 | 18 | 10 | 47 |
| DevOps/CI-CD | 5 | 11 | 10 | 5 | 31 |
| **TOTAL** | **22** | **46** | **55** | **37** | **160** |

---

## TOP 15 HALLAZGOS CRITICOS (Accion Inmediata)

### 1. `AuthProvider` no esta en el arbol de componentes - La app crashea al cargar
- **Archivo:** `dashboard/src/main.tsx`
- `AuthProvider` nunca se renderiza. Todo `useAuth()` lanza error, haciendo la app inusable.

### 2. CORS Wildcard en produccion (`Access-Control-Allow-Origin: *`)
- **Archivo:** `supabase/functions/_shared/cors.ts`
- Cuando `ALLOWED_ORIGINS` esta vacio (default), cualquier sitio puede hacer requests cross-origin autenticados.

### 3. Todas las Edge Functions desplegadas con `--no-verify-jwt`
- **Archivo:** `.github/workflows/deploy-functions.yml:39`
- `manage-api-keys` y `register-user` quedan expuestos sin autenticacion.

### 4. No existe pipeline CI de tests/lint
- **Archivo:** Falta `.github/workflows/ci.yml`
- 21 archivos de test existen pero nunca se ejecutan en CI. Codigo roto puede llegar a produccion.

### 5. `@mantine/charts` se usa pero no esta en `package.json`
- **Archivo:** `dashboard/package.json`
- El build falla o depende de una dependencia transitiva fragil.

### 6. Sin Rate Limiting en ningun endpoint
- **Archivos:** Todos los edge functions
- Sin limites, un atacante puede generar costos ilimitados de LLM API.

### 7. `SECURITY DEFINER` sin `SET search_path` - Escalacion de privilegios
- **Archivo:** `supabase/migrations/010_multi_tenant.sql:50-60`
- `get_user_installation_ids()` vulnerable a hijacking de search_path.

### 8. Container Semgrep corre como root
- **Archivo:** `semgrep-service/Dockerfile`
- Sin instruccion `USER`, combinado con que el endpoint escribe archivos del usuario al filesystem.

### 9. Dockerfile no usa `requirements.txt` - Builds no reproducibles
- **Archivo:** `semgrep-service/Dockerfile:3`
- `pip install` sin pinning. `requirements.txt` existe pero es ignorado.

### 10. No hay Error Boundary en React
- **Archivo:** `dashboard/src/main.tsx`
- Cualquier error de render produce pantalla blanca sin recuperacion.

### 11. N+1 Queries en Hebbian Learning - O(n^2) DB calls
- **Archivo:** `supabase/functions/_shared/hebbian/learner.ts:158-173`
- `strengthenAll()` genera cientos de roundtrips secuenciales a DB por review.

### 12. Imports inconsistentes de `@supabase/supabase-js` (4 fuentes diferentes)
- **Archivos:** Multiples en `supabase/functions/`
- `esm.sh@2.39.0`, `esm.sh@2`, `jsr:@2`, `npm:@2`, bare import. Riesgo de resoluciones incompatibles.

### 13. `ENCRYPTION_KEY` falta en CI secrets
- **Archivo:** `.github/workflows/deploy-functions.yml:42-54`
- La encriptacion de API keys per-repo falla en produccion.

### 14. `.ghagga.json` Config Injection desde PRs
- **Archivo:** `supabase/functions/webhook/handlers/pull_request.ts:385-435`
- Un autor de PR puede forzar consensus mode (costoso), inyectar prompts custom, o overridear cualquier configuracion via spread operator.

### 15. Layout component es dead code - No hay navegacion
- **Archivo:** `dashboard/src/components/Layout/Layout.tsx`
- El Layout con navbar existe pero nunca se usa. Los usuarios no pueden navegar entre paginas.

---

## 1. SEGURIDAD (23 issues)

### Criticos

#### S1: CORS Wildcard Fallback - Acceso Cross-Origin sin restricciones
- **Severidad:** CRITICO (CVSS 9.1)
- **Archivo:** `supabase/functions/_shared/cors.ts:1-16`
- **Descripcion:** Cuando `ALLOWED_ORIGINS` esta vacio (default en `.env.example`), la configuracion CORS cae a `Access-Control-Allow-Origin: *`. Este wildcard se propaga a toda respuesta de edge function via `corsHeaders`. Ademas, `getCorsOrigin()` existe como validador per-request pero **nunca se llama** - todas las funciones usan el objeto estatico `corsHeaders`.
- **Remediacion:**
  - Setear `ALLOWED_ORIGINS` al dominio del dashboard en produccion
  - Reemplazar `corsHeaders` estatico con funcion que llame `getCorsOrigin(req)` por request
  - Agregar `Vary: Origin` header
  - Lanzar error al startup si `ALLOWED_ORIGINS` esta vacio en produccion

#### S2: Sin Rate Limiting en ningun endpoint
- **Severidad:** CRITICO (CVSS 8.6)
- **Archivos:** `webhook/index.ts`, `manage-api-keys/index.ts`, `register-user/index.ts`
- **Descripcion:** Cero rate limiting en toda la aplicacion. Expone a: brute-force de API keys, webhook flood attacks, DoS, y amplificacion de costos LLM (cada review trigger = llamada API de pago).
- **Remediacion:**
  - Implementar rate limiting con Deno KV o Upstash Redis
  - Per-IP limits en webhook (60/min)
  - Per-user limits en manage-api-keys y register-user (10/min)
  - Per-installation daily review caps

#### S3: `get_user_installation_ids()` SECURITY DEFINER sin search_path
- **Severidad:** CRITICO (CVSS 8.2)
- **Archivo:** `supabase/migrations/010_multi_tenant.sql:50-60`
- **Descripcion:** Funcion `SECURITY DEFINER` (ejecuta como postgres) sin `SET search_path`. Un atacante podria crear tabla/funcion maliciosa en schema anterior del search_path para hijackear la query.
- **Remediacion:**
  ```sql
  CREATE OR REPLACE FUNCTION get_user_installation_ids()
  RETURNS SETOF bigint
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $$
    SELECT installation_id
    FROM public.github_user_mappings
    WHERE supabase_user_id = auth.uid()
      AND installation_id IS NOT NULL;
  $$;
  ```

#### S4: Sin validacion de largo maximo en API keys
- **Severidad:** CRITICO (CVSS 7.5)
- **Archivo:** `supabase/functions/manage-api-keys/index.ts:106-114`
- **Descripcion:** Valida prefijo pero no largo maximo. Un atacante puede enviar strings de megabytes que se encriptan y almacenan, causando memory pressure y DB bloat.
- **Remediacion:** Agregar check `api_key.length > 256` y content-length check en request body.

### Altos

#### S5: RLS falta para 6 tablas
- **Severidad:** ALTO (CVSS 7.5)
- **Archivos:** `007_rls_policies.sql`, `010_multi_tenant.sql`
- **Descripcion:** `review_chunks`, `thread_messages`, `thread_contexts`, `hebbian_associations`, `hebbian_patterns`, `hebbian_feedback` tienen RLS habilitado pero solo policies de `service_role`, sin policies para usuarios autenticados.
- **Remediacion:** Agregar SELECT policies tenant-scoped para usuarios autenticados.

#### S6: Webhook Replay Attack
- **Severidad:** ALTO (CVSS 7.1)
- **Archivo:** `supabase/functions/webhook/index.ts:28-80`
- **Descripcion:** Verificacion HMAC-SHA256 correcta pero sin validacion de timestamp o delivery ID. `x-github-delivery` se usa solo para logging, nunca para deduplicacion.
- **Remediacion:** Almacenar delivery IDs procesados con TTL. Rechazar duplicados.

#### S7: `.ghagga.json` Config Injection
- **Severidad:** ALTO (CVSS 7.0)
- **Archivo:** `supabase/functions/webhook/handlers/pull_request.ts:385-435`
- **Descripcion:** `getRepoConfig` lee `.ghagga.json` del HEAD del PR (controlado por el autor). Spread operator `...customConfig` permite override de cualquier propiedad sin validacion. Un PR malicioso puede: forzar consensus mode, inyectar customRules (prompt injection), cambiar provider/model.
- **Remediacion:** Allowlist de campos especificos en vez de spread. Validar tipos y rangos.

#### S8: Sin CSP/HSTS headers
- **Severidad:** ALTO (CVSS 6.5)
- **Archivos:** `_shared/cors.ts`, `dashboard/vite.config.ts`
- **Descripcion:** Faltan `Content-Security-Policy`, `Strict-Transport-Security`, `Permissions-Policy`.
- **Remediacion:** Agregar HSTS y CSP headers en API responses y dashboard.

#### S9: API keys decriptadas sin limpiar de memoria
- **Severidad:** ALTO (CVSS 6.1)
- **Archivo:** `supabase/functions/_shared/providers/credentials.ts:20-66`
- **Descripcion:** Keys plaintext persisten en objetos JS durante toda la duracion del request. Si error handlers loguean el objeto `credentials`, las keys aparecen en logs.
- **Remediacion:** Minimizar ventana de exposicion. Nunca incluir credentials en logs/errors.

#### S10: Trigger bypass via `current_setting`
- **Severidad:** ALTO (CVSS 6.0)
- **Archivo:** `supabase/migrations/010_multi_tenant.sql:159-183`
- **Descripcion:** `prevent_direct_api_key_update()` usa `current_setting('role', true)` que puede ser manipulado. Grant innecesario de EXECUTE a `authenticated`.
- **Remediacion:** Usar `auth.role()` para consistencia con RLS policies. Remover grant innecesario.

### Medios

| # | Problema | Archivo |
|---|----------|---------|
| S11 | `register-user` confia en `user_metadata` sin verificacion adicional | `register-user/index.ts:59-68` |
| S12 | Falta `.env.example` para dashboard | `dashboard/` |
| S13 | SSRF protection incompleta (falta 169.254.169.254, IPv6) | `static-analysis/semgrep-client.ts:68-84` |
| S14 | OpenAI API key regex demasiado permisivo (`/^sk-/` matchea Anthropic) | `manage-api-keys/index.ts:23-27` |
| S15 | Sin limite de tamano en body del webhook | `webhook/index.ts:166` |
| S16 | Datos sensibles en error logs | `providers/credentials.ts:63` |
| S17 | Database functions sin tenant-scoping | `006_indexes_functions.sql:14-169` |
| S18 | CORS origin no varia con request (solo usa primer origin de la lista) | `_shared/cors.ts:10` |

### Bajos

| # | Problema | Archivo |
|---|----------|---------|
| S19 | Deno std library desactualizada (@0.208.0) | `webhook/index.ts:8` |
| S20 | Sin eslint-plugin-security en dashboard | `dashboard/package.json` |
| S21 | OAuth redirect URL hardcodeada a `/ghagga/` | `dashboard/src/lib/supabase.ts:17` |
| S22 | `embedding_cache` table posiblemente sin RLS | `embeddings/cache.ts` |
| S23 | GitHub private key base64 decode error silenciado | `pull_request.ts:284-290` |

---

## 2. CALIDAD DE CODIGO (27 issues)

### Criticos

#### C1: N+1 Database Queries en Hebbian Learning - O(n^2) DB calls por review
- **Severidad:** CRITICO
- **Archivo:** `supabase/functions/_shared/hebbian/learner.ts:158-173`, `review/index.ts:405-418`
- **Descripcion:** `strengthenAll()` itera todas las combinaciones por pares y emite 1 SELECT + 1 INSERT/UPDATE por par. Para un review con 10 conceptos y 20 findings en 15 archivos, genera cientos de roundtrips secuenciales.
- **Remediacion:** Batch-fetch todas las asociaciones existentes en una query, computar diff en memoria, bulk-upsert en una sola llamada.

#### C2: Supabase Client creado en cada request
- **Severidad:** CRITICO
- **Archivo:** `webhook/handlers/installation.ts:24-29`, `pull_request.ts:440-449`
- **Descripcion:** `getSupabaseClient()` duplicado en 2 archivos, crea `createClient()` fresh en cada invocacion.
- **Remediacion:** Exportar singleton lazy desde `_shared/db.ts`.

#### C3: Imports inconsistentes de `@supabase/supabase-js` (4+ fuentes)
- **Severidad:** CRITICO
- **Archivos:** Multiples en `supabase/functions/`
- **Descripcion:** Mismo paquete importado desde `esm.sh@2.39.0`, `esm.sh@2`, `jsr:@2`, `npm:@2`, y bare import. Riesgo de versiones incompatibles en runtime.
- **Remediacion:** Centralizar en `import_map.json` con version pinned unica.

#### C4: `TokenBudgeter` instanciado pero tiene solo metodos static
- **Severidad:** CRITICO
- **Archivo:** `webhook/handlers/pull_request.ts:1021-1030`
- **Descripcion:** `new TokenBudgeter()` cuando todos los metodos son `static`. Ademas, `new SmartChunker()` es dead code (nunca se usa).
- **Remediacion:** Llamar `TokenBudgeter.estimateTokens()` directamente. Eliminar `chunker`.

### Altos

| # | Problema | Archivo |
|---|----------|---------|
| C5 | `RepoConfig` definido 2 veces con formas incompatibles | `pull_request.ts:37` vs `types/database.ts` |
| C6 | `AIProvider` interface definida en `anthropic.ts` (ubicacion incorrecta) | `providers/anthropic.ts:17-23` |
| C7 | `runSimpleReview` duplica logica de `review/simple.ts` | `pull_request.ts:547-589` |
| C8 | `handlePullRequest` es God Function (~280 lineas, 12+ responsabilidades) | `pull_request.ts:852-1134` |
| C9 | Silent key decode failure en `getInstallationAccessToken` | `pull_request.ts:284-291` |
| C10 | `textSearch` en HybridSearch hace fetch client-side (no usa pg_trgm) | `search/hybrid.ts:138-181` |
| C11 | Singleton `ProviderRegistry` inseguro en Edge Functions | `providers/registry.ts:240-257` |
| C12 | Dead branch en `mapFindingToObservationType` | `memory/service.ts:392-417` |

### Medios

| # | Problema | Archivo |
|---|----------|---------|
| C13 | Workflow status detection via string scanning fragil | `workflow/engine.ts:362-378` |
| C14 | Regex con flags duplicados en `extractConcepts` | `hebbian/concepts.ts:163-186` |
| C15 | Type-casting innecesario con `as AssociationType` | `review/index.ts:399-416` |
| C16 | Privacy stripping solo en `content`, no en otros campos | `memory/service.ts:121-167` |
| C17 | `calculateSimilarity` O(n*m) en nested loop | `review/consensus.ts:411-444` |
| C18 | Error silenciado en installation upsert | `installation.ts:48-49` |
| C19 | Race condition en `ThreadManager.addTurn()` | `threads/manager.ts:163-194` |
| C20 | Model name hardcodeado en workflow.ts | `review/workflow.ts:128-133` |

### Bajos

| # | Problema | Archivo |
|---|----------|---------|
| C21 | `LLMCaller` type duplicado en 3 archivos | `simple.ts`, `workflow.ts`, `engine.ts` |
| C22 | `formatReviewComment` duplicado con implementaciones diferentes | `review/index.ts:460`, `pull_request.ts:674` |
| C23 | Magic number en scoring normalization | `hebbian/concepts.ts:179` |
| C24 | `resetProviderRegistry()` pierde registrations silenciosamente | `providers/registry.ts:254-257` |
| C25 | `hashText` usa 32-bit integer hash (colisiones) | `chunking/chunker.ts:169-177` |
| C26 | Regexes stateful a nivel de modulo | `memory/privacy.ts:9,19,48-57` |
| C27 | `buildStaticAnalysisConfig` usa type cast inseguro (siempre usa defaults) | `pull_request.ts:802-813` |

### Resumen Arquitectonico

El problema arquitectonico mas significativo es la **existencia paralela de dos stacks de review**: `review/index.ts` con `ReviewService` (limpio y bien abstraido) y `pull_request.ts` que reimplementa los 3 modos de review inline y nunca usa `ReviewService`. Bug fixes en un path no se propagan al otro.

---

## 3. BASE DE DATOS (32 issues)

### Criticos

#### D1: SECURITY DEFINER sin search_path
- **Severidad:** CRITICO
- **Archivo:** `010_multi_tenant.sql:50-60`
- **Descripcion:** `get_user_installation_ids()` vulnerable a search_path hijacking.
- **Remediacion:** Agregar `SET search_path = public, auth`.

#### D2: `update_hebbian_weight()` sin chequeo de autorizacion
- **Severidad:** CRITICO
- **Archivo:** `006_indexes_functions.sql:115-154`
- **Descripcion:** UPDATE sin validar que el caller esta autorizado para el `assoc_id` especifico. Sin check de NOT FOUND (SELECT INTO retorna NULL silenciosamente).
- **Remediacion:** Agregar tenant scoping via `installation_id` y check `IF NOT FOUND THEN RAISE EXCEPTION`.

#### D3: 6 tablas sin RLS policies para usuarios autenticados
- **Severidad:** CRITICO
- **Archivos:** `007_rls_policies.sql`, `010_multi_tenant.sql`
- **Descripcion:** `review_chunks`, `thread_messages`, `thread_contexts`, `hebbian_associations`, `hebbian_patterns`, `hebbian_feedback` solo tienen policies de `service_role`.
- **Remediacion:** Agregar SELECT policies tenant-scoped para cada tabla.

#### D4: `FOR ALL` policies sin `WITH CHECK` clause
- **Severidad:** CRITICO
- **Archivos:** `007_rls_policies.sql:18-65`, `009_engram_memory.sql:182-188`, `010_multi_tenant.sql:144-146`
- **Descripcion:** Todas las policies de service_role usan `FOR ALL` con solo `USING` sin `WITH CHECK`. Funciona porque `auth.role() = 'service_role'` es identico para reads y writes, pero es defensive coding concern.
- **Remediacion:** Agregar `WITH CHECK (auth.role() = 'service_role')` explicito.

### Altos

| # | Problema | Archivo |
|---|----------|---------|
| D5 | HNSW indexes incluyen NULLs (faltan partial indexes) | `006_indexes_functions.sql:5-11` |
| D6 | HNSW sin tunear (default m=16, ef_construction=64) | `006_indexes_functions.sql:5-11` |
| D7 | Hybrid search mezcla scores incomparables sin normalizar | `006_indexes_functions.sql:77-112` |
| D8 | `prevent_direct_api_key_update()` usa `current_setting` spoofable | `010_multi_tenant.sql:159-179` |
| D9 | Sin unique constraint en `(repo_full_name, pr_number)` | `memory_sessions` |
| D10 | `repo_full_name` denormalizado en 6 tablas sin FK | Multiples migraciones |
| D11 | `installations.id` sin CHECK constraint documentado | `002_core_tables.sql:5` |

### Medios

| # | Problema | Archivo |
|---|----------|---------|
| D12 | Sin enums - todas las columnas tipo usan CHECK con string literals | Todas las migraciones |
| D13 | `reviews.severity` permite NULL inconsistente con `review_type` NOT NULL | `003_reviews_embeddings.sql:13-14` |
| D14 | `thread_contexts.relevance_score` sin CHECK constraint de rango | `004_threads.sql:38` |
| D15 | Index redundante `idx_reviews_repo` (prefix de `idx_reviews_pr`) | `003_reviews_embeddings.sql:34-35` |
| D16 | Index redundante `idx_memory_observations_repo` | `009_engram_memory.sql:98-99` |
| D17 | `memory_observations` tiene `session_id` y `installation_id` - inconsistencia potencial | `009_engram_memory.sql:25-26` |
| D18 | `get_thread_context` usa estimacion `max_tokens / 100` inexacta | `006_indexes_functions.sql:157-169` |
| D19 | Sin `ON UPDATE CASCADE` para `installations.id` | `002_core_tables.sql` |
| D20 | Connection pooler deshabilitado | `config.toml:16-19` |
| D21 | Functions sin `SECURITY INVOKER` explicito | `006_indexes_functions.sql` |
| D22 | `api_keys_configured` desincronizado de columnas encriptadas | `010_multi_tenant.sql:8-11` |

### Bajos

| # | Problema | Archivo |
|---|----------|---------|
| D23 | Migraciones no idempotentes (sin IF NOT EXISTS) | `002-005` |
| D24 | Sin rollback/down migrations | Todas las migraciones |
| D25 | `008_static_analysis.sql` sin header comment | `008_static_analysis.sql` |
| D26 | PostgreSQL 15 (16 tiene mejoras para HNSW) | `config.toml:14` |
| D27 | Sin `COMMENT ON TABLE/COLUMN` | Todas las migraciones |
| D28 | Uso inconsistente de `float` vs `real` vs `double precision` | Multiples |
| D29 | `semgrep_service_url` default '' en vez de NULL | `008_static_analysis.sql:8` |
| D30 | Dependencia implicita de trigger en funcion de migracion anterior | `010_multi_tenant.sql:43-45` |
| D31 | Index redundante `idx_hebbian_patterns_hash` | `005_hebbian.sql:58,66` |
| D32 | Sin grants explicitos de tabla (depende de defaults de Supabase) | `007_rls_policies.sql` |

---

## 4. FRONTEND / DASHBOARD (47 issues)

### Criticos

#### F1: AuthProvider no esta en el arbol de componentes
- **Severidad:** CRITICO
- **Archivo:** `dashboard/src/main.tsx:11-18`
- **Descripcion:** `AuthProvider` nunca se renderiza. `useAuth()` lanza `"useAuth must be used within an AuthProvider"`, crasheando toda la app.
- **Remediacion:** Agregar `<AuthProvider>` dentro de `<BrowserRouter>` wrapping `<App />`.

#### F2: `@mantine/charts` usado pero no declarado en package.json
- **Severidad:** CRITICO
- **Archivos:** `dashboard/package.json`, `main.tsx:9`, `Dashboard.tsx:2`
- **Descripcion:** `AreaChart` y su CSS se importan pero el paquete no esta en dependencies.
- **Remediacion:** `npm install @mantine/charts`

#### F3: Sin Error Boundary
- **Severidad:** CRITICO
- **Archivo:** `dashboard/src/main.tsx`
- **Descripcion:** Ningun Error Boundary en la aplicacion. Error de render = pantalla blanca.
- **Remediacion:** Agregar `react-error-boundary` wrapping `<App />`.

#### F4: Table rows clickeables sin soporte de teclado
- **Severidad:** CRITICO
- **Archivo:** `dashboard/src/components/ReviewTable/ReviewTable.tsx:104-107`
- **Descripcion:** `<Table.Tr>` con `onClick` y `cursor: pointer` pero sin `tabIndex`, `role="button"`, `onKeyDown`, ni `aria-label`. Usuarios de teclado no pueden acceder.
- **Remediacion:** Agregar `tabIndex={0}`, `role="button"`, `onKeyDown` handler.

#### F5: (Repetido A-01/R-04 del reporte de frontend - ya cubierto en F1)

### Altos

| # | Problema | Archivo |
|---|----------|---------|
| F5 | Layout component es dead code - sin navegacion | `Layout.tsx` con `<Outlet />` nunca usado |
| F6 | Nav items no coinciden con rutas definidas | `Layout.tsx:20-26` vs `App.tsx` |
| F7 | `register-user` falla silenciosamente en auth | `AuthContext.tsx:47-53` |
| F8 | OAuth redirect hardcodeado a `/ghagga/` | `supabase.ts:17` |
| F9 | Sin lazy loading de rutas | `App.tsx:1-7` |
| F10 | Loop infinito potencial en Reviews search effect | `Reviews.tsx:87-94` |
| F11 | Type assertion `as Review[]` sin validacion | `useStats.ts:52` |
| F12 | Sin ESLint config a pesar de lint script | `dashboard/` |
| F13 | Race condition en `useStats` - sin cancelacion de fetches | `useStats.ts:35-73` |
| F14 | Settings repo cards clickeables sin keyboard support | `Settings.tsx:457-509` |
| F15 | StatsCard con hover animation pero no interactivo | `StatsCard.tsx` |
| F16 | Sin error handling en API key save/remove | `Settings.tsx:70-80` |
| F17 | Vite config usa `process.env` (correcto pero confuso) | `vite.config.ts:8` |
| F18 | Sin `build.rollupOptions.output.manualChunks` | `vite.config.ts` |

### Medios

| # | Problema | Archivo |
|---|----------|---------|
| F19 | ProtectedRoute re-wraps en Fragment innecesario | `ProtectedRoute.tsx:25` |
| F20 | ProtectedRoute duplicado en cada ruta | `App.tsx:14-54` |
| F21 | HebbianTab type filter Select no funcional | `Memory.tsx:176-181` |
| F22 | `useStats` fetchStats sin useCallback | `useStats.ts:35` |
| F23 | Optimistic update sin rollback en `useSettings` | `useSettings.ts:109-117` |
| F24 | `selectSession` sin loading state | `useMemoryObservations.ts:170-180` |
| F25 | Sin session expiry/refresh handling | `AuthContext.tsx:30-57` |
| F26 | Login no maneja OAuth errors | `Login.tsx:18-20` |
| F27 | Supabase client sin type parameter | `supabase.ts:11` |
| F28 | `Partial<RepoConfig>` permite update de campos read-only | `useSettings.ts:96` |
| F29 | `handleSelectChange` type demasiado amplio | `Settings.tsx:173` |
| F30 | useStats fetches 1000 reviews para stats client-side | `useStats.ts:40-46` |
| F31 | useMemory fetchStats fetches todas las associations | `useMemory.ts:89-154` |
| F32 | Search inputs sin labels asociados | `Reviews.tsx:120-126` |
| F33 | Sin skip navigation link | `index.html` |
| F34 | Color-only status indication | `ReviewTable.tsx:122-125` |
| F35 | Sin confirmacion para acciones destructivas (remove key) | `Settings.tsx:126-135` |
| F36 | Sin toast/notification system | Toda la app |

### Bajos

| # | Problema | Archivo |
|---|----------|---------|
| F37 | `formatTimeAgo` duplicada en 2 archivos | `AssociationCard.tsx`, `ObservationCard.tsx` |
| F38 | `statusColors` y `formatDate` duplicados | `ReviewTable.tsx`, `Reviews.tsx` |
| F39 | searchMemory solo filtra client-side | `useMemoryObservations.ts:182-184` |
| F40 | Non-null assertion en `getElementById('root')` | `main.tsx:11` |
| F41 | Sin 404 / catch-all route | `App.tsx` |
| F42 | Pagination muestra rango incorrecto cuando pagina vacia | `ReviewTable.tsx:144-148` |
| F43 | Modal close button sin label descriptivo | `Reviews.tsx:156-160` |
| F44 | `formatTimeAgo` sin full datetime para screen readers | `AssociationCard.tsx`, `ObservationCard.tsx` |
| F45 | Dashboard dice "All time reviews" pero son 90 dias | `Dashboard.tsx:54` |
| F46 | Sin path aliases configurados | `tsconfig.json`, `vite.config.ts` |

---

## 5. DEVOPS / CI-CD (31 issues)

### Criticos

#### O1: Sin pipeline CI de tests/lint
- **Severidad:** CRITICO
- **Archivo:** Falta `.github/workflows/ci.yml`
- **Descripcion:** 21 archivos de test + lint script existen pero **ningun workflow los ejecuta**. Codigo roto puede llegar a main y desplegarse directamente a produccion.
- **Remediacion:** Crear `.github/workflows/ci.yml` con jobs para Dashboard (lint + typecheck), Supabase Functions (deno test), y Semgrep Service (pytest).

#### O2: `--no-verify-jwt` en todas las functions
- **Severidad:** CRITICO
- **Archivo:** `.github/workflows/deploy-functions.yml:39`
- **Descripcion:** `supabase functions deploy --no-verify-jwt` deshabilita verificacion JWT en TODAS las funciones. Solo `webhook` necesita esto.
- **Remediacion:** Desplegar cada funcion individualmente:
  ```yaml
  supabase functions deploy webhook --no-verify-jwt
  supabase functions deploy review
  supabase functions deploy manage-api-keys
  supabase functions deploy register-user
  ```

#### O3: Container Semgrep corre como root
- **Severidad:** CRITICO
- **Archivo:** `semgrep-service/Dockerfile:1-10`
- **Descripcion:** Sin instruccion `USER`. El endpoint escribe contenido del usuario al filesystem como root.
- **Remediacion:** Agregar `RUN useradd --create-home appuser && USER appuser`.

#### O4: Dependencies sin pinning en Dockerfile
- **Severidad:** CRITICO
- **Archivo:** `semgrep-service/Dockerfile:3`
- **Descripcion:** `pip install semgrep fastapi uvicorn` sin version pins. `requirements.txt` existe pero es ignorado.
- **Remediacion:** `COPY requirements.txt /app/ && pip install -r requirements.txt`.

#### O5: `ENCRYPTION_KEY` falta en CI secrets
- **Severidad:** CRITICO
- **Archivo:** `.github/workflows/deploy-functions.yml:42-54`
- **Descripcion:** `.env.example` lista `ENCRYPTION_KEY` pero CI workflow no lo incluye en `supabase secrets set`.
- **Remediacion:** Agregar `ENCRYPTION_KEY="${{ secrets.ENCRYPTION_KEY }}"`.

### Altos

| # | Problema | Archivo |
|---|----------|---------|
| O6 | Sin `permissions` block en deploy-functions (defaults a full read/write) | `deploy-functions.yml` |
| O7 | Supabase CLI sin version pinned (`version: latest`) | `deploy-functions.yml:30` |
| O8 | Secrets expuestos como env a todos los steps | `deploy-functions.yml:13-16` |
| O9 | Sin concurrency control en deploy workflow | `deploy-functions.yml` |
| O10 | Sin `.dockerignore` | `semgrep-service/` |
| O11 | Sin multi-stage build en Dockerfile | `semgrep-service/Dockerfile` |
| O12 | Path traversal en scan endpoint | `semgrep-service/main.py:133-136` |
| O13 | Sin autenticacion en scan endpoint | `semgrep-service/main.py:123-124` |
| O14 | Sin `.env.production` o separacion por ambiente | `supabase/.env.example` |
| O15 | `SEMGREP_SERVICE_URL` no incluido en CI secrets | `deploy-functions.yml` |
| O16 | Import map usa major version sin pin | `import_map.json:3` |
| O17 | `.gitignore` sin entries para `*.pem`, `*.key` | `.gitignore` |
| O18 | Sin monitoring/logging/alerting | Proyecto completo |
| O19 | Sin backup strategy documentada | Proyecto completo |

### Medios

| # | Problema | Archivo |
|---|----------|---------|
| O20 | DB migrations sin dry-run ni rollback plan | `deploy-functions.yml:36` |
| O21 | Sin workflow status notifications | `deploy-functions.yml` |
| O22 | Sin build validation (lint/typecheck) antes de deploy pages | `deploy-pages.yml:37-40` |
| O23 | Sin HEALTHCHECK en Dockerfile | `semgrep-service/Dockerfile` |
| O24 | Sin resource limits en Railway | `semgrep-service/railway.toml` |
| O25 | Sin request size limit en scan endpoint | `semgrep-service/main.py:124` |
| O26 | Sin secret rotation strategy documentada | Proyecto completo |
| O27 | Migration files usan numeracion secuencial vs timestamps | `supabase/migrations/` |
| O28 | `semgrep` con floor pin (`>=1.90.0`) no exact | `requirements.txt:3` |
| O29 | `.gitignore` sin coverage/test output directories | `.gitignore` |

### Bajos

| # | Problema | Archivo |
|---|----------|---------|
| O30 | Node.js 20 acercandose a EOL (abril 2026) | `deploy-pages.yml:33` |
| O31 | Base image de Docker sin patch version pinned | `Dockerfile:1` |
| O32 | `healthcheckTimeout` de 30s demasiado generoso | `railway.toml:6` |
| O33 | Analytics deshabilitado en config.toml | `config.toml:68-70` |
| O34 | Sin Dependabot/Renovate configurado | Falta `dependabot.yml` |

---

## HALLAZGOS POSITIVOS (Sin accion requerida)

- Webhook HMAC-SHA256 con constant-time comparison correctamente implementado
- AES-256-GCM encryption usa IVs aleatorios de 12 bytes via Web Crypto API
- JWT authentication verificado via Supabase `getUser()` server-side
- Columnas encriptadas de API keys tienen SELECT revocado para `authenticated`
- Trigger de DB previene updates directos a columnas de API keys
- Sin `dangerouslySetInnerHTML`, `innerHTML`, o `eval` en el dashboard
- Todas las queries de DB usan Supabase client (parametrizado) - sin SQL injection
- Error responses no exponen detalles internos a clientes
- Protected routes correctamente implementadas en React dashboard
- SSRF protection basica implementada en Semgrep client

---

## PLAN DE REMEDIACION PRIORIZADO

### Fase 1: Bloqueadores Criticos (Pre-deploy)
1. Agregar `AuthProvider` a `main.tsx`
2. Fijar CORS: setear `ALLOWED_ORIGINS`, usar per-request validation
3. Desplegar functions individualmente (solo `webhook` con `--no-verify-jwt`)
4. Agregar `ENCRYPTION_KEY` a CI secrets
5. Agregar `@mantine/charts` a `package.json`
6. Agregar Error Boundary
7. Agregar `SET search_path` a funciones `SECURITY DEFINER`

### Fase 2: Seguridad Alta (Semana 1-2)
8. Implementar rate limiting (Upstash Redis o Deno KV)
9. Fix Dockerfile: requirements.txt, non-root user, .dockerignore
10. Crear CI pipeline (tests + lint + typecheck)
11. Unificar imports de `@supabase/supabase-js`
12. Allowlist campos de `.ghagga.json`
13. Agregar webhook replay deduplication
14. Agregar HSTS/CSP headers
15. Fix `.gitignore` para `*.pem`, `*.key`

### Fase 3: Calidad y Performance (Semana 3-4)
16. Refactorizar `handlePullRequest` (extraer funciones)
17. Usar `ReviewService` en vez de logica inline
18. Batch Hebbian learning queries
19. Agregar partial HNSW indexes
20. Normalizar hybrid search scores
21. Wiring Layout component + fix navigation
22. Agregar lazy loading de rutas
23. Agregar RLS policies para tablas faltantes

### Fase 4: Mejoras Continuas (Mes 2+)
24. Agregar monitoring (Sentry)
25. Configurar Dependabot
26. Documentar secret rotation
27. Agregar notification system (toasts)
28. Agregar accesibilidad (keyboard nav, ARIA labels)
29. Generar Supabase types (`supabase gen types typescript`)
30. Agregar database backup verification

---

## Compliance Assessment

| Framework | Status | Notas |
|-----------|--------|-------|
| OWASP Top 10 | Parcial | A01 (Broken Access Control): RLS bien disenado con gaps. A02 (Crypto): AES-256-GCM ok. A03 (Injection): SQL parametrizado. A05 (Misconfiguration): CORS wildcard critico. A07 (Rate Limiting): No implementado. |
| SOC 2 | No cumple | Falta rate limiting (Availability), audit logging incompleto, sin incident response plan. |
| GDPR | Parcial | API keys encriptadas at rest (bien). Sin data retention policies. Sin mecanismo de data deletion documentado. |
