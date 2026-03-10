# Design: Migración a Coolify (Self-Hosted)

## Part of: coolify-migration

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Hetzner CX21 VPS                         │
│                   (2 vCPU, 4GB RAM)                         │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Coolify    │    │  PostgreSQL  │    │    Redis     │
│   Manager    │    │     16       │    │      7       │
└──────────────┘    └──────────────┘    └──────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│              Docker Compose Stack                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Server  │  │  Worker  │  │  Worker  │  │ Bull-    │  │
│  │  (API)   │  │   #1     │  │   #2     │  │ Dashboard│  │
│  │  :3000   │  │(review)  │  │(review)  │  │  :3001   │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              GitHub App (ghagga-review)                     │
│         Webhooks → https://api.tudominio.com                │
└─────────────────────────────────────────────────────────────┘
```

### Component Diagram

```
                    ┌─────────────┐
                    │   GitHub    │
                    │    App      │
                    └──────┬──────┘
                           │ Webhook
                           ▼
                    ┌─────────────┐
                    │    Nginx    │
                    │  (Coolify)  │
                    └──────┬──────┘
                           │
                           ▼
┌─────────┐         ┌─────────────┐
│  Bull   │◄────────│    Server   │
│Dashboard│         │    (API)    │
└─────────┘         └──────┬──────┘
                           │ Enqueue
                           ▼
                    ┌─────────────┐
                    │    Redis    │
                    │   (Queue)   │
                    └──────┬──────┘
                           │ Process
              ┌────────────┴────────────┐
              ▼                         ▼
       ┌─────────────┐           ┌─────────────┐
       │   Worker    │           │   Worker    │
       │     #1      │           │     #2      │
       └──────┬──────┘           └──────┬──────┘
              │                         │
              └────────────┬────────────┘
                           │ Query/Update
                           ▼
                    ┌─────────────┐
                    │  PostgreSQL │
                    │   (Data)    │
                    └─────────────┘
```

## Key Decisions

### KD1: BullMQ over Inngest

**Decision**: Replace Inngest with BullMQ

**Rationale**:
- Inngest requiere servicio externo (SaaS) - expuesto y costo
- BullMQ es open source, self-hosted con Redis
- Mejor performance (0ms latency vs network)
- Más control sobre retries y concurrencia
- Bull Dashboard incluido para monitoreo

**Trade-offs**:
- (+) Costo $0, latencia 0ms, control total
- (-) Requiere Redis, más código propio que gestionar

### KD2: PostgreSQL Self-Hosted

**Decision**: Replace Neon with local PostgreSQL

**Rationale**:
- Neon tiene latencia de red (20-50ms)
- Local es < 1ms
- Sin límites de conexiones
- Sin costo variable
- Control total sobre backups

**Trade-offs**:
- (+) Performance, costo fijo, sin vendor lock-in
- (-) Responsabilidad de backups y mantenimiento

### KD3: Docker Compose in Coolify

**Decision**: Usar Coolify con Docker Compose

**Rationale**:
- Coolify simplifica deploy y SSL
- Docker Compose orquesta múltiples servicios
- Un solo comando levanta toda la stack
- Fácil rollback y versionado

**Trade-offs**:
- (+) Simplicidad, UI, SSL automático
- (-) Learning curve de Coolify

### KD4: Separate Worker Containers

**Decision**: Server y Worker como servicios separados

**Rationale**:
- Escalabilidad independiente
- Si worker crashea, API sigue funcionando
- Puedo tener N workers según carga
- Mejor resource isolation

**Trade-offs**:
- (+) Resilience, scalability
- (-) Más containers = más RAM usada

### KD5: Single VPS (por ahora)

**Decision**: Todo en un solo Hetzner CX21

**Rationale**:
- Costo mínimo ($6.55/mes)
- Suficiente para carga actual
- BullMQ + PostgreSQL en local = muy rápido
- KISS principle

**Trade-offs**:
- (+) Simplicidad, costo
- (-) Single point of failure, limitado a 4GB RAM

## Data Flow

### Webhook to Review (Happy Path)

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant API as Server (API)
    participant R as Redis
    participant W as Worker
    participant DB as PostgreSQL
    participant AI as OpenAI API
    participant GHA as GitHub API

    GH->>API: POST /webhook (issue_comment)
    API->>API: Validate signature
    API->>DB: Create review record
    API->>R: enqueueReview(jobData)
    API->>GH: 200 OK
    
    W->>R: poll for jobs
    R->>W: job data
    W->>GHA: Get installation token
    W->>GHA: Fetch PR context (diff, files)
    W->>AI: Run review pipeline
    AI->>W: Review results
    W->>GHA: Post review comment
    W->>DB: Update review status
    W->>R: job completed
```

