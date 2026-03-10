# Alternativas Self-Hosted a Inngest (en Coolify)

## ¿Qué hace Inngest y por qué reemplazarlo?

**Inngest gestiona:**
- Colas de jobs (queue)
- Workflows duraderos (durable functions)
- Retries automáticos
- Scheduling (cron)
- Event-driven architecture

**Problema**: Es SaaS externo, vendor lock-in, costs adicionales

**Solución**: Reemplazar con stacks self-hosted dentro de tu VPS Coolify

---

## Opción 1: BullMQ + Redis (⭐ RECOMENDADA para GHAGGA)

### ¿Qué es?
- **BullMQ**: Librería Node.js para queues basada en Redis
- Usada por empresas como Adobe, Twitch, Elastic
- Más rápida que Inngest (menos overhead de red)

### Arquitectura para GHAGGA:

```
┌─────────────────────────────────────────────┐
│              Coolify VPS                    │
│                                             │
│  ┌──────────────┐      ┌──────────────┐    │
│  │  GHAGGA API  │──────▶│    Redis     │    │
│  │   (Hono)     │      │   (Queue)    │    │
│  └──────────────┘      └──────┬───────┘    │
│         │                     │             │
│         ▼                     ▼             │
│  ┌──────────────┐      ┌──────────────┐    │
│  │  Webhook     │      │  Worker      │    │
│  │  Receiver    │      │  (BullMQ)    │    │
│  └──────────────┘      └──────────────┘    │
│                                             │
│  ┌──────────────┐      ┌──────────────┐    │
│  │ PostgreSQL   │      │  PostgreSQL  │    │
│  │  (App Data)  │      │  (Job State) │    │
│  └──────────────┘      └──────────────┘    │
└─────────────────────────────────────────────┘
```

### Implementación:

#### 1. Crear Redis en Coolify
```yaml
# docker-compose.yml para Redis
services:
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s

volumes:
  redis-data:
```

#### 2. Instalar BullMQ en GHAGGA
```bash
pnpm add bullmq ioredis
```

#### 3. Crear Queue y Worker
```typescript
// src/queues/review.ts
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis({
  host: 'redis',  // nombre del servicio en docker-compose
  port: 6379,
  maxRetriesPerRequest: null,
});

// Crear queue
export const reviewQueue = new Queue('review', { connection });

// Crear worker
export const reviewWorker = new Worker('review', async (job) => {
  const { reviewId, repoFullName, prNumber } = job.data;
  
  // Aquí va toda la lógica de review
  // (lo que ahora hace Inngest)
  await runReviewWorkflow({
    reviewId,
    repoFullName,
    prNumber,
  });
  
  return { success: true };
}, {
  connection,
  concurrency: 5,  // procesar 5 reviews en paralelo
  attempts: 3,     // retry 3 veces
  backoff: {
    type: 'exponential',
    delay: 1000,
  },
});

// Agregar job desde webhook
export async function enqueueReview(data: ReviewData) {
  return reviewQueue.add('process-review', data, {
    delay: 0,
    priority: 1,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  });
}
```

#### 4. Reemplazar Inngest en webhook
```typescript
// Antes (con Inngest)
await inngest.send({
  name: 'ghagga/review.requested',
  data: { reviewId, repoFullName, prNumber },
});

// Después (con BullMQ)
await enqueueReview({
  reviewId,
  repoFullName,
  prNumber,
});
```

#### 5. Cron jobs (reemplazar Inngest scheduling)
```typescript
// src/cleanup.ts
import { Queue } from 'bullmq';

const cleanupQueue = new Queue('cleanup', { connection });

// Programar con node-cron o similar
import cron from 'node-cron';

// Ejecutar todos los días a las 3 AM
cron.schedule('0 3 * * *', async () => {
  await cleanupQueue.add('cleanup-old-reviews', {}, {
    repeat: { cron: '0 3 * * *' },
  });
});
```

### Ventajas de BullMQ:
- ✅ **Velocidad**: Redis en localhost = 0ms latency
- ✅ **Costo**: $0 (Redis corre en tu VPS)
- ✅ **Control total**: Tuyo, no depende de Inngest
- ✅ **Features**: Prioridades, delays, retries, cron jobs
- ✅ **UI**: Bull Dashboard para monitorear colas
- ✅ **Escalable**: Podés tener N workers en el mismo VPS

---

## Opción 2: Coolify Jobs Nativos (Más Simple)

Coolify tiene **Jobs** integrados para tareas programadas:

```yaml
# En Coolify, configurar un "Job"
# Ejecuta comandos en containers en horarios específicos

# Ejemplo: Cleanup diario
schedule: "0 3 * * *"  # 3 AM todos los días
command: "node scripts/cleanup.js"
```

**Limitación**: No tiene colas persistentes, solo cron jobs simples.

**Para GHAGGA**: No es suficiente, necesitás colas para manejar spikes de reviews.

---

## Opción 3: Temporal (Enterprise-grade)

Si querés algo MÁS potente que Inngest:

```yaml
# docker-compose.yml para Temporal
services:
  temporal:
    image: temporalio/auto-setup:1.22
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=temporal
      - POSTGRES_PWD=temporal
      - POSTGRES_SEEDS=postgresql
```

**Pros**: Workflows complejos, retries sofisticados, visibilidad total
**Contras**: MUCHO más complejo, overkill para GHAGGA

---

## Comparativa: Inngest vs BullMQ vs Coolify Jobs

