import { describe, expect, it } from 'vitest';
import type { ObservationForContext } from './context.js';
import { formatMemoryContext } from './context.js';

describe('formatMemoryContext', () => {
  it('returns empty string for empty observations array', () => {
    expect(formatMemoryContext([])).toBe('');
  });

  it('formats single observation with type/title/content', () => {
    const observations: ObservationForContext[] = [
      {
        type: 'pattern',
        title: 'Uses barrel exports',
        content: 'This project uses barrel exports in index.ts files.',
      },
    ];

    const result = formatMemoryContext(observations);

    expect(result).toContain('### [PATTERN] Uses barrel exports');
    expect(result).toContain('This project uses barrel exports in index.ts files.');
  });

  it('formats multiple observations', () => {
    const observations: ObservationForContext[] = [
      {
        type: 'pattern',
        title: 'Barrel exports',
        content: 'Uses barrel exports.',
      },
      {
        type: 'decision',
        title: 'No default exports',
        content: 'Team decided against default exports.',
      },
      {
        type: 'bugfix',
        title: 'Race condition fix',
        content: 'Fixed async race condition in data loader.',
      },
    ];

    const result = formatMemoryContext(observations);

    expect(result).toContain('### [PATTERN] Barrel exports');
    expect(result).toContain('### [DECISION] No default exports');
    expect(result).toContain('### [BUGFIX] Race condition fix');
  });

  it('includes "Past Review Memory" header', () => {
    const observations: ObservationForContext[] = [
      { type: 'learning', title: 'Test', content: 'Content' },
    ];

    const result = formatMemoryContext(observations);
    expect(result).toContain('## Past Review Memory');
  });

  it('includes the guidance footer', () => {
    const observations: ObservationForContext[] = [
      { type: 'learning', title: 'Test', content: 'Content' },
    ];

    const result = formatMemoryContext(observations);
    expect(result).toContain(
      'Use these past observations to give more informed, context-aware reviews.',
    );
    expect(result).toContain(
      'Do not repeat findings that match these known patterns unless the issue persists.',
    );
  });

  it('uppercases the observation type', () => {
    const observations: ObservationForContext[] = [
      { type: 'architecture', title: 'Hexagonal', content: 'Uses hexagonal architecture.' },
    ];

    const result = formatMemoryContext(observations);
    expect(result).toContain('[ARCHITECTURE]');
    // Ensure lowercase version is NOT used as the label
    expect(result).not.toContain('[architecture]');
  });

  it('includes strength percentage when strength is present', () => {
    const observations: ObservationForContext[] = [
      { type: 'pattern', title: 'Auth pattern', content: 'JWT validation.', strength: 0.75 },
    ];

    const result = formatMemoryContext(observations);
    expect(result).toContain('(strength: 75%)');
    expect(result).toContain('### [PATTERN] Auth pattern (strength: 75%)');
  });

  it('omits strength label when strength is undefined', () => {
    const observations: ObservationForContext[] = [
      { type: 'pattern', title: 'Auth pattern', content: 'JWT validation.' },
    ];

    const result = formatMemoryContext(observations);
    expect(result).toContain('### [PATTERN] Auth pattern');
    expect(result).not.toContain('strength');
  });

  it('shows 100% for full strength observations', () => {
    const observations: ObservationForContext[] = [
      { type: 'bugfix', title: 'Fix', content: 'Fixed.', strength: 1.0 },
    ];

    const result = formatMemoryContext(observations);
    expect(result).toContain('(strength: 100%)');
  });
});
