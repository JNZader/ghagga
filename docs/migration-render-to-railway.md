# Migración de Render a Railway - Guía Paso a Paso

## Pre-migración (5 minutos)

1. **Crear cuenta en Railway**
   - Ir a https://railway.app
   - Login con GitHub (misma cuenta que GHAGGA)

2. **Crear proyecto nuevo**
   - "New Project" → "Deploy from GitHub repo"
   - Seleccionar `JNZader/ghagga`
   - Railway detectará automáticamente el `railway.toml`

## Configuración de Variables (10 minutos)

En Railway Dashboard → Variables:

### Copiar desde Render:
```bash
# Estas las tenés que copiar manualmente desde tu dashboard de Render:
DATABASE_URL=<tu-connection-string-de-neon>
GITHUB_APP_ID=<mismo-valor>
GITHUB_PRIVATE_KEY=<mismo-valor-base64>
GITHUB_WEBHOOK_SECRET=<mismo-valor>
ENCRYPTION_KEY=<mismo-valor-hex-64-chars>
STATE_SECRET=<mismo-valor>
GITHUB_CLIENT_SECRET=<mismo-valor>

# Opcionales (si las tenías en Render):
INNGEST_EVENT_KEY=<si-lo-tenías>
INNGEST_SIGNING_KEY=<si-lo-tenías>
CALLBACK_TTL_MINUTES=11
```

### Variables automáticas (NO configurar):
- `PORT` - Railway lo setea automáticamente
- `RAILWAY_ENVIRONMENT` - Inyectado por Railway
- `RAILWAY_STATIC_URL` - Para health checks

## Deploy Inicial (5 minutos)

1. **Primer deploy**
   - Hacer commit del `railway.toml` a main
   - Railway auto-deployará
   - Verificar logs: "Building..." → "Deploying..." → "Running"

2. **Verificar health check**
   ```bash
   curl https://<tu-app>.up.railway.app/health
   # Debería devolver: {"status":"ok"}
   ```

## Actualizar GitHub App (5 minutos)

En https://github.com/settings/apps/ghagga-review:

1. **Webhook URL**
   - Cambiar: `https://ghagga.onrender.com/webhook`
   - A: `https://<tu-app>.up.railway.app/webhook`

2. **GitHub App → General → Webhook URL**
   - Actualizar al nuevo dominio de Railway

3. **OAuth Callback URL** (para Dashboard login)
   - Cambiar: `https://jnzader.github.io/ghagga/app/callback`
   - OJO: Esto NO cambia, es el mismo dashboard estático
   - Pero el backend callback es: `https://<tu-app>.up.railway.app/auth/callback`

## Actualizar Dashboard (2 minutos)

En `apps/dashboard/.env.production`:
```env
# Cambiar:
VITE_API_BASE_URL=https://ghagga.onrender.com
# A:
VITE_API_BASE_URL=https://<tu-app>.up.railway.app
```

Hacer commit y push → GitHub Pages auto-deployará el dashboard actualizado.

## Pruebas Post-migración (10 minutos)

1. **Test de webhook**
   ```bash
   curl -X POST https://<tu-app>.up.railway.app/webhook \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   # Debería devolver 200 (aunque falle la validación del signature)
   ```

2. **Test de health**
   ```bash
   curl https://<tu-app>.up.railway.app/health
   ```

3. **Test de API**
   ```bash
   curl https://<tu-app>.up.railway.app/api/repositories
   ```

4. **Test end-to-end**
   - Crear un PR en algún repo
   - Verificar que llega el webhook (logs de Railway)
   - Verificar que se procesa la review

## Rollback Plan (Si algo falla)

Si necesitás volver a Render:

1. En GitHub App settings, volver a cambiar el webhook URL al de Render
2. En Railway, pausar el servicio (no eliminar, por si acaso)
3. Render seguirá funcionando si no eliminaste el servicio

## Costos Esperados

| Uso | Costo aproximado |
|-----|------------------|
| Bajo tráfico (< 100 PRs/mes) | **$0-2/mes** (dentro de los $5 créditos) |
| Medio tráfico (100-500 PRs/mes) | **$3-5/mes** |
| Alto tráfico (500+ PRs/mes) | **$5-10/mes** |

## Troubleshooting

### "Build failed"
- Verificar que `railway.toml` está en la raíz del repo
- Verificar que el Dockerfile path es correcto: `apps/server/Dockerfile`

### "Health check failed"
- Aumentar `healthcheckTimeout` en `railway.toml` (default: 30s)
- Verificar que el servidor escucha en `process.env.PORT`

### "Out of memory"
- En Railway Dashboard → Resources → aumentar a 2GB RAM
- Esto consume más de los $5 créditos

### "Provider 'github' not available"
- Normal en SaaS mode - agregar PAT en Settings
- O usar otro provider (Anthropic, OpenAI)

## Post-migración: Limpiar Render (Opcional)

Después de 1-2 semanas confirmando que todo funciona:

1. Eliminar el servicio de Render (para no gastar minutos)
2. Exportar logs/historial si querés conservarlos

---

**Tiempo total estimado**: 30-40 minutos
**Downtime**: ~2-5 minutos (entre cambiar el webhook y que Railway esté listo)
