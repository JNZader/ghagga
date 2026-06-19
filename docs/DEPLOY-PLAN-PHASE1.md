# Plan de Despliegue — Fase 1: ghagga en Contabo VPS 30 + Coolify

> **Estado**: plan para ejecutar MÁS TARDE (no ahora). Self-contained, sourced del repo real.
> **Objetivo**: primer deploy productivo del `server` + `worker` de ghagga en un VPS barato,
> dejando todo listo para shippear la feature **issue-triage** (`/ghagga triage`).

---

## Resumen + decisión

Desplegamos ghagga (server HTTP + worker BullMQ + Postgres + Redis) en una **Contabo VPS 30**
(8 vCPU / 24 GB RAM / 200 GB NVMe, **x86_64**) por ~**$16.80/mes**, gestionado con **Coolify**.
Elegimos x86 porque los CLIs de LLM que el worker hornea en la imagen — sobre todo **OpenCode**,
que se baja como binario `opencode-linux-x64` (ver `apps/server/Dockerfile`) — son **x86-only**;
ARM quedaría afuera. Coolify nos da multi-proyecto (otras apps en la misma caja) + SSL automático
+ backups programados de Postgres. Es **single-box PROD** a propósito: NO triple-stack
(Render/Northflank/Neon/Inngest), todo self-hosted en una sola máquina con headroom de RAM para
los CLIs. El razonamiento de costo/arquitectura es la continuación del existente
[`docs/HETZNER-COOLIFY-DEPLOY.md`](HETZNER-COOLIFY-DEPLOY.md) (ese migra de Render a Hetzner CX21;
acá adaptamos a Contabo, que es más barato por RAM y nos da el headroom que los LLM CLIs necesitan).

---

## Pre-requisitos

