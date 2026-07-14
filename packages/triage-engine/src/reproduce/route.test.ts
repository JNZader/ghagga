import { describe, expect, it } from 'vitest';
import { extractRouteFromIssueBody } from './route.js';

describe('extractRouteFromIssueBody', () => {
  it('extracts the plain widget line: "Módulo: X · Ruta: /app/alertas"', () => {
    const body = 'Algo se rompió.\n\nMódulo: Alertas · Ruta: /app/alertas';
    expect(extractRouteFromIssueBody(body)).toBe('/app/alertas');
  });

  it('extracts the markdown variant: "- Ruta: `/app/alertas`"', () => {
    const body = [
      'Something is broken.',
      '',
      '- Módulo: `alertas`',
      '- Ruta: `/app/alertas`',
      '',
    ].join('\n');
    expect(extractRouteFromIssueBody(body)).toBe('/app/alertas');
  });

  it('extracts a route with query params and trailing hash segments', () => {
    const body = '- Ruta: `/app/tanques?filtro=activo#detalle`';
    expect(extractRouteFromIssueBody(body)).toBe('/app/tanques?filtro=activo#detalle');
  });

  it('returns null when the body has no Ruta: line', () => {
    const body = 'Just a plain bug report with no widget metadata at all.';
    expect(extractRouteFromIssueBody(body)).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(extractRouteFromIssueBody('')).toBeNull();
  });

  it('accepts a custom pattern override', () => {
    const body = 'Path: /custom/path';
    expect(extractRouteFromIssueBody(body, /Path:\s*(\S+)/i)).toBe('/custom/path');
  });

  it('is case-insensitive on the "Ruta:" label', () => {
    const body = 'ruta: /app/lowercase';
    expect(extractRouteFromIssueBody(body)).toBe('/app/lowercase');
  });
});
