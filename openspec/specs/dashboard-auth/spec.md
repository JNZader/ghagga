# Dashboard Authentication Specification

## Purpose

Esta especificación define los requisitos y escenarios para la autenticación del Dashboard de GHAGGA, cubriendo dos áreas principales: (1) la migración de OAuth Device Flow a OAuth Web Flow para el login del Dashboard, y (2) la corrección de mappings de instalación obsoletos que causan reinstalaciones fantasma de la GitHub App.

Todos los requisitos son cambios de código en servidor, dashboard y base de datos. No se modifican los flujos del CLI ni del GitHub Action.

---

## Requirements

### R1 (P0): Server — Endpoints OAuth Web Flow

El servidor Hono MUST implementar dos nuevos endpoints públicos (sin auth middleware) para el OAuth Web Flow:

1. **`GET /auth/login`** — MUST redirigir al usuario a `https://github.com/login/oauth/authorize` con los parámetros:
   - `client_id`: El Client ID de la OAuth App de GHAGGA (`Ov23liyYpSgDqOLUFa5k`)
   - `redirect_uri`: La URL de callback del servidor (`https://api.javierzader.com/auth/callback`)
   - `scope`: `public_repo`
   - `state`: Parámetro HMAC-signed (ver R2)
2. **`GET /auth/callback`** — MUST recibir `code` y `state` de GitHub, validar el state (ver R2), intercambiar el code por un access_token via `POST https://github.com/login/oauth/access_token` usando `CLIENT_ID` + `CLIENT_SECRET`, y redirigir al Dashboard con el token en el URL fragment.

El redirect al Dashboard MUST usar el formato: `https://jnzader.github.io/ghagga/app/#/auth/callback?token={access_token}`.

El endpoint `/auth/callback` MUST responder con HTTP 302 (redirect) en caso de éxito, no con un body JSON.

Los endpoints MUST NOT requerir autenticación previa (son usados ANTES del login).

#### Scenario: S-R1.1 — Login redirect exitoso

- GIVEN un usuario no autenticado en el Dashboard
- WHEN el navegador hace `GET /auth/login`
- THEN el servidor responde con HTTP 302
- AND el header `Location` contiene `https://github.com/login/oauth/authorize`
- AND la URL incluye `client_id=Ov23liyYpSgDqOLUFa5k`
- AND la URL incluye `scope=public_repo`
- AND la URL incluye un parámetro `state` no vacío
- AND la URL incluye `redirect_uri=https://api.javierzader.com/auth/callback`

#### Scenario: S-R1.2 — Callback intercambia code por token y redirige

- GIVEN que GitHub redirige al usuario a `/auth/callback?code=abc123&state=valid_state`
- WHEN el servidor recibe la request
- THEN el servidor valida el `state` (ver R2)
- AND el servidor hace `POST https://github.com/login/oauth/access_token` con `client_id`, `client_secret`, y `code`
- AND recibe un `access_token` válido de GitHub
- AND el servidor responde con HTTP 302
- AND el header `Location` es `https://jnzader.github.io/ghagga/app/#/auth/callback?token={access_token}`

#### Scenario: S-R1.3 — Callback con code inválido de GitHub

- GIVEN que GitHub redirige al usuario a `/auth/callback?code=invalid&state=valid_state`
- WHEN el servidor intenta intercambiar el code por un token
- AND GitHub responde con error (code expirado, ya usado, o inválido)
- THEN el servidor redirige al Dashboard con un parámetro de error en el fragment
- AND el redirect MUST ser `https://jnzader.github.io/ghagga/app/#/auth/callback?error=exchange_failed`

#### Scenario: S-R1.4 — Callback sin parámetro code

- GIVEN que un request llega a `/auth/callback` sin el parámetro `code`
- WHEN el servidor procesa la request
- THEN el servidor redirige al Dashboard con error: `#/auth/callback?error=missing_code`

---

### R2 (P0): State Parameter — Seguridad CSRF con HMAC

El parámetro `state` del flujo OAuth MUST ser stateless y basado en HMAC para prevenir ataques CSRF. El servidor MUST NOT almacenar state en memoria, sesión, ni base de datos (MUST sobrevivir deploys y restarts en Render).

La implementación MUST cumplir:

1. **Generación**: El state MUST ser un string que contenga un timestamp y una firma HMAC-SHA256 calculada con un `STATE_SECRET` (variable de entorno). Formato sugerido: `{timestamp}.{hmac_signature}`.
2. **Expiración**: El state MUST incluir un timestamp que permita validar expiración. El state MUST expirar tras 5 minutos.
3. **Validación**: En `/auth/callback`, el servidor MUST verificar que: (a) la firma HMAC es válida, (b) el timestamp no ha expirado (≤5 minutos).
4. **Secret**: `STATE_SECRET` MUST ser una variable de entorno en Render. MUST NOT estar en código, `.env.example`, ni commiteado. Si `STATE_SECRET` no está configurado, el endpoint `/auth/login` MUST responder con HTTP 500.

#### Scenario: S-R2.1 — State válido y dentro del tiempo

- GIVEN que el servidor generó un state hace 2 minutos
- WHEN el callback recibe ese state
- THEN la validación HMAC es exitosa
- AND el timestamp no ha expirado
- AND el flujo continúa normalmente

#### Scenario: S-R2.2 — State expirado (más de 5 minutos)

