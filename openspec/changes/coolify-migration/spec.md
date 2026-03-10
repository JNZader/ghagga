# Spec: Migración a Coolify (Self-Hosted)

## Part of: coolify-migration

## Requirements

### R1: Infraestructura Hetzner + Coolify
**Priority**: Critical

The system must run on a self-hosted VPS with PaaS management.

**R1.1**: Crear VPS Hetzner CX21 (2 vCPU, 4GB RAM, 40GB SSD)
**R1.2**: Instalar Ubuntu 22.04 LTS
**R1.3**: Configurar SSH access con keys
**R1.4**: Instalar Coolify v4 via script oficial
**R1.5**: Configurar dominio coolify.tudominio.com con SSL
**R1.6**: Configurar api.tudominio.com para la aplicación

### R2: Base de Datos Self-Hosted
**Priority**: Critical

Replace Neon PostgreSQL with local PostgreSQL.

**R2.1**: PostgreSQL 16 corriendo en container Docker
**R2.2**: Database `ghagga` creada con usuario `ghagga`
**R2.3**: Password seguro generado (no reutilizar)
**R2.4**: Health check configurado
**R2.5**: Volume persistente para datos
**R2.6**: Opcional: Backups automáticos configurados

### R3: Message Queue System
**Priority**: Critical

Replace Inngest with BullMQ + Redis.

**R3.1**: Redis 7 corriendo en container Docker
**R3.2**: BullMQ instalado como dependencia
**R3.3**: Queue `review` definida con opciones:
  - attempts: 3
  - backoff: exponential (1s base)
  - removeOnComplete: 100
  - removeOnFail: 50
**R3.4**: Worker procesando jobs con concurrencia: 3
**R3.5**: Event handlers para monitoreo (completed, failed)
**R3.6**: Graceful shutdown implementado

### R4: Application Code Changes
**Priority**: Critical

**R4.1**: Remover dependencia `inngest` completamente
**R4.2**: Instalar `bullmq`, `ioredis`, `node-cron`
**R4.3**: Crear módulo de conexión Redis
**R4.4**: Crear queue `review` con tipado TypeScript
**R4.5**: Crear worker entry point separado
**R4.6**: Modificar webhook handler para usar BullMQ
**R4.7**: Mantener misma API externa (responder 200 inmediatamente)
**R4.8**: Implementar health check endpoint

### R5: Containerization
**Priority**: Critical

**R5.1**: Dockerfile multi-stage (builder + runner)
**R5.2**: Usar Node.js 20 slim
**R5.3**: Optimizar layer caching
**R5.4**: Script `start.sh` para seleccionar server/worker
**R5.5**: docker-compose.yml con 5 servicios:
  - server (API)
  - worker (processor)
  - postgres (DB)
  - redis (Queue)
  - bull-dashboard (monitoreo)

### R6: Environment Configuration
**Priority**: Critical

**R6.1**: DATABASE_URL apunta a PostgreSQL local
**R6.2**: REDIS_URL apunta a Redis local
**R6.3**: GitHub secrets son NUEVOS (rotados)
**R6.4**: ENCRYPTION_KEY generado nuevo (64 hex chars)
**R6.5**: STATE_SECRET generado nuevo (base64)
**R6.6**: NODE_ENV=production
**R6.7**: PORT=3000

### R7: GitHub App Integration
**Priority**: Critical

**R7.1**: Webhook URL actualizada a api.tudominio.com
**R7.2**: Webhook Secret nuevo configurado
**R7.3**: Homepage URL actualizada
**R7.4**: Callback URL actualizada
**R7.5**: Private key nueva en uso
**R7.6**: Webhook events: issue_comment, pull_request, etc.

### R8: Testing & Validation
**Priority**: High

**R8.1**: Endpoint /health responde 200
**R8.2**: Webhook recibe eventos de GitHub
**R8.3**: Jobs se encolan correctamente
**R8.4**: Worker procesa jobs
**R8.5**: Reviews se generan con IA
**R8.6**: Comentarios se postean en PRs
**R8.7**: Dashboard de Bull accesible

### R9: Cleanup Security
**Priority**: High