## Module Design

### M1: Redis Connection (`lib/redis.ts`)

```typescript
// Singleton Redis connection for BullMQ
export const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,  // Required by BullMQ
  enableReadyCheck: false,     // Required by BullMQ
});
```

**Responsibilities**:
- Single connection reused by all BullMQ instances
- Configuración optimizada para queue processing
- Auto-reconnect on failure

### M2: Review Queue (`queues/review.ts`)

```typescript
// Queue definition with default options
export const reviewQueue = new Queue('review', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Enqueue function
export async function enqueueReview(data: ReviewJobData) {
  return reviewQueue.add('process-review', data, {
    jobId: data.reviewId,
    priority: 1,
  });
}

// Worker factory
export function createReviewWorker() {
  return new Worker('review', processor, {
    connection: redis,
    concurrency: 3,
  });
}
```

**Responsibilities**:
- Definir queue con opciones de retry
- Proveer función para encolar jobs
- Crear workers con processor

### M3: Worker Entry (`workers/review.ts`)

```typescript
// Entry point for worker container
const worker = createReviewWorker();
setupQueueEvents();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});
```

**Responsibilities**:
- Iniciar worker al arrancar container
- Manejar señales de sistema (SIGTERM)
- Monitorear events de queue

### M4: Webhook Handler (modified)

```typescript
// Before (Inngest):
// await inngest.send({ name: 'ghagga/review.requested', data: {...} });

// After (BullMQ):
import { enqueueReview } from '../queues/review.js';

await enqueueReview({
  reviewId,
  installationId,
  repoFullName,
  prNumber,
  // ...
});

return c.json({ message: 'Review queued', reviewId });
```

**Responsibilities**:
- Validar webhook signature
- Crear review record en DB
- Encolar job en BullMQ
- Responder 200 inmediatamente

## Database Schema

### Tablas Requeridas

```sql
-- Reviews
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id INTEGER NOT NULL,
  repo_full_name VARCHAR(255) NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha VARCHAR(40),
  base_branch VARCHAR(255),
  status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices
CREATE INDEX idx_reviews_status ON reviews(status);
CREATE INDEX idx_reviews_repo_pr ON reviews(repo_full_name, pr_number);

-- Installations (GitHub App)
CREATE TABLE installations (
  id INTEGER PRIMARY KEY,
  account_login VARCHAR(255) NOT NULL,
  account_type VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Provider Chain Entries
CREATE TABLE provider_chain_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id),
  provider VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  config JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Environment Variables

### Required

```bash
# Database (PostgreSQL local)
DATABASE_URL=postgresql://ghagga:PASSWORD@postgres:5432/ghagga

# Redis (para BullMQ)
REDIS_URL=redis://redis:6379
REDIS_HOST=redis
REDIS_PORT=6379

# GitHub App (nuevos valores rotados)
GITHUB_APP_ID=2991025
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=nuevo_webhook_secret
GITHUB_CLIENT_SECRET=nuevo_client_secret

# Secrets (generados nuevos)
ENCRYPTION_KEY=64_chars_hex
STATE_SECRET=base64_44_chars

# Config
NODE_ENV=production
PORT=3000
```

### Removed (Inngest)

```bash
# Ya no se usan:
# INNGEST_EVENT_KEY
# INNGEST_SIGNING_KEY
# INNGEST_BASE_URL
```

## Docker Configuration

### Dockerfile

```dockerfile
# Build stage
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/*/package.json packages/*/
COPY apps/server/package.json apps/server/
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @ghagga/server build

