import { describe, expect, it } from 'vitest';
import { checkForgeBoundary } from './lint-boundary.js';

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