- GIVEN que el servidor generó un state hace 6 minutos
- WHEN el callback recibe ese state
- THEN la validación de timestamp falla
- AND el servidor redirige al Dashboard con `#/auth/callback?error=state_expired`

#### Scenario: S-R2.3 — State manipulado (HMAC inválido)

- GIVEN que un atacante modifica el timestamp o la firma del state
- WHEN el callback recibe el state manipulado
- THEN la validación HMAC falla
- AND el servidor redirige al Dashboard con `#/auth/callback?error=invalid_state`

#### Scenario: S-R2.4 — State ausente en callback

- GIVEN que la request a `/auth/callback` no incluye parámetro `state`
- WHEN el servidor procesa la request
- THEN el servidor redirige al Dashboard con `#/auth/callback?error=missing_state`

#### Scenario: S-R2.5 — STATE_SECRET no configurado

- GIVEN que la variable de entorno `STATE_SECRET` no está definida
- WHEN un usuario accede a `GET /auth/login`
- THEN el servidor responde con HTTP 500
- AND el body indica un error de configuración del servidor

#### Scenario: S-R2.6 — State sobrevive restart del servidor

- GIVEN que el servidor Render se reinicia (cold start) entre la generación del state y el callback
- WHEN el callback recibe el state generado antes del restart
- THEN la validación HMAC es exitosa (porque el secret es el mismo env var)
- AND el flujo continúa normalmente

---

### R3 (P0): Dashboard — Login con Web Flow

`Login.tsx` MUST reemplazar el flujo de Device Flow por un redirect al endpoint `/auth/login` del servidor cuando el servidor está disponible.

1. Cuando `serverOnline === true`, el botón principal "Sign in with GitHub" MUST redirigir a `{API_URL}/auth/login` via `window.location.href` (no `fetch`, no popup).
2. Login.tsx MUST NOT mostrar la UI de Device Flow (código de usuario, polling, instrucciones de github.com/login/device).
3. Login.tsx MUST conservar el enlace secundario "Or enter a Personal Access Token" como fallback.
4. Login.tsx MUST conservar la verificación de disponibilidad del servidor (`isServerAvailable()`).

#### Scenario: S-R3.1 — Usuario hace click en "Sign in with GitHub"

- GIVEN que el servidor está disponible (`serverOnline === true`)
- AND el usuario está en la página de login
- WHEN el usuario hace click en "Sign in with GitHub"
- THEN el navegador navega a `{API_URL}/auth/login`
- AND NO se muestra ningún código de dispositivo
- AND NO se abre una nueva pestaña

#### Scenario: S-R3.2 — Servidor verificándose al cargar

- GIVEN que Login.tsx se monta por primera vez
- WHEN `isServerAvailable()` aún no ha respondido (`serverOnline === null`)
- THEN se muestra un indicador de carga ("Checking server...")
- AND el botón de login NO está disponible aún

#### Scenario: S-R3.3 — Login.tsx no muestra flujo Device Flow

- GIVEN que el Dashboard tiene el nuevo flujo Web Flow implementado
- WHEN el usuario accede a `/login` con el servidor disponible
- THEN NO hay ningún elemento que muestre `user_code`, `verification_uri`, ni instrucciones de Device Flow
- AND NO hay polling activo al endpoint `/auth/device/token`

---

### R4 (P0): Dashboard — Callback Route y Extracción de Token

El Dashboard MUST implementar una nueva ruta `#/auth/callback` que procese el token recibido del servidor.

1. El HashRouter del Dashboard MUST incluir la ruta `/auth/callback`.
2. Un componente `AuthCallback` MUST extraer los query params del URL fragment (después del `#`).
3. Si existe un parámetro `token`, el componente MUST:
   a. Validar el token llamando a `GET https://api.github.com/user`
   b. En caso de éxito: guardar el token y la info del usuario en `localStorage` (keys: `ghagga_token`, `ghagga_user`)
   c. Redirigir al destino original (o `/` por defecto)
4. Si existe un parámetro `error`, el componente MUST mostrar un mensaje de error descriptivo con opción de reintentar.
5. Tras extraer el token del fragment, el componente MUST limpiar la URL usando `window.history.replaceState()` para eliminar el token de la barra de direcciones y el historial del navegador (ver R12).

#### Scenario: S-R4.1 — Callback exitoso con token válido

- GIVEN que el servidor redirigió al Dashboard a `#/auth/callback?token=gho_abc123`
- WHEN el componente `AuthCallback` se monta
- THEN extrae `token=gho_abc123` del URL fragment
- AND llama a `GET https://api.github.com/user` con el token
- AND GitHub responde con éxito (login, id, avatar_url)
- AND guarda `ghagga_token` y `ghagga_user` en `localStorage`
- AND limpia el token de la URL con `history.replaceState()`
- AND redirige a `/`

#### Scenario: S-R4.2 — Callback con token inválido

- GIVEN que el servidor redirigió con un token corrupto a `#/auth/callback?token=invalid`
- WHEN el componente `AuthCallback` valida el token contra GitHub API
- AND GitHub responde con 401 (Unauthorized)
- THEN el componente muestra un mensaje de error: "Token inválido. Por favor, intenta de nuevo."
- AND muestra un botón "Retry" que redirige a `/login`
- AND NO guarda nada en `localStorage`

#### Scenario: S-R4.3 — Callback con parámetro de error