**R9.1**: Cuenta Neon eliminada
**R9.2**: Cuenta Inngest archivada/eliminada
**R9.3**: Servicio Render cancelado
**R9.4**: Proyecto Northflank eliminado
**R9.5**: Ningún secret expuesto en uso

## Scenarios

### S1: Happy Path - Review Requested
```gherkin
Given a GitHub PR exists
When user comments "ghagga review"
Then GitHub sends webhook to api.tudominio.com
And server responds 200 immediately
And job is enqueued in BullMQ
And worker picks up job within 5 seconds
And review is generated in < 2 minutes
And comment is posted to PR
And user sees 👀 then 🚀 reactions
```

### S2: Queue Processing
```gherkin
Given BullMQ is running
When multiple reviews are requested simultaneously
Then jobs are queued in order
And 3 workers process in parallel
And each job has 3 retry attempts on failure
And failed jobs are logged with error details
```

### S3: Infrastructure Failure Recovery
```gherkin
Given PostgreSQL container stops
When health check fails
Then Coolify restarts container automatically
And workers reconnect to DB
And pending jobs resume processing
```

### S4: Graceful Shutdown
```gherkin
Given worker is processing a job
When SIGTERM is received
Then worker finishes current job
And closes connection to Redis
And exits cleanly without data loss
```

### S5: Webhook Validation
```gherkin
Given webhook is received
When signature doesn't match
Then server responds 401
And job is not enqueued
And error is logged
```

## Acceptance Criteria

### AC1: Infrastructure
- [ ] VPS Hetzner CX21 accesible via SSH
- [ ] Coolify dashboard en HTTPS funcionando
- [ ] PostgreSQL accesible desde containers
- [ ] Redis accesible desde containers

### AC2: Application
- [ ] `pnpm install` funciona sin errores
- [ ] `pnpm build` compila sin errores
- [ ] Docker build exitoso
- [ ] All containers start sin errores

### AC3: Functionality
- [ ] POST /webhook responde 200 con payload válido
- [ ] GET /health responde 200
- [ ] Bull Dashboard muestra colas activas
- [ ] Jobs aparecen en queue "review"
- [ ] Workers procesan jobs exitosamente

### AC4: End-to-End
- [ ] "ghagga review" en PR dispara webhook
- [ ] Job se encola inmediatamente
- [ ] Worker procesa en < 5 minutos
- [ ] Review completa se postea en PR

### AC5: Security
- [ ] Zero referencias a Neon en código
- [ ] Zero referencias a Inngest en código
- [ ] Nuevos secrets funcionan
- [ ] Viejas keys rechazadas (testeado)

## Edge Cases

### E1: Private Key Format
GitHub private key debe mantener formato PEM con saltos de línea reales. En Coolify usar textarea multilinea, no string single-line.

### E2: Redis Connection Loss
Si Redis se reinicia, BullMQ debe reconectar automáticamente usando `maxRetriesPerRequest: null`.

### E3: Database Migration
No migrar datos históricos de Neon. Empezar fresh en PostgreSQL local.

### E4: Concurrent Jobs
Configurar concurrencia en 3 para evitar sobrecargar la VPS de 4GB RAM.

### E5: Memory Limits
Container de worker limitado a 512MB RAM para evitar OOM kills.

## Non-Functional Requirements

### Performance
- Latencia DB: < 1ms (local network)
- Job processing: < 5 minutos por review
- API response: < 100ms para webhooks

### Reliability
- Uptime target: 99% (backups manuales disponibles)
- Job retry: 3 attempts con exponential backoff
- Health checks: Cada 30 segundos

### Scalability
- Current: 1 VPS, 3 workers concurrentes
- Future: Escala vertical (upgrade VPS) o horizontal (múltiples workers)

### Cost
- VPS: $6.55/mes fijo
- Dominio: ~$1/mes
- Total: ~$7.55/mes (objetivo)

## Technical Constraints

- **OS**: Ubuntu 22.04 LTS
- **Node.js**: 20.x
- **Package Manager**: pnpm
- **Database**: PostgreSQL 16
- **Queue**: BullMQ + Redis 7
- **Container**: Docker + Docker Compose
- **Platform**: Coolify v4
- **VPS**: Hetzner CX21 (4GB RAM limit)
