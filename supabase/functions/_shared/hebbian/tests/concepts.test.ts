/**
 * Tests for concept extraction utilities
 */

import {
  assertEquals,
  assertArrayIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  extractConcepts,
  extractConceptsWithScores,
  extractConceptsFromMultiple,
  getAvailableConcepts,
} from '../concepts.ts';

Deno.test('extractConcepts - should identify security concepts', () => {
  const content = `
    function authenticate(password: string) {
      const token = generateToken();
      return encrypt(token);
    }
  `;
  const concepts = extractConcepts(content);

  assertArrayIncludes(concepts, ['security']);
});

Deno.test('extractConcepts - should identify database concepts', () => {
  const content = `
    const query = "SELECT * FROM users WHERE id = ?";
    const model = createSchema({ name: String });
  `;
  const concepts = extractConcepts(content);

  assertArrayIncludes(concepts, ['database']);
});

Deno.test('extractConcepts - should identify performance concepts', () => {
  const content = `
    async function batchProcess(items) {
      const cache = new Map();
      for await (const item of items) {
        await processItem(item);
      }
    }
  `;
  const concepts = extractConcepts(content);

  assertArrayIncludes(concepts, ['performance']);
  assertArrayIncludes(concepts, ['async']);
});

Deno.test('extractConcepts - should identify API concepts', () => {
  const content = `
    app.get('/api/users', async (request, response) => {
      const handler = new RequestHandler();
      return response.json({ data: users });
    });
  `;
  const concepts = extractConcepts(content);

  assertArrayIncludes(concepts, ['api']);
});

Deno.test('extractConcepts - should identify error handling concepts', () => {
  const content = `
    try {
      await riskyOperation();
    } catch (error) {
      throw new CustomException(error.message);
    }
  `;
  const concepts = extractConcepts(content);

  assertArrayIncludes(concepts, ['error']);
});

Deno.test('extractConcepts - should identify testing concepts', () => {
  const content = `
    describe('UserService', () => {
      it('should create user', () => {
        const mock = jest.fn();
        expect(service.create()).toBeDefined();
      });
    });
  `;
  const concepts = extractConcepts(content);

  assertArrayIncludes(concepts, ['testing']);
});

Deno.test('extractConcepts - should identify multiple concepts', () => {
  const content = `
    async function fetchUserData(token: string) {
      try {
        const response = await api.get('/users', { auth: token });
        const query = 'SELECT * FROM cache';
        return response.data;
      } catch (error) {
        logger.error('Failed to fetch', error);
        throw error;
      }
    }
  `;
  const concepts = extractConcepts(content);

  assertArrayIncludes(concepts, ['security']);
  assertArrayIncludes(concepts, ['api']);
  assertArrayIncludes(concepts, ['database']);
  assertArrayIncludes(concepts, ['error']);
  assertArrayIncludes(concepts, ['async']);
  assertArrayIncludes(concepts, ['logging']);
});

Deno.test('extractConcepts - should return empty array for unrelated content', () => {
  const content = 'Hello world, this is just plain text.';
  const concepts = extractConcepts(content);

  assertEquals(concepts.length, 0);
});

Deno.test('extractConceptsWithScores - should return scores based on frequency', () => {
  const content = `
    query query query
    SELECT INSERT UPDATE DELETE
    schema model table
  `;
  const result = extractConceptsWithScores(content);

  assertArrayIncludes(result.concepts, ['database']);
  assertEquals(result.scores['database'] > 0, true);
});

Deno.test('extractConceptsWithScores - higher frequency means higher score', () => {
  const lowFreq = 'query';
  const highFreq = 'query select insert model schema table index';

  const lowResult = extractConceptsWithScores(lowFreq);
  const highResult = extractConceptsWithScores(highFreq);

  assertEquals(
    highResult.scores['database'] > lowResult.scores['database'],
    true
  );
});

Deno.test('extractConceptsFromMultiple - should aggregate concepts from multiple sources', () => {
  const contents = [
    'function authenticate(password) {}',
    'const query = "SELECT * FROM users"',
    'try { } catch (error) { }',
  ];

  const result = extractConceptsFromMultiple(contents);

  assertArrayIncludes(result.concepts, ['security']);
  assertArrayIncludes(result.concepts, ['database']);
  assertArrayIncludes(result.concepts, ['error']);
});

Deno.test('extractConceptsFromMultiple - should average scores', () => {
  const contents = [
    'password password password', // High security score
    'hello world', // No security score
  ];

  const result = extractConceptsFromMultiple(contents);

  // Average should be less than single high score
  assertEquals(result.scores['security'] > 0, true);
  assertEquals(result.scores['security'] < 0.3, true);
});

Deno.test('getAvailableConcepts - should return all concept categories', () => {
  const concepts = getAvailableConcepts();

  assertArrayIncludes(concepts, ['security']);
  assertArrayIncludes(concepts, ['database']);
  assertArrayIncludes(concepts, ['performance']);
  assertArrayIncludes(concepts, ['api']);
  assertArrayIncludes(concepts, ['error']);
  assertArrayIncludes(concepts, ['testing']);
  assertArrayIncludes(concepts, ['typing']);
  assertArrayIncludes(concepts, ['async']);
  assertArrayIncludes(concepts, ['config']);
  assertArrayIncludes(concepts, ['logging']);
});