- GIVEN que el servidor redirigió con `#/auth/callback?error=state_expired`
- WHEN el componente `AuthCallback` se monta
- THEN muestra un mensaje descriptivo: "Tu sesión de login expiró. Por favor, intenta de nuevo."
- AND muestra un botón "Retry" que redirige a `/login`
- AND muestra un enlace a "Usar Personal Access Token" como alternativa

#### Scenario: S-R4.4 — Callback sin token ni error

- GIVEN que alguien accede directamente a `#/auth/callback` sin parámetros
- WHEN el componente `AuthCallback` se monta
- THEN redirige inmediatamente a `/login`

#### Scenario: S-R4.5 — Callback preserva destino original

- GIVEN que un usuario no autenticado intentó acceder a `/settings`
- AND `ProtectedRoute` lo redirigió a `/login` con `state.from = '/settings'`
- AND el usuario completó el Web Flow
- WHEN el componente `AuthCallback` recibe un token válido
- THEN tras guardar las credenciales, redirige a `/settings` (no a `/`)

---

### R5 (P0): Limpieza de URL Post-Autenticación

Tras extraer el token del URL fragment, el Dashboard MUST eliminar el token de la barra de direcciones del navegador de forma inmediata.

1. `AuthCallback` MUST llamar a `window.history.replaceState()` para reemplazar la URL actual por `#/auth/callback` (sin query params) o directamente por la URL de destino.
2. La eliminación MUST ocurrir ANTES de cualquier redirección y lo antes posible tras extraer el token.
3. El token MUST NOT permanecer visible en la barra de direcciones por más de un frame de renderizado.

#### Scenario: S-R5.1 — Token eliminado de la URL inmediatamente

- GIVEN que el componente `AuthCallback` extrajo el token del fragment
- WHEN comienza la validación del token
- THEN `window.history.replaceState()` ya fue invocado
- AND la barra de direcciones NO muestra `?token=...`

#### Scenario: S-R5.2 — Token no queda en el historial del navegador

- GIVEN que el usuario completó el flujo de callback
- WHEN el usuario usa el botón "Atrás" del navegador
- THEN la entrada del historial NO contiene el token en la URL

---

### R6 (P0): Preservación de Device Flow para CLI

El servidor MUST mantener los endpoints existentes de Device Flow funcionales e inalterados:

1. `POST /auth/device/code` MUST seguir funcionando tal como está implementado actualmente.
2. `POST /auth/device/token` MUST seguir funcionando tal como está implementado actualmente.
3. Los nuevos endpoints Web Flow (`/auth/login`, `/auth/callback`) MUST ser aditivos y NO MUST afectar los endpoints de Device Flow.
4. El CLI MUST poder autenticarse via Device Flow sin cambios en su código.

#### Scenario: S-R6.1 — Device Flow sigue funcionando tras agregar Web Flow

- GIVEN que los nuevos endpoints Web Flow están desplegados
- WHEN el CLI ejecuta `ghagga login` usando Device Flow
- THEN `POST /auth/device/code` responde con `device_code`, `user_code`, `verification_uri`
- AND `POST /auth/device/token` responde con `access_token` tras autorización del usuario
- AND el flujo completo de Device Flow funciona sin modificaciones

#### Scenario: S-R6.2 — Endpoints Device Flow no cambian su comportamiento

- GIVEN que `createOAuthRouter()` incluye los nuevos endpoints Web Flow
- WHEN se procesan requests a `/auth/device/code` y `/auth/device/token`
- THEN el comportamiento es idéntico al actual (mismos request/response formats, mismos error codes)

---

### R7 (P0): PAT Fallback cuando el Servidor está Offline

El Dashboard MUST mantener el fallback de Personal Access Token (PAT) para cuando el servidor no responde.

1. Cuando `isServerAvailable()` retorna `false`, Login.tsx MUST mostrar el formulario de PAT directamente (no el botón de Web Flow).
2. El formulario de PAT MUST funcionar sin depender del servidor (valida el token directamente contra `api.github.com/user`).
3. Cuando el servidor está online, el enlace "Or enter a Personal Access Token" MUST seguir disponible como opción secundaria.

#### Scenario: S-R7.1 — Servidor offline muestra PAT form

- GIVEN que `isServerAvailable()` retorna `false` (health check falla o timeout de 3s)
- WHEN el usuario ve la página de login
- THEN se muestra el formulario de PAT como opción principal
- AND NO se muestra el botón "Sign in with GitHub" (Web Flow)
- AND se muestra un botón "Retry server connection" para re-verificar

#### Scenario: S-R7.2 — PAT login funciona sin servidor

- GIVEN que el servidor está offline
- AND el usuario ingresa un PAT válido (`ghp_xxx`)
- WHEN el usuario hace submit del formulario
- THEN el Dashboard valida el token contra `api.github.com/user`
- AND guarda las credenciales en `localStorage`
- AND redirige al usuario al Dashboard principal

---

### R8 (P0): CLIENT_SECRET — Configuración Segura

El `CLIENT_SECRET` de la GitHub OAuth App MUST ser configurado exclusivamente como variable de entorno en Render.

