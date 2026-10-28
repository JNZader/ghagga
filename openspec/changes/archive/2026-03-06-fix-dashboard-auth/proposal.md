# Proposal: Fix Dashboard Authentication — Web Flow OAuth + Stale Mapping Cleanup

## Intent

La autenticación del Dashboard tiene dos problemas que degradan la experiencia del usuario:
1. **Reinstalación fantasma de la GitHub App**: Cuando un usuario inicia sesión desde un dispositivo/navegador nuevo, el Dashboard puede redirigirlo a reinstalar la GitHub App aunque ya esté instalada. Esto ocurre porque la tabla `github_user_mappings` tiene un constraint UNIQUE en `github_user_id`, y cuando la App se reinstala (nuevo `installation_id`), los mappings antiguos no se limpian. El auto-discovery en `authMiddleware` solo se ejecuta cuando NO existen mappings — si hay mappings obsoletos apuntando a una instalación muerta, no re-descubre. Además, en un dispositivo nuevo sin sesión en localStorage, el flujo no distingue entre "necesitas loguearte" y "necesitas instalar la App", enviando al usuario por el flujo completo de instalación.

2. **Device Flow OAuth es engorroso**: El login actual usa OAuth Device Flow (código + github.com/login/device + pegar código). Se eligió porque el Dashboard es una SPA estática en GitHub Pages sin backend propio. Pero el servidor en Render ya existe y puede servir como endpoint de callback OAuth.

El flujo deseado: Click "Login con GitHub" -> redirect a GitHub -> autorizar -> redirect de vuelta al Dashboard -> logueado. Un click, sin códigos.

## Scope

### In Scope

- **OAuth Web Flow via servidor Render**: Nuevos endpoints `GET /auth/login` (redirect a GitHub) y `GET /auth/callback` (recibe code, intercambia por token, redirige al Dashboard con token en fragment `#`).
- **Configuración de `CLIENT_SECRET`**: Variable de entorno en Render. El Web Flow lo requiere, a diferencia del Device Flow.
- **Redirect cross-domain seguro**: El callback en Render redirige a `https://jnzader.github.io/ghagga/app/#/auth/callback?token=...` — el token va en el URL fragment (hash), que NO se envía al servidor y es extraído por la SPA.
- **Nueva ruta Dashboard `/auth/callback`**: Componente React que extrae el token del fragment, lo guarda en localStorage y redirige al Dashboard principal.
- **Login.tsx simplificado**: Reemplazar la UI de Device Flow por un botón "Login con GitHub" que redirige al endpoint del servidor.
- **Limpieza de mappings obsoletos en auth middleware**: Cuando se detectan mappings existentes pero la instalación asociada ya no es válida, eliminar los mappings obsoletos y re-ejecutar auto-discovery.
- **Limpieza proactiva via webhook**: El webhook `installation.deleted` DEBE limpiar los `github_user_mappings` asociados a esa instalación.
- **Separación de flujos login vs install**: En dispositivo nuevo sin sesión, el Dashboard DEBE distinguir "necesitas loguearte" de "necesitas instalar la App" y mostrar el flujo correcto.

### Out of Scope

- **Eliminar Device Flow del servidor**: El CLI necesita Device Flow (no tiene capacidad de redirect en browser). Los endpoints existentes se mantienen.
- **Eliminar soporte PAT (Personal Access Token)**: Se mantiene como fallback para cuando el servidor está offline.
- **Migración a GitHub App OAuth**: Usamos el OAuth App existente (Client ID: `Ov23liyYpSgDqOLUFa5k`). Migrar a App-based OAuth es un cambio futuro.
- **Refresh tokens**: El token de GitHub no expira (classic OAuth). No se implementa refresh flow.
- **Múltiples sesiones simultáneas**: No se gestiona multi-sesión entre dispositivos.

## Approach

### 1. OAuth Web Flow (Server-Side)

Agregar `CLIENT_SECRET` como variable de entorno en Render. Crear dos nuevos endpoints en el servidor Hono:

```
GET /auth/login
  → Genera state random, lo guarda en memoria/cookie
  → Redirige a: https://github.com/login/oauth/authorize
      ?client_id=Ov23liyYpSgDqOLUFa5k
      &redirect_uri=https://ghagga.onrender.com/auth/callback
      &scope=public_repo
      &state={random}

GET /auth/callback?code=...&state=...
  → Valida state
  → POST https://github.com/login/oauth/access_token
      con client_id + client_secret + code
  → Obtiene access_token
  → Redirige a: https://jnzader.github.io/ghagga/app/#/auth/callback?token={access_token}
```

