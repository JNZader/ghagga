import { describe, expect, it } from 'vitest';
import { parseAction } from './parse-action.js';

describe('parseAction', () => {
  it('parses a bare JSON action object', () => {
    expect(parseAction('{"action":"click","role":"button","name":"Guardar"}')).toEqual({
      action: 'click',
      role: 'button',
      name: 'Guardar',
    });
  });

  it('extracts JSON embedded in surrounding prose (LLM chatter)', () => {
    const raw =
      'Sure, here is the action:\n{"action":"fill","role":"textbox","value":"99"}\nHope that helps!';
    expect(parseAction(raw)).toEqual({ action: 'fill', role: 'textbox', value: '99' });
  });

  it('parses a done action', () => {
    expect(parseAction('{"action":"done"}')).toEqual({ action: 'done' });
  });

  it('parses near-scoped row targeting', () => {
    expect(parseAction('{"action":"click","role":"button","near":"pH"}')).toEqual({
      action: 'click',
      role: 'button',
      near: 'pH',
    });
  });

  it('returns null when no JSON object is present', () => {
    expect(parseAction('no idea sorry')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseAction('{"action":"click", oops}')).toBeNull();
  });

  it('returns null when the parsed object has no action field', () => {
    expect(parseAction('{"role":"button"}')).toBeNull();
  });

  it('returns null when there are only brackets, no braces (array reply)', () => {
    expect(parseAction('[1,2,3]')).toBeNull();
  });
});