1. `CLIENT_SECRET` MUST NOT aparecer en ningún archivo del repositorio (código fuente, `.env`, `.env.example`, documentación con valores reales).
2. El servidor MUST leer `CLIENT_SECRET` de `process.env.CLIENT_SECRET` (o `process.env.GITHUB_CLIENT_SECRET`).
3. Si `CLIENT_SECRET` no está definido, el endpoint `/auth/callback` MUST responder con HTTP 500 cuando intenta intercambiar el code.
4. Los logs del servidor MUST NOT incluir el valor de `CLIENT_SECRET` ni el `access_token` obtenido.

#### Scenario: S-R8.1 — Callback funciona con CLIENT_SECRET configurado

- GIVEN que `CLIENT_SECRET` está configurado como variable de entorno en Render
- WHEN `/auth/callback` intercambia un code por token
- THEN el servidor usa `CLIENT_SECRET` en el POST a GitHub
- AND el intercambio es exitoso

#### Scenario: S-R8.2 — CLIENT_SECRET ausente causa error controlado

- GIVEN que `CLIENT_SECRET` NO está configurado en las variables de entorno
- WHEN `/auth/callback` recibe un code válido
- THEN el servidor responde con HTTP 500
- AND el log registra un error de configuración (sin exponer el secret)
- AND el Dashboard recibe un redirect con error

#### Scenario: S-R8.3 — CLIENT_SECRET no aparece en el repositorio

- GIVEN el código fuente del repositorio
- WHEN se busca la cadena del secret real en todos los archivos
- THEN no se encuentra en ningún archivo commiteado
- AND `.env.example` NO contiene un valor real para `CLIENT_SECRET` (solo un placeholder o comentario)

---

### R9 (P0): Auth Middleware — Validación de Instalaciones y Limpieza de Mappings Obsoletos

El auth middleware (`apps/server/src/middleware/auth.ts`) MUST validar que las instalaciones asociadas a los mappings del usuario todavía existen y están activas. Si algún mapping apunta a una instalación inactiva o inexistente, MUST limpiar los mappings obsoletos y re-ejecutar auto-discovery.

1. Tras obtener los mappings del usuario via `getInstallationsByUserId()`, el middleware MUST verificar que cada instalación referenciada existe en la tabla `installations` y tiene `is_active = true`.
2. Si algún mapping apunta a una instalación inactiva o inexistente, el middleware MUST eliminar esos mappings de `github_user_mappings`.
3. Tras eliminar mappings obsoletos, si NO quedan mappings válidos, el middleware MUST ejecutar `discoverAndMapInstallations()` para re-descubrir instalaciones.
4. La verificación SHOULD usar los datos de la tabla `installations` de la base de datos (no la GitHub API) para evitar rate limits.

**Actualmente**: El middleware solo ejecuta auto-discovery cuando `userInstallations.length === 0`. Si hay mappings obsoletos apuntando a instalaciones muertas, NO re-descubre.

#### Scenario: S-R9.1 — Mappings válidos — flujo normal sin cambios

- GIVEN un usuario con un mapping a `installation_id=5`
- AND la instalación 5 existe con `is_active = true`
- WHEN el auth middleware procesa la request
- THEN el flujo continúa normalmente con `installationIds = [5]`
- AND no se ejecuta limpieza ni re-discovery

#### Scenario: S-R9.2 — Mapping obsoleto con instalación inactiva

- GIVEN un usuario con un mapping a `installation_id=5`
- AND la instalación 5 tiene `is_active = false` (fue desinstalada)
- WHEN el auth middleware procesa la request
- THEN el middleware elimina el mapping obsoleto a instalación 5
- AND como no quedan mappings válidos, ejecuta `discoverAndMapInstallations()`
- AND si el auto-discovery encuentra nuevas instalaciones, las mapea

#### Scenario: S-R9.3 — Mapping obsoleto con instalación inexistente

- GIVEN un usuario con un mapping a `installation_id=99`
- AND la instalación 99 no existe en la tabla `installations`
- WHEN el auth middleware procesa la request
- THEN el middleware elimina el mapping huérfano a instalación 99
- AND ejecuta auto-discovery

#### Scenario: S-R9.4 — Múltiples mappings, uno válido y uno obsoleto

- GIVEN un usuario con mappings a `installation_id=5` y `installation_id=7`
- AND la instalación 5 tiene `is_active = true`
- AND la instalación 7 tiene `is_active = false`
- WHEN el auth middleware procesa la request
- THEN el middleware elimina solo el mapping a instalación 7
- AND mantiene el mapping a instalación 5
- AND el flujo continúa con `installationIds = [5]`
- AND NO ejecuta auto-discovery (queda al menos un mapping válido)

#### Scenario: S-R9.5 — Todos los mappings son obsoletos, auto-discovery encuentra nueva instalación

- GIVEN un usuario `johndoe` con un mapping a `installation_id=3` (inactiva)
- AND existe una instalación activa con `account_login = 'johndoe'` y `id = 10`
- WHEN el auth middleware limpia el mapping obsoleto y ejecuta auto-discovery
- THEN el middleware crea un nuevo mapping `(johndoe, installation_id=10)`
- AND el flujo continúa con `installationIds = [10]`

---

### R10 (P0): Webhook — Limpieza de Mappings en Uninstall

Cuando el servidor recibe un evento webhook `installation.deleted`, MUST eliminar todos los registros de `github_user_mappings` donde `installation_id` corresponde a la instalación eliminada.

