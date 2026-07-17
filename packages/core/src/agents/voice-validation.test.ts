import { describe, expect, it } from 'vitest';

import { getDeadVoiceReason } from './voice-validation.js';

describe('getDeadVoiceReason', () => {
  // ── Dead voices ──

  it('flags empty text', () => {
    expect(getDeadVoiceReason('')).toContain('empty response text');
  });

  it('flags whitespace-only text', () => {
    expect(getDeadVoiceReason('   \n\t  ')).toContain('empty response text');
  });

  it('flags a full-body JSON object with is_error: true', () => {
    const envelope = JSON.stringify({ is_error: true, result: 'something went wrong' });
    expect(getDeadVoiceReason(envelope)).toContain('is_error: true');
  });

  it('flags the Claude CLI error envelope (type: result + subtype: error_*)', () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      duration_ms: 123,
    });
    expect(getDeadVoiceReason(envelope)).not.toBeNull();
  });

  it('flags type result + error subtype even without is_error', () => {
    const envelope = JSON.stringify({ type: 'result', subtype: 'error_during_execution' });
    expect(getDeadVoiceReason(envelope)).toContain('error_during_execution');
  });

  it('flags an envelope surrounded by whitespace', () => {
    const envelope = `\n  ${JSON.stringify({ is_error: true })}  \n`;
    expect(getDeadVoiceReason(envelope)).not.toBeNull();
  });

  // ── Legitimate reviews (never rejected) ──

  it('accepts a normal review that contains the word "error"', () => {
    const review =
      'STATUS: FAILED\nSUMMARY: Missing error handling in parser.\nFINDINGS:\n- error path is not covered';
    expect(getDeadVoiceReason(review)).toBeNull();
  });

  it('accepts a review that embeds an error-envelope JSON snippet inside prose', () => {
    const review = `The gateway may return {"type":"result","subtype":"error_max_turns","is_error":true} — handle it.`;
    expect(getDeadVoiceReason(review)).toBeNull();
  });

  it('accepts a full-body JSON object without error markers', () => {
    expect(getDeadVoiceReason(JSON.stringify({ status: 'PASSED', findings: [] }))).toBeNull();
  });

  it('accepts a JSON object with type result and a non-error subtype', () => {
    expect(getDeadVoiceReason(JSON.stringify({ type: 'result', subtype: 'success' }))).toBeNull();
  });

  it('accepts a JSON object with is_error: false', () => {
    expect(getDeadVoiceReason(JSON.stringify({ is_error: false, result: 'ok' }))).toBeNull();
  });

  it('accepts text that looks like JSON but is invalid', () => {
    expect(getDeadVoiceReason('{ this is not valid JSON, despite braces }')).toBeNull();
  });

  it('accepts a JSON array body', () => {
    // Arrays start with [ so the brace gate skips them; verify explicitly anyway.
    expect(getDeadVoiceReason('[{"is_error": true}]')).toBeNull();
  });
});