**Seguridad**: El token va en el fragment (`#`), no en query params (`?`). Los fragments NO se envían al servidor en requests HTTP, así que GitHub Pages nunca ve el token en sus logs.

### 2. Dashboard Auth Callback

Nueva ruta en el HashRouter del Dashboard: `#/auth/callback`. Un componente `AuthCallback.tsx` que:
1. Extrae el `token` de los query params del fragment
2. Valida el token con `GET api.github.com/user`
3. Guarda token y user info en localStorage
4. Redirige a la página principal del Dashboard

### 3. Login.tsx Simplificado

Reemplazar la UI actual de Device Flow (mostrar código, polling, instrucciones) por:
- Un botón "Login con GitHub" que hace `window.location.href = 'https://ghagga.onrender.com/auth/login'`
- Un enlace secundario "Usar Personal Access Token" como fallback
- Eliminar el flujo de Device Flow del frontend (queda solo en el servidor para el CLI)

### 4. Stale Mapping Cleanup

**En auth middleware** (`apps/server/src/middleware/auth.ts`):
- Cuando se obtienen mappings del usuario, verificar que las instalaciones asociadas siguen existiendo (vía GitHub API o cache)
- Si una instalación ya no existe → eliminar los mappings obsoletos de `github_user_mappings`
- Si después de limpiar no quedan mappings → ejecutar auto-discovery
- Si hay mappings válidos → proceder normalmente

**En webhook handler**:
- Cuando llega `installation.deleted` → eliminar TODOS los `github_user_mappings` donde `installation_id` = la instalación eliminada

### 5. Constraint de BD

Evaluar si el UNIQUE constraint en `github_user_id` de `github_user_mappings` debe cambiarse. Un usuario puede tener múltiples instalaciones (org personal + orgs), así que el constraint debería ser UNIQUE en `(github_user_id, installation_id)` en lugar de solo `github_user_id`.

## Affected Areas

| Area                                        | Impact   | Description                                                                                             |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `apps/server/src/routes/oauth.ts`           | Modified | Nuevos endpoints Web Flow (`/auth/login`, `/auth/callback`). Mantener endpoints Device Flow existentes. |
| `apps/server/src/middleware/auth.ts`        | Modified | Validación de instalaciones activas, limpieza de mappings obsoletos, re-discovery.                      |
| `apps/server/src/routes/webhook.ts`         | Modified | Handler para evento `installation.deleted` que limpia mappings.                                         |
| `apps/dashboard/src/pages/Login.tsx`        | Modified | Reemplazar UI Device Flow por botón redirect + fallback PAT.                                            |
| `apps/dashboard/src/pages/AuthCallback.tsx` | New      | Componente que extrae token del fragment y completa el login.                                           |
| `apps/dashboard/src/lib/auth.tsx`           | Modified | Integrar nueva ruta de callback, separar lógica login vs install.                                       |
| `apps/dashboard/src/lib/oauth.ts`           | Modified | Eliminar lógica Device Flow del frontend. Mantener `fetchGitHubUser` y `CLIENT_ID`.                     |
| `apps/dashboard/src/App.tsx` (o router)     | Modified | Agregar ruta `#/auth/callback` al HashRouter.                                                           |
| `packages/db/src/schema.ts`                 | Modified | Cambiar UNIQUE constraint de `github_user_id` a `(github_user_id, installation_id)`.                    |
| `packages/db/src/queries.ts`                | Modified | Agregar `deleteStaleUserMappings`, `deleteMappingsByInstallation`. Ajustar `upsertUserMapping`.         |
| Render Environment                          | Config   | Agregar variable de entorno `CLIENT_SECRET`.                                                            |
| GitHub OAuth App Settings                   | Config   | Configurar callback URL: `https://ghagga.onrender.com/auth/callback`.                                   |

## Risks

