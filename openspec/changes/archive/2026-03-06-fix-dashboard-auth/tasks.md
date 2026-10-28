# Tasks: Fix Dashboard Authentication — Web Flow OAuth + Stale Mapping Cleanup

Refs: proposal.md, specs/dashboard-auth/spec.md, design.md

## Orden de despliegue

- **Fase 1 + 2** pueden desplegarse ANTES de Fase 3-4 (el fix de stale mappings es independiente del Web Flow)
- **Fase 3** (server) debe desplegarse ANTES de Fase 4 (dashboard necesita los endpoints del server)
- **T3.3** es un paso manual en Render, no un cambio de código
- Cada tarea es un commit atómico e independiente

---

## Phase 1: Database Foundation (sin breaking changes)

- [x] **T1.1**: Migración DB — cambiar UNIQUE constraint de `(github_user_id)` a `(github_user_id, installation_id)` [R11]
  - **Files**: `packages/db/drizzle/0004_fix_user_mapping_constraint.sql` (crear), `packages/db/src/schema.ts`
  - **What**: Crear archivo SQL de migración que: (1) `DROP CONSTRAINT "github_user_mappings_github_user_id_unique"`, (2) `ADD CONSTRAINT "uq_user_installation" UNIQUE ("github_user_id", "installation_id")`. En `schema.ts`: eliminar `.unique()` de `githubUserId` (línea 183), agregar `unique('uq_user_installation').on(t.githubUserId, t.installationId)` en la función de tabla. Importar `unique` de `drizzle-orm/pg-core`.
  - **Verify**: La migración ejecuta sin errores contra la DB. El schema refleja el constraint compuesto. Insertar dos mappings con mismo `github_user_id` pero distinto `installation_id` funciona. Insertar duplicado `(github_user_id, installation_id)` falla con constraint violation.
  - **Depends on**: Ninguna
  - **Scenarios**: S-R11.1, S-R11.4, S-MIG3

- [x] **T1.2**: Actualizar `upsertUserMapping` para usar composite key [R11]
  - **Files**: `packages/db/src/queries.ts`
  - **What**: Modificar `upsertUserMapping` (línea 493-517): cambiar la búsqueda de `WHERE github_user_id = ?` a `WHERE github_user_id = ? AND installation_id = ?`. El upsert ahora busca por la combinación `(githubUserId, installationId)`. Si existe, actualiza `github_login`. Si no existe, inserta nuevo registro.
  - **Verify**: Test: `upsertUserMapping(db, { githubUserId: 100, githubLogin: 'john', installationId: 5 })` seguido de `upsertUserMapping(db, { githubUserId: 100, githubLogin: 'john', installationId: 7 })` crea DOS registros (no sobreescribe). Llamar de nuevo con `installationId: 5` actualiza el existente.
  - **Depends on**: T1.1
  - **Scenarios**: S-R11.2, S-R11.3

- [x] **T1.3**: Agregar query functions para mappings: `getRawMappingsByUserId`, `deleteStaleUserMappings`, `deleteMappingsByInstallationId` [R9, R10, R12]
  - **Files**: `packages/db/src/queries.ts`
  - **What**: Agregar tres funciones nuevas según las interfaces del design:
    - `getRawMappingsByUserId(db, githubUserId)`: SELECT id, github_user_id, github_login, installation_id FROM github_user_mappings WHERE github_user_id = ?. Retorna mappings SIN filtrar por instalación activa.
    - `deleteStaleUserMappings(db, mappingIds)`: DELETE FROM github_user_mappings WHERE id IN (...). Si `mappingIds` está vacío, no-op.
    - `deleteMappingsByInstallationId(db, installationId)`: DELETE FROM github_user_mappings WHERE installation_id = ?. No-op si no hay registros.
  - **Verify**: Test unitario para cada función. `getRawMappingsByUserId` retorna mappings incluyendo los de instalaciones inactivas. `deleteStaleUserMappings([1,2])` elimina solo esos IDs. `deleteMappingsByInstallationId(5)` elimina todos los mappings de esa instalación.
  - **Depends on**: T1.1
  - **Scenarios**: S-R9.2, S-R9.3, S-R10.1, S-R10.2