1. El handler de `installation.deleted` en `webhook.ts` MUST, además de desactivar la instalación (comportamiento actual), eliminar los mappings de usuario asociados.
2. La limpieza MUST usar el `installation.id` interno de la tabla `installations` (no el `github_installation_id` directamente), tras buscar la instalación en la BD.
3. Si no hay mappings asociados, la operación MUST ser un no-op (no error).

**Actualmente**: `handleInstallation` con `action === 'deleted'` solo llama a `deactivateInstallation()`, que marca `is_active = false`. No limpia `github_user_mappings`.

#### Scenario: S-R10.1 — Webhook uninstall limpia mappings

- GIVEN que la instalación con `github_installation_id=12345` tiene el `id=5` interno
- AND existen 3 mappings en `github_user_mappings` con `installation_id=5`
- WHEN llega un webhook `installation.deleted` con `installation.id=12345`
- THEN el handler desactiva la instalación (comportamiento existente)
- AND elimina los 3 mappings de `github_user_mappings` donde `installation_id=5`

#### Scenario: S-R10.2 — Webhook uninstall sin mappings asociados

- GIVEN que la instalación con `id=5` no tiene mappings en `github_user_mappings`
- WHEN llega un webhook `installation.deleted`
- THEN el handler desactiva la instalación normalmente
- AND la operación de limpieza de mappings no produce error

#### Scenario: S-R10.3 — Siguiente login tras uninstall + reinstall

- GIVEN que un usuario tenía mappings a `installation_id=5`
- AND la instalación 5 fue eliminada via webhook (mappings limpiados, is_active=false)
- AND el usuario reinstala la GitHub App (nueva instalación `id=10`)
- WHEN el usuario hace login en el Dashboard
- THEN el auth middleware no encuentra mappings existentes
- AND ejecuta auto-discovery
- AND crea un mapping a `installation_id=10`
- AND el usuario accede correctamente al Dashboard

---

### R11 (P0): Cambio de Constraint UNIQUE en github_user_mappings

El constraint UNIQUE de la tabla `github_user_mappings` MUST cambiar de `UNIQUE(github_user_id)` a `UNIQUE(github_user_id, installation_id)` para soportar usuarios con múltiples instalaciones.

1. La migración MUST eliminar el constraint `UNIQUE(github_user_id)` existente.
2. La migración MUST crear un nuevo constraint `UNIQUE(github_user_id, installation_id)`.
3. La migración MUST manejar datos existentes que podrían violar el nuevo constraint (limpiar duplicados si existen).
4. La función `upsertUserMapping` en `queries.ts` MUST actualizarse para buscar por `(github_user_id, installation_id)` en lugar de solo `github_user_id`.

**Actualmente**: `githubUserMappings` tiene `.unique()` en `github_user_id` (línea 183 de `schema.ts`). La función `upsertUserMapping` busca solo por `github_user_id` para decidir si hacer insert o update (línea 504 de `queries.ts`).

#### Scenario: S-R11.1 — Usuario con instalación personal y de organización

- GIVEN un usuario `johndoe` (github_user_id=100) que es dueño de una cuenta personal y miembro de una organización
- AND la cuenta personal tiene `installation_id=5`
- AND la organización tiene `installation_id=7`
- WHEN el auto-discovery encuentra ambas instalaciones
- THEN se crean dos mappings: `(100, 5)` y `(100, 7)`
- AND no se viola ningún constraint

#### Scenario: S-R11.2 — upsertUserMapping actualiza mapping existente para misma combinación

- GIVEN un mapping existente `(github_user_id=100, installation_id=5)`
- WHEN se llama `upsertUserMapping(db, { githubUserId: 100, githubLogin: 'johndoe', installationId: 5 })`
- THEN se actualiza el `github_login` del mapping existente (upsert)
- AND no se crea un registro duplicado

#### Scenario: S-R11.3 — upsertUserMapping crea nuevo mapping para diferente instalación

- GIVEN un mapping existente `(github_user_id=100, installation_id=5)`
- WHEN se llama `upsertUserMapping(db, { githubUserId: 100, githubLogin: 'johndoe', installationId: 7 })`
- THEN se crea un nuevo mapping `(100, 7)` sin afectar el existente `(100, 5)`

#### Scenario: S-R11.4 — Migración maneja datos existentes

- GIVEN que la tabla `github_user_mappings` tiene datos con el constraint UNIQUE antiguo
- WHEN se ejecuta la migración del constraint
- THEN no se pierde ningún dato válido
- AND si existen filas con el mismo `(github_user_id, installation_id)` (duplicados), se elimina el duplicado más antiguo

---

### R12 (P0): Re-Discovery Resiliente

El auto-discovery MUST ejecutarse no solo cuando no existen mappings, sino también cuando TODOS los mappings existentes apuntan a instalaciones no existentes o inactivas.

1. Tras la validación de instalaciones en el auth middleware (R9), si la lista de instalaciones válidas queda vacía (todos los mappings eran obsoletos), MUST ejecutar auto-discovery.
2. Este comportamiento MUST reemplazar la condición actual `if (userInstallations.length === 0)` por una lógica que contemple tanto "sin mappings" como "todos los mappings son obsoletos tras limpieza".

**Actualmente**: `authMiddleware` solo ejecuta `discoverAndMapInstallations` cuando `getInstallationsByUserId` retorna un array vacío. Si retorna mappings a instalaciones muertas, no re-descubre.

#### Scenario: S-R12.1 — Auto-discovery tras limpieza de todos los mappings

