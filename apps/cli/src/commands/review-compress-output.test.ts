/**
 * Unit tests for the output style calibration CLI seam
 * (review-output-compression T1.5): `resolveCompressOutputEnabled`, the
 * default-ON sibling of `resolveGraphContextEnabled`.
 *
 * Precedence matrix (flag beats config beats default-ON). No network, no
 * filesystem — unlike graph-context there is no graph to probe, so the
 * resolver is pure.
 */

import { describe, expect, it } from 'vitest';
import { resolveCompressOutputEnabled } from './review.js';

describe('resolveCompressOutputEnabled', () => {
  it('defaults ON when neither flag nor config says otherwise', () => {
    expect(resolveCompressOutputEnabled({}, {})).toBe(true);
  });

  it('explicit flag true stays ON', () => {
    expect(resolveCompressOutputEnabled({ compressOutput: true }, {})).toBe(true);
  });

  it('.ghagga.json compressOutput: true stays ON', () => {
    expect(resolveCompressOutputEnabled({}, { compressOutput: true })).toBe(true);
  });

  it('--no-compress-output (compressOutput: false) turns it OFF', () => {
    expect(resolveCompressOutputEnabled({ compressOutput: false }, {})).toBe(false);
  });

  it('.ghagga.json compressOutput: false turns it OFF', () => {
    expect(resolveCompressOutputEnabled({}, { compressOutput: false })).toBe(false);
  });

  it('flag beats config: --no-compress-output wins over compressOutput: true', () => {
    expect(resolveCompressOutputEnabled({ compressOutput: false }, { compressOutput: true })).toBe(
      false,
    );
  });

  it('a merely-true flag does NOT override config OFF (only false is meaningful for a negated option)', () => {
    expect(resolveCompressOutputEnabled({ compressOutput: true }, { compressOutput: false })).toBe(
      false,
    );
  });
});
