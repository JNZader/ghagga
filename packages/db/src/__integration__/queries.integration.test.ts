/**
 * Integration: buildTsQuery against a REAL PostgreSQL.
 *
 * `buildTsQuery` (src/queries.ts) sanitizes free-text input into a string that
 * is handed verbatim to `to_tsquery('english', ...)` inside `searchObservations`.
 * The unit suite (queries.test.ts) only asserts the *string shape* of that
 * output. It can NOT prove the output is actually accepted by Postgres — a
 * malformed lexeme or an un-neutralized tsquery operator would only blow up at
 * runtime as a `syntax error in tsquery`.
 *
 * This test closes that gap by booting a real `postgres:16-alpine` container
 * (aligned with docker-compose.yml) and feeding `buildTsQuery(input)` straight
 * into `to_tsquery`, for a battery of adversarial inputs. That is the one true
 * contract this file proves: `to_tsquery('english', …)` accepts whatever
 * `buildTsQuery` emits, without a syntax error.
 *
 * It ALSO exercises a tsvector probe (`to_tsvector` + `@@` + `ts_rank`) that
 * MIRRORS the SQL shape `searchObservations` runs, but on a standalone probe
 * table — it does NOT call `searchObservations` and does NOT touch the real
 * `memory_observations` table or its trigger. The probe validates that the
 * sanitized query behaves sensibly against a live tsvector column; it does NOT
 * cover `searchObservations`'s own WHERE / ORDER BY / project filter / trigger.
 *
 * REQUIRES DOCKER. Excluded from the default unit run; invoke with:
 *   pnpm --filter ghagga-db test:integration
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTsQuery } from '../queries.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  // Align the image with the production stack (docker-compose.yml -> postgres:16-alpine).
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/**
 * Edge-case inputs. Each must survive `to_tsquery('english', buildTsQuery(input))`
 * without a syntax error. The interesting ones contain tsquery metacharacters
 * (& | ! : * ( )) and quoting hazards (single quotes, backslashes) that, if not
 * neutralized by quoting+escaping, would either be interpreted as operators or
 * break the surrounding lexeme quotes.
 */
const EDGE_INPUTS: ReadonlyArray<{ name: string; input: string }> = [
  { name: 'plain multi-word text', input: 'auth token rotation' },
  { name: 'single quote inside word', input: "it's broken" },
  { name: 'trailing backslash', input: 'path\\' },
  { name: 'embedded backslash', input: 'a\\b' },
  { name: 'tsquery AND operator', input: 'foo & bar' },
  { name: 'tsquery OR operator', input: 'foo | bar' },
  { name: 'tsquery NOT operator', input: '!foo' },
  { name: 'tsquery weight/colon', input: 'foo:bar' },
  { name: 'tsquery prefix star', input: 'foo*' },
  { name: 'tsquery parens', input: '(foo) bar' },
  // buildTsQuery splits on whitespace, so '<->' is tokenized as a literal
  // lexeme ('foo' | '<->' | 'bar') — it is NOT recognized/neutralized as the
  // FOLLOWED-BY operator. This only proves to_tsquery accepts the quoted
  // '<->' lexeme without error.
  { name: "quoted '<->' lexeme (not the FOLLOWED-BY operator)", input: 'foo <-> bar' },
  { name: 'collapsing whitespace', input: '  foo   bar  ' },
  { name: 'all operators jammed together', input: "a & b | !c:* (d) 'e' \\f" },
];

