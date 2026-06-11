# GHAGGA — Notas de refactors diferidos (audit 2026-06-10)

> Escrito 2026-06-11 al cerrar los 4 sprints del audit (PRs #203–#206).
> Cada ítem tiene evidencia file:line verificada contra `origin/main` (no inferencias).
> Trackeado en `notes/` desde la Fase 0 DX (2026-06-11). Vive junto a
> [`AUDIT-2026-06-10.md`](./AUDIT-2026-06-10.md), el reporte completo del audit.
>
> Los ítems marcados 🔐 tocan seguridad — encararlos con el tier de review más alto
> (cross-engine) antes de mergear.

---

## ✅ ACCIÓN DE MERGE — RESUELTA 2026-06-11

> Los 4 PRs mergeados en orden: #203 `2c0c596`, #204 `9a2e818`, #205 `b0f3a78`, #206 `be535c5`
> (único conflicto: `review.test.ts` entre sprint 2/4, resuelto preservando ambos lados).
> El fix SSRF salió como PR #207 (`a5edf14`, review 4vr): `revalidateGatewayChain` ahora valida
> por **presencia** de `gatewayUrl` (cualquier provider, cierra el bypass del loop de mapeo),
> drop con warn sin echo de URL/host, log explícito si el chain queda vacío. Canary verde.
> Queda como histórico:

Los 4 sprints salieron como ramas independientes desde `origin/main`, ninguna mergeada aún.
Orden de merge obligatorio y por qué:

```
#203 (sprint 1 — features muertas)      → sin dependencias
#204 (sprint 2 — seguridad, SSRF)        → introduce revalidateGatewayChain + lib/safe-url.ts
#205 (sprint 3 — dashboard UX)           → sin conflicto con los otros
#206 (sprint 4 — estructural)            → MUEVE las credenciales a un re-fetch de DB en el worker
```

🔐 **Interacción cross-PR crítica (#204 + #206):** el sprint 4 movió el provider chain a un
re-fetch de la DB dentro del worker (`apps/server/src/queues/review.ts`, chain construido ~:531).
El `revalidateGatewayChain` del sprint 2 valida el chain que venía por el **job payload** — un
camino que ya no existe tras el #206. **Si merjeás ambos sin actuar, el `gatewayUrl` re-fetcheado
BYPASSEA la validación SSRF del sprint 2.**

Hay un `// SECURITY TODO(sprint-2 merge)` en el sitio exacto. Al resolver el merge:
1. Invocar `validateOutboundUrl` (de `apps/server/src/lib/safe-url.ts`, viene con #204) sobre cada
   entry del chain re-fetcheado en `resolveEncryptedCredentials`, dropeando las que fallen.
2. Agregar un test a **processing-time**: repo con `gatewayUrl` apuntando a IP privada → rechazado
   en el worker, no solo en el enqueue.
3. Borrar el comentario TODO una vez wireado.

---

## REFACTOR 1 — Unificar los 4 parsers de unified-diff 🔧

**Tipo:** behavior-preserving + arregla bugs latentes. **Riesgo:** medio-alto (toca el motor del review).
**Tamaño estimado:** 1 SDD chico (proponer → spec → apply con TDD → 4vr). **Modelo:** Fable (no es seguridad).

### Estado actual — 4 parsers independientes y divergentes

| Archivo | Líneas | Qué parsea | Regex clave |
|---------|-------:|-----------|-------------|
| `packages/core/src/utils/diff.ts` | 186 | file headers → `DiffFile[]` | `FILE_HEADER_RE = /^diff --git a\/.+ b\/(.+)$/` (`:35`) |
| `packages/core/src/recursive/patch-extractor.ts` | 151 | file + hunk para aplicar patches | `/^diff --git a\/.+ b\/(.+)$/` (`:86`) + `/^@@ -\d+(?:,\d+)? \+(\d+)/` (`:94`) |
| `packages/core/src/scope/diff-mapper.ts` | 96 | hunk ranges → símbolos | `HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/` (`:23`) |
| `packages/core/src/scope/entity-diff.ts` | 268 | hunk + line prefixes por símbolo | `HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/` (`:61`) |

**Divergencias confirmadas (grep 2026-06-11):**
- **3 formas distintas de file-header**: dos copian `/^diff --git a\/.+ b\/(.+)$/`, los otros dos no parsean file headers.
- **3 formas distintas de hunk-header**: `diff-mapper` captura old+new count, `entity-diff` captura solo starts, `patch-extractor` captura solo new-start. Mismo concepto, 3 regexes.
- **NINGUNO maneja paths con espacios ni quoted** (`diff --git "a/x y" "b/x y"`) → verificado: el grep de quoted-path handling da vacío. Esos archivos **desaparecen del review** sin warning (bug MEDIUM del audit: CORE-M6, MEM-relacionados CORE-M8/M9 son consecuencia de coordenadas old/new mal mapeadas en `entity-diff`).

### Bugs que la unificación cierra (todos del audit, sin arreglar aún)
- **CORE-M6** (`diff.ts:35`): paths quoted/con espacios dropeados del review y de las métricas.
- **CORE-M9** (`entity-diff.ts:80-86`): deletions comparadas contra rangos de símbolo del lado NEW → clasificación cosmetic-vs-logic incorrecta cuando old/new divergen.
- **CORE-M8** (`entity-diff.ts:168-187`): `computeSimilarity` dice LCS pero compara char por posición (no es de diff parsing pero vive en el mismo archivo, atacarlo en el mismo SDD).

### Approach propuesto
1. Crear `packages/core/src/diff/` con UN modelo: `parseUnifiedDiff(raw): ParsedDiff` que produzca
   `{ files: [{ oldPath, newPath, hunks: [{ oldStart, oldCount, newStart, newCount, lines }] }] }`.
   - Un solo file-header parser que maneje: forma normal, paths con espacios, **forma quoted**
     (`"a/..."` con escapes), renames (`rename from/to`), y prefiera `+++ b/...` como autoridad del
     path nuevo cuando el `diff --git` es ambiguo.
   - Un solo hunk-header parser con la forma completa (old start+count, new start+count).
2. Reescribir los 4 consumidores para usar el modelo compartido en vez de su regex local.
   Blast radius medido: `parseDiffFiles` 3 consumidores no-test, `diff-mapper` 4, `entity-diff` 3.
3. Mantener las firmas públicas de `parseDiffFiles`/`extractEntityDiffLines`/etc. como adapters
   finos sobre el modelo, para no romper sus callers de golpe (migración incremental).

### Estrategia de testing (CRÍTICA — es lo que hace seguro el refactor)
- Antes de tocar nada: **golden tests** sobre los 4 parsers actuales con un corpus de diffs reales
  (incluí: paths con espacios, quoted, renames, binarios, hunks `@@ -0,0 +1,N @@`, multi-hunk,
  CRLF). Capturar el output actual como baseline.
- El parser unificado debe reproducir el output para los casos que HOY funcionan, y ADEMÁS manejar
  los casos que hoy se dropean (espacios/quoted) — esos son mejoras, no regresiones.
- Tabla de paridad cross-consumidor: el mismo diff → mismos símbolos mapeados / mismas líneas de
  entidad antes y después.

### Riesgos
- `entity-diff` mezcla coordenadas old/new (CORE-M9) — al unificar hay que decidir la semántica
  correcta y eso CAMBIA comportamiento (arregla el bug). Documentar el cambio explícitamente.
- El recursive patch-extractor aplica patches virtuales — un error de off-by-one rompe la
  re-review recursiva. Tests de aplicación de patch antes y después.

---

## REFACTOR 2 — Partir el god-function `reviewPipeline` 🔧

**Tipo:** behavior-preserving puro (cosmético estructural). **Riesgo:** alto (es EL motor).
**Tamaño:** 1 SDD mediano. **Modelo:** Fable (no es seguridad, pero el 4vr sí por ser core crítico).

### Estado actual
- `reviewPipeline` va de `pipeline.ts:150` a `:1078` (la próxima función es `resolveAiEnabled` en `:1079`)
  = **~928 líneas en una sola función**. El archivo entero son 1505 líneas.
- Tiene **~13 steps opcionales inline**, cada uno un bloque `try/catch` que muta `result` y pushea a
  `failedSteps` (sitios de `failedSteps.push`: `:298, :571, :622, :771, :902, :960, :1010, :1034,
  :1054, :1294, :1334, :1410`). Steps: static analysis, memory search, blast-radius, call-chain,
  enhance, trust, exploitability, recursive re-review, doc-validation, ranking, code-intel, etc.

### Por qué duele (no es solo estético)
- La resiliencia (degradar graceful con `failedSteps`) es un PUNTO FUERTE real — pero está
  implícita y repetida 13 veces. No es testeable por step de forma aislada.
- Inconsistencia detectada en el audit: solo `PASSED` baja a `PARTIAL` ante fallos (`:1065`); un
  `FAILED`/`NEEDS_HUMAN_REVIEW` con steps degradados no da señal de cobertura incompleta.

### Approach propuesto
1. Definir un contrato `PipelineStep` uniforme: `{ name, run(ctx): Promise<Partial<Result>>, degrade(err, ctx): void }`.
2. Extraer cada bloque inline a su propio `PipelineStep` (un archivo por step en `pipeline/steps/`).
   El orquestador queda como una lista de steps + un runner que aplica el patrón try/run/degrade UNA vez.
3. El runner centraliza el `failedSteps.push` y la lógica de downgrade de status (y de paso arregla
   la inconsistencia PASSED-only → aplicar el downgrade de cobertura a todos los status finales).
4. Comportamiento idéntico: mismo orden, mismos side-effects sobre `result`, mismo output.

### Estrategia de testing
- `pipeline.test.ts` ya existe (es uno de los que tiene fallas pre-existentes — ARREGLAR ESO PRIMERO,
  ver backlog). Antes de partir: snapshot del `ReviewResult` completo para un set de inputs
  representativos (cada step on/off, cada degradación forzada).
- Post-refactor: mismo snapshot byte a byte. Cualquier diff = regresión.
- Bonus: ahora cada step es testeable aislado — agregar tests por step que hoy no existen.

### Riesgo
- Es el corazón del producto. NO hacerlo en el mismo PR que ningún otro cambio. Rama dedicada,
  4vr completo, y NO mergear sin canary verde. El valor es mantenibilidad, no funcionalidad —
  así que el listón de "cero cambio de comportamiento" es absoluto.

---

## BACKLOG MENOR (acumulado en los 4 sprints)

### Seguridad 🔐 (Opus)
- **Engram backend sin decay**: `engram.ts:80-98` (search), `:158-182` (list), `:185-200` (get) no
  aplican `computeStrength`. SQLite y ahora Postgres (sprint 4) sí. Cerrar la paridad o documentar
  que Engram delega el decay al server remoto.
- **2 pools `createDatabaseFromEnv` con leak** en `queues/review.ts`: workflow-injection (~:428, :447)
  y un caller público `enqueueReview` que todavía acepta campos de credencial por tipo (type-guard).
  El sprint 4 arregló los del path principal; estos quedaron flageados.
- **`checklistContext` sin wrap**: hoy es admin/code-defined (`DEFAULT_CHECKLIST`), NO atacable.
  PERO `config.ts` (`mergeCheck`/`mergeDimension`) permite overrides free-form de `name`/`description`.
  Si alguna vez se wirea `settings.checklist` a un archivo del repo → envolverlo como untrusted en
  los 5 agentes (`simple/workflow/consensus/diagnostic/fan-out`).

### Correctness
- ~~**22 fallas pre-existentes en `ghagga-core`**~~ ✅ **RESUELTO 2026-06-11, PR #209** (`950d2723`, 3vr).
  Diagnóstico: 2 bugs reales de producción (semantic-diff: precedencia del patrón export anulaba
  function_added/removed/modified; taxonomy: `uses` duplicado en relationship+fact) + 6 grupos de
  tests stale. Core ahora: **2702/2702 verdes** — la red de seguridad del Refactor 2 está activa.
- **`semantic-diff` no está cableado a producción** (hallazgo de #209): solo se re-exporta desde
  `core/src/index.ts`, ningún caller real. El bug de precedencia vivió meses sin detectarse por eso.
  Decidir: wirearlo al pipeline o marcarlo experimental.
- **Higiene de lint del monorepo**: el pre-commit hook (`biome check .` repo-wide) falla SIEMPRE por
  errores pre-existentes ajenos (apps/dashboard a11y en ConfirmDialog/ObservationDetailModal,
  packages/db queries.ts formato, api.ts organizeImports, Reviews.tsx exhaustive-deps) → fuerza
  `--no-verify` en todos los commits. Ticket de higiene propio: limpiar y recuperar el hook.
- **`Review.repo` es ficción** (descubierto sprint 3): las review rows del server nunca llevan campo
  `repo`. El dashboard lo papelea con fallback a `fullName`. Fix real: corregir el contrato en
  `@ghagga/types` y mapear server-side.
- **Test live-PG para tsquery** (sprint 1): el escaping de `buildTsQuery` está string-tested; falta
  un test de integración con PG real que pruebe que `to_tsquery` acepta el output.
- **Matrix jobs comparten cache key** (sprint 1): aún con runAttempt, dos jobs en el mismo run-attempt
  comparten el save key del Action (no-fatal, warned).
- **`apps/action/dist/` stale vs source** (descubierto Fase 0): el bundle trackeado de la Action no se
  regeneró tras los cambios de los sprints en `apps/action/src/` (#203/#206). Los consumers pinean tags
  (`@v2.8.1`), así que no hay rotura activa, pero el próximo release necesita un paso deliberado:
  rebuild de dist + commit + tag (v2.8.2). NO regenerarlo como side-effect de otros PRs — un rebuild
  local mete ~200k líneas de churn no reproducible en el diff.
- 🔐 **TOCTOU residual DNS-rebinding** (4vr de #207, Opus): `validateOutboundUrl` resuelve vía
  `dns.lookup` (`safe-url.ts:228`) pero el fetch posterior (undici, `gateway.ts:62`) re-resuelve el
  hostname en connect-time → ventana de rebinding entre validación y fetch. Documentado como aceptado
  en el código ("narrows the window to milliseconds"). Cierre completo: pinear la IP validada
  (custom `lookup`/dispatcher de undici). Pre-existente de sprint 2, no introducido por #207.
- **¿Fail-closed en all-dropped?** (4vr de #207, GPT-5.4+5.5): si la revalidación SSRF dropea TODOS
  los entries del chain, hoy degrada a static-only con warn explícito (`entriesIn`) — semántica
  grácil heredada de sprint 2 (mismo patrón que decrypt-failure). Decisión de PRODUCTO pendiente:
  ¿debería fallar el job en vez de degradar en silencio operativo? Si se cambia, cambiar también
  el caso decrypt-failure por consistencia.

### Dashboard
- **DSH-A5**: el botón "Validate" del gateway no manda `gatewayUrl` → server responde `valid:true`
  siempre. Toca el path SSRF-validado → 🔐 Opus.
- **DSH-A6**: `AuthCallback` valida el token dos veces (doble round-trip a GitHub). Baja prioridad.

---

## Cómo encarar — plan DX-first (reordenado 2026-06-11)

> Contexto de la decisión: la app no está en uso → la deuda de *producción* (seguridad runtime)
> pierde urgencia y el criterio pasa a ser DX puro: qué hace el desarrollo más rápido y confiable.

1. ~~**Mergear** #203→#206 + acción SSRF (#207)~~ ✅ 2026-06-11, canary verde.
2. ~~**22 fallas pre-existentes de core**~~ ✅ 2026-06-11, PR #209 — core 2702/2702.
3. ~~**Fase 0 DX**: lint a cero + typecheck verde + hook restaurado (PR #210), notas trackeadas,
   dependabot~~ ✅ 2026-06-11.
4. **Refactor 1** (diff parsers) — SDD con golden tests, 4vr. El corpus de golden tests es un
   activo permanente.
5. **Refactor 2** (pipeline god-function) — SDD, rama dedicada, 4vr, canary obligatorio.
   Desbloqueado (la suite de core está verde).
6. **Contratos**: `Review.repo` en `@ghagga/types` (los tipos que mienten son veneno de DX).

> Regla de stamina: no encadenar los dos refactors en la misma sesión. Cada uno es un esfuerzo
> aislado con su propia red de tests. La deuda estructural se cierra con foco, no con prisa.

---

## PRE-LAUNCH 🔐 — estacionado hasta que haya usuarios reales

Estos ítems importan cuando haya tráfico real; hoy no bloquean nada. El día que esto vaya a
producción con usuarios, esta lista ES el sprint previo:

- Engram backend sin decay (paridad con SQLite/Postgres)
- 2 pools `createDatabaseFromEnv` con leak + type-guard en `enqueueReview`
- `checklistContext` wrap preventivo (si se wirea a settings del repo)
- TOCTOU residual DNS-rebinding (pinear IP en undici)
- DSH-A5 (Validate del gateway sin `gatewayUrl`)
- Decisión fail-closed vs degradación en all-dropped (+ decrypt-failure por consistencia)
- Test live-PG para `buildTsQuery`
- Matrix cache key del Action
- DSH-A6 (doble validación de token en AuthCallback — menor, no seguridad)

(Los detalles con file:line de cada uno quedan en sus secciones de arriba.)