- [x] **T1.4**: Actualizar `getInstallationsByUserId` — documentar comportamiento de filtrado por `is_active` [R9, R12]
  - **Files**: `packages/db/src/queries.ts`
  - **What**: La función actual (líneas 519-537) ya filtra por `is_active = true` via JOIN. Agregar JSDoc clarificando este comportamiento y exportar las nuevas funciones del T1.3 desde el barrel export si existe (`packages/db/src/index.ts`).
  - **Verify**: Verificar que la función existente retorna solo instalaciones activas (ya lo hace). Las nuevas funciones son accesibles desde `ghagga-db`.
  - **Depends on**: T1.3

- [x] **T1.5**: Tests para cambios de DB [R11]
  - **Files**: `packages/db/src/__tests__/queries.test.ts` (crear o extender)
  - **What**: Tests Vitest para:
    - `upsertUserMapping` con composite key: insert nuevo, upsert mismo (userId, installationId), insert diferente installationId (S-R11.1, S-R11.2, S-R11.3)
    - `getRawMappingsByUserId`: retorna mappings incluyendo los de instalaciones inactivas
    - `deleteStaleUserMappings`: elimina por IDs, no-op con array vacío
    - `deleteMappingsByInstallationId`: elimina todos, no-op sin registros
  - **Verify**: `pnpm --filter ghagga-db test` pasa. Cubre los escenarios S-R11.1 a S-R11.4.
  - **Depends on**: T1.2, T1.3
  - **Scenarios**: S-R11.1, S-R11.2, S-R11.3, S-R11.4

---

## Phase 2: Stale Mapping Cleanup (corrige el bug de "reinstall")

- [x] **T2.1**: Actualizar auth middleware — detección y limpieza de mappings obsoletos [R9, R12]
  - **Files**: `apps/server/src/middleware/auth.ts`
  - **What**: Refactorizar el bloque de lookup de instalaciones (líneas 83-103):
    1. Obtener mappings RAW con `getRawMappingsByUserId(db, githubUserId)`
    2. Si hay mappings, obtener las instalaciones activas de esos mappings (usar `getInstallationsByUserId` existente que ya filtra)
    3. Comparar: si hay mappings RAW pero la lista de instalaciones activas es más corta → identificar mappings stale (cuyo `installationId` no está en las instalaciones activas)
    4. Eliminar mappings stale con `deleteStaleUserMappings(db, staleIds)`
    5. Si no quedan instalaciones activas tras limpieza → ejecutar `discoverAndMapInstallations()`
    6. Si quedan instalaciones activas → continuar normalmente
       Importar las nuevas funciones de `ghagga-db`.
  - **Verify**: Test con mock DB:
    - Mappings válidos → flujo normal sin cleanup (S-R9.1)
    - Mapping a instalación inactiva → se limpia, se re-descubre (S-R9.2)
    - Mapping a instalación inexistente → se limpia (S-R9.3)
    - Mixto: uno válido, uno stale → solo limpia el stale, no re-descubre (S-R9.4)
    - Todos stale, discovery encuentra nueva → crea mapping nuevo (S-R9.5)
    - Todos stale, discovery no encuentra nada → continúa con [] (S-R12.1)
  - **Depends on**: T1.3, T1.4
  - **Scenarios**: S-R9.1, S-R9.2, S-R9.3, S-R9.4, S-R9.5, S-R12.1, S-R12.2

- [x] **T2.2**: Actualizar webhook handler — limpieza de mappings en `installation.deleted` [R10]
  - **Files**: `apps/server/src/routes/webhook.ts`
  - **What**: En `handleInstallation` (líneas 410-456), dentro del bloque `action === 'deleted'` (línea 444):
    1. Después de `deactivateInstallation(db, installation.id)`, buscar la instalación interna por `github_installation_id` usando `getInstallationByGitHubId(db, installation.id)` (nota: `installation.id` en el webhook es el `github_installation_id`)
    2. Si se encuentra, llamar `deleteMappingsByInstallationId(db, inst.id)` con el `id` interno
    3. Loguear la cantidad de mappings eliminados
       Importar `getInstallationByGitHubId` y `deleteMappingsByInstallationId` de `ghagga-db`.
  - **Verify**: Test: webhook `installation.deleted` con `installation.id=12345` → llama a `deactivateInstallation` Y `deleteMappingsByInstallationId`. Sin mappings asociados → no error (S-R10.2).
  - **Depends on**: T1.3
  - **Scenarios**: S-R10.1, S-R10.2, S-R10.3