- [ ] Cuenta en **Contabo** (https://contabo.com) con método de pago.
- [ ] **Dominio** propio con acceso al panel DNS (Cloudflare, registrador, etc.).
- [ ] **GitHub App de ghagga ya existente** (App ID, private key `.pem`, webhook secret). Si no existe,
      crearla siguiendo `docs/self-hosted.md` §1.
- [ ] Acceso **SSH** desde tu máquina (`ssh-keygen` si no tenés par de claves).
- [ ] Cliente para generar secretos: `openssl` + `node` (ambos locales).

---

## Parte 1 — Provisionar el VPS (Contabo VPS 30)

> **Diferencias clave vs el doc de Hetzner**: Contabo NO tiene un cloud-console tan pulido como
> Hetzner; el alta de SSH key se hace en el formulario de pedido o post-provisioning vía panel.
> La IP puede tardar más en estar lista (provisioning de Contabo es más lento). Contabo es
> **oversold** (ver Notas/gotchas) — performance esporádicamente variable, aceptable para esta carga.

- [ ] 1.1 Entrar a https://contabo.com → **VPS** → elegir **VPS 30** (8 vCPU / 24 GB / 200 GB NVMe, **x86**).
      - Confirmá explícitamente la arquitectura **x86_64** (NO el plan ARM "VPS … ARM"). Esto es bloqueante por OpenCode.
- [ ] 1.2 **Region**: la más cercana a tus repos/usuarios (EU Central o US Central típico).
- [ ] 1.3 **Image**: `Ubuntu 22.04` (o 24.04 LTS). Coolify soporta ambas.
- [ ] 1.4 **SSH key**: pegar tu clave pública.
      ```bash
      cat ~/.ssh/id_ed25519.pub   # o id_rsa.pub
      # Si no existe:
      ssh-keygen -t ed25519 -C "tu-email@ejemplo.com"
      ```
- [ ] 1.5 Completar el pedido. Esperar el email de Contabo con la **IP pública** y credenciales.
- [ ] 1.6 Verificar conexión SSH:
      ```bash
      ssh root@TU_IP
      ```
- [ ] 1.7 Actualizar y firewall básico (UFW):
      ```bash
      apt update && apt upgrade -y
      apt install -y curl wget git htop ufw
      ufw allow OpenSSH        # 22
      ufw allow 80/tcp         # HTTP (Let's Encrypt + Traefik)
      ufw allow 443/tcp        # HTTPS
      ufw allow 8000/tcp       # Coolify UI (cerrar después si querés, o usar dominio)
      ufw --force enable
      ufw status
      ```

---

## Parte 2 — Instalar Coolify

> La instalación de Coolify es **provider-agnóstica**: reutilizamos los pasos de
> [`docs/HETZNER-COOLIFY-DEPLOY.md` §Parte 3](HETZNER-COOLIFY-DEPLOY.md) tal cual. Resumen:

- [ ] 2.1 Ejecutar el instalador oficial (one-liner) en el VPS por SSH:
      ```bash
      curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
      ```
      Tarda 3-5 min (instala Docker + Coolify).
- [ ] 2.2 Verificar Docker corriendo: `docker ps`.
- [ ] 2.3 Abrir la UI: `http://TU_IP:8000` → **Register** (admin email + password fuerte, guardalo).
- [ ] 2.4 Wizard de setup: Instance Domain `coolify.tudominio.com`, Instance Name `ghagga Production`.
- [ ] 2.5 (Opcional pero recomendado) conectar la **GitHub App de Coolify** como Source para deploy
      automático desde el repo — ver `HETZNER-COOLIFY-DEPLOY.md §Parte 4`.
      > OJO: esta es la GitHub App **de Coolify** (para clonar/deployar el repo), distinta de la
      > **GitHub App de ghagga** (la que recibe webhooks). No confundirlas.

---

## Parte 3 — DNS + SSL

> Idéntico a `HETZNER-COOLIFY-DEPLOY.md §Parte 2 y §3.5`. Apuntá los A records a la **IP de Contabo**.

- [ ] 3.1 Crear A record `coolify.tudominio.com` → IP de Contabo (Proxy **DNS only** si usás Cloudflare).
- [ ] 3.2 Crear A record `api.tudominio.com` → misma IP (este es el endpoint del **server** de ghagga).
- [ ] 3.3 (Opcional) A record para el dashboard si lo hosteás acá también (`app.tudominio.com`).
- [ ] 3.4 Verificar propagación: `nslookup api.tudominio.com`.
- [ ] 3.5 SSL: Coolify emite Let's Encrypt automáticamente vía **Traefik** al asignar el dominio a la app.
      No hay paso manual de certbot.

---

## Parte 4 — Desplegar el stack ghagga

El stack está definido en [`docker-compose.yml`](../docker-compose.yml) (raíz del repo). Servicios reales:

| Servicio | Imagen / Build | Puerto | Volumen | Healthcheck |
|----------|----------------|--------|---------|-------------|
| **server** | build `apps/server/Dockerfile`, context = **raíz del monorepo**, `SERVICE_TYPE=server` | `3000:3000` | — | `GET /health` (node fetch) |
| **worker** | mismo Dockerfile, `SERVICE_TYPE=worker` | — | — | — (no healthcheck) |
| **postgres** | `postgres:16-alpine` | interno | `postgres-data:/var/lib/postgresql/data` | `pg_isready -U ghagga -d ghagga` |
| **redis** | `redis:7-alpine`, `--appendonly yes --save 60 1` | interno | `redis-data:/data` | `redis-cli ping` |

Notas de build (de `apps/server/Dockerfile`):
- **Build context = raíz del monorepo** (`context: .`), dockerfile `apps/server/Dockerfile`. Multi-stage (node:22-slim, pnpm@9).
- **Build-args** (con defaults, normalmente NO hace falta tocarlos): `CLI_TOOLS_VERSION=4`,
  `OPENCODE_VERSION=1.2.27`. Bumpealos solo para invalidar cache o subir versión de OpenCode.
- La imagen hornea los **CLIs del cli-bridge**: OpenCode (binario x86), Gemini CLI y GitHub Copilot CLI
  (estos dos vía npm, opcionales — fallan en silencio con WARNING si no instalan).
- `server` y `worker` **comparten la misma imagen**; sólo cambia `SERVICE_TYPE`.

### Opción recomendada: Docker Compose deployment en Coolify

- [ ] 4.1 En Coolify → New Project `ghagga` → **+ New Resource** → **Application** → repo ghagga.
- [ ] 4.2 Build Pack = **Docker Compose**. Base Directory = `/`. Compose file = `docker-compose.yml`.
      - Esto levanta los 4 servicios (server, worker, postgres, redis) tal como están en el compose,
        con sus volúmenes nombrados (`postgres-data`, `redis-data`) → **Postgres persiste** entre deploys.
- [ ] 4.3 Asignar el dominio `api.tudominio.com` → puerto `3000` (al servicio `server`).
- [ ] 4.4 Healthcheck: path `/health`, port `3000` (ya viene en el compose + Dockerfile).
- [ ] 4.5 Cargar las variables de entorno (ver **Parte 5**) ANTES del primer deploy.
- [ ] 4.6 **Deploy**. Esperar build (3-8 min la primera vez por los CLIs).

> **Alternativa (per-service)**: si preferís que Coolify gestione Postgres y Redis como recursos
> nativos (con sus propios backups programados), creá `ghagga-db` (PostgreSQL 16) y `ghagga-redis`
> (Redis 7) como recursos separados, y deployá sólo `server` + `worker` desde el Dockerfile apuntando
> `DATABASE_URL` / `REDIS_URL` a esos recursos. Esto es lo que hace el doc de Hetzner (§5.2–5.4) y
> habilita los **scheduled backups** nativos de Coolify sobre Postgres. **Tradeoff**: más pasos manuales
> de wiring, pero backups y monitoreo de DB más prolijos. Para single-box PROD, esta alternativa es la
> preferible a mediano plazo.

---

## Parte 5 — Variables de entorno

> Fuente: `docker-compose.yml`, `.env.example` (raíz), y grep real de `process.env.*` en
> `apps/server/src` + `packages/core/src` + `packages/db/src`. **SECRET** = generás/obtenés;
> **CONFIG** = tiene default sensato. Cargalas en Coolify por servicio.

### Compartidas — server **y** worker

| Var | Tipo | Propósito | Cómo obtener / generar | Ejemplo |
|-----|------|-----------|------------------------|---------|
| `DATABASE_URL` | **SECRET** | Conexión Postgres (server corre migraciones; worker lee/escribe) | Del recurso Postgres de Coolify, o del compose: `postgresql://ghagga:<pass>@postgres:5432/ghagga` | `postgresql://ghagga:xxx@postgres:5432/ghagga` |
| `REDIS_URL` | CONFIG | Cola BullMQ | Default compose `redis://redis:6379`; si Redis nativo Coolify, `redis://ghagga-redis:6379` | `redis://redis:6379` |
| `REDIS_HOST` | CONFIG | Host Redis (usado por algunos paths) | Default `redis` | `redis` |
| `REDIS_PORT` | CONFIG | Puerto Redis | Default `6379` | `6379` |
| `GITHUB_APP_ID` | **SECRET** | ID numérico de la GitHub App de ghagga | Settings de la GitHub App (arriba de todo) | `2991025` |
| `GITHUB_PRIVATE_KEY` | **SECRET** | Firma JWTs de la App | Descargar `.pem` de GitHub App → Private keys. En Coolify usar input **multilínea** (PEM completo con saltos) | `-----BEGIN RSA PRIVATE KEY----- …` |
| `ENCRYPTION_KEY` | **SECRET** | AES-256-GCM de las API keys de LLM guardadas (BYOK) | `openssl rand -hex 32` (o `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) | 64 hex chars |
| `ANTHROPIC_API_KEY` | CONFIG (opcional) | Fallback LLM si un repo no trae su propia key | Consola Anthropic | `sk-ant-…` |
| `OPENAI_API_KEY` | CONFIG (opcional) | Fallback LLM | Plataforma OpenAI | `sk-…` |
| `GOOGLE_AI_API_KEY` | CONFIG (opcional) | Fallback LLM | Google AI Studio | `AIza…` |
| `NODE_ENV` | CONFIG | Entorno Node | `production` (lo fija el compose) | `production` |

### Solo **server**

| Var | Tipo | Propósito | Cómo obtener / generar | Ejemplo |
|-----|------|-----------|------------------------|---------|
| `SERVICE_TYPE` | CONFIG | Selecciona server vs worker | `server` (lo fija el compose) | `server` |
| `PORT` | CONFIG | Puerto HTTP del server (Hono) | Default `3000` | `3000` |
| `GITHUB_WEBHOOK_SECRET` | **SECRET** | Verifica firma de webhooks de GitHub | `openssl rand -hex 32` — debe coincidir con el seteado en la GitHub App | 64 hex chars |
| `GITHUB_CLIENT_ID` | CONFIG (opcional) | OAuth login del dashboard | GitHub App → OAuth credentials | `Iv1.…` |
| `GITHUB_CLIENT_SECRET` | **SECRET** (opcional) | OAuth login del dashboard | GitHub App → OAuth credentials | (secret) |
| `STATE_SECRET` | **SECRET** (opcional) | CSRF del OAuth web flow | `openssl rand -hex 32` | 64 hex chars |
| `SERVER_URL` | CONFIG (opcional) | URL pública del server (callbacks del runner) | Tu dominio | `https://api.tudominio.com` |
| `ALLOWED_ORIGINS` | CONFIG (opcional) | CORS (coma-separado) | Dominios del dashboard | `https://app.tudominio.com` |
| `CALLBACK_TTL_MINUTES` | CONFIG (opcional) | TTL del secret de callback del runner | Default `11` | `11` |
| `LOG_LEVEL` | CONFIG (opcional) | Nivel de log (pino). Default `info` en prod | — | `info` |

### Solo **worker**

| Var | Tipo | Propósito | Cómo obtener / generar | Ejemplo |
|-----|------|-----------|------------------------|---------|
| `SERVICE_TYPE` | CONFIG | Selecciona worker | `worker` (lo fija el compose) | `worker` |
| `WORKER_CONCURRENCY` | CONFIG | Jobs concurrentes por worker | Default `3` | `3` |
| `SEMGREP_PATH` | CONFIG (opcional) | Override binario Semgrep | Si no se setea, busca `semgrep` en PATH | `/usr/local/bin/semgrep` |
| `TRIVY_PATH` | CONFIG (opcional) | Override binario Trivy | Si no se setea, busca `trivy` en PATH | `/usr/local/bin/trivy` |
| `GHAGGA_ALLOW_PRIVATE_GATEWAY` | CONFIG (opcional) | **NO setear en prod**: habilita gateways privados/loopback (defensa SSRF). Dejar sin setear. | — | (vacío) |

### Solo **postgres** (recurso compose)

| Var | Tipo | Propósito | Cómo obtener / generar | Ejemplo |
|-----|------|-----------|------------------------|---------|
| `DB_PASSWORD` | **SECRET** | Password del usuario `ghagga` de Postgres | `openssl rand -hex 24` (o el generador de Coolify) | (secret) |

> `POSTGRES_USER=ghagga` y `POSTGRES_DB=ghagga` están **hardcodeados** en el compose; sólo
> `DB_PASSWORD` es variable. `DATABASE_URL` debe usar ese mismo password.

### Dashboard (si lo deployás)

| Var | Tipo | Propósito | Ejemplo |
|-----|------|-----------|---------|
| `VITE_API_URL` | CONFIG (build-time) | URL del server que consume el dashboard | `https://api.tudominio.com` |

> En `apps/dashboard/.env.production` está fijado a `https://api.javierzader.com` — ajustalo a tu dominio.

**Conteo**: **SECRETS** = `DATABASE_URL`, `GITHUB_PRIVATE_KEY`, `GITHUB_APP_ID`, `ENCRYPTION_KEY`,
`GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_SECRET`, `STATE_SECRET`, `DB_PASSWORD` → **8 secrets**
(5 estrictamente requeridos para arrancar: `DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `ENCRYPTION_KEY`; los otros 3 son del OAuth del dashboard, opcionales).
El resto son **CONFIG con default** (incluyendo las 3 API keys de LLM, opcionales).

---

## Parte 6 — Issue-triage específico

> **IMPORTANTE**: la feature issue-triage vive en el branch **`feat/issue-triage-agent`** (NO está
> en `main` todavía). Está **release-blocked** hasta deployar el server + cerrar la lista PRE-LAUNCH 🔐
> (ver Pendientes). El código está construido y testeado; el deploy es lo que falta.

Mecánica real (de `apps/server/src/routes/webhook.ts` y `docs/issue-triage.md` del branch):

1. Un maintainer comenta **`/ghagga triage`** en un **issue plano** (no PR).
2. El server lo recibe vía el evento webhook **`issue_comment`** (action `created`) — el **mismo evento
   que ya usa el review por `/ghagga review`**. NO requiere un evento webhook nuevo distinto.
3. El server aplica un gate **más estricto** (`OWNER`/`MEMBER`/`COLLABORATOR` — write-association),
   reacciona con 👀, fetchea issue+comentarios (con caps de tamaño anti-DoS) y encola un job `issue-analysis`.
4. El **worker NUNCA postea**: corre el agente de triage y persiste un **DRAFT**.
5. Un humano revisa/edita el draft en el **Dashboard** (página Issue Triage) y aprueba.
6. **Solo al aprobar** (`POST /api/issue-drafts/:id/approve`) el server postea el comentario en el issue
   (con CAS posting-lock → exactly-once).

### Permiso de GitHub App nuevo: `Issues: Read and write`

- [ ] 6.1 En Settings de la **GitHub App de ghagga** → **Repository permissions** → setear
      **Issues: Read and write** (read = fetchear issue+comentarios; write = postear el draft aprobado).
- [ ] 6.2 **RE-CONSENT (bloqueante)**: agregar el scope `Issues` a una App **ya instalada** dispara un
      prompt de re-consentimiento mandado por GitHub para **cada instalación existente** — los admins
      deben **re-aprobar** el nuevo permiso antes de que la App siga funcionando.
      - Bundlear este cambio con el deploy pre-launch para que las instalaciones se re-prompten **una sola vez**.
- [ ] 6.3 **Subscribe to events**: confirmar que **Issue comment** está tildado (ya lo está para review).
      > **VERIFICAR**: en GitHub Apps, el evento `Issue comment` cubre comentarios tanto en PRs como en
      > issues planos, por lo que `/ghagga triage` funciona con SOLO `Issue comment` suscrito; el evento
      > **Issues** (open/close/label) NO es necesario para v1 (no hay label-gate todavía). El permiso
      > `Issues: Read and write` SÍ es necesario (para el fetch + post). Confirmar en GitHub al configurar.

### Webhook URL + secret

- [ ] 6.4 En la GitHub App → **Webhook URL** = `https://api.tudominio.com/webhook`
      (la ruta es `/webhook`, ver `apps/server/src/routes/webhook.ts`).
- [ ] 6.5 **Webhook secret** = el valor de `GITHUB_WEBHOOK_SECRET` que generaste (Parte 5). Debe coincidir
      exactamente entre la GitHub App y la env var del server.

---

## Parte 7 — Migraciones de DB

Las migraciones corren **automáticamente al arrancar el server** (verificado en `apps/server/start.sh`):

```sh
# start.sh (modo server):
cd /app/packages/db && npx tsx src/migrate.ts   # Drizzle migrations + _custom_tsvector.sql
cd /app
node apps/server/dist/index.js
```

- `migrate.ts` (de `packages/db/src/migrate.ts`) corre las migraciones Drizzle de `packages/db/drizzle`
  y luego el SQL custom idempotente `_custom_tsvector.sql` (tsvector + triggers).
- El **worker NO corre migraciones** (`start.sh` salta directo a `node …/workers/review.js`). Por lo tanto:
  - [ ] 7.1 Asegurar que el **server arranca al menos una vez ANTES (o junto a)** que el worker procese jobs,
        para que el schema exista. En el compose ambos `depends_on` postgres healthy, pero solo el server migra.
  - [ ] 7.2 La feature issue-triage agrega una migración (`packages/db/drizzle/0001_low_wild_pack.sql`,
        tabla de issue-drafts) en el branch — correrá igual al deployar ese branch (mismo `migrate.ts`).
- [ ] 7.3 Verificar en logs del server al primer deploy: `🔄 Running database migrations...` → `✅ Drizzle migrations complete`.

---

## Parte 8 — Verificación post-deploy (checklist)

- [ ] 8.1 **Health endpoint**: `curl https://api.tudominio.com/health` → `{"status":"ok"}` (o similar).
- [ ] 8.2 **Logs server** (Coolify): ver migraciones OK + `🚀 Starting GHAGGA API Server...`.
- [ ] 8.3 **Logs worker** (Coolify): ver el chequeo de CLIs — `✅ opencode: <version>` (crítico),
      gemini/copilot pueden faltar (WARNING benigno).
- [ ] 8.4 **Webhook ping**: en la GitHub App → Advanced → Recent Deliveries, reenviar un ping → 200.
- [ ] 8.5 **E2E de review** (sanity del pipeline base): comentar `ghagga review` en un PR de un repo tracked → review posteado.
- [ ] 8.6 **E2E de issue-triage** (cuando el branch esté mergeado + permiso `Issues` consentido):
      1. Comentar `/ghagga triage` en un **issue plano** (como OWNER/MEMBER/COLLABORATOR).
      2. Ver la reacción 👀 + el job `issue-analysis` en logs del worker.
      3. En el **Dashboard → Issue Triage**, aparece el **draft**.
      4. **Aprobar** el draft → el comentario se postea en el issue (exactly-once).
- [ ] 8.7 Verificar persistencia: redeploy → Postgres conserva data (volumen `postgres-data`).

---

## Notas / gotchas

- **x86-only (OpenCode)**: el Dockerfile baja `opencode-linux-x64`. En ARM el worker arranca pero
  OpenCode no existe → el provider cli-bridge degradado. Por eso VPS 30 **x86**, no ARM.
- **Headroom de RAM (24 GB)**: los CLIs de LLM (OpenCode, Gemini, Copilot) + Node + Postgres + Redis
  en una caja necesitan margen. 24 GB da aire; 4 GB (CX21 del doc Hetzner) sería ajustado para correr
  los CLIs además del stack.
- **Multi-proyecto**: Coolify permite hostear otras apps en la misma caja (otros proyectos/recursos).
  El stack de ghagga queda aislado en su propio proyecto Coolify.
- **Backups de Postgres**: si usás el recurso Postgres **nativo de Coolify** (Opción per-service de
  Parte 4), habilitá los **Scheduled Backups** de Coolify (S3/local). Si usás el Postgres del compose,
  los backups hay que configurarlos a mano (pg_dump cron o snapshot del volumen).
- **Contabo oversold**: Contabo sobre-vende capacidad; el rendimiento puede variar esporádicamente.
  Para esta carga (webhooks + jobs de review/triage, no real-time crítico) es aceptable. Reviews
  ocasionalmente más lentos = OK.
- **GitHub App de Coolify ≠ GitHub App de ghagga**: dos Apps distintas. La de Coolify clona/deploya;
  la de ghagga recibe webhooks y postea comentarios.

---

## Pendientes antes de shippear

Estos gates son **bloqueantes para usuarios reales** (el código está build+test, falta release):

- [ ] **Mergear `feat/issue-triage-agent` a `main`**. Tiene un **conflicto webhook/cli-bridge**
      (las tablas de memoria recientes lo marcan: conflicto entre el branch de triage y cambios de
      cli-bridge). Resolverlo antes del merge.
      > **VERIFICAR**: el detalle exacto del conflicto está en el plan del branch / engram
      > (`project_ghagga_issue_triage`), no en `main`. Revisar `git diff main..feat/issue-triage-agent`
      > sobre `apps/server/src/routes/webhook.ts` y `packages/core/src/providers/cli-bridge.ts`.
- [ ] **Cerrar la lista PRE-LAUNCH 🔐** (hard gate de seguridad pre-launch). Incluye, entre otros:
      SSRF hardening, connection pools, `checklistContext`, etc.
      > **VERIFICAR**: la lista PRE-LAUNCH 🔐 completa NO está como archivo en el repo — vive en
      > engram (`project_ghagga_issue_triage`) / el plan del branch. Recuperarla de ahí antes de
      > marcar este gate como cerrado. Los ítems citados (SSRF/pools/checklistContext) son los
      > recordados; confirmar el set completo en engram.
- [ ] **Re-consent del permiso `Issues`**: bundlear con el deploy pre-launch (Parte 6.2) para
      re-promptear las instalaciones una sola vez.
- [ ] **Rotar cualquier secreto** que haya estado expuesto antes de cargarlo en Coolify
      (mismo principio que `HETZNER-COOLIFY-DEPLOY.md`).

---

## Referencias del repo

- `docker-compose.yml` — stack (server/worker/postgres/redis), puertos, volúmenes, healthchecks.
- `apps/server/Dockerfile` — build multi-stage, CLIs horneados, build-args, healthcheck.
- `apps/server/start.sh` — migraciones al arrancar + selección server/worker por `SERVICE_TYPE`.
- `packages/db/src/migrate.ts` — runner de migraciones Drizzle + SQL custom.
- `apps/server/src/routes/webhook.ts` — ruta `/webhook`, eventos (`pull_request`, `issue_comment`, `installation`).
- `.env.example` — env vars documentadas (raíz).
- `docs/self-hosted.md` — setup de la GitHub App de ghagga (permisos + eventos).
- `docs/HETZNER-COOLIFY-DEPLOY.md` — base provider-agnóstica de Coolify (DNS/SSL/deploy).
- `docs/issue-triage.md` (branch `feat/issue-triage-agent`) — feature issue-triage en detalle.
