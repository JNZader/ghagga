import { describe, expect, it } from 'vitest';
import { checkForgeBoundary, checkServerForgeClientBoundary } from './lint-boundary.js';

describe('forge-boundary checker (R-AGNOSTIC)', () => {
  it('PASSES a type-only forge→core import', () => {
    const src = "import type { DependencyGraph } from 'ghagga-core';";

    expect(checkForgeBoundary(src)).toEqual([]);
  });

  it('PASSES forge→core when all named specifiers are inline-type', () => {
    const src = "import { type DependencyGraph, type GraphMetadata } from 'ghagga-core';";

    expect(checkForgeBoundary(src)).toEqual([]);
  });

  it('FAILS a value forge→core import', () => {
    const src = "import { buildGraph } from 'ghagga-core';";

    const violations = checkForgeBoundary(src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.module).toBe('ghagga-core');
    expect(violations[0]?.reason).toMatch(/TYPE position only/i);
  });

  it('FAILS a mixed forge→core import (one value specifier taints it)', () => {
    const src = "import { type DependencyGraph, buildGraph } from 'ghagga-core';";

    const violations = checkForgeBoundary(src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.module).toBe('ghagga-core');
  });

  it('FAILS a default/namespace value import from core', () => {
    const src = "import * as core from 'ghagga-core';";

    expect(checkForgeBoundary(src)).toHaveLength(1);
  });

  it('FAILS any import of the server app (package specifier)', () => {
    const src = "import { app } from 'ghagga-server';";

    const violations = checkForgeBoundary(src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/MUST NOT import apps\/server/i);
  });

  it('FAILS a relative path import that reaches into apps/server', () => {
    const src = "import { handler } from '../../apps/server/src/routes.js';";

    expect(checkForgeBoundary(src)).toHaveLength(1);
  });

  it('IGNORES unrelated imports (own package, third-party)', () => {
    const src = [
      "import { describe } from 'vitest';",
      "import type { RepoRef } from './types.js';",
      "import { MapForgeRegistry } from './registry.js';",
    ].join('\n');

    expect(checkForgeBoundary(src)).toEqual([]);
  });

  it('FAILS a value re-export from core (export { X } from)', () => {
    const src = "export { buildGraph } from 'ghagga-core';";

    const violations = checkForgeBoundary(src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.module).toBe('ghagga-core');
    expect(violations[0]?.reason).toMatch(/TYPE position only/i);
  });

  it('FAILS even an `export type` re-export from core (re-export = value escape)', () => {
    const src = "export type { DependencyGraph } from 'ghagga-core';";

    expect(checkForgeBoundary(src)).toHaveLength(1);
  });

  it('FAILS a dynamic import() of core', () => {
    const src = "const m = await import('ghagga-core');";

    expect(checkForgeBoundary(src)).toHaveLength(1);
  });

  it('FAILS a require() of core', () => {
    const src = "const core = require('ghagga-core');";

    expect(checkForgeBoundary(src)).toHaveLength(1);
  });

  it('FAILS a core SUBPATH value import', () => {
    const src = "import { buildGraph } from 'ghagga-core/graph';";

    const violations = checkForgeBoundary(src);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.module).toBe('ghagga-core/graph');
  });

  it('PASSES a core SUBPATH type-only import', () => {
    const src = "import type { DependencyGraph } from 'ghagga-core/graph';";

    expect(checkForgeBoundary(src)).toEqual([]);
  });

  it('FAILS the scoped alias @ghagga/core value import', () => {
    const src = "import { buildGraph } from '@ghagga/core';";

    expect(checkForgeBoundary(src)).toHaveLength(1);
  });

  it('PASSES a MULTI-LINE type-only import from core', () => {
    const src = "import type {\n  DependencyGraph,\n  GraphMetadata,\n} from 'ghagga-core';";

    expect(checkForgeBoundary(src)).toEqual([]);
  });

  it('FAILS a MULTI-LINE mixed import (inline type + value across lines)', () => {
    const src = "import {\n  type DependencyGraph,\n  buildGraph,\n} from 'ghagga-core';";

    expect(checkForgeBoundary(src)).toHaveLength(1);
  });

  it('handles multiple imports in one file, flagging only the offenders', () => {
    const src = [
      "import type { GraphMetadata } from 'ghagga-core';", // ok
      "import { buildGraph } from 'ghagga-core';", // value → fail
      "import { z } from 'zod';", // ok
    ].join('\n');

    const violations = checkForgeBoundary(src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.module).toBe('ghagga-core');
  });
});