- GIVEN un usuario con 2 mappings, ambos apuntando a instalaciones inactivas
- WHEN el auth middleware valida y limpia ambos mappings
- AND la lista de instalaciones válidas queda vacía
- THEN el middleware ejecuta auto-discovery
- AND si encuentra instalaciones que coinciden con el `account_login` del usuario, las mapea

#### Scenario: S-R12.2 — No re-discovery si al menos un mapping es válido

- GIVEN un usuario con 2 mappings, uno a una instalación activa y otro a una inactiva
- WHEN el auth middleware limpia el mapping obsoleto
- AND queda 1 instalación válida
- THEN el middleware NO ejecuta auto-discovery
- AND continúa con la instalación válida

---

## Cross-Cutting Concerns

### CC1: Seguridad — Token en URL Fragment

El access_token MUST viajar exclusivamente en el URL fragment (después de `#`), NEVER en query params (después de `?`).

Los fragments HTTP (`#`) no se envían al servidor en requests HTTP, por lo que GitHub Pages no los verá en sus logs de acceso.

1. El servidor MUST redirigir con `#/auth/callback?token=...` (fragment), no `?token=...` (query param).
2. El Dashboard MUST extraer el token del fragment, no de `window.location.search`.
3. Tras la extracción, el token MUST ser eliminado de la URL inmediatamente (R5).

#### Scenario: S-CC1.1 — Token no viaja como query param

- GIVEN que el servidor genera el redirect en `/auth/callback`
- WHEN se construye la URL de redirect
- THEN la URL usa `#` para separar el fragment: `...app/#/auth/callback?token=...`
- AND no contiene `?token=` antes del `#`

#### Scenario: S-CC1.2 — Token no se envía a GitHub Pages

- GIVEN que el navegador navega a `https://jnzader.github.io/ghagga/app/#/auth/callback?token=abc`
- WHEN el navegador hace la request HTTP a GitHub Pages
- THEN el request HTTP es a `https://jnzader.github.io/ghagga/app/` (sin fragment)
- AND GitHub Pages nunca recibe el token

### CC2: Error Handling — Errores en el Flujo de Autenticación

Todos los errores en el flujo OAuth MUST resultar en una experiencia de usuario comprensible, no en pantallas en blanco ni errores técnicos crípticos.

1. **State inválido/expirado**: Redirigir a Dashboard con error descriptivo y opción de reintentar.
2. **GitHub auth denegada**: Mostrar mensaje "Autenticación cancelada" con botón de reintentar.
3. **Server error en callback**: Mostrar error con opción de PAT fallback.
4. **GitHub API caída durante callback**: Mostrar error con opción de reintentar más tarde.
5. **Token inválido en callback**: Mostrar error con opción de reintentar login.

#### Scenario: S-CC2.1 — Usuario deniega la autorización OAuth en GitHub

- GIVEN que GitHub redirige al callback con `?error=access_denied&error_description=...`
- WHEN el servidor recibe esta respuesta (sin `code`)
- THEN el servidor redirige al Dashboard con `#/auth/callback?error=access_denied`
- AND el Dashboard muestra "Has cancelado la autorización. ¿Quieres intentar de nuevo?"
- AND muestra botón "Retry" y enlace a PAT fallback

#### Scenario: S-CC2.2 — GitHub API caída durante intercambio de token

- GIVEN que el servidor intenta POST a `github.com/login/oauth/access_token`
- AND GitHub no responde (timeout o error 5xx)
- WHEN el servidor maneja el error
- THEN redirige al Dashboard con `#/auth/callback?error=github_unavailable`
- AND el Dashboard muestra "GitHub no está disponible en este momento. Intenta más tarde o usa un Personal Access Token."

#### Scenario: S-CC2.3 — Error genérico del servidor en callback

- GIVEN que el servidor tiene un error interno inesperado durante el callback
- WHEN el error es capturado
- THEN el servidor redirige al Dashboard con `#/auth/callback?error=server_error`
- AND el log del servidor registra el error completo para debugging

### CC3: UX — Flujo de Login en Un Click

El flujo completo de login desde el Dashboard MUST completarse en un máximo de 3 interacciones del usuario y SHOULD completarse en menos de 5 segundos (en conexión rápida, sin cold start de Render).

1. **Interacción 1**: Click en "Sign in with GitHub" en Login.tsx
2. **Interacción 2**: Click en "Authorize" en la página de GitHub (omitido si el usuario ya autorizó la App)
3. **Interacción 3**: (Automática) Redirect de vuelta al Dashboard — no requiere acción del usuario

El usuario MUST NOT necesitar copiar códigos, cambiar de pestaña, ni realizar pasos manuales más allá de clicks.

#### Scenario: S-CC3.1 — Login completo para usuario nuevo

- GIVEN un usuario que nunca autorizó la OAuth App de GHAGGA
- WHEN hace click en "Sign in with GitHub"
- THEN es redirigido a GitHub, autoriza la App (1 click), y es redirigido al Dashboard autenticado
- AND el flujo total requiere exactamente 2 clicks del usuario

#### Scenario: S-CC3.2 — Login completo para usuario que ya autorizó

- GIVEN un usuario que ya autorizó la OAuth App de GHAGGA previamente
- WHEN hace click en "Sign in with GitHub"
- THEN GitHub auto-redirige sin mostrar la pantalla de autorización
- AND el flujo total requiere exactamente 1 click del usuario

