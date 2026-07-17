import { describe, expect, it } from 'vitest';
import { deduceRouteFromLabels, extractRouteFromIssueBody } from './route.js';

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

describe('deduceRouteFromLabels', () => {
  it('deduces /app/<module> from a módulo:: label via the heuristic', () => {
    expect(deduceRouteFromLabels(['bug', 'módulo::checklists'])).toBe('/app/checklists');
  });

  it('prefers a moduleRoutes override over the /app/<module> heuristic', () => {
    expect(deduceRouteFromLabels(['módulo::equipos'], { equipos: '/app/tanques' })).toBe(
      '/app/tanques',
    );
  });

  it('falls back to the heuristic for modules absent from moduleRoutes', () => {
    expect(deduceRouteFromLabels(['módulo::compliance'], { equipos: '/app/tanques' })).toBe(
      '/app/compliance',
    );
  });

  it('accepts the non-accented "modulo::" spelling', () => {
    expect(deduceRouteFromLabels(['modulo::configuracion-planta'])).toBe(
      '/app/configuracion-planta',
    );
  });

  it('returns null when no módulo:: label is present', () => {
    expect(deduceRouteFromLabels(['bug', 'prioridad::alta'])).toBeNull();
  });

  it('returns null for an empty label list', () => {
    expect(deduceRouteFromLabels([])).toBeNull();
  });
});