- [x] **T2.3**: Tests para middleware y webhook changes [R9, R10, R12]
  - **Files**: `apps/server/src/__tests__/auth-middleware.test.ts` (crear o extender), `apps/server/src/__tests__/webhook.test.ts` (crear o extender)
  - **What**: Tests Vitest con mocks de DB:
    - **Auth middleware**:
      - Mappings válidos → flujo normal, no cleanup (S-R9.1)
      - Mapping a instalación inactiva → cleanup + re-discovery (S-R9.2)
      - Todos stale → cleanup + re-discovery exitoso (S-R9.5, S-R12.1)
      - Mixto → cleanup parcial, sin re-discovery (S-R9.4, S-R12.2) - **Webhook**:
      - `installation.deleted` → deactivate + delete mappings (S-R10.1)
      - `installation.deleted` sin mappings → no error (S-R10.2) - **Backward compatibility**:
      - Token existente (Device Flow) funciona sin cambios (S-CC4.1, S-CC4.2)
  - **Verify**: `pnpm --filter ghagga-server test` pasa. Cobertura de todos los escenarios listados.
  - **Depends on**: T2.1, T2.2
  - **Scenarios**: S-R9.1 a S-R9.5, S-R10.1, S-R10.2, S-R12.1, S-R12.2, S-CC4.1, S-CC4.2

---

## Phase 3: Server OAuth Web Flow

- [x] **T3.1**: Agregar endpoint `GET /auth/login` — generar state HMAC, redirect a GitHub [R1, R2]
  - **Files**: `apps/server/src/routes/oauth.ts`
  - **What**: Dentro de `createOAuthRouter()`:
    1. Agregar helper function `generateState(secret: string): string` — genera `{timestamp_base36}.{hmac_sha256_hex}` usando `createHmac('sha256', secret)` de Node.js crypto
    2. Agregar helper function `validateState(state: string, secret: string): { valid: boolean; error?: string }` — valida formato, HMAC con `timingSafeEqual`, y expiración (5 min)
    3. Agregar `router.get('/auth/login', ...)`:
       - Lee `STATE_SECRET` de `process.env.STATE_SECRET`. Si no existe → HTTP 500 con error de configuración
       - Genera state con `generateState(STATE_SECRET)`
       - Redirige (302) a `https://github.com/login/oauth/authorize` con params: `client_id`, `redirect_uri=https://ghagga.onrender.com/auth/callback`, `scope=public_repo`, `state`
  - **Verify**: Test: `GET /auth/login` responde 302 con Location correcto incluyendo todos los params (S-R1.1). Sin `STATE_SECRET` → 500 (S-R2.5). State generado y validado correctamente (S-R2.1). State expirado falla (S-R2.2). State manipulado falla (S-R2.3).
  - **Depends on**: Ninguna (independiente de Fase 1-2)
  - **Scenarios**: S-R1.1, S-R2.1, S-R2.2, S-R2.3, S-R2.4, S-R2.5, S-R2.6

- [x] **T3.2**: Agregar endpoint `GET /auth/callback` — validar state, intercambiar code, redirect al Dashboard con token [R1, R2, R4, CC1, CC2]
  - **Files**: `apps/server/src/routes/oauth.ts`
  - **What**: Agregar `router.get('/auth/callback', ...)`:
    1. Leer `code` y `state` de query params
    2. Si falta `state` → redirect a Dashboard con `#/auth/callback?error=missing_state`
    3. Si falta `code`: verificar si hay `error=access_denied` de GitHub → redirect con `#/auth/callback?error=access_denied`. Si no → redirect con `#/auth/callback?error=missing_code`
    4. Validar state con `validateState()`. Si inválido → redirect con error correspondiente (`invalid_state`, `state_expired`)
    5. POST a `https://github.com/login/oauth/access_token` con `client_id`, `client_secret` (de `process.env.GITHUB_CLIENT_SECRET`), `code`. Accept: `application/json`
    6. Si `GITHUB_CLIENT_SECRET` no está configurado → redirect con `#/auth/callback?error=server_error`, log error
    7. Si GitHub retorna error → redirect con `#/auth/callback?error=exchange_failed`
    8. Si GitHub no responde (timeout/5xx) → redirect con `#/auth/callback?error=github_unavailable`
    9. Si éxito → redirect (302) a `https://jnzader.github.io/ghagga/app/#/auth/callback?token={access_token}`
    - **Seguridad**: NO loguear `CLIENT_SECRET` ni `access_token`. Solo loguear github_login e installation_ids.
    - **Dashboard URL**: Usar constante `DASHBOARD_URL` (hardcoded por ahora, env var futura).
  - **Verify**: Test con mock fetch:
    - Code válido → 302 con token en fragment (S-R1.2)
    - Code inválido → redirect con error (S-R1.3)
    - Sin code → redirect con error (S-R1.4)
    - State inválido → redirect con error (S-R2.3)
    - State expirado → redirect con error (S-R2.2)
    - Sin state → redirect con error (S-R2.4)
    - Sin CLIENT_SECRET → redirect con error (S-R8.2)
    - GitHub down → redirect con error (S-CC2.2)
    - User deniega auth → redirect con error (S-CC2.1)
    - Token en fragment, no en query params (S-CC1.1)
  - **Depends on**: T3.1
  - **Scenarios**: S-R1.2, S-R1.3, S-R1.4, S-R2.2, S-R2.3, S-R2.4, S-R8.1, S-R8.2, S-CC1.1, S-CC2.1, S-CC2.2, S-CC2.3

