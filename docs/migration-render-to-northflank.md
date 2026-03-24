# Migración de Render a Northflank - Guía Paso a Paso

## Pre-migración (5 minutos)

1. **Crear cuenta en Northflank**
   - Ir a https://northflank.com
   - Sign up (puede ser con GitHub)
   - Crear un nuevo proyecto (ej: "ghagga")

2. **Conectar repositorio GitHub**
   - En Northflank Dashboard → "Integrations" → GitHub
   - Autorizar acceso al repo `JNZader/ghagga`

## Método 1: Deploy via YAML (Recomendado - 10 minutos)

1. **Aplicar la configuración**
   ```bash
   # Instalar Northflank CLI (opcional, pero útil)
   npm install -g @northflank/cli
   
   # O simplemente usar el dashboard web:
   # Services → Create Service → Import YAML
   ```

2. **En el Dashboard:**
   - Ir a "Services" → "Create Service"
   - Seleccionar "Import YAML"
   - Pegar el contenido de `northflank-service.yaml`
   - Deploy

## Método 2: Manual via Dashboard (15 minutos)

1. **Create Service**
   - Tipo: "Build from GitHub repository"
   - Repo: `JNZader/ghagga`
   - Branch: `main`
   - Dockerfile path: `apps/server/Dockerfile`
   - Build context: `.` (root)

2. **Configurar recursos**
   - CPU: 100m (o 250m si querés más potencia)
   - RAM: 512Mi
   - Instances: 1

3. **Puertos y dominio**
   - Port: 3000
   - Protocol: HTTP
   - Public: Sí
   - Domain: Auto-generado (ej: `ghagga-server--ghagga.northflank.app`)

4. **Health check**
   - Path: `/health`
   - Port: 3000
   - Initial delay: 10s
   - Interval: 30s

## Configurar Variables de Entorno (10 minutos)

En Northflank Dashboard → Tu Servicio → "Environment" → "Variables":

### Variables obligatorias:
```
DATABASE_URL=<tu-connection-string-de-neon>
GITHUB_APP_ID=<mismo-valor-de-render>
GITHUB_PRIVATE_KEY=<mismo-valor-base64>
GITHUB_WEBHOOK_SECRET=<mismo-valor>
ENCRYPTION_KEY=<mismo-valor-hex-64-chars>
STATE_SECRET=<mismo-valor>
GITHUB_CLIENT_SECRET=<mismo-valor>
PORT=3000
NODE_ENV=production
```

### Variables opcionales:
```
INNGEST_EVENT_KEY=<si-lo-tenías>
INNGEST_SIGNING_KEY=<si-lo-tenías>
CALLBACK_TTL_MINUTES=11
```

**Nota**: Northflank soporta secrets (variables enmascaradas). Marcá como "Secret" las que sean sensibles (ENCRYPTION_KEY, GITHUB_PRIVATE_KEY, etc.)

## Deploy y Verificación (5 minutos)

1. **Primer deploy**
   - Hacer commit del `northflank-service.yaml` a main
   - Northflank auto-detectará y hará build
   - Verificar logs en Dashboard → "Builds"

2. **Verificar health endpoint**
   ```bash
   curl https://<tu-servicio>.northflank.app/health
   # Debería devolver: {"status":"ok"}
   ```

3. **Verificar que el servidor responde**
   ```bash
   curl https://<tu-servicio>.northflank.app/api/repositories
   ```

## Actualizar GitHub App (5 minutos)

En https://github.com/settings/apps/ghagga-review:

### 1. Webhook URL
- Cambiar: `https://ghagga.onrender.com/webhook`
- A: `https://<tu-servicio>.northflank.app/webhook`

### 2. OAuth Callback URL
- Cambiar backend callback a: `https://<tu-servicio>.northflank.app/auth/callback`
- El frontend sigue igual: `https://ghagga.javierzader.com/app/callback`

## Actualizar Dashboard (2 minutos)

En `apps/dashboard/.env.production`:
```env
# Cambiar:
VITE_API_BASE_URL=https://ghagga.onrender.com
# A:
VITE_API_BASE_URL=https://<tu-servicio>.northflank.app
```

Commit y push → GitHub Pages auto-deployará.

## Pruebas Post-migración (10 minutos)

### 1. Test de webhook
```bash
curl -X POST https://<tu-servicio>.northflank.app/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": true}'
# Status 200 (aunque falle validación de signature es OK)
```

### 2. Test de health
```bash
curl https://<tu-servicio>.northflank.app/health
```

### 3. Test de API
```bash
curl https://<tu-servicio>.northflask.app/api/repositories
```

### 4. Test end-to-end
- Crear PR de prueba
- Verificar logs en Northflank Dashboard
- Confirmar que procesa el webhook

## Configuración Avanzada (Opcional)

### Persistencia de logs
Northflank guarda logs por defecto por 7 días en free tier.

### Monitoreo
- Dashboard incluye métricas básicas (CPU, RAM, requests)
- Para más detalle, integrar con external service (Datadog, etc.)

### Backups
No hay backups automáticos en free tier. Para PostgreSQL, seguir usando Neon que ya tiene backups.

## Límites del Free Tier (Northflank)

| Recurso | Límite |
|---------|--------|
| **Servicios** | 2 |
| **Jobs** | 2 |
| **Storage** | 1GB |
| **Transferencia** | 100GB/mes |
| **Logs retention** | 7 días |
| **Team members** | 3 |

Para GHAGGA solo necesitás **1 servicio** (el server), así que estás cómodo dentro del free tier.

## Troubleshooting

### "Build failed"
- Verificar que el Dockerfile path es correcto: `apps/server/Dockerfile`
- Verificar que el build context es la raíz: `.`
- Revisar logs en Dashboard → "Builds"

### "Service unhealthy"
- Aumentar initialDelaySeconds a 20-30s
- Verificar que el servidor escucha en `process.env.PORT` (o 3000 por defecto)
- Revisar que `/health` responde correctamente

### "Out of memory"
- En Dashboard → Service → Resources → aumentar a 1GB
- Esto consume más de los recursos gratuitos
- Optimizar: reducir workers de Node.js, etc.

### "Cannot connect to database"
- Verificar que `DATABASE_URL` está seteada correctamente
- Neon permite conexiones desde cualquier IP (verificar configuración de Neon)

## Rollback Plan

Si algo falla:

1. En GitHub App settings, volver al webhook URL de Render
2. En Northflank, pausar el servicio (no eliminar)
3. Render sigue funcionando (si no eliminaste el servicio)

## Diferencias con Render

| Aspecto | Render | Northflank |
|---------|--------|------------|
| **Free tier** | 500 pipeline min/mes | 2 servicios perpetuos |
| **Sleep** | No (siempre activo) | No (siempre activo) |
| **Build** | En Render | En Northflank |
| **DB** | PostgreSQL propio | Trae tu propia DB (Neon) |
| **Custom domains** | Sí | Sí (requiere verificación) |

## Post-migración: Limpiar Render (Después de 1-2 semanas)

Cuando confirmes que todo funciona bien:

1. Pausar o eliminar el servicio en Render
2. Exportar logs si querés conservar historial

---

**Tiempo total estimado**: 30-45 minutos
**Downtime**: ~2-5 minutos
**Costo**: **$0/mes** (dentro del free tier de Northflank)

---

## Recursos útiles

- [Northflank Docs](https://northflank.com/docs)
- [Northflank GitHub Integration](https://northflank.com/docs/v1/application/github-integration)
- [Northflank Environment Variables](https://northflank.com/docs/v1/application/environment-variables)
