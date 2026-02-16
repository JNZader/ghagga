# Guia de Despliegue

Guia paso a paso para desplegar ghagga en produccion. Cubre los 4 componentes: base de datos (Supabase), Edge Functions, Dashboard (GitHub Pages) y Semgrep Service (opcional).

## Tabla de Contenidos

1. [Arquitectura de Despliegue](#arquitectura-de-despliegue)
2. [Prerequisitos](#prerequisitos)
3. [Paso 1: Crear proyecto en Supabase](#paso-1-crear-proyecto-en-supabase)
4. [Paso 2: Ejecutar migraciones de BD](#paso-2-ejecutar-migraciones-de-bd)
5. [Paso 3: Crear GitHub App](#paso-3-crear-github-app)
6. [Paso 4: Configurar secrets de Edge Functions](#paso-4-configurar-secrets-de-edge-functions)
7. [Paso 5: Desplegar Edge Functions](#paso-5-desplegar-edge-functions)
8. [Paso 6: Desplegar Dashboard en GitHub Pages](#paso-6-desplegar-dashboard-en-github-pages)
9. [Paso 7: Desplegar Semgrep Service (opcional)](#paso-7-desplegar-semgrep-service-opcional)
10. [Paso 8: CI/CD automatico](#paso-8-cicd-automatico)
11. [Verificacion post-despliegue](#verificacion-post-despliegue)
12. [Despliegue para otros proyectos (forks)](#despliegue-para-otros-proyectos-forks)
13. [Troubleshooting](#troubleshooting)

---

## Arquitectura de Despliegue

```
GitHub (PR events)
    |
    | webhook POST
    v
Supabase Edge Functions          Semgrep Service (opcional)
    |-- webhook/                       |-- FastAPI + Semgrep
    |-- review/                        |-- Railway / Docker
    |
    v
Supabase PostgreSQL
    |-- 9 migraciones
    |-- pgvector, FTS, RLS
    |-- RPCs de busqueda hibrida
    |
    v
Dashboard (GitHub Pages)
    |-- React + Mantine UI
    |-- SPA con client-side routing
```

---

## Prerequisitos

- **Cuenta GitHub** con permisos para crear GitHub Apps
- **Cuenta Supabase** (plan Free o superior)
- **Supabase CLI** instalado: `npm install -g supabase`
- **Node.js 20+** (para build del dashboard)
- **Al menos 1 API key de LLM**: Anthropic (`sk-ant-*`), OpenAI (`sk-*`), o Google AI (`AIza*`)

---

## Paso 1: Crear proyecto en Supabase

1. Ir a [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click **New Project**
3. Elegir organizacion, nombre, password de DB, y region
4. Esperar a que se aprovisione (~2 minutos)
5. Anotar estos valores de **Settings > API**:

| Valor | Donde encontrarlo | Variable |
|-------|-------------------|----------|
| Project URL | Settings > API > Project URL | `SUPABASE_URL` |
| Anon Key | Settings > API > anon public | `SUPABASE_ANON_KEY` |
| Service Role Key | Settings > API > service_role | `SUPABASE_SERVICE_ROLE_KEY` |
| Project Ref | URL del dashboard: `supabase.com/dashboard/project/<REF>` | `SUPABASE_PROJECT_ID` |
| DB Password | El que elegiste al crear el proyecto | `SUPABASE_DB_PASSWORD` |
| Access Token | [Account > Access Tokens](https://supabase.com/dashboard/account/tokens) | `SUPABASE_ACCESS_TOKEN` |

---

## Paso 2: Ejecutar migraciones de BD

Las 9 migraciones crean todo el schema: tablas, indexes HNSW/GIN, triggers, RPCs de busqueda hibrida, y politicas RLS.

```bash
# Login en Supabase CLI
supabase login

# Linkar al proyecto
supabase link --project-ref <TU_PROJECT_ID>

# Ejecutar las 9 migraciones
supabase db push
```

Esto crea:

| Migracion | Que crea |
|-----------|----------|
| 001 | Extensiones: pgvector, pg_trgm |
| 002 | Tablas core: installations, repo_configs |
| 003 | reviews, review_chunks, review_embeddings |
| 004 | review_threads |
| 005 | hebbian_associations |
| 006 | Indexes HNSW/GIN, RPCs de busqueda hibrida |
| 007 | Politicas RLS |
| 008 | static_analysis_results |
| 009 | memory_sessions, memory_observations, RPCs de memoria |

### Verificar

En Supabase Dashboard > SQL Editor:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
```

Debe listar: `hebbian_associations`, `installations`, `memory_observations`, `memory_sessions`, `repo_configs`, `review_chunks`, `review_embeddings`, `review_threads`, `reviews`, `static_analysis_results`.

---

## Paso 3: Crear GitHub App

Guia completa en [GITHUB_APP_SETUP.md](./GITHUB_APP_SETUP.md). Resumen rapido:

1. Ir a [github.com/settings/apps](https://github.com/settings/apps) > **New GitHub App**
2. Configurar:

| Campo | Valor |
|-------|-------|
| Name | `ghagga-reviewer` (o el nombre que prefieras) |
| Webhook URL | `https://<project-ref>.supabase.co/functions/v1/webhook` |
| Webhook Secret | Generar con `openssl rand -hex 32` |
| Content Type | `application/json` |

3. Permisos de repositorio:

| Permiso | Nivel | Motivo |
|---------|-------|--------|
| Contents | Read | Leer archivos del repo |
| Metadata | Read | Requerido por GitHub |
| Pull requests | Read & Write | Leer PRs y postear reviews |

4. Suscribirse a eventos:
   - **Pull request**
   - **Installation**
   - **Installation repositories**

5. Generar private key (descarga un `.pem`) y convertir a base64:

```bash
# Linux/macOS
cat ghagga-reviewer.pem | base64 -w 0

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("ghagga-reviewer.pem"))
```

6. Anotar credenciales:

| Credencial | Variable |
|------------|----------|
| App ID | `GITHUB_APP_ID` |
| Client ID | `GITHUB_CLIENT_ID` |
| Client Secret | `GITHUB_CLIENT_SECRET` |
| Private Key (base64) | `GITHUB_PRIVATE_KEY` |
| Webhook Secret | `GITHUB_WEBHOOK_SECRET` |

7. Instalar la app en los repos deseados desde `https://github.com/apps/<nombre-app>`

---

## Paso 4: Configurar secrets de Edge Functions

```bash
supabase secrets set \
  GITHUB_APP_ID="<tu-app-id>" \
  GITHUB_CLIENT_ID="<tu-client-id>" \
  GITHUB_CLIENT_SECRET="<tu-client-secret>" \
  GITHUB_PRIVATE_KEY="<base64-encoded-private-key>" \
  GITHUB_WEBHOOK_SECRET="<tu-webhook-secret>" \
  SUPABASE_URL="https://<project-ref>.supabase.co" \
  SUPABASE_ANON_KEY="<tu-anon-key>" \
  SUPABASE_SERVICE_ROLE_KEY="<tu-service-role-key>" \
  ANTHROPIC_API_KEY="<sk-ant-...>" \
  OPENAI_API_KEY="<sk-...>" \
  GOOGLE_AI_API_KEY="<AIza...>"
```

> Solo necesitas **al menos 1** API key de LLM. El `ProviderRegistry` usa fallback automatico en este orden: Anthropic > OpenAI > Google.

### Verificar

```bash
supabase secrets list
```

---

## Paso 5: Desplegar Edge Functions

```bash
# Deployar todas las funciones
supabase functions deploy --no-verify-jwt
```

O individualmente:

```bash
supabase functions deploy webhook --no-verify-jwt
supabase functions deploy review --no-verify-jwt
```

Las funciones desplegadas:

| Funcion | Endpoint | Proposito |
|---------|----------|-----------|
| `webhook` | `/functions/v1/webhook` | Recibe webhooks de GitHub, verifica firma, routea a handlers |
| `review` | `/functions/v1/review` | Orquesta el code review (simple/workflow/consensus) |

### Verificar

```bash
# Debe retornar 405 Method Not Allowed (solo acepta POST)
curl https://<project-ref>.supabase.co/functions/v1/webhook
```

---

## Paso 6: Desplegar Dashboard en GitHub Pages

El dashboard es una SPA React con Mantine UI. Se despliega automaticamente en GitHub Pages.

### 6.1 Habilitar GitHub Pages

1. Ir al repo en GitHub > **Settings** > **Pages**
2. En "Build and deployment", seleccionar **GitHub Actions** como source

### 6.2 Configurar secrets del dashboard

En **Settings** > **Secrets and variables** > **Actions**, agregar:

| Secret | Valor |
|--------|-------|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Tu anon key de Supabase |

### 6.3 Trigger del deploy

El workflow `deploy-pages.yml` se ejecuta automaticamente cuando:
- Se pushea a `main` con cambios en `dashboard/`
- Se dispara manualmente desde **Actions** > **Deploy Dashboard to GitHub Pages** > **Run workflow**

### 6.4 URL del dashboard

Despues del deploy, acceder en:

```
https://<usuario>.github.io/<nombre-repo>/
```

### 6.5 Base path dinamico

El base path se detecta automaticamente del nombre del repositorio. No hay que configurar nada extra, funciona con cualquier nombre de repo.

### 6.6 Deploy manual (alternativa)

```bash
cd dashboard
npm ci

# Variables de entorno para el build
export VITE_SUPABASE_URL=https://<project-ref>.supabase.co
export VITE_SUPABASE_ANON_KEY=<tu-anon-key>
export VITE_BASE_PATH=/<nombre-repo>/

npm run build
# Subir dist/ al hosting que prefieras (Vercel, Netlify, Cloudflare Pages, etc.)
```

### 6.7 Custom domain (opcional)

1. En el repo: **Settings** > **Pages** > **Custom domain** > ingresar tu dominio
2. Configurar DNS segun las instrucciones de GitHub
3. Si usas dominio custom en la raiz, cambiar `VITE_BASE_PATH=/`

---

## Paso 7: Desplegar Semgrep Service (opcional)

El servicio de Semgrep agrega analisis estatico avanzado (SAST) al pipeline de review. Es opcional - ghagga funciona sin el.

### Opcion A: Railway

```bash
cd semgrep-service
railway login
railway up
```

La configuracion ya esta en `railway.toml` (healthcheck en `/health`).

### Opcion B: Docker

```bash
cd semgrep-service
docker build -t ghagga-semgrep .
docker run -d -p 8000:8000 ghagga-semgrep
```

### Opcion C: Cualquier hosting con Python

```bash
cd semgrep-service
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

### Conectar con Edge Functions

Agregar la URL del servicio como secret:

```bash
supabase secrets set SEMGREP_SERVICE_URL="https://<tu-semgrep-url>"
```

---

## Paso 8: CI/CD automatico

El proyecto incluye 2 workflows de GitHub Actions que se ejecutan al pushear a `main`:

### deploy-functions.yml

| Trigger | Paths | Que hace |
|---------|-------|----------|
| Push a `main` | `supabase/functions/**`, `supabase/migrations/**` | Migraciones + deploy funciones + set secrets |
| `workflow_dispatch` | - | Deploy manual |

**Secrets requeridos en GitHub Actions:**

| Secret | Proposito |
|--------|-----------|
| `SUPABASE_ACCESS_TOKEN` | Auth del CLI |
| `SUPABASE_PROJECT_ID` | Linkar proyecto |
| `SUPABASE_DB_PASSWORD` | Ejecutar migraciones |
| `GITHUB_APP_ID` | Secret de la funcion |
| `GITHUB_CLIENT_ID` | Secret de la funcion |
| `GITHUB_CLIENT_SECRET` | Secret de la funcion |
| `GITHUB_PRIVATE_KEY` | Secret de la funcion |
| `GITHUB_WEBHOOK_SECRET` | Secret de la funcion |
| `SUPABASE_URL` | Secret de la funcion |
| `SUPABASE_ANON_KEY` | Secret de la funcion |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret de la funcion |
| `ANTHROPIC_API_KEY` | LLM (al menos 1) |
| `OPENAI_API_KEY` | LLM (opcional) |
| `GOOGLE_AI_API_KEY` | LLM (opcional) |

### deploy-pages.yml

| Trigger | Paths | Que hace |
|---------|-------|----------|
| Push a `main` | `dashboard/**` | Build + deploy a GitHub Pages |
| `workflow_dispatch` | - | Deploy manual |

**Secrets requeridos:**

| Secret | Proposito |
|--------|-----------|
| `VITE_SUPABASE_URL` | URL de Supabase para el frontend |
| `VITE_SUPABASE_ANON_KEY` | Anon key para el frontend |

---

## Verificacion post-despliegue

### 1. Base de datos

En Supabase Dashboard > SQL Editor:

```sql
-- Verificar tablas
SELECT count(*) FROM memory_sessions;  -- Debe retornar 0
SELECT count(*) FROM installations;     -- Debe retornar 0

-- Verificar RPCs
SELECT proname FROM pg_proc WHERE proname LIKE 'hybrid_search%' OR proname LIKE 'search_memory%';
-- Debe listar: hybrid_search_reviews, hybrid_search_memory, search_memory_observations_vector
```

### 2. Edge Functions

```bash
# Webhook (debe dar 405)
curl -s -o /dev/null -w "%{http_code}" \
  https://<project-ref>.supabase.co/functions/v1/webhook
# Esperado: 405

# Review (debe dar 401 sin auth)
curl -s -o /dev/null -w "%{http_code}" \
  https://<project-ref>.supabase.co/functions/v1/review
# Esperado: 401 o 405
```

### 3. Dashboard

Navegar a `https://<usuario>.github.io/<repo>/` y verificar:
- Carga la pagina de login/home
- Las rutas `/memory`, `/settings`, `/reviews` funcionan
- Recargar la pagina en una subruta no da 404

### 4. Test end-to-end

1. Instalar la GitHub App en un repo de prueba
2. Abrir un PR con cambios de codigo
3. Verificar que el bot comenta con el code review en ~30-60 segundos
4. En Supabase Dashboard, verificar que se creo un registro en `reviews` y `memory_sessions`

---

## Despliegue para otros proyectos (forks)

ghagga esta preparado para funcionar con cualquier nombre de repositorio. Si haces fork o lo usas en otro proyecto:

### Lo que se adapta solo

- **Base path del dashboard**: Se genera automaticamente de `github.event.repository.name` en el workflow
- **BrowserRouter basename**: Usa `import.meta.env.BASE_URL` (se configura en build)
- **404.html SPA redirect**: Funciona con cualquier base path

### Lo que hay que configurar

1. Crear tu propio proyecto en Supabase
2. Crear tu propia GitHub App (apuntando a tu Supabase)
3. Configurar los secrets de GitHub Actions de tu repo
4. Habilitar GitHub Pages con source "GitHub Actions"

### Ejemplo: fork como `mi-org/code-reviewer`

```
Dashboard URL: https://mi-org.github.io/code-reviewer/
Webhook URL:   https://<mi-project>.supabase.co/functions/v1/webhook
```

No se necesita cambiar ni una linea de codigo.

---

## Troubleshooting

### Migraciones fallan

```bash
# Ver estado de migraciones
supabase migration list

# Si hay conflictos, reparar manualmente en SQL Editor
# y luego marcar como aplicada
supabase migration repair <version> --status applied
```

### Edge Functions no responden

```bash
# Ver logs en tiempo real
supabase functions logs webhook --tail

# Verificar secrets
supabase secrets list
```

### Dashboard da 404 en subrutas

- Verificar que `dashboard/public/404.html` existe en el build
- Verificar que GitHub Pages usa "GitHub Actions" como source (no "Deploy from branch")

### Webhook no recibe eventos

1. En GitHub App settings > **Advanced** > **Recent Deliveries**: ver si los webhooks se envian
2. Verificar que la Webhook URL sea exacta: `https://<ref>.supabase.co/functions/v1/webhook`
3. Verificar que el `GITHUB_WEBHOOK_SECRET` coincida exactamente

### Review no comenta en el PR

1. Verificar logs: `supabase functions logs review --tail`
2. Verificar que al menos 1 API key de LLM este configurada
3. Verificar que la GitHub App tenga permisos de `pull_requests: write`
4. Verificar que el PR no sea draft y la accion sea `opened`, `synchronize`, o `reopened`

### Memoria no funciona

1. Verificar en `repo_configs` que `memory_enabled = true` para el repo
2. Verificar que las tablas `memory_sessions` y `memory_observations` existen
3. Los embeddings requieren que al menos 1 LLM provider con embeddings este disponible

---

## Referencias

- [Supabase CLI Docs](https://supabase.com/docs/guides/cli)
- [GitHub Apps Documentation](https://docs.github.com/en/apps)
- [GitHub Pages](https://docs.github.com/en/pages)
- [Variables de entorno](./ENV_VARIABLES.md)
- [Setup de GitHub App](./GITHUB_APP_SETUP.md)
- [Configuracion](./CONFIGURATION.md)