- [x] **T3.3**: Agregar `GITHUB_CLIENT_SECRET` y `STATE_SECRET` a `render.yaml` [R8]
  - **Files**: `render.yaml`
  - **What**: Agregar dos nuevas entradas en `envVars`:

    ```yaml
    - key: GITHUB_CLIENT_SECRET
      sync: false
    - key: STATE_SECRET
      sync: false
    ```

    **Paso manual (fuera del código)**: Configurar los valores reales en Render Dashboard. `STATE_SECRET` generar con `openssl rand -hex 32`.
  - **Verify**: `render.yaml` tiene las dos nuevas env vars. Los valores NO están en el archivo (solo `sync: false`).
  - **Depends on**: Ninguna
  - **Scenarios**: S-R8.1, S-R8.3

- [x] **T3.4**: Tests para nuevos endpoints OAuth Web Flow [R1, R2, R6, R8]
  - **Files**: `apps/server/src/__tests__/oauth.test.ts` (crear o extender)
  - **What**: Tests Vitest con Hono test client (`app.request()`):
    - **`generateState` / `validateState`**:
      - State válido dentro de 5 min → OK (S-R2.1)
      - State expirado (mock Date.now) → error (S-R2.2)
      - State con HMAC manipulado → error (S-R2.3)
      - State con formato inválido → error - **`GET /auth/login`**:
      - Responde 302 con Location a GitHub authorize URL (S-R1.1)
      - Incluye client_id, scope, redirect_uri, state
      - Sin STATE_SECRET → 500 (S-R2.5) - **`GET /auth/callback`**:
      - Code válido + state válido → 302 a Dashboard con token en fragment (S-R1.2)
      - Code inválido → redirect con error=exchange_failed (S-R1.3)
      - Sin code → redirect con error=missing_code (S-R1.4)
      - Sin state → redirect con error=missing_state (S-R2.4)
      - State expirado → redirect con error=state_expired (S-R2.2)
      - State manipulado → redirect con error=invalid_state (S-R2.3)
      - Sin CLIENT_SECRET → redirect con error=server_error (S-R8.2)
      - GitHub auth denegada → redirect con error=access_denied (S-CC2.1) - **Device Flow inalterado**:
      - `POST /auth/device/code` sigue funcionando (S-R6.1)
      - `POST /auth/device/token` sigue funcionando (S-R6.2)
  - **Verify**: `pnpm --filter ghagga-server test` pasa. Cobertura >80% en código nuevo.
  - **Depends on**: T3.1, T3.2
  - **Scenarios**: S-R1.1 a S-R1.4, S-R2.1 a S-R2.6, S-R6.1, S-R6.2, S-R8.1, S-R8.2, S-CC2.1

---

## Phase 4: Dashboard Web Flow

