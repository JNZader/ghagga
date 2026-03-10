# Proposal: Migración a Coolify (Self-Hosted)

## Intent

Migrar GHAGGA de servicios SaaS comprometidos (Render, Northflank, Neon, Inngest) a una infraestructura 100% self-hosted usando Coolify en Hetzner CX21.

### Motivación
1. **Seguridad**: Todos los secretos fueron expuestos públicamente en chat (DATABASE_URL, GITHUB_PRIVATE_KEY, ENCRYPTION_KEY, INNGEST keys, etc.)
2. **Control**: Eliminar vendor lock-in y dependencias externas
3. **Costo**: Reducir de ~$30-50/mes a ~$7.55/mes fijos
4. **Rendimiento**: 0ms latency a DB/Queue (local network vs SaaS)

### Estado actual problemático
- Render: Límites de minutos, bloqueos frecuentes
- Northflank: Errores OpenSSL persistentes, complejidad innecesaria
- Neon: Base de datos externa con latencia y costo
- Inngest: SaaS externo para queues, expuesto y ya archivado

## Scope

### In Scope
- [ ] Crear VPS Hetzner CX21 (2vCPU, 4GB RAM, 40GB SSD)
- [ ] Instalar Coolify v4 con SSL (Let's Encrypt)
- [ ] Configurar DNS en Cloudflare (coolify.tudominio.com, api.tudominio.com)
- [ ] Conectar GitHub a Coolify para CI/CD
- [ ] Crear PostgreSQL 16 self-hosted en Coolify
- [ ] Crear Redis 7 self-hosted en Coolify
- [ ] Reemplazar Inngest por BullMQ:
  - Crear queues/review.ts con BullMQ
  - Crear workers/review.ts processor
  - Modificar webhook handler para enqueue BullMQ
- [ ] Crear docker-compose.yml con server, worker, postgres, redis, bull-dashboard
- [ ] Crear Dockerfile multi-stage optimizado
- [ ] Configurar variables de entorno (nuevos secrets, nunca usados)
- [ ] Deploy aplicación en Coolify
- [ ] Actualizar GitHub App webhook URL al nuevo dominio
- [ ] Testing end-to-end ("ghagga review" funciona)
- [ ] Eliminar cuentas viejas: Neon, Inngest, Render, Northflank

### Out of Scope
- Migración de datos históricos de Neon (empezar fresh)
- Configuración de backups automatizados a S3 (fase 2)
- Monitoreo avanzado (Uptime Kuma, etc.)
- Escalado multi-server (Coolify Cluster)
- Migración de otras aplicaciones (solo GHAGGA por ahora)

## Approach

### Fase 1: Infraestructura (30 min)
1. Crear VPS Hetzner CX21
2. Configurar DNS A records en Cloudflare
3. Instalar Coolify vía SSH
4. Configurar dominio y SSL

### Fase 2: GitHub Integration (10 min)
1. Conectar GitHub App a Coolify
2. Seleccionar repositorio ghagga

### Fase 3: Base de Datos (15 min)
1. Crear PostgreSQL service en Coolify
2. Crear Redis service en Coolify
3. Anotar connection strings

### Fase 4: Código (45 min)
1. Remover Inngest (`pnpm remove inngest`)
2. Instalar BullMQ (`pnpm add bullmq ioredis`)
3. Crear `apps/server/src/lib/redis.ts`
4. Crear `apps/server/src/queues/review.ts`
5. Crear `apps/server/src/workers/review.ts`
6. Modificar `apps/server/src/routes/webhook.ts`
7. Crear `docker-compose.yml`
8. Crear `apps/server/Dockerfile`
9. Crear `apps/server/start.sh`
10. Update `.env.example`

### Fase 5: Deploy (20 min)
1. Push código a GitHub
2. Configurar variables de entorno en Coolify
3. Deploy aplicación
4. Verificar /health endpoint

### Fase 6: GitHub App Update (10 min)
1. Cambiar Webhook URL a api.tudominio.com
2. Actualizar Homepage URL
3. Verificar nuevos secrets

### Fase 7: Testing (15 min)
1. Probar "ghagga review" en PR
2. Verificar cola BullMQ procesa
3. Verificar comentario se postea

### Fase 8: Cleanup (10 min)
1. Archivar/eliminar Neon
2. Archivar/eliminar Inngest (ya hecho)
3. Cancelar Render
4. Cancelar Northflank

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `apps/server/src/routes/webhook.ts` | Modified | Cambiar Inngest.send() por BullMQ enqueueReview() |
| `apps/server/src/lib/` | New | redis.ts - conexión a Redis |
| `apps/server/src/queues/` | New | review.ts - definición de cola BullMQ |
| `apps/server/src/workers/` | New | review.ts - worker processor |
| `apps/server/Dockerfile` | New | Multi-stage build para server/worker |
| `apps/server/start.sh` | New | Script para iniciar server o worker |
| `docker-compose.yml` | New | Stack completo con 5 servicios |
| `package.json` | Modified | Remover inngest, agregar bullmq ioredis |
| `.env.example` | Modified | Nuevas variables REDIS_*, sin INNGEST_* |
| `.github/` | None | No cambios |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Downtime durante migración | High | Medium | Hacer en horario bajo; DNS TTL bajo (5 min) |
| BullMQ no procesa jobs | Medium | High | Testing exhaustivo local; tener rollback listo |
| GitHub webhook format issues | Medium | Medium | Verificar formato exacto; logs en tiempo real |
| PostgreSQL connection issues | Low | High | Usar hostname de servicio Coolify; health checks |
| Data loss (si hay datos importantes) | Low | High | Exportar backup antes de eliminar Neon |
| SSL/TLS cert issues | Low | Medium | Let's Encrypt automático; Cloudflare fallback |
| Private key format en Coolify | Medium | High | Probar formato multilinea; usar textarea en UI |

## Rollback Plan

### Si falla el deploy:
1. Mantener GitHub App webhook URL vieja activa
2. No eliminar Neon hasta verificar funciona todo
3. Coolify permite rollback a versión anterior (1 click)
4. Revertir código: git revert del commit de migración

### Si BullMQ no funciona:
1. Volver a Inngest temporalmente (revertir cambios)
2. Actualizar webhook URL en GitHub App
3. Debug local con BullMQ

### Rollback DNS:
1. Cambiar DNS A record de `api.tudominio.com` a IP vieja (Render/Northflank)
2. TTL de 5 min permite rollback rápido

## Dependencies

### Blockers
- ✅ GitHub App secrets rotados (completado)
- ✅ Inngest archivado (completado)
- ⏳ Terminal SSH disponible
- ⏳ Cuenta Hetzner con método de pago
- ⏳ Dominio en Cloudflare

### External Services
- Hetzner Cloud (VPS)
- Cloudflare (DNS)
- GitHub (repositorio y App)
- Coolify (open source, self-hosted)

## Success Criteria

### Funcionales
- [ ] VPS Hetzner CX21 creado y accesible por SSH
- [ ] Coolify instalado y accesible en https://coolify.tudominio.com
- [ ] PostgreSQL corriendo localmente en Coolify
- [ ] Redis corriendo localmente en Coolify
- [ ] Aplicación deployada en https://api.tudominio.com
- [ ] Endpoint /health responde OK
- [ ] Webhook de GitHub App apunta a nuevo dominio
- [ ] Comando "ghagga review" en PR funciona end-to-end
- [ ] Review se genera y se postea en GitHub
- [ ] Bull Dashboard accesible (monitoreo de colas)

### Seguridad
- [ ] Cuenta Neon eliminada
- [ ] Cuenta Inngest archivada/eliminada
- [ ] Servicio Render cancelado
- [ ] Proyecto Northflank eliminado
- [ ] Ningún secret expuesto sigue en uso

### Performance
- [ ] Latencia a DB < 1ms (vs 20-50ms en Neon)
- [ ] Jobs procesados en < 30s (vs variable en Inngest)
- [ ] Zero costo variable (solo VPS fijo)

### Costo
- [ ] Costo mensual <= $7.55 (VPS + dominio)

## Timeline Estimado

| Fase | Duración | Acumulado |
|------|----------|-----------|
| Infraestructura | 30 min | 30 min |
| GitHub Integration | 10 min | 40 min |
| Base de Datos | 15 min | 55 min |
| Código | 45 min | 1h 40min |
| Deploy | 20 min | 2h |
| GitHub App Update | 10 min | 2h 10min |
| Testing | 15 min | 2h 25min |
| Cleanup | 10 min | 2h 35min |

**Total estimado**: ~2.5 horas

## Notes

- Documentación completa ya existe en `/docs/HETZNER-COOLIFY-DEPLOY.md`
- Código de migración completo en `/docs/COOLIFY-COMPLETE-MIGRATION.md`
- Esta es una migración destructiva (no hay vuelta atrás fácil después de eliminar Neon)
- BullMQ es más rápido que Inngest pero requiere Redis (incluido en stack)
