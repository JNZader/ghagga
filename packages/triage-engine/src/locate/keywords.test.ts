import { describe, expect, it } from 'vitest';
import { extractKeywords } from './keywords.js';

describe('extractKeywords', () => {
  it('drops configured stopwords', () => {
    const result = extractKeywords({
      title: 'el sistema de alertas',
      body: 'con el modulo de alertas hay un problema',
      stopwords: ['el', 'de', 'con', 'un', 'hay'],
    });
    expect(result).not.toContain('el');
    expect(result).not.toContain('de');
    expect(result).not.toContain('con');
  });

  it('applies ES->EN synonym bridge', () => {
    const result = extractKeywords({
      title: 'no anda el umbral de ph',
      body: '',
      synonyms: { umbral: ['threshold', 'limit'] },
    });
    expect(result).toContain('umbral');
    expect(result).toContain('threshold');
    expect(result).toContain('limit');
  });

  it('keeps the module label even when short', () => {
    const result = extractKeywords({ title: 'algo', body: 'algo', moduleLabel: 'ph' });
    expect(result).toContain('ph');
  });

  it('normalizes accents for stopword matching', () => {
    const result = extractKeywords({
      title: 'módulo de alertas',
      body: '',
      stopwords: ['modulo', 'de'],
    });
    // 'módulo' normalizes to 'modulo' which is stopworded
    expect(result).not.toContain('módulo');
    expect(result).not.toContain('modulo');
  });

  it('drops short non-module tokens (<4 chars)', () => {
    const result = extractKeywords({ title: 'yo no se que es', body: '', stopwords: [] });
    expect(result).not.toContain('yo');
    expect(result).not.toContain('no');
    expect(result).not.toContain('se');
    expect(result).not.toContain('es');
  });

  it('is a pure function returning a deduplicated array', () => {
    const result = extractKeywords({ title: 'alerta alerta alerta', body: '', stopwords: [] });
    expect(result.filter((k) => k === 'alerta')).toHaveLength(1);
  });

  it('returns [] for empty input with no module label', () => {
    expect(extractKeywords({ title: '', body: '' })).toEqual([]);
  });
});
