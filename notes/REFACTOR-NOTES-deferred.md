# GHAGGA — Notas de refactors diferidos (audit 2026-06-10)

> Escrito 2026-06-11 al cerrar los 4 sprints del audit (PRs #203–#206).
> Cada ítem tiene evidencia file:line verificada contra `origin/main` (no inferencias).
> Trackeado en `notes/` desde la Fase 0 DX (2026-06-11). Vive junto a
> [`AUDIT-2026-06-10.md`](./AUDIT-2026-06-10.md), el reporte completo del audit.
>
> Los ítems marcados 🔐 tocan seguridad — encararlos con el tier de review más alto
> (cross-engine) antes de mergear.

---

## 🚀 ESTADO — v3.0.0 PUBLICADA EN NPM (2026-06-15)

> **main @ `251d2a8`** (sprint de CI cerrado 2026-06-16). Release coordinado mayor: `ghagga-core`, `ghagga`, `ghagga-db`
> los 3 en **3.0.0** en npm **con provenance SLSA** (drift core-2.9.1-vs-resto MUERTO).
> changesets wireado en lockstep. **Por qué v3** (no v2.10): breaking changes reales
> (CLI `--provider` rechaza legacy, `applyVirtualPatches` firma, `ghagga-db` borró
> delegated-CI) — varios mal-etiquetados "minor" en el changelog, corregidos.
>
> **Resuelto esta sesión (2026-06-15):**
> - Bug de scoping: el static-analysis ahora se filtra a los changed files (no falla
>   por deuda repo-wide). Reglas custom de semgrep wireadas al pipeline activo + tuneadas.
> - getClientIp: documentado honesto (deployment real = Coolify/Hetzner, NO Render;
>   ghagga **no está deployado**) — ver su entrada abajo, **ya no es "verificar Render"**.
> - 5 PRs Dependabot resueltas (4 merge + migración TS6 #246). `actions/checkout` v6 +
>   `action.yml` node24 (deprecation Node 20).
>
> **Sprint de CI (2026-06-16) — al re-habilitar Actions afloraron 2 workflows rotos:**
> - deploy-pages.yml (#249): orden `Setup pnpm` antes de `setup-node cache:pnpm`. Verde.
> - docker.yml/server Dockerfile (#250 types + #251 templates): 2 bugs latentes tapados
>   uno por otro (server importa @ghagga/types type-only sin copiarlo → TS2307; builder
>   no copiaba `templates/`). Verificado con `docker build` completo local + CI. Verde.
> - Hygiene (#252): SHA-pin de los 4 `docker/*`; publish.yml node 20→22; ci.yml
>   permissions least-priv; timeout-minutes; concurrency en docker.yml.
> - **CI re-habilitado FULL (#253)**: composite `.github/actions/setup` (DRY del
>   boilerplate ×4), triggers PR+push-main+dispatch, jobs paralelos, split test(PR)/
>   coverage(main push). `gh workflow enable ci.yml` (estaba manual-disabled de cuando
>   era privado). Verificado en PR real #254. **Gap cerrado**: los PRs ahora gatean el
>   backend, no solo el canary del dashboard.
> - Lint debt (#254): biome organizeImports en 2 tests de esta sesión. Fix. Quedan
>   ~250 warnings pre-existentes (no bloquean).
>
> **Gotchas del release (para la próxima):** el publish.yml exige **Actions habilitadas
> en el repo** + **NPM_TOKEN válido** (granular bypass-2FA o automation). Trusted
> Publishing bloqueado (pnpm no soporta OIDC, pnpm#9812). Repo público = Actions gratis.
> Las PRs post-3.0.0 NO tienen changeset → agregar para el próximo bump.
>
> **Follow-ups nuevos (sin fecha urgente):** command-injection taint precision (FP en
> `exec` propio); copy-assets try/catch; gitleaks-secrets-no-exentos-del-scope; Trusted
> Publishing cuando pnpm cierre #9812; **del audit de CI**: server Dockerfile node 20→22
> (build-verify); política del `security` audit (¿fallar en CRITICAL?); `apps/action/
> Dockerfile` (--filter names equivocados + dockerignore, dormido); cleanup de los ~250
> biome warnings.
>
> **3.1.0 issue-triage agent — IMPLEMENTACIÓN COMPLETA 7/7 FASES (sesión 2026-06-16), branch `feat/issue-triage-agent` (17 commits sobre main, SIN pushear, release-blocked):**
> Planning + las 7 fases, cada una con review multi-voz (3vr/4vr/5vr) + fix-forward. Todo en engram `sdd/issue-triage-agent/*`.
> **Scope LOCKEADO:** gating SOLO comando `/ghagga triage` (label-gate→3.2), GH Projects v2→3.2, permiso delta = solo `issues`.
> - ✅ **Phase 1** tabla `issue_drafts` (3vr: bigint comment-id, CHECK status/kind, partial-unique 1-open-DRAFT)
> - ✅ **Phase 2** agente core (5vr cazó 2 HIGH injection: labels sin sanitizar + markers boundary disjuntos)
> - ✅ **Phase 3** memory dedup (2vr+3vr: score era recencia no relevancia → Path A keyword-overlap backend-agnóstico)
> - ✅ **Phase 4** queue+worker `issue-analysis` (4vr: **Codex cazó SSRF** que las Claude perdieron + retry idempotency; never-auto-post estructural)
> - ✅ **Phase 5** webhook routing (5vr: **auth gate** demasiado amplio → gate propio write-only de triage; newest-comments paging; payload caps)
> - ✅ **Phase 6** dashboard approval API+page (3vr: **double-post race** → CAS DRAFT→APPROVED→POSTED exactly-once; XSS plain-text; cross-tenant scoped)
> - ✅ **Phase 7** permiso `issues:write` (docs, no manifest) + changeset minor (core+db, lockstep arrastra cli) + docs/issue-triage.md
> **Carry-forwards RESUELTOS:** save bajo `ISSUE_TRIAGE_OBSERVATION_TYPE` ✓, DI generateFn ✓, confidence fail-safe ✓, comment-count+payload caps ✓. Suites finales: core 3440 + server 656 + db 186 + dashboard 562 verde.
> **Blocker de release (sigue vivo):** NO shippea hasta (1) deployar server + (2) cerrar PRE-LAUNCH 🔐 + (3) re-consent del permiso `issues` en las instalaciones. Código buildeable/testeable local YA. NO pusheado → no gateó canary/CI todavía. Diseño ref: claude.ai/share/9e6b1461.
> **Pendiente menor (follow-up LOW):** COMMAND_REGEX no anclado a línea (quoting-injection, compartido con review) — hardening per-path después.
>
> **PRE-LAUNCH 🔐 sigue PARQUEADO** (server no deployado) — vuelve a importar el día que
> deployees el server para el issue-triage. Ver sección abajo.

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

## ✅ REFACTOR 1 — Unificar los parsers de unified-diff — RESUELTO 2026-06-12

> **Resolución (SDD `unify-diff-parsers`, branch `refactor/unify-diff-parsers`, base `c51878d`):**
> los 5 parsers ahora son adapters finos sobre UN parser unificado
> (`packages/core/src/diff/parse.ts` — única regex de file-header y única de hunk-header
> en producción, verificado por rg en el check R8). Corpus golden permanente de 23 fixtures
> (`src/diff/__tests__/fixtures/`) + 5 harnesses de paridad con copias frozen verbatim de las
> implementaciones viejas + tabla cross-consumer final (`parity-table.test.ts`).
> - **CORE-M6 CERRADO**: paths quoted parsean + unescape octal/C-style (changelog, semver minor).
> - **CORE-M9 CERRADO**: deletions atribuidas por posición new-side viva (changelog; flippeó
>   exactamente 2 snapshots del corpus: c07 y c15, gateado dual-baseline).
> - **Off-by-N del recursive RESUELTO** (SDD recursive-coordinate-contract, 2026-06-12 — reemplaza
>   el "congelado AS-IS" del Refactor 1): Design B (renumber de headers) + tracking out-of-band.
>   Ver ticket abajo.
> - Paridad byte-exacta de `DiffFile.content` verificada (Buffer.equals) → cero cambio en
>   prompts LLM.
>
> Lo que sigue de esta sección queda como histórico (el estado que describía ya no existe).

**Tipo:** behavior-preserving + arregla bugs latentes. **Riesgo:** medio (corregido a la baja, ver nota).
**Tamaño estimado:** 1 SDD chico (proponer → spec → apply con TDD → 4vr).

> **Corrección post-explore SDD (2026-06-11, verificado contra `c51878d`):**
> 1. Son **5 parsers, no 4** — `semantic-diff/index.ts:168-203` tiene su propio `parseHunks`
>    local (hoy `@experimental`, sin callers).
> 2. **Blast radius real mucho menor al estimado**: `diff-mapper` y `entity-diff` tienen CERO
>    callers de producción (solo re-exports + tests). El consumo real se concentra en
>    `pipeline.ts:166/171/379` (parseDiffFiles/filterDiffFiles/truncateDiff) y
>    `recursive/index.ts:74-156`.
> 3. **CORE-M6 reframeado**: paths con espacios simples parsean OK (backtracking greedy
>    accidental); lo que se dropea es la forma **quoted** (`"a/café.ts"`, no-ASCII/control).
> 4. Restricciones de diseño descubiertas: paridad **byte-exacta** de `DiffFile.content`
>    (reconstrucción `join('\n')` en `pipeline.ts:227` va al prompt del LLM), parser defensivo
>    ante diffs truncados (truncateDiff + input ACP arbitrario), y off-by-N pre-existente del
>    recursive en iteración 2+ (congelar con golden test, NO arreglar de pasada).

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

## ✅ REFACTOR 2 — Partir el god-function `reviewPipeline` — COMPLETADO 2026-06-12 — PR #221 mergeado

> **Resolución (SDD `split-review-pipeline`, branch `refactor/split-review-pipeline`, base
> `992c69f`):** PR #221 squash-merged @ `aa15e7b` (2026-06-12), canary verde, verificación
> post-merge verde (core 3296, typecheck 10/10), batches B0–B7 con 4vr por batch.
> `reviewPipeline` quedó como orquestador fino (~30 líneas de función) que
> encadena 5 fases sobre un `PipelineState` mutable compartido:
> `pipeline/prepare.ts` (+ sibling `prepare-graph.ts`) → `gather-context.ts` (+ sibling
> `gather-safe.ts`) → `execute.ts` → `enrich.ts` → `finalize.ts`, con `state.ts`, `degrade.ts`
> (`runDegradable`), `providers.ts` y `results.ts` como soporte. Red golden de 53 casos
> (`pipeline-golden.test.ts`, activo permanente) pinnea ReviewResult + stream de emits byte-igual.
>
> **Deltas verificados durante el SDD vs lo escrito abajo (el explore midió contra código real):**
> 1. **Límites reales de la función**: `reviewPipeline` iba de `pipeline.ts:150` a `:1071`
>    (~921 líneas, no ~928 — entre `:1071` y `resolveAiEnabled :1079` hay doc comment).
> 2. **3 steps degradan SIN push** a `failedSteps` (solo `console.warn`): call-chain,
>    negative-examples y self-improve. La lista de 12 push-sites de abajo era correcta pero
>    incompleta como inventario de degradación — los 3 warn-only quedaron preservados explícitos
>    (`runDegradable` con `reportFailure: false` + comentario DELIBERATE) y pinneados por golden.
> 3. **Contradicción del approach original**: el punto 3 de abajo proponía "de paso arregla la
>    inconsistencia PASSED-only" — eso contradice el listón "cero cambio de comportamiento" que la
>    sección Riesgo declara absoluto. **Decisión**: el refactor preservó el downgrade PASSED→PARTIAL
>    LITERAL (pinneado por `pipeline.test.ts` "preserves FAILED status"); el fix de aplicar el
>    downgrade de cobertura a todos los status va como **PR aparte post-SDD** (cambio de
>    comportamiento observable, changelog propio).
> 4. **Approach distinto al propuesto**: el contrato `PipelineStep` + runner con `Partial<Result>`
>    fue RECHAZADO con evidencia (design D1 del SDD): los steps mutan findings in-place, leen
>    read-your-writes sobre `result`, y el trío static∥memory∥code-intel escribe concurrente — un
>    runner-merge cambiaba semántica. En su lugar: fases que mutan un `PipelineState` explícito;
>    `runDegradable` centraliza el patrón try/warn/push/emit solo en los sitios genuinamente
>    uniformes (blast-radius y el dispatch conservan sus catch bespoke).
> 5. Bonus: dedupe del shape `FailedStep` — `pipeline/state.ts` ahora lo deriva de
>    `ReviewResult['failedSteps']` (no puede divergir del tipo público).
>
> Lo que sigue queda como histórico (el estado que describía ya no existe).

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
- ~~**`semantic-diff` no está cableado a producción**~~ ✅ **RESUELTO 2026-06-13** (SDD
  `wire-semantic-diff`): wireado al comment del PR. `extractSemanticDiff` corre en la fase enrich
  (`pipeline/enrich.ts`), el resultado va a `ReviewResult.semanticDiff` y alimenta la sección
  "What changed" del comment vía `formatSemanticDiffSection` (`format.ts`). Decisión cerrada
  (wirear, no marcar experimental): los `@experimental` removidos del módulo y del re-export en
  `core/src/index.ts`; header del módulo reescrito a la verdad actual con las limitaciones reales
  pinneadas (regex single-line: multiline arrows, generic constraints con parens). El hallazgo
  original (#209): el bug de precedencia vivió meses sin detectarse PORQUE no estaba cableado —
  ahora lo está y el extractor tiene callers de producción reales.
- **Off-by-N del recursive en iteración 2+ — RESUELTO 2026-06-12** (SDD recursive-coordinate-contract;
  reemplaza la nota "congelado AS-IS" del Refactor 1/spec R7). El problema: las líneas `+[SUGGESTED FIX]`
  inyectadas en iter1 corrían el counter target-side cuando `recursive/index.ts` re-parsea el diff
  sintético, así que los patches de iter2 aterrizaban N líneas abajo (N = markers inyectados arriba en
  el mismo hunk) — y peor, el N dependía de si el LLM numeraba por headers `@@` (interp A) o por líneas
  físicas (interp B), o sea NO determinista.
  **Approach (Design B — robusto-a-ambas)**: `applyVirtualPatches` ahora emite un unified diff VÁLIDO —
  al inyectar un marker renumera el header del hunk afectado (`newCount += markers-in-hunk`) y corre el
  `newStart` de cada hunk posterior del mismo archivo por los markers inyectados arriba. Así el `@@ +N`
  declarado dice la verdad: posición física == `@@ +N` == línea real == lo que reporta cualquier LLM
  sano. Interp A y B convergen en la MISMA línea (gateado por el contract test
  `recursive/coordinate-contract.test.ts`, que corre el loop completo iter1→iter2 con un mock que
  parsea el `patchedDiff` real). Identidad del marker trackeada OUT-OF-BAND vía
  `VirtualPatchResult.injectedLineIndices` (índices grabados en el sitio de inyección), nunca por
  scan del prefijo `[SUGGESTED FIX]` → inmune a colisión con líneas de código que empiecen así.
  **Re-bless a conciencia**: `c16.diff` regenerado como output Design-B (6 headers renumerados);
  `recursive-golden.test.ts.snap` re-blessado (iter2 alpha7 ahora cae TRAS alpha7, no tras alpha6);
  `parity-apply-virtual-patches.test.ts` levanta la igualdad legacy SOLO en el path de markers
  (`assertMarkerPathDivergence`: divergencia confinada a headers `@@`; no-op/miss/malformed siguen
  pinneados byte-exactos). `RecursiveReviewReport` público SIN cambios.
  Bug de paridad cazado durante el reconcile: el branch de header de la Fase 2-4 hacía `continue`
  saltándose el patch-match post-header → perdía la inyección legacy en `line === newStart-1`.
  Restaurado con helper `injectAfter()` + `countMarkersInHunk` ahora presupuesta el match en posición
  de header. Verificado: markers aterrizan idénticos al legacy en TODAS las fixtures.
- ~~**CORE-M8 `computeSimilarity`**~~ ✅ **RESUELTO 2026-06-12, PR #218** (`dac8808`, 3vr con
  fix-forward). LCS real (DP dos filas, Uint32Array) en vez de char-por-posición; threshold 0.9
  intacto (LCS ≥ posicional para todo par ⇒ cero falsos negativos nuevos). El 3vr agregó guards:
  denominador con longitudes ORIGINALES (mata el falso rename 1.0 de bodies >10k idénticos solo en
  el prefijo capeado), prefilter O(1) (`min/max < threshold` ⇒ skip DP) y budget de celdas DP
  (200M default, inyectable vía `EntityDiffOptions.lcsDpCellBudget`) porque el costo por par subió
  ~10.000× — sin budget era bomba de CPU latente en `detectRenames` (API pública sin callers hoy).
- **2 bugs pre-existentes de `semantic-diff` congelados por los harnesses de paridad** (hallados por
  el 3vr de Phase 5-7 del SDD, AMBOS anteriores al refactor y preservados a propósito —
  `@experimental`, sin callers prod):
  1. `buildSummary` double-cuenta imports/exports: `semantic-diff/index.ts:357-358` pasa
     `import_added`/`export_added` como `modifiedKind` a `groupSummary` → un import agregado se
     reporta como "1 import added, 1 import modified".
  2. Una class modificada se reporta como `function_modified` (`semantic-diff/index.ts:312` — el
     union `EntityChangeKind` no tiene `class_modified`).
  Arreglarlos = delta de comportamiento observable → actualizar `parity-extract-semantic-diff.test.ts`
  (la copia frozen los reproduce) y el changelog al hacerlo.
  ✅ **RESUELTO 2026-06-12, PR #219** (`f78f835`, 3vr): union ampliado con
  `class_modified`/`import_modified`/`export_modified`, ternarios de 3 ramas, buildSummary con
  modifiedKinds correctos. Bonus descubierto en el fix: (cara B) toda function modificada también
  contaba en "N class modified", y los imports/exports MODIFICADOS eran alcanzables y se reportaban
  `*_removed`. Harness convertido a divergencia confinada con evidencia estructural por par
  (precedente `assertMarkerPathDivergence`); 4 snapshots re-blessed auditados (solo
  `export_removed→export_modified` + recuentos). Semver minor, changelog incluido.
- **Limitación documentada de autoridad de path en headers malformados** (SDD unify-diff-parsers,
  `src/diff/parse.ts:17-19`): en el header unquoted `diff --git a/x b/y`, un path con ` b/` literal
  es ambiguo — gana la ÚLTIMA ocurrencia (mismo boundary que la regex histórica). Y cuando el header
  y la línea `+++ b/` discrepan (solo alcanzable en input malformado, nunca en git/GitHub), la
  autoridad es `+++ b/` → `rename to` → header (la impl vieja confiaba en el header) — divergencia
  pinneada en `parity-parse-diff-files.test.ts` (`adv-header-b-mismatch`). No hay fix posible sin
  formato quoted: es ambigüedad inherente del formato unquoted.
- ~~**Higiene de lint del monorepo**~~ ✅ **RESUELTO — verificado 2026-06-12 sobre `4c1f0c3`**.
  Entrada stale: la deuda ya se había limpiado en #182 (`c7d932d`) y #210 (`6a510d6`, "zero biome
  errors"). Los 4 sospechosos citados (ConfirmDialog/ObservationDetailModal a11y, queries.ts formato,
  api.ts organizeImports, Reviews.tsx exhaustive-deps) ya no emiten ningún diagnóstico. Estado actual:
  `pnpm exec biome check .` → exit 0 (0 errores; 253 warnings deliberadamente degradados a "warn" en
  `biome.json`) y el pre-commit (`javi-forge ci --quick --no-docker --no-security --no-ci-ghagga`)
  pasa verde completo — `--no-verify` ya NO es necesario por lint. Gotcha vigente: el paso Compile
  del hook regenera `apps/action/dist` (churn de bundle; si no se quiere commitear, restaurar con
  `git checkout -- apps/action/dist` y borrar los artefactos nuevos no trackeados).
- ~~**`Review.repo` es ficción**~~ ✅ **RESUELTO 2026-06-12, PR #217** (`4212a0e`, 3vr con
  fix-forward). `GET /api/reviews` ahora mapea ambos paths por `toReviewDto` (per-repo compone del
  repo ya validado, cross-installation del innerJoin); el dashboard perdió el fallback en cadena.
  Bonus de seguridad: en main el endpoint emitía filas DB CRUDAS — `metadata` (provider, modelo,
  tokens, costos, fileList), `tokensUsed`, `executionTimeMs` salían al wire; el mapper allowlistea.
  El 3vr (Codex) cazó además: `ReviewMode` ahora se re-exporta de core (faltaba `diagnostic`, que
  el runtime persiste desde `c35b011`) y `Finding.line` pasó a opcional (core dice `line?`, se
  persiste verbatim; el dashboard ya no renderiza `file:undefined`). Deploy note: server-first.
- **Follow-ups del 3vr de #217** (anotados, no bloqueantes):
  1. ~~El `Finding` del wire es subset del `ReviewFinding` de core~~ ✅ **RESUELTO 2026-06-13, PR #227**
     (3vr): `ReviewFinding` re-exportado de `ghagga-core` desde `@ghagga/types` (patrón
     `ReviewMode`/`ReviewStatus`), `Review.findings: ReviewFinding[]`, `Finding` queda alias
     `@deprecated`. Server route (productor del contrato) migró al nombre canónico; dashboard
     `lib/types` también re-exporta `ReviewFinding`; `ghagga-core` movido a `dependencies` de
     `@ghagga/types` (sus tipos están ahora en la superficie pública `.d.ts`). Cero cambio de
     comportamiento wire — la data ya viajaba verbatim (verificado: `saveReview` persiste el
     `ReviewFinding` completo a un jsonb opaco, `toReviewDto` lo castea verbatim).
     **Follow-up ✅ RESUELTO 2026-06-13, PR #228**: el wire ahora PROYECTA — `toReviewDto` stripea
     `filterReason` (razonamiento LLM crudo) y `exploitabilityDetail`/`usageDetail` (paths internos
     del repo). `Finding` pasó a `Omit<ReviewFinding, esos3>`; labels/señales se mantienen. CLI/ACP
     locales siguen con el `ReviewFinding` completo (el user es dueño de su data).
  2. ~~No hay integration test de auth para `GET /api/reviews`~~ ✅ **RESUELTO 2026-06-13, PR #225**
     (`f451352`): S2.6 (per-repo 200), S2.7 (cross-installation 403 — gate corta ANTES de la query),
     S2.8 (path "all repositories" scopeado por installation IDs / aislamiento de tenant). Test-only,
     cross-chequea además la emisión wire de `coverageComplete` (#223). Server suite 556→559.
- ~~**Test live-PG para tsquery** (sprint 1)~~ ✅ **RESUELTO 2026-06-13, PR #232**: integration test
  con testcontainers (`postgres:16-alpine`) que valida que `to_tsquery('english')` acepta el output de
  `buildTsQuery` (13 inputs edge + probe tsvector que espeja el SQL de `searchObservations`, no la función).
  Aislamiento doble-barrera: `*.integration.test.ts` excluido del `test` normal (`...configDefaults.exclude`)
  + config y script `test:integration` separados (no en `turbo.json`) → CI sin Docker intacto. 3vr aprobado.
- ~~**Matrix jobs comparten cache key** (sprint 1)~~ ❌ **FALSO PROBLEMA — verificado 2026-06-13, NO tocar**:
  la key compartida `ghagga-${tool}-${RUNNER_OS}` (`apps/action/src/tools/execution.ts:78,96`) es INTENCIONAL —
  cachea binarios INMUTABLES en paths fijos (trivy/pmd/hadolint) para reusarlos entre jobs. El segundo
  `saveCache` "que falla" ya está manejado (try/catch → `core.warning` no-fatal, `ReserveCacheError` esperado).
  Diferenciar la key por run-attempt/job (el "fix" original) causaría cache-miss garantizado en toda la matrix
  → cada job re-descarga todo. Contraste: el memory cache (`index.ts:217`) sí usa run-attempt porque cachea
  ESTADO MUTABLE. Único accionable opcional (cosmético): degradar ese warning a `core.debug` para `ReserveCacheError`.
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
- ~~**DSH-A6**: `AuthCallback` valida el token dos veces~~ ✅ **RESUELTO 2026-06-13, PR #231** (5vr):
  eliminada la validación redundante; `AuthCallback` delega a `loginFromCallback` (única validación).
  Sin bypass de auth (consenso Opus + Codex); reduce round-trips bajo StrictMode 4→2. Fix-forward:
  mensaje de error preservado (cero cambio observable) + test con `toHaveBeenCalledTimes(1)`.
- ~~**DSH-A7 / DSH-A8**~~ ✅ **RESUELTO 2026-06-13, PR #234** (5vr): `useRef` once-flag hace el effect
  del callback OAuth idempotente bajo StrictMode (corre 1 vez, sobrevive mount→cleanup→mount). El bug
  del `REDIRECT_KEY` (destino → `/`) era DEV-only — StrictMode no dobla effects en prod (cazado por Codex
  5.4); el guard fija dev + endurece contra cualquier re-invocación futura. DSH-A8: dep array
  `searchParams.get` → `searchParams` + se borró el `eslint-disable` huérfano (el paquete usa Biome, no
  eslint). Tests StrictMode blindan happy + error/throw (rojo→verde confirmado). 5vr descartó: retry roto
  (Try Again es `<Link>` que desmonta → reprocesa), y AbortController (colgaría la UI). Cero cambio observable de prod.
- ~~**DSH-A9**~~ ✅ **RESUELTO 2026-06-13, PR #235** (5vr + re-check de seguridad): unificado en
  `REDIRECT_KEY` — el handler 401 (`api.ts`) ahora stashea la ruta (saneada, pathname-only) antes de
  redirigir; `Login.tsx` computa UN destino saneado usado en TODOS los navigate (Web Flow + **PAT login** +
  ya-autenticado), así el PAT también preserva el destino. Hardening open-redirect: helper `safeInternalPath`
  que stripea control chars C0/DEL ANTES de validar + rechaza protocol-relative/no-internal. **El 5vr cazó
  un bypass real** (Codex 5.4): la 1ra versión aceptaba `/\n/evil.com` (el browser stripea tab/LF/CR → colapsa
  a `//evil.com` off-site); cerrado y re-verificado contra la WHATWG URL spec (Opus + Codex, sin bypass
  residual). El 5vr también cazó que la 1ra versión solo cubría OAuth, no PAT. Preservación pathname-only
  deliberada (query no round-trippeado, consistente con ProtectedRoute). HashRouter = 2da capa de defensa.

---

## Cómo encarar — plan DX-first (reordenado 2026-06-11)

> Contexto de la decisión: la app no está en uso → la deuda de *producción* (seguridad runtime)
> pierde urgencia y el criterio pasa a ser DX puro: qué hace el desarrollo más rápido y confiable.

1. ~~**Mergear** #203→#206 + acción SSRF (#207)~~ ✅ 2026-06-11, canary verde.
2. ~~**22 fallas pre-existentes de core**~~ ✅ 2026-06-11, PR #209 — core 2702/2702.
3. ~~**Fase 0 DX**: lint a cero + typecheck verde + hook restaurado (PR #210), notas trackeadas,
   dependabot~~ ✅ 2026-06-11.
4. ~~**Refactor 1** (diff parsers) — SDD con golden tests, 4vr. El corpus de golden tests es un
   activo permanente.~~ ✅ 2026-06-12, SDD `unify-diff-parsers` (ver sección arriba). El corpus
   (23 fixtures) + los 6 harnesses de paridad quedaron como activo permanente.
5. ~~**Refactor 2** (pipeline god-function) — SDD, rama dedicada, 4vr, canary obligatorio.~~
   ✅ 2026-06-12, SDD `split-review-pipeline` (ver sección arriba) — PR #221 mergeado @ `aa15e7b`,
   canary verde. ~~Follow-up post-merge: fix del downgrade PASSED-only (PR aparte).~~
   ✅ Follow-up RESUELTO 2026-06-12 (esta rama): el "downgrade a todos los status" del approach
   original era un ERROR — la Action falla el check SOLO con `FAILED` (`action/index.ts:343`);
   colapsar FAILED-degradado a PARTIAL pondría en verde PRs con issues críticos. Decisión: veredicto
   y cobertura son dimensiones ortogonales → campo nuevo `ReviewResult.coverageComplete?: boolean`
   (false si degradó CUALQUIER step, incluidos los 3 warn-only vía tracking `warnOnlyDegradations`
   interno; undefined en SKIPPED). Status intacto, downgrade PASSED→PARTIAL literal, test
   "preserves FAILED" extendido. Wire: doblado en metadata jsonb (sin migración), DTO condicional,
   indicador ⚠ en dashboard. Semver minor, changelog incluido.
6. ~~**Contratos**: `Review.repo` en `@ghagga/types`~~ ✅ 2026-06-12, PR #217 (ver sección
   Correctness). El barrido fix-between-SDDs del 2026-06-12 cerró además CORE-M8 (#218),
   los 2 bugs de semantic-diff (#219) y el ticket stale de lint (#216).

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
- ~~**getClientIp trust boundary** (`apps/server/src/lib/get-client-ip.ts`)~~ ✅ **DOCUMENTADO 2026-06-15**
  (commit `5e7665c`): toma la ÚLTIMA IP del XFF; consumidores = SOLO 3 rate-limiters (api/oauth/webhook),
  no auth/logging/DB → blast radius = rate-limit. El comentario "Render" era **stale** (el deployment migró
  a Coolify/Hetzner y ghagga **no está deployado** — la box vieja fue torn down). Reemplazado por un
  contrato de trust-boundary abstracto, **validate-at-deploy-time** (last-IP correcto SOLO con 1 proxy de
  confianza que appendea + puerto del app firewalleado). No hay nada vivo que verificar hasta que deployees.
  🔐 Decisión de deployment, diferida hasta el deploy real del server.
- ~~Test live-PG para `buildTsQuery`~~ ✅ RESUELTO PR #232 (testcontainers; ver sección Correctness)
- ~~Matrix cache key del Action~~ ❌ falso problema (NO tocar; ver sección Correctness)
- ~~DSH-A6 (doble validación de token en AuthCallback)~~ ✅ RESUELTO PR #231 (ver sección Dashboard)
- ~~**DSH-A7 / DSH-A8**~~ ✅ RESUELTO PR #234 (5vr; guard StrictMode + dep array — bug era dev-only; ver sección Dashboard)
- ~~**DSH-A9**~~ ✅ RESUELTO PR #235 (5vr + re-check seguridad; redirect preservado en error/expiración + PAT + hardening open-redirect — bypass `/\n/` cazado por Codex y cerrado; ver sección Dashboard)
- ~~**Proyección de campos AI-internos en el wire de `/api/reviews`**~~ ✅ **RESUELTO 2026-06-13,
  PR #228** (`ea87e4e`, 3vr): `toReviewDto` stripea `filterReason` + `exploitabilityDetail`/`usageDetail`
  de cada finding antes del wire; `Finding = Omit<ReviewFinding, esos3>`. Completitud verificada (único
  sink HTTP de findings; comment/SARIF/Action outputs no los emiten). Guard fail-closed para jsonb
  malformado. CLI/ACP locales sin cambios. NOTA pre-existente descartada en el review: `finding.message`
  puede contener paths del repo del propio caller — no es leak cross-tenant (es la descripción del
  hallazgo en su propio repo), no se toca.
- ~~**`model`-cell del comment sin strip de backticks**~~ ✅ **RESUELTO 2026-06-13, PR #230**:
  `format.ts:471` ahora usa `sanitizeInlineCodeName(model)` (que stripea backticks) en vez de
  `sanitizeTableCell(model)` crudo. Verificado que es la ÚNICA celda envuelta en backticks del comment.
  El barrido general de config untrusted (`checklistContext`, overrides free-form de `mergeCheck`) sigue
  pendiente en sus propias entradas — esta era la única celda de backticks alcanzable por esa vía.

(Los detalles con file:line de cada uno quedan en sus secciones de arriba — salvo los autocontenidos.)
