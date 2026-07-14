import { describe, expect, it } from 'vitest';
import type { ReproEvidence } from '../types/evidence.js';
import { formatReproEvidence } from './evidence-format.js';

describe('formatReproEvidence', () => {
  it('returns null when evidence is absent (null/undefined)', () => {
    expect(formatReproEvidence(null)).toBeNull();
    expect(formatReproEvidence(undefined)).toBeNull();
  });

  it('represents a non-reproduction honestly, not as an error', () => {
    const evidence: ReproEvidence = {
      reproduced: false,
      steps: ['clicked pH row edit', 'entered value 7.2', 'clicked Guardar'],
      consoleErrors: [],
      netFails: [],
      uiErrors: [],
    };
    const text = formatReproEvidence(evidence);
    expect(text).not.toBeNull();
    expect(text).toMatch(/did not reproduce|no reproduc/i);
    expect(text).toContain('clicked pH row edit');
    // Must NOT read as an error/failure of the reproduction attempt itself.
    expect(text?.toLowerCase()).not.toContain('reproduction failed');
  });

  it('includes console errors, network failures, and UI errors when reproduced', () => {
    const evidence: ReproEvidence = {
      reproduced: true,
      steps: ['clicked pH row edit', 'entered value 999'],
      consoleErrors: ['TypeError: cannot read property "value" of undefined'],
      netFails: [{ url: '/api/ph', status: 500, method: 'POST', body: '{"error":"out of range"}' }],
      uiErrors: ['Valor fuera de rango'],
      screenshotRef: 'shots/ph-999.png',
    };
    const text = formatReproEvidence(evidence);
    expect(text).toContain('TypeError: cannot read property');
    expect(text).toContain('POST');
    expect(text).toContain('/api/ph');
    expect(text).toContain('500');
    expect(text).toContain('Valor fuera de rango');
    expect(text).toContain('shots/ph-999.png');
    expect(text).toMatch(/reproduced|success/i);
  });

  it('omits empty sections rather than emitting empty headers', () => {
    const evidence: ReproEvidence = {
      reproduced: true,
      steps: [],
      consoleErrors: ['boom'],
      netFails: [],
      uiErrors: [],
    };
    const text = formatReproEvidence(evidence) ?? '';
    expect(text).not.toMatch(/Steps taken:\s*$/m);
    expect(text).not.toContain('Network failures:');
    expect(text).not.toContain('On-screen error text:');
  });
});