#### Scenario: S-CC3.3 — Render cold start durante login

- GIVEN que el servidor Render está dormido (cold start de 10-30 segundos)
- WHEN el usuario hace click en "Sign in with GitHub"
- THEN el navegador muestra la página de carga del servidor (o spinner de Render) durante el cold start
- AND tras despertar, el flujo continúa normalmente con el redirect a GitHub
- AND el usuario NO necesita reintentar manualmente

### CC4: Backward Compatibility

Los cambios MUST NOT romper el funcionamiento existente para usuarios ya autenticados ni para otros modos de distribución.

1. Tokens existentes en `localStorage` (`ghagga_token`, `ghagga_user`) MUST seguir siendo válidos tras el deploy.
2. Usuarios ya logueados MUST NOT necesitar re-autenticarse solo por este cambio.
3. El Device Flow del CLI MUST seguir funcionando sin cambios.
4. Los endpoints de la API que usan auth middleware MUST seguir funcionando para tokens obtenidos por cualquier método (Device Flow, PAT, o Web Flow).

#### Scenario: S-CC4.1 — Token existente en localStorage sigue funcionando

- GIVEN un usuario que se autenticó via Device Flow antes de este cambio
- AND tiene `ghagga_token` válido en `localStorage`
- WHEN el Dashboard carga con la nueva versión del código
- THEN el `AuthProvider` valida el token existente contra `api.github.com/user`
- AND el usuario permanece autenticado sin necesidad de re-login

#### Scenario: S-CC4.2 — Auth middleware acepta tokens de cualquier origen

- GIVEN un token obtenido via Web Flow, Device Flow, o PAT
- WHEN el auth middleware verifica el token contra `api.github.com/user`
- THEN el token es aceptado independientemente de su origen
- AND el middleware procede normalmente con la búsqueda de instalaciones

---

## Escenarios Adicionales

### Scenarios de Edge Cases

#### Scenario: S-E1 — Usuario con instalaciones personal y de organización

- GIVEN un usuario `johndoe` que es dueño de `johndoe/repo1` y miembro de la org `acme-corp`
- AND la GitHub App está instalada en ambas cuentas (`installation_id=5` para johndoe, `installation_id=7` para acme-corp)
- WHEN el usuario hace login y el auto-discovery encuentra ambas instalaciones
- THEN se crean dos mappings: `(johndoe, 5)` y `(johndoe, 7)`
- AND el middleware devuelve `installationIds = [5, 7]`
- AND el Dashboard muestra repos de ambas instalaciones

#### Scenario: S-E2 — Usuario reinstala la GitHub App (nuevo installation_id)

- GIVEN que el usuario tenía `installation_id=5` y desinstala la App
- AND el webhook `installation.deleted` limpia los mappings y desactiva la instalación
- AND el usuario reinstala la App, creando `installation_id=10`
- WHEN el usuario hace login en el Dashboard
- THEN el auth middleware no encuentra mappings existentes (fueron limpiados)
- AND ejecuta auto-discovery, encontrando la nueva instalación `id=10`
- AND crea un mapping a `installation_id=10`
- AND el usuario accede al Dashboard normalmente

#### Scenario: S-E3 — Render cold start durante callback (10-30s)

- GIVEN que el usuario autorizó en GitHub y GitHub redirige a `/auth/callback?code=abc&state=valid`
- AND el servidor Render está dormido
- WHEN la request llega al servidor
- THEN Render inicia el cold start (10-30s)
- AND el state MUST NO haber expirado durante el cold start (5 min de ventana es suficiente)
- AND tras despertar, el servidor procesa el callback normalmente

#### Scenario: S-E4 — Login concurrente desde dos dispositivos

- GIVEN que un usuario inicia el Web Flow desde el Dispositivo A
- AND simultáneamente inicia el Web Flow desde el Dispositivo B
- WHEN ambos dispositivos completan el flujo
- THEN ambos obtienen tokens válidos (cada uno con su propio state)
- AND ambos guardan credenciales en su respectivo `localStorage`
- AND ambos acceden al Dashboard correctamente
- AND los tokens son independientes (no se invalidan mutuamente)

#### Scenario: S-E5 — Token en URL fragment interceptado por browser extension

- GIVEN que el usuario tiene una extensión de navegador que lee URLs
- WHEN el callback carga con `#/auth/callback?token=gho_abc123`
- THEN `AuthCallback` limpia la URL con `history.replaceState()` inmediatamente
- AND la ventana de exposición del token es mínima (un frame de renderizado)
- AND la mitigación principal es la limpieza inmediata, no la prevención de lectura por extensiones

#### Scenario: S-E6 — AuthProvider valida token al montar pero GitHub API está lenta

- GIVEN que un usuario tiene un token en `localStorage`
- AND el componente `AuthProvider` hace `fetchGitHubUser(token)` al montarse
- WHEN GitHub API tarda más de lo normal (>5s)
- THEN el Dashboard muestra un spinner de carga
- AND eventualmente, cuando GitHub responde, el usuario es autenticado o se limpia el token inválido

#### Scenario: S-E7 — Múltiples tabs abiertos durante callback

- GIVEN que el usuario tiene múltiples tabs del Dashboard abiertos
- AND completa el Web Flow en una de las tabs
- WHEN `AuthCallback` guarda el token en `localStorage`
- THEN las otras tabs SHOULD detectar el cambio de `localStorage` (via `storage` event) o validar en el próximo re-render
- AND todas las tabs eventualmente reflejan el estado autenticado