describe('integration: buildTsQuery -> to_tsquery (real PostgreSQL)', () => {
  it.each(EDGE_INPUTS)('produces a tsquery PostgreSQL accepts: $name', async ({ input }) => {
    const sanitized = buildTsQuery(input);
    // Sanity: every edge input here has at least one real word, so the
    // sanitized output is never the empty string.
    //
    // Empty/whitespace-only input is intentionally OUT OF SCOPE here: it would
    // produce an empty string and break this non-empty assertion, but more
    // importantly that path never reaches `to_tsquery` in production —
    // searchObservations short-circuits via `if (!sanitizedQuery) return []`
    // (queries.ts) before building the SQL. The empty-input behavior of
    // buildTsQuery is covered by the unit suite (queries.test.ts).
    expect(sanitized.length).toBeGreaterThan(0);

    // The contract under test: this is EXACTLY what searchObservations does
    // (`to_tsquery('english', ${sanitizedQuery})`). It must not throw a
    // "syntax error in tsquery" and must yield a non-empty tsquery.
    const { rows } = await pool.query<{ q: string }>(
      "SELECT to_tsquery('english', $1)::text AS q",
      [sanitized],
    );
    expect(rows[0]?.q.length).toBeGreaterThan(0);
  });

  it('neutralizes operators: "foo & bar" matches as an OR of literal lexemes, NOT as AND', async () => {
    // If '&' leaked through as a real operator, this query would require BOTH
    // foo AND bar in the document. buildTsQuery quotes each whitespace-split
    // token as a lexeme and joins with '|', so the raw output is
    // 'foo' | '&' | 'bar'. The english stemmer then DROPS the '&' lexeme (it
    // is not a recognized word and normalizes to nothing), so the effective
    // tsquery is 'foo' | 'bar' — a doc containing only "foo" must still match.
    const sanitized = buildTsQuery('foo & bar');
    const { rows } = await pool.query<{ matched: boolean }>(
      "SELECT to_tsvector('english', 'foo') @@ to_tsquery('english', $1) AS matched",
      [sanitized],
    );
    expect(rows[0]?.matched).toBe(true);
  });
});

describe('integration: tsvector probe mirroring searchObservations SQL (real PostgreSQL)', () => {
  // NOTE: this suite does NOT call searchObservations and does NOT use the real
  // memory_observations table or its trigger. It builds a standalone probe
  // table whose tsvector population MIRRORS the production trigger
  // (drizzle/_custom_tsvector.sql) and runs the same `@@ to_tsquery` / `ts_rank`
  // SQL shape, to confirm buildTsQuery's output behaves sensibly against a live
  // tsvector column. searchObservations's own filters/ordering/trigger are
  // intentionally out of scope.
  beforeAll(async () => {
    // Standalone probe table whose tsvector column is populated exactly like
    // the production trigger (drizzle/_custom_tsvector.sql): a tsvector built
    // from coalesce(title,'') || ' ' || coalesce(content,''), matched via
    // `@@ to_tsquery('english', ...)`. This is a MIRROR of the trigger SQL, not
    // the trigger itself.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS obs_fts_probe (
        id serial PRIMARY KEY,
        title text NOT NULL,
        content text NOT NULL,
        search tsvector
      );
    `);
    await pool.query('TRUNCATE obs_fts_probe RESTART IDENTITY;');
    await pool.query(
      `INSERT INTO obs_fts_probe (title, content, search) VALUES
        ($1, $2, to_tsvector('english', coalesce($1, '') || ' ' || coalesce($2, ''))),
        ($3, $4, to_tsvector('english', coalesce($3, '') || ' ' || coalesce($4, '')))`,
      [
        'auth token rotation',
        "fixes the broken refresh flow when it's stale",
        'unrelated note',
        'about caching layers and nothing else',
      ],
    );
  });

  it('matches the expected row through buildTsQuery -> to_tsquery -> @@', async () => {
    const sanitized = buildTsQuery('token rotation');
    const { rows } = await pool.query<{ title: string }>(
      `SELECT title FROM obs_fts_probe
       WHERE search @@ to_tsquery('english', $1)
       ORDER BY ts_rank(search, to_tsquery('english', $1)) DESC`,
      [sanitized],
    );
    expect(rows.map((r) => r.title)).toContain('auth token rotation');
    expect(rows.map((r) => r.title)).not.toContain('unrelated note');
  });

  it('survives an adversarial query (single quotes + operators) without error', async () => {
    // A real user query containing quoting hazards and tsquery operators must
    // run cleanly against the live column and simply return whatever matches.
    const sanitized = buildTsQuery("it's & broken:*");
    const { rows } = await pool.query<{ title: string }>(
      `SELECT title FROM obs_fts_probe
       WHERE search @@ to_tsquery('english', $1)`,
      [sanitized],
    );
    // 'broken' stems and lives in the first row's content; it must be found.
    expect(rows.map((r) => r.title)).toContain('auth token rotation');
  });
});