| Feature | Inngest (SaaS) | BullMQ + Redis | Coolify Jobs |
|---------|----------------|----------------|--------------|
| **Costo** | $0-50/mes | $0 (tu Redis) | $0 |
| **Latencia** | 50-200ms | 0-1ms | 0ms |
| **Colas** | ✅ Sí | ✅ Sí | ❌ No |
| **Retries** | ✅ Automático | ✅ Configurable | ❌ Manual |
| **Cron jobs** | ✅ Sí | ✅ Sí | ✅ Sí |
| **Dashboard UI** | ✅ Web | ✅ Bull Dashboard | ❌ Logs only |
| **Durabilidad** | ✅ Alta | ✅ Alta (Redis AOF) | ❌ Baja |
| **Escalabilidad** | ✅ Cloud | ✅ Horizontal | ❌ Vertical only |
| **Vendor lock-in** | ✅ Sí (Inngest) | ❌ No | ❌ No |

---

## Mi Recomendación para GHAGGA

**Stack completo self-hosted:**

```yaml
# docker-compose.yml completo para Coolify

services:
  # App principal
  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    environment:
      - DATABASE_URL=postgresql://ghagga:password@postgres:5432/ghagga
      - REDIS_URL=redis://redis:6379
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - GITHUB_PRIVATE_KEY=${GITHUB_PRIVATE_KEY}
      # ... más variables
    depends_on:
      - postgres
      - redis
    restart: unless-stopped

  # Base de datos
  postgres:
    image: postgres:16-alpine
    volumes:
      - postgres-data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=ghagga
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=ghagga
    restart: unless-stopped

  # Redis para BullMQ
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --save 60 1
    restart: unless-stopped

  # Worker de BullMQ (procesa reviews)
  worker:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    command: node dist/worker.js  # entrypoint del worker
    environment:
      - DATABASE_URL=postgresql://ghagga:password@postgres:5432/ghagga
      - REDIS_URL=redis://redis:6379
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - GITHUB_PRIVATE_KEY=${GITHUB_PRIVATE_KEY}
    depends_on:
      - postgres
      - redis
    restart: unless-stopped
    deploy:
      replicas: 2  # 2 workers en paralelo

  # Dashboard de Bull (opcional, para monitoreo)
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

### Flujo de trabajo:

1. **Webhook llega** → API (Hono) lo recibe
2. **API encola job** → BullMQ + Redis (instantáneo)
3. **Worker procesa** → Ejecuta review (1-N workers en paralelo)
4. **Resultado** → Guarda en PostgreSQL
5. **Cron jobs** → Cleanup, mantenimiento (node-cron o Coolify Jobs)

---

## Migración desde Inngest

### Paso 1: Instalar dependencias
```bash
pnpm remove inngest
pnpm add bullmq ioredis node-cron
```

### Paso 2: Reemplazar imports
```typescript
// Antes
import { Inngest } from 'inngest';

// Después
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
```

### Paso 3: Reemplazar funciones
```typescript
// Antes (Inngest)
export const reviewFunction = inngest.createFunction(
  { name: 'Process Review' },
  { event: 'ghagga/review.requested' },
  async ({ event, step }) => {
    const { reviewId } = event.data;
    await step.run('fetch-context', async () => { ... });
    await step.run('run-review', async () => { ... });
  }
);

// Después (BullMQ)
export const reviewWorker = new Worker('review', async (job) => {
  const { reviewId } = job.data;
  
  // Paso 1: Fetch context
  await job.updateProgress(10);
  const context = await fetchContext(reviewId);
  
  // Paso 2: Run review
  await job.updateProgress(50);
  const result = await runReview(context);
  
  // Paso 3: Save results
  await job.updateProgress(90);
  await saveResults(result);
  
  await job.updateProgress(100);
  return result;
}, {
  connection: redis,
  concurrency: 5,
});
```

### Paso 4: Reemplazar event triggers
```typescript
// Antes
await inngest.send({
  name: 'ghagga/review.requested',
  data: { reviewId, repoFullName, prNumber },
});

// Después
await reviewQueue.add('process-review', {
  reviewId,
  repoFullName,
  prNumber,
}, {
  priority: 1,
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
});
```

### Paso 5: Eliminar Inngest
- Borrar `/api/inngest` endpoint
- Borrar `INNGEST_EVENT_KEY` y `INNGEST_SIGNING_KEY` de variables
- Desuscribirse de Inngest Cloud (si tenías plan pago)

---

## Costo Total Self-Hosted

| Componente | Costo | Incluye |
|------------|-------|---------|
| **VPS Hetzner CX21** | $6.55/mes | 2 vCPU, 4 GB RAM, 40 GB SSD |
| **PostgreSQL** | $0 | Tu propia instancia |
| **Redis** | $0 | Tu propia instancia |
| **BullMQ** | $0 | Open source |
| **Dominio** | ~$1/mes | .com o similar |
| **Cloudflare** | $0 | Free tier |
| **TOTAL** | **~$7.55/mes** | Todo incluido, ilimitado |

**vs Inngest + Neon + Render:**
- Inngest: $0-20/mes
- Neon: $0-19/mes
- Render: $0-25/mes
- **Total anterior**: $19-64/mes

**Ahorro**: $11-56/mes (~70% menos)

---

## Conclusión

**Sí, podés reemplazar Innget completamente** con:
1. **BullMQ** para colas y workflows
2. **Redis** como backend de colas (en tu VPS)
3. **node-cron** para tareas programadas
4. **PostgreSQL** para estado durable

**Beneficios**:
- ✅ 100% self-hosted
- ✅ Sin vendor lock-in
- ✅ Más rápido (0ms latency)
- ✅ Más barato
- ✅ Más control

**¿Te gustaría que prepare el código completo para migrar GHAGGA de Inngest a BullMQ?**
