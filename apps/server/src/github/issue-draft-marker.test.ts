/**
 * Tests for the issue-draft correlation marker helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  appendIssueDraftMarker,
  buildIssueDraftMarker,
  commentHasIssueDraftMarker,
} from './issue-draft-marker.js';

describe('issue-draft-marker', () => {
  it('builds the exact per-draft marker format', () => {
    expect(buildIssueDraftMarker(123)).toBe('<!-- ghagga-issue-draft:123 -->');
  });

  it('appends the marker on a trailing blank line without mutating the body', () => {
    const body = 'This is the analysis.';
    const out = appendIssueDraftMarker(body, 42);
    expect(out).toBe('This is the analysis.\n\n<!-- ghagga-issue-draft:42 -->');
    // input untouched
    expect(body).toBe('This is the analysis.');
  });

  it('round-trips build → append → detect for the same id', () => {
    const posted = appendIssueDraftMarker('body', 7);
    expect(commentHasIssueDraftMarker(posted, 7)).toBe(true);
  });

  it('does NOT match a different draft id', () => {
    const posted = appendIssueDraftMarker('body', 7);
    expect(commentHasIssueDraftMarker(posted, 8)).toBe(false);
    // and a prefix/suffix id must not partial-match (the ` -->` bounds the id)
    const posted12 = appendIssueDraftMarker('body', 12);
    expect(commentHasIssueDraftMarker(posted12, 1)).toBe(false);
    expect(commentHasIssueDraftMarker(posted12, 2)).toBe(false);
    expect(commentHasIssueDraftMarker(posted12, 123)).toBe(false);
    expect(commentHasIssueDraftMarker(posted12, 12)).toBe(true);
  });

  it('returns false when no marker is present', () => {
    expect(commentHasIssueDraftMarker('just a normal comment', 7)).toBe(false);
  });
});
