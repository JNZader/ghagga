/**
 * Unit tests for SmartChunker
 *
 * Run with: deno test --allow-read
 */

import {
  assertEquals,
  assertExists,
  assert,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { SmartChunker, type Chunk, type ChunkConfig } from './chunker.ts';

Deno.test('SmartChunker - constructor uses default config', () => {
  const chunker = new SmartChunker();
  const config = chunker.getConfig();

  assertEquals(config.maxTokens, 400);
  assertEquals(config.overlapTokens, 80);
  assertEquals(config.charsPerToken, 4);
});

Deno.test('SmartChunker - constructor accepts partial config', () => {
  const chunker = new SmartChunker({ maxTokens: 200 });
  const config = chunker.getConfig();

  assertEquals(config.maxTokens, 200);
  assertEquals(config.overlapTokens, 80);
  assertEquals(config.charsPerToken, 4);
});

Deno.test('SmartChunker - chunk empty content returns empty array', () => {
  const chunker = new SmartChunker();

  assertEquals(chunker.chunk(''), []);
  assertEquals(chunker.chunk('   '), []);
});

Deno.test('SmartChunker - chunk small content returns single chunk', () => {
  const chunker = new SmartChunker();
  const content = 'Hello\nWorld';
  const chunks = chunker.chunk(content);

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].text, content);
  assertEquals(chunks[0].startLine, 1);
  assertEquals(chunks[0].endLine, 2);
  assertExists(chunks[0].hash);
  assert(chunks[0].tokenEstimate > 0);
});

Deno.test('SmartChunker - chunk respects line boundaries', () => {
  const chunker = new SmartChunker({ maxTokens: 10, charsPerToken: 4 }); // 40 chars max
  const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
  const chunks = chunker.chunk(content);

  assert(chunks.length >= 1);
  // Each chunk should contain complete lines (no partial lines)
  for (const chunk of chunks) {
    const lines = chunk.text.split('\n');
    for (const line of lines) {
      assert(
        line.startsWith('Line') || line === '',
        `Chunk contains partial line: "${line}"`
      );
    }
  }
});

Deno.test('SmartChunker - chunk creates overlap between chunks', () => {
  const chunker = new SmartChunker({
    maxTokens: 10,
    overlapTokens: 5,
    charsPerToken: 4,
  });

  // Create content that will require multiple chunks
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) {
    lines.push(`Line number ${i}`);
  }
  const content = lines.join('\n');
  const chunks = chunker.chunk(content);

  // With overlap, adjacent chunks should share some content
  if (chunks.length >= 2) {
    const firstChunkLines = chunks[0].text.split('\n');
    const secondChunkLines = chunks[1].text.split('\n');

    // The second chunk should start before where the first chunk ends
    assert(
      chunks[1].startLine <= chunks[0].endLine,
      'Adjacent chunks should have overlapping line ranges'
    );

    // Find common lines
    const commonLines = firstChunkLines.filter((line) =>
      secondChunkLines.includes(line)
    );
    assert(
      commonLines.length > 0,
      'Adjacent chunks should share some lines for context'
    );
  }
});

Deno.test('SmartChunker - chunk handles very long lines', () => {
  const chunker = new SmartChunker({ maxTokens: 50, charsPerToken: 4 }); // 200 chars max
  const longLine = 'x'.repeat(500);
  const chunks = chunker.chunk(longLine);

  assert(chunks.length >= 3, 'Long line should be split into multiple chunks');

  // All chunks should have the same line number (since it's one line)
  for (const chunk of chunks) {
    assertEquals(chunk.startLine, 1);
    assertEquals(chunk.endLine, 1);
  }

  // Reassembled content should equal original
  const reassembled = chunks.map((c) => c.text).join('');
  assertEquals(reassembled, longLine);
});

Deno.test('SmartChunker - hashText produces consistent hashes', () => {
  const chunker = new SmartChunker();
  const text = 'Hello World';

  const hash1 = chunker.hashText(text);
  const hash2 = chunker.hashText(text);

  assertEquals(hash1, hash2);
  assert(hash1.length >= 1);
});

Deno.test('SmartChunker - hashText produces different hashes for different text', () => {
  const chunker = new SmartChunker();

  const hash1 = chunker.hashText('Hello');
  const hash2 = chunker.hashText('World');

  assert(hash1 !== hash2, 'Different texts should have different hashes');
});

Deno.test('SmartChunker - estimateTokens calculates correctly', () => {
  const chunker = new SmartChunker({ charsPerToken: 4 });

  assertEquals(chunker.estimateTokens(''), 0);
  assertEquals(chunker.estimateTokens('1234'), 1);
  assertEquals(chunker.estimateTokens('12345'), 2);
  assertEquals(chunker.estimateTokens('12345678'), 2);
});

Deno.test('SmartChunker - chunkDiff empty diff returns empty array', () => {
  const chunker = new SmartChunker();

  assertEquals(chunker.chunkDiff(''), []);
  assertEquals(chunker.chunkDiff('   '), []);
});

Deno.test('SmartChunker - chunkDiff splits by file', () => {
  const chunker = new SmartChunker();
  const diff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
+added line
 existing line
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1,2 +1,3 @@
+another added line
 another existing line`;

  const chunks = chunker.chunkDiff(diff);

  assert(chunks.length >= 1, 'Should create at least one chunk');

  // Verify that file headers are preserved
  const allText = chunks.map((c) => c.text).join('\n');
  assert(allText.includes('file1.ts'), 'Should contain file1.ts');
  assert(allText.includes('file2.ts'), 'Should contain file2.ts');
});

Deno.test('SmartChunker - chunkDiff handles single file diff', () => {
  const chunker = new SmartChunker();
  const diff = `diff --git a/single.ts b/single.ts
--- a/single.ts
+++ b/single.ts
@@ -1 +1,2 @@
+new line
 old line`;

  const chunks = chunker.chunkDiff(diff);

  assertEquals(chunks.length, 1);
  assert(chunks[0].text.includes('single.ts'));
});

Deno.test('SmartChunker - chunks have unique hashes for different content', () => {
  const chunker = new SmartChunker({ maxTokens: 10, charsPerToken: 4 });
  const content = 'Unique line A\nUnique line B\nUnique line C\nUnique line D\nUnique line E';
  const chunks = chunker.chunk(content);

  const hashes = chunks.map((c) => c.hash);
  const uniqueHashes = new Set(hashes);

  assertEquals(
    hashes.length,
    uniqueHashes.size,
    'Each chunk should have a unique hash'
  );
});

Deno.test('SmartChunker - line numbers are accurate', () => {
  const chunker = new SmartChunker();
  const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
  const chunks = chunker.chunk(content);

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].startLine, 1);
  assertEquals(chunks[0].endLine, 5);
});

Deno.test('SmartChunker - handles mixed content with empty lines', () => {
  const chunker = new SmartChunker();
  const content = 'Line 1\n\nLine 3\n\n\nLine 6';
  const chunks = chunker.chunk(content);

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].text, content);
  assertEquals(chunks[0].startLine, 1);
  assertEquals(chunks[0].endLine, 6);
});

Deno.test('SmartChunker - getConfig returns copy of config', () => {
  const chunker = new SmartChunker({ maxTokens: 500 });
  const config1 = chunker.getConfig();
  const config2 = chunker.getConfig();

  // Modify one config
  config1.maxTokens = 1000;

  // Other config and internal config should be unchanged
  assertEquals(config2.maxTokens, 500);
  assertEquals(chunker.getConfig().maxTokens, 500);
});
