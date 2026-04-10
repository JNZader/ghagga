import { describe, expect, it } from 'vitest';
import { classifyObservation, formatTaxonomyPrompt } from './taxonomy.js';

describe('classifyObservation', () => {
  it('classifies constraint observations', () => {
    const tag = classifyObservation(
      'This module cannot access the file system directly.',
      'File system restriction',
    );
    expect(tag.category).toBe('constraint');
    expect(tag.confidence).toBeGreaterThan(0.5);
  });

  it('classifies decision observations', () => {
    const tag = classifyObservation(
      'We decided to use JWT because of its stateless nature and the trade-off with session complexity.',
      'Auth decision',
    );
    expect(tag.category).toBe('decision');
  });

  it('classifies bug_pattern observations', () => {
    const tag = classifyObservation(
      'This function crashes when null is passed as the userId argument.',
      'Null crash bug',
    );
    expect(tag.category).toBe('bug_pattern');
  });

  it('classifies preference observations', () => {
    const tag = classifyObservation(
      'The team prefers async/await over callbacks for readability.',
      'Async preference',
    );
    expect(tag.category).toBe('preference');
  });

  it('classifies relationship observations', () => {
    const tag = classifyObservation(
      'UserService depends on AuthService for token validation.',
      'Service relationship',
    );
    expect(tag.category).toBe('relationship');
  });

  it('classifies skill observations', () => {
    const tag = classifyObservation(
      'The retry pattern used here wraps calls in an exponential backoff strategy.',
      'Retry pattern',
    );
    expect(tag.category).toBe('skill');
  });

  it('classifies fact observations', () => {
    const tag = classifyObservation(
      'The auth module uses JWT for token management and stores sessions in Redis.',
      'Auth uses JWT',
    );
    expect(tag.category).toBe('fact');
  });

  it('defaults to fact when no keywords match', () => {
    const tag = classifyObservation(
      'Some generic text without any classification keywords.',
      'Generic',
    );
    expect(tag.category).toBe('fact');
    expect(tag.confidence).toBeLessThan(0.5);
  });

  it('includes evidence text in the tag', () => {
    const tag = classifyObservation(
      'We must not use plaintext passwords anywhere in the codebase.',
      'Password constraint',
    );
    expect(tag.evidence).toBeTruthy();
    expect(typeof tag.evidence).toBe('string');
  });

  it('returns confidence between 0 and 1', () => {
    const inputs = [
      ['bug in the null check', 'Null bug'],
      ['prefer async patterns', 'Preference'],
      ['AuthService depends on TokenService', 'Relationship'],
      ['decided to use PostgreSQL', 'DB decision'],
    ] as [string, string][];

    for (const [content, title] of inputs) {
      const tag = classifyObservation(content, title);
      expect(tag.confidence).toBeGreaterThanOrEqual(0);
      expect(tag.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('boosts confidence when keyword appears in both title and content', () => {
    const bothTag = classifyObservation(
      'This cannot be done because of the constraint.',
      'Cannot use external API',
    );
    const contentOnlyTag = classifyObservation(
      'This cannot be done because of the constraint.',
      'System restriction',
    );
    // Both-match should have >= confidence than content-only
    expect(bothTag.confidence).toBeGreaterThanOrEqual(contentOnlyTag.confidence);
  });
});

describe('formatTaxonomyPrompt', () => {
  it('returns empty string for empty tags', () => {
    expect(formatTaxonomyPrompt([])).toBe('');
  });

  it('formats a single tag', () => {
    const output = formatTaxonomyPrompt([
      { category: 'preference', confidence: 0.85, evidence: 'prefer' },
    ]);
    expect(output).toContain('PREFERENCE');
    expect(output).toContain('85%');
    expect(output).toContain('prefer');
  });

  it('formats multiple tags', () => {
    const output = formatTaxonomyPrompt([
      { category: 'bug_pattern', confidence: 0.9, evidence: 'null' },
      { category: 'decision', confidence: 0.75, evidence: 'decided' },
    ]);
    expect(output).toContain('BUG PATTERN');
    expect(output).toContain('DECISION');
  });

  it('includes the Memory Classification header', () => {
    const output = formatTaxonomyPrompt([{ category: 'fact', confidence: 0.5, evidence: 'uses' }]);
    expect(output).toContain('Memory Classification');
  });
});