- [x] **T4.1**: Crear `AuthCallback.tsx` — extraer token del fragment, validar, guardar, limpiar URL, redirigir [R4, R5, CC1, CC2]
  - **Files**: `apps/dashboard/src/pages/AuthCallback.tsx` (crear)
  - **What**: Nuevo componente React que:
    1. Al montar, extrae query params del hash (`window.location.hash`). Parsear lo que viene después de `?` en el fragment.
    2. Inmediatamente llama `window.history.replaceState(null, '', window.location.pathname + '#/auth/callback')` para limpiar el token de la URL (R5)
    3. Si hay param `token`:
       - Validar con `fetchGitHubUser(token)` de `@/lib/oauth`
       - Si éxito: guardar `ghagga_token` y `ghagga_user` en localStorage
       - Redirigir al destino original (leer de `sessionStorage.getItem('ghagga_redirect_after_login')` o `/` por defecto)
    4. Si hay param `error`: mostrar mensaje descriptivo mapear códigos:
       - `state_expired` → "Tu sesión de login expiró"
       - `invalid_state` → "Error de seguridad"
       - `exchange_failed` → "No se pudo completar la autenticación"
       - `access_denied` → "Has cancelado la autorización"
       - `missing_code` → "Error en la respuesta de GitHub"
       - `github_unavailable` → "GitHub no está disponible"
       - `server_error` → "Error del servidor"
         Mostrar botón "Retry" (→ `/login`) y enlace "Usar Personal Access Token"
    5. Si no hay ni `token` ni `error` → redirect a `/login`
       Usar los estilos existentes de shadcn/tailwind del proyecto.
  - **Verify**: Test Vitest + Testing Library:
    - Token válido → guarda en localStorage, redirige a `/` (S-R4.1)
    - Token inválido → muestra error, no guarda (S-R4.2)
    - Param error → muestra mensaje descriptivo + retry (S-R4.3)
    - Sin params → redirect a /login (S-R4.4)
    - Preserva destino original (S-R4.5)
    - URL limpiada inmediatamente (S-R5.1, S-R5.2)
  - **Depends on**: Ninguna (independiente de server, solo necesita `fetchGitHubUser`)
  - **Scenarios**: S-R4.1, S-R4.2, S-R4.3, S-R4.4, S-R4.5, S-R5.1, S-R5.2, S-CC2.1 a S-CC2.3

- [x] **T4.2**: Actualizar `App.tsx` — agregar ruta pública `/auth/callback` [R4]
  - **Files**: `apps/dashboard/src/App.tsx`
  - **What**:
    1. Agregar lazy import: `const AuthCallback = lazy(() => import('@/pages/AuthCallback').then((m) => ({ default: m.AuthCallback })));`
    2. Agregar ruta PÚBLICA (sin `ProtectedRoute`) ANTES del catch-all `*`:

       ```tsx
       <Route path="/auth/callback" element={<AuthCallback />} />
       ```

    La ruta es pública porque el token aún no está guardado cuando se monta.
  - **Verify**: Navegar a `#/auth/callback` carga el componente sin pedir autenticación. Las rutas protegidas siguen requiriendo auth.
  - **Depends on**: T4.1
  - **Scenarios**: S-R4.1

- [x] **T4.3**: Actualizar `Login.tsx` — reemplazar Device Flow por redirect a `/auth/login`, mantener PAT fallback [R3, R7]
  - **Files**: `apps/dashboard/src/pages/Login.tsx`
  - **What**:
    1. Cuando `serverOnline === true`:
       - El botón "Sign in with GitHub" hace `window.location.href = \`${API_URL}/auth/login\``en vez de`startLogin()`
       - NO mostrar UI de Device Flow (código, polling, instrucciones)
       - Antes del redirect, guardar destino original en `sessionStorage.setItem('ghagga_redirect_after_login', from)`
    2. Importar `API_URL` desde `@/lib/oauth` (necesita ser exportado — ver T4.5)
    3. Eliminar las secciones de `loginPhase === 'requesting_code'`, `loginPhase === 'waiting_for_user'`, y `loginPhase === 'exchanging_token'` del render
    4. Mantener la sección de PAT fallback intacta (`showPatFallback`)
    5. Cuando `serverOnline === false`: mostrar PAT form como actualmente + botón "Retry server connection" (ya existe)
    6. Cuando `serverOnline === null`: spinner "Checking server..." (ya existe)
    7. Actualizar el texto del enlace toggle: "Or enter a Personal Access Token" (ya existe) y en la dirección contraria: "Back to GitHub login" (en vez de "Back to Device Flow login")
  - **Verify**: Test Vitest + Testing Library:
    - Server online → botón redirect, no Device Flow UI (S-R3.1, S-R3.3)
    - Server checking → spinner (S-R3.2)
    - Server offline → PAT form principal (S-R7.1)
    - PAT login funciona sin servidor (S-R7.2)
  - **Depends on**: T4.5 (necesita `API_URL` exportado)
  - **Scenarios**: S-R3.1, S-R3.2, S-R3.3, S-R7.1, S-R7.2