describe('server→client.ts forge-adapter boundary (R-AGNOSTIC 1.6)', () => {
  const FILE = 'apps/server/src/queues/review.ts';

  it('CATCHES the namespace-import bypass (alias.fetchPRDiff)', () => {
    const src = [
      "import * as gh from '../github/client.js';",
      'const diff = await gh.fetchPRDiff(token, owner, repo, n);',
    ].join('\n');

    const violations = checkServerForgeClientBoundary(FILE, src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/NAMESPACE BYPASS/i);
    expect(violations[0]?.module).toMatch(/gh\.fetchPRDiff/);
  });

  it('CATCHES every banned fn via namespace member access', () => {
    const banned = [
      'fetchPRDiff',
      'fetchPRDetails',
      'getPRFileList',
      'getPRCommitMessages',
      'postComment',
      'findExistingComment',
      'deleteComment',
      'updateComment',
      'addCommentReaction',
      'fetchGraphFromBranch',
      'fetchGraphMetadata',
    ];
    const src = [
      "import * as gh from '../github/client.js';",
      ...banned.map((fn) => `gh.${fn}();`),
    ].join('\n');

    expect(checkServerForgeClientBoundary(FILE, src)).toHaveLength(banned.length);
  });

  it('ALLOWS getInstallationToken via namespace member access', () => {
    const src = [
      "import * as gh from '../github/client.js';",
      'const t = await gh.getInstallationToken(id);',
    ].join('\n');

    expect(checkServerForgeClientBoundary(FILE, src)).toEqual([]);
  });

  it('ALLOWS verifyWebhookSignature via namespace member access', () => {
    const src = [
      "import * as gh from '../github/client.js';",
      'const ok = gh.verifyWebhookSignature(body, sig);',
    ].join('\n');

    expect(checkServerForgeClientBoundary(FILE, src)).toEqual([]);
  });

  it('CATCHES a named import of a banned fn (defense-in-depth with Biome)', () => {
    const src = "import { fetchPRDiff } from '../github/client.js';";

    const violations = checkServerForgeClientBoundary(FILE, src);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/named import is forbidden/i);
  });

  it('ALLOWS a named import of getInstallationToken/verifyWebhookSignature', () => {
    const src =
      "import { getInstallationToken, verifyWebhookSignature } from '../github/client.js';";

    expect(checkServerForgeClientBoundary(FILE, src)).toEqual([]);
  });

  it('does NOT flag member access on an alias of a DIFFERENT module', () => {
    const src = [
      "import * as octokit from '@octokit/rest';",
      'octokit.fetchPRDiff();', // not client.ts — out of scope
    ].join('\n');

    expect(checkServerForgeClientBoundary(FILE, src)).toEqual([]);
  });

  it('resolves the client.ts path across relative depths (./, ../, ../../)', () => {
    for (const spec of ['./client.js', '../github/client.js', '../../github/client.js']) {
      const src = `import * as gh from '${spec}';\ngh.postComment();`;
      expect(checkServerForgeClientBoundary(FILE, src)).toHaveLength(1);
    }
  });

  it('IGNORES a clean file (only allowed fns + unrelated imports)', () => {
    const src = [
      "import * as gh from '../github/client.js';",
      "import { z } from 'zod';",
      'const t = await gh.getInstallationToken(id);',
      'const ad = makeGitHubAdapter({ owner, repo, token: t });',
    ].join('\n');

    expect(checkServerForgeClientBoundary(FILE, src)).toEqual([]);
  });

  it('ignores banned fn names inside comments (stripComments)', () => {
    const src = [
      "import * as gh from '../github/client.js';",
      '// gh.fetchPRDiff() would be illegal here',
      '/* gh.postComment() also illegal */',
      'gh.getInstallationToken(id);',
    ].join('\n');

    expect(checkServerForgeClientBoundary(FILE, src)).toEqual([]);
  });
});