# Production stage
FROM node:20-slim AS runner
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/*/package.json packages/*/
COPY apps/server/package.json apps/server/
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/packages/*/dist packages/*/
COPY --from=builder /app/apps/server/dist apps/server/
COPY --from=builder /app/apps/server/start.sh apps/server/
EXPOSE 3000
CMD ["./apps/server/start.sh"]
```

### start.sh

```bash
#!/bin/sh
if [ "$SERVICE_TYPE" = "worker" ]; then
  echo "Starting Worker..."
  node apps/server/dist/workers/review.js
else
  echo "Starting API Server..."
  node apps/server/dist/index.js
fi
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    environment:
      - SERVICE_TYPE=server
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      # ... todas las demás vars
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  worker:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    environment:
      - SERVICE_TYPE=worker
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      # ... solo vars necesarias para worker
    depends_on:
      - postgres
      - redis
    restart: unless-stopped
    deploy:
      replicas: 2

  postgres:
    image: postgres:16-alpine
    volumes:
      - postgres-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=ghagga
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=ghagga
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ghagga"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --save 60 1
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  bull-dashboard:
    image: vitalyliber/bull-board:latest
    environment:
      - REDIS_HOST=redis
      - REDIS_PORT=6379
    ports:
      - "3001:3000"
    depends_on:
      - redis

volumes:
  postgres-data:
  redis-data:
```

## Deployment Strategy

### Phase 1: Infrastructure
1. Create Hetzner CX21
2. Configure DNS
3. Install Coolify
4. Verify SSL

### Phase 2: Services
1. Create PostgreSQL in Coolify
2. Create Redis in Coolify
3. Note connection strings

### Phase 3: Application
1. Push code with BullMQ migration
2. Configure env vars in Coolify
3. Deploy
4. Verify /health

### Phase 4: GitHub App
1. Update webhook URL
2. Test webhook delivery
3. Verify signature validation

### Phase 5: Testing
1. Test "ghagga review"
2. Verify job processing
3. Check Bull Dashboard

### Phase 6: Cleanup
1. Archive/Delete Neon
2. Cancel Render
3. Cancel Northflank

## Monitoring

### Health Checks
- Coolify health checks cada 30s
- PostgreSQL healthcheck con pg_isready
- Redis healthcheck con PING
- API endpoint /health

### Logs
- Coolify centraliza logs de todos los containers
- Accesibles via Dashboard → Service → Logs
- Persistencia: Configurable en Coolify

### Bull Dashboard
- URL: http://TU_IP:3001
- Muestra:
  - Jobs pending (en cola)
  - Jobs active (procesando)
  - Jobs completed
  - Jobs failed
  - Retry attempts

### Alerting (Future)
- Uptime Kuma (self-hosted)
- Email notifications
- Slack webhooks

## Security Considerations

### Network
- PostgreSQL: Solo accesible desde red Docker interna
- Redis: Solo accesible desde red Docker interna
- Bull Dashboard: Puerto 3001 (opcional, puede ser interno)
- API: Puerto 3000 expuesto via Nginx (SSL)

### Secrets
- Nunca commitear .env
- Usar Coolify secrets management
- Rotar keys cada 90 días (próximamente)
- ENCRYPTION_KEY: 64 hex chars (suficiente para AES-256)

### GitHub App
- Webhook secret valida cada request
- Private key nunca expuesta en logs
- Scope mínimo necesario

## Rollback Strategy

### Code Rollback
```bash
# En Coolify Dashboard
# Service → Deployments → Rollback to previous version
```

### Infrastructure Rollback
```bash
# Cambiar DNS A record a IP vieja
# TTL bajo (5 min) permite rollback rápido
```

### Database Rollback
- Exportar backup antes de migrar
- Importar a Neon si es necesario volver
- (Pero objetivo es no volver atrás)

## Future Improvements

### Phase 2
- Backups automáticos a S3/Backblaze
- Monitoreo con Uptime Kuma
- Log aggregation con Loki
- Métricas con Prometheus/Grafana

### Phase 3
- Autoscaling de workers según queue length
- Multi-region (si es necesario)
- CDN para assets estáticos

## References

- BullMQ Docs: https://docs.bullmq.io/
- Coolify Docs: https://coolify.io/docs/
- Docker Compose: https://docs.docker.com/compose/
- PostgreSQL 16: https://www.postgresql.org/docs/16/
- Redis 7: https://redis.io/docs/