- [x] **T4.4**: Actualizar `auth.tsx` — simplificar AuthProvider, agregar `loginFromCallback` [R3, R4]
  - **Files**: `apps/dashboard/src/lib/auth.tsx`
  - **What**:
    1. Agregar método `loginFromCallback(token: string): Promise<boolean>`:
       - Llama `fetchGitHubUser(token)`
       - Si éxito: guarda token y user en localStorage y state, retorna `true`
       - Si falla: retorna `false`
    2. Eliminar del contexto: `startLogin`, `cancelLogin`, `reAuthenticate`, `loginPhase`, `deviceCode`
    3. Eliminar del state: `loginPhase`, `deviceCode`, `abortController`
    4. Eliminar `LoginPhase` type export
    5. Simplificar `AuthContextType`:

       ```typescript
       interface AuthContextType {
         user: User | null;
         token: string | null;
         isAuthenticated: boolean;
         isLoading: boolean;
         loginFromCallback: (token: string) => Promise<boolean>;
         loginWithToken: (token: string) => Promise<void>;
         logout: () => void;
         error: string | null;
       }
       ```
    6. Eliminar imports de `requestDeviceCode`, `pollForAccessToken`, `DeviceCodeResponse` de `./oauth`
    7. Mantener la validación de token al mount (useEffect con `fetchGitHubUser`)
  - **Verify**: Compilación sin errores. `useAuth()` retorna la interfaz simplificada. `loginFromCallback` guarda credenciales correctamente. `loginWithToken` (PAT) sigue funcionando.
  - **Depends on**: T4.1 (AuthCallback usa `loginFromCallback`)
  - **Scenarios**: S-R3.1, S-CC4.1, S-CC4.2, S-MIG1, S-MIG2

- [x] **T4.5**: Limpiar Device Flow del Dashboard — eliminar código frontend, exportar `API_URL` [R6]
  - **Files**: `apps/dashboard/src/lib/oauth.ts`
  - **What**:
    1. Exportar `API_URL` (actualmente es `const` privado, línea 14). Cambiar a `export const API_URL = ...`
    2. Eliminar funciones `requestDeviceCode` y `pollForAccessToken` (ya no se usan desde el dashboard)
    3. Eliminar types `DeviceCodeResponse`, `AccessTokenResponse`, `DeviceFlowError` (ya no se usan)
    4. Eliminar helper `sleep`
    5. Mantener: `GITHUB_CLIENT_ID`, `API_URL`, `isServerAvailable`, `fetchGitHubUser`, `GitHubUser`
       **Nota**: Los endpoints Device Flow (`POST /auth/device/code`, `POST /auth/device/token`) se mantienen en el SERVIDOR para el CLI (R6). Solo se elimina el código CLIENTE del Dashboard.
  - **Verify**: Compilación del dashboard sin errores (`pnpm --filter ghagga-dashboard build`). `import { API_URL } from '@/lib/oauth'` funciona. Las funciones eliminadas no se importan en ningún otro archivo del dashboard.
  - **Depends on**: T4.4 (auth.tsx ya no importa las funciones eliminadas)
  - **Scenarios**: S-R6.1, S-R6.2

- [x] **T4.6**: Tests para cambios del Dashboard [R3, R4, R5, R7, CC2]
  - **Files**: `apps/dashboard/src/__tests__/AuthCallback.test.tsx` (crear), `apps/dashboard/src/__tests__/Login.test.tsx` (crear o extender)
  - **What**: Tests Vitest + Testing Library:
    - **AuthCallback**:
      - Token válido → guarda en localStorage, redirige (S-R4.1)
      - Token inválido (GitHub 401) → muestra error, botón retry (S-R4.2)
      - Param `error=state_expired` → mensaje descriptivo (S-R4.3)
      - Sin params → redirect a /login (S-R4.4)
      - Preserva destino original de sessionStorage (S-R4.5)
      - `history.replaceState` llamado antes de validación (S-R5.1) - **Login.tsx**:
      - Server online → botón redirect (no Device Flow) (S-R3.1, S-R3.3)
      - Server offline → PAT form (S-R7.1)
      - Server checking → spinner (S-R3.2)
        Mock `fetchGitHubUser`, `window.history.replaceState`, `window.location`.
  - **Verify**: `pnpm --filter ghagga-dashboard test` pasa. Cobertura >80% en código nuevo.
  - **Depends on**: T4.1, T4.3
  - **Scenarios**: S-R3.1 a S-R3.3, S-R4.1 a S-R4.5, S-R5.1, S-R5.2, S-R7.1, S-R7.2, S-CC2.1 a S-CC2.3