### Scenarios de Seguridad

#### Scenario: S-SEC1 — Ataque CSRF con state forjado

- GIVEN que un atacante genera un URL `/auth/callback?code=stolen_code&state=forged_state`
- WHEN la víctima navega a esa URL
- THEN el servidor verifica la firma HMAC del `state`
- AND la firma no coincide (el atacante no conoce `STATE_SECRET`)
- AND el servidor redirige al Dashboard con `#/auth/callback?error=invalid_state`
- AND el `code` robado no se intercambia por un token

#### Scenario: S-SEC2 — Replay de state válido

- GIVEN que un atacante captura un `state` válido de una sesión anterior
- AND el state tiene más de 5 minutos de antigüedad
- WHEN el atacante usa ese state en una request a `/auth/callback`
- THEN la validación de timestamp falla (expirado)
- AND el servidor redirige con `#/auth/callback?error=state_expired`

#### Scenario: S-SEC3 — CLIENT_SECRET no se loguea

- GIVEN que el servidor maneja un callback exitoso o fallido
- WHEN se registran logs del proceso
- THEN el `CLIENT_SECRET` no aparece en ningún log
- AND el `access_token` obtenido de GitHub no aparece en ningún log
- AND solo se loguean identificadores no sensibles (github_login, installation_ids)

#### Scenario: S-SEC4 — Token no viaja en el body del redirect

- GIVEN que el servidor construye el redirect en `/auth/callback`
- WHEN el servidor responde con HTTP 302
- THEN el response body está vacío o contiene solo un mensaje genérico
- AND el token viaja exclusivamente en el `Location` header como parte del fragment

### Scenarios de Migración

#### Scenario: S-MIG1 — Tokens de Device Flow existentes siguen funcionando

- GIVEN un token `ghp_xxx` obtenido via Device Flow antes de este cambio
- AND almacenado en `localStorage` como `ghagga_token`
- WHEN el Dashboard se actualiza con el nuevo código
- THEN `AuthProvider.useEffect` valida el token existente contra `api.github.com/user`
- AND el usuario permanece autenticado sin re-login

#### Scenario: S-MIG2 — Tokens de PAT existentes siguen funcionando

- GIVEN un PAT `ghp_yyy` ingresado manualmente antes de este cambio
- AND almacenado en `localStorage` como `ghagga_token`
- WHEN el Dashboard se actualiza
- THEN el PAT sigue siendo válido y el usuario permanece autenticado

#### Scenario: S-MIG3 — Migración del constraint UNIQUE no rompe datos

- GIVEN que `github_user_mappings` tiene registros existentes con el constraint `UNIQUE(github_user_id)`
- WHEN se ejecuta la migración a `UNIQUE(github_user_id, installation_id)`
- THEN no se pierden registros existentes
- AND la migración completa sin errores
- AND el nuevo constraint permite insertar mappings para la misma `github_user_id` con diferente `installation_id`

---

## Acceptance Criteria Summary

| ID | Priority | Requirement | Acceptance Criteria |
|----|----------|-------------|---------------------|
| R1 | P0 | Server — Web Flow Endpoints | `GET /auth/login` redirige a GitHub; `GET /auth/callback` intercambia code por token y redirige al Dashboard con token en fragment |
| R2 | P0 | State HMAC Security | State es stateless (HMAC-signed), expira en 5 min, sobrevive restarts, previene CSRF |
| R3 | P0 | Dashboard — Web Flow Login | Login.tsx redirige a `/auth/login` en vez de Device Flow; no muestra código ni polling |
| R4 | P0 | Dashboard — Callback Route | `#/auth/callback` extrae token, valida via GitHub API, guarda en localStorage, maneja errores |
| R5 | P0 | Clean URL After Auth | Token eliminado de la URL inmediatamente tras extracción via `history.replaceState()` |
| R6 | P0 | Device Flow Preservation | Endpoints `/auth/device/code` y `/auth/device/token` siguen funcionando sin cambios |
| R7 | P0 | PAT Fallback | Servidor offline → Login.tsx muestra PAT form; PAT funciona sin servidor |
| R8 | P0 | CLIENT_SECRET Config | Solo env var en Render; nunca en código/logs/commits |
| R9 | P0 | Auth Middleware — Stale Mapping Cleanup | Valida instalaciones activas; limpia mappings obsoletos; re-descubre si necesario |
| R10 | P0 | Webhook — Uninstall Cleanup | `installation.deleted` elimina mappings asociados de `github_user_mappings` |
| R11 | P0 | DB Constraint Change | UNIQUE cambia de `(github_user_id)` a `(github_user_id, installation_id)` |
| R12 | P0 | Re-Discovery Resiliente | Auto-discovery se ejecuta cuando todos los mappings son obsoletos, no solo cuando no existen |
| CC1 | — | Token en Fragment Only | Token viaja en `#`, nunca en `?`; no se envía a GitHub Pages |
| CC2 | — | Error Handling | Todos los errores resultan en UX comprensible con opciones de retry/fallback |
| CC3 | — | UX — Un Click Login | Login completo en ≤3 interacciones, <5s en conexión rápida |
| CC4 | — | Backward Compatibility | Tokens existentes válidos; Device Flow CLI sin cambios; no re-login forzado |