| Risk                                                              | Likelihood | Mitigation                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_SECRET` se filtra en logs o código                        | Low        | NUNCA commitearlo. Solo como env var en Render. Revisar que no se loguee en ningún middleware. El secret no viaja al frontend.                                                                                                                                                                        |
| Redirect cross-domain falla por CORS/CSP                          | Low        | No es un fetch cross-origin, es un redirect HTTP 302. Los redirects no están sujetos a CORS. Verificar que GitHub Pages no tenga CSP headers que bloqueen navigación.                                                                                                                                 |
| Token en URL fragment visible en historial del browser            | Medium     | Los fragments (#) no se envían en requests HTTP, pero sí aparecen en el historial local. `AuthCallback` debe limpiar la URL (con `history.replaceState`) inmediatamente después de extraer el token.                                                                                                  |
| State parameter storage en servidor stateless                     | Medium     | Si Render tiene múltiples instancias, el state guardado en memoria de una instancia no estará en otra. Opciones: (a) Render free tier es una sola instancia, (b) usar state firmado (HMAC) que no requiere server-side storage. Preferir (b) para robustez.                                           |
| GitHub API rate limit al validar instalaciones en auth middleware | Low        | Cachear el resultado de validación de instalaciones por un tiempo razonable (ej. 5 min). No validar en cada request.                                                                                                                                                                                  |
| Migración del constraint UNIQUE rompe datos existentes            | Low        | La migración debe limpiar duplicados antes de crear el nuevo constraint. Verificar con query de duplicados primero.                                                                                                                                                                                   |
| Render cold start causa timeout en el redirect flow               | Medium     | Render free tier apaga la instancia tras inactividad. Un cold start puede tardar 30-60s. Mitigación: el botón de login puede mostrar un spinner o mensaje "Conectando con el servidor..." mientras espera. Alternativa: mantener Device Flow como fallback visible si el servidor no responde rápido. |

## Rollback Plan

1. **Web Flow OAuth**: Los endpoints son aditivos. Si fallan, eliminar las rutas del servidor y revertir `Login.tsx` al Device Flow original. El `CLIENT_SECRET` en Render se puede eliminar.
2. **Stale Mapping Cleanup**: La lógica de cleanup es defensiva (solo elimina registros inválidos). Si causa problemas, revertir el auth middleware al comportamiento original (no validar instalaciones).
3. **DB Constraint Change**: Si la migración del UNIQUE constraint causa problemas, revertir con una migración inversa. Los datos no se pierden, solo cambia el constraint.
4. **Cambios son independientes**: Los dos problemas (Web Flow + Stale Mappings) son ortogonales. Se pueden deployar/revertir por separado.

## Dependencies

- **Render Environment**: Necesita `CLIENT_SECRET` configurado como variable de entorno antes del deploy.
- **GitHub OAuth App Settings**: Necesita callback URL `https://ghagga.onrender.com/auth/callback` configurado en la GitHub OAuth App antes de probar.
- **Free tier constraints**: Todo debe funcionar dentro del tier gratuito de Render (una instancia, cold starts posibles) y GitHub Pages (estático, sin server-side logic).

## Considerations for Distribution Modes

| Mode                 | Impact                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| **SaaS (Dashboard)** | Principal beneficiario. Login simplificado, stale mapping cleanup.                                           |
| **GitHub Action**    | Sin impacto. No usa OAuth — se autentica con el GITHUB_TOKEN del workflow.                                   |
| **CLI**              | Sin impacto directo. Sigue usando Device Flow. Se beneficia de la limpieza de stale mappings en el servidor. |
| **1-Click Deploy**   | Sin impacto si usa self-hosted. Si comparte el servidor Render, se beneficia de ambos fixes.                 |

## Success Criteria

- [ ] Un usuario puede hacer login en el Dashboard con un solo click (redirect a GitHub y vuelta)
- [ ] El token se almacena en localStorage y el usuario queda autenticado
- [ ] En un dispositivo nuevo, el Dashboard distingue "necesitas login" de "necesitas instalar la App"
- [ ] Si la GitHub App se reinstala, los mappings viejos se limpian automáticamente (vía middleware o webhook)
- [ ] El constraint UNIQUE de `github_user_mappings` permite múltiples instalaciones por usuario
- [ ] Device Flow sigue funcionando en el servidor para el CLI
- [ ] PAT fallback sigue funcionando cuando el servidor no responde
- [ ] `CLIENT_SECRET` no aparece en ningún archivo commiteado ni en logs del servidor
- [ ] El flujo completo funciona con Render free tier (incluyendo cold starts)
- [ ] `AuthCallback` limpia el token de la URL inmediatamente después de extraerlo