---

## Phase 5: Verification & Polish

- [x] **T5.1**: Error handling completo — todos los estados de error en callback [CC2]
  - **Files**: `apps/dashboard/src/pages/AuthCallback.tsx`, `apps/server/src/routes/oauth.ts`
  - **What**: Verificar cobertura completa de errores:
    - Server: todos los caminos de error redirigen con código apropiado (no HTTP 500 con body JSON)
    - Dashboard: todos los códigos de error tienen mensaje descriptivo en español/inglés
    - Cada error muestra opción de retry + fallback PAT
    - Errores no previstos muestran mensaje genérico con retry
    - Server no loguea `CLIENT_SECRET` ni `access_token` en ningún caso (S-SEC3)
  - **Verify**: Revisión manual de todos los caminos de error. Verificar que no hay pantallas en blanco ni errores técnicos al usuario.
  - **Depends on**: T3.2, T4.1
  - **Scenarios**: S-CC2.1, S-CC2.2, S-CC2.3, S-SEC3

- [x] **T5.2**: Cross-verificar backward compatibility — tokens existentes, CLI Device Flow [CC4]
  - **Files**: N/A (verificación, no cambio de código)
  - **What**: Verificar manualmente o con tests:
    - Token existente en localStorage sigue funcionando (S-CC4.1, S-MIG1, S-MIG2)
    - Auth middleware acepta tokens de cualquier origen (Web Flow, Device Flow, PAT) (S-CC4.2)
    - Device Flow endpoints del servidor sin cambios (S-R6.1, S-R6.2)
    - No se requiere re-login tras deploy
  - **Verify**: Tests de integración o verificación manual. Todos los tokens previos siguen funcionando.
  - **Depends on**: T2.3, T3.4, T4.6
  - **Scenarios**: S-CC4.1, S-CC4.2, S-R6.1, S-R6.2, S-MIG1, S-MIG2

- [x] **T5.3**: Documentación del deploy — guía para CLIENT_SECRET y STATE_SECRET
  - **Files**: Actualizar documentación existente si la hay, o notas en el PR
  - **What**: Documentar los pasos manuales necesarios para el deploy:
    1. Configurar callback URL en GitHub OAuth App Settings: `https://ghagga.onrender.com/auth/callback`
    2. Agregar `GITHUB_CLIENT_SECRET` en Render Dashboard (valor del OAuth App)
    3. Agregar `STATE_SECRET` en Render Dashboard (generar con `openssl rand -hex 32`)
    4. Ejecutar migración DB `0004_fix_user_mapping_constraint.sql` antes del deploy
    5. Deploy order: DB migration → Server → Dashboard
  - **Verify**: Las instrucciones son claras y completas. Un developer nuevo puede seguirlas.
  - **Depends on**: T3.3

---

## Resumen de Coverage por Requisito

| Requisito                     | Tareas           |
| ----------------------------- | ---------------- |
| R1 (Web Flow Endpoints)       | T3.1, T3.2, T3.4 |
| R2 (State HMAC)               | T3.1, T3.2, T3.4 |
| R3 (Dashboard Login)          | T4.3, T4.4, T4.6 |
| R4 (Callback Route)           | T4.1, T4.2, T4.6 |
| R5 (Clean URL)                | T4.1, T4.6       |
| R6 (Device Flow Preservation) | T4.5, T3.4, T5.2 |
| R7 (PAT Fallback)             | T4.3, T4.6       |
| R8 (CLIENT_SECRET Config)     | T3.2, T3.3, T3.4 |
| R9 (Stale Mapping Cleanup)    | T1.3, T2.1, T2.3 |
| R10 (Webhook Cleanup)         | T1.3, T2.2, T2.3 |
| R11 (DB Constraint)           | T1.1, T1.2, T1.5 |
| R12 (Re-Discovery Resiliente) | T1.3, T2.1, T2.3 |
| CC1 (Token en Fragment)       | T3.2, T4.1       |
| CC2 (Error Handling)          | T3.2, T4.1, T5.1 |
| CC3 (UX Un Click)             | T4.3             |
| CC4 (Backward Compat)         | T2.3, T5.2       |
