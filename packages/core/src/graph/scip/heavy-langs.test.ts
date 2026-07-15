/**
 * Unit tests for buildGraphFromScip() against the Tier C/D fixtures
 * (Java+Kotlin, C#, PHP) — mirrors mature-langs.test.ts's coverage,
 * proving the mapper is language-agnostic across the "heavy"/"experimental"
 * maturity indexers too.
 *
 * Each fixture is a real captured `index.scip`, produced by running the
 * real indexer against a tiny sample with one cross-file (Java+Kotlin:
 * cross-LANGUAGE, same indexer) reference — see
 * test/fixtures/scip-<lang>-sample/.
 *
 * Toolchain bring-up notes (for whoever re-captures these):
 * - scip-java: needs `coursier` (`brew install coursier`) + a Gradle build
 *   (`brew install gradle`). The Kotlin Gradle plugin version MUST match
 *   scip-java's bundled `kotlin-compiler-embeddable` (2.2.0 at capture
 *   time) — a mismatched Kotlin compiler plugin ABI throws
 *   `AbstractMethodError` on `FirDeclarationChecker.check`. The Gradle
 *   *host* JVM must also be JDK 21, not JDK 25+ — running the Kotlin
 *   compiler daemon under a JDK 25 host JVM crashes in
 *   `CoreJrtFileSystem` regardless of the toolchain target version.
 * - scip-dotnet: `dotnet tool install --global scip-dotnet` installs
 *   cleanly, but needs `DOTNET_ROOT` set explicitly when the `dotnet` CLI
 *   itself is a Homebrew (non-standard-path) install — the apphost can't
 *   find the runtime otherwise ("You must install .NET to run this
 *   application"). Exclude `obj/`/`bin/` build-artifact dirs via
 *   `--exclude` or they leak MSBuild-generated `.cs` files into the index.
 * - scip-php (davidrjenni/scip-php): the latest *tagged* release (v0.0.2)
 *   lacks a fallback for running as a project's own `--dev` dependency
 *   (its vendor-dir resolution only supports being indexed as a
 *   standalone checkout) — this throws
 *   "Invalid scip-php vendor directory" immediately. `dev-main` fixes
 *   this. Separately: scip-php's own PSR-4 classmap resolution is
 *   case-sensitive — a file at `src/pkg/Greeting.php` under namespace
 *   `Foo\Pkg\Greeting` is silently EXCLUDED from indexing (0 documents)
 *   unless the directory is capitalized `src/Pkg/Greeting.php` to match
 *   the namespace segment exactly. Also: scip-php's own generated PHP
 *   protobuf bindings serialize `Document.language` as the numeric
 *   `Language` enum value rather than the canonical SCIP string per the
 *   proto's `scip.proto` field type (`string language = 4`) — decoded
 *   client-side this makes `doc.language` an unrecognized value, but the
 *   mapper's `?? detectLanguage(relativePath)` fallback (by file
 *   extension) already covers this, so it never mismaps in practice.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraphFromScip, parseScipIndex } from './builder.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures');

function loadFixtureIndex(name: string) {
  const bytes = readFileSync(join(FIXTURES_DIR, name, 'index.scip'));
  return parseScipIndex(bytes);
}

describe('buildGraphFromScip — Java + Kotlin (scip-java fixture, shared indexer)', () => {
  it('parses the real scip-java fixture into an Index with 2 documents (1 Java, 1 Kotlin)', () => {
    const index = loadFixtureIndex('scip-java-sample');
    expect(index.documents).toHaveLength(2);
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual([
      'src/main/java/com/example/Main.java',
      'src/main/kotlin/com/example/Greeting.kt',
    ]);
  });

  it('resolves the CROSS-LANGUAGE reference: Main.java (Java) references Greeting.kt (Kotlin)', () => {
    const index = loadFixtureIndex('scip-java-sample');
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['src/main/java/com/example/Main.java'];
    expect(mainNode).toBeDefined();
    expect(mainNode?.language).toBe('java');
    expect(mainNode?.imports).toContain('src/main/kotlin/com/example/Greeting.kt');
  });

  it('Greeting.kt is mapped as kotlin and exports greet', () => {
    const index = loadFixtureIndex('scip-java-sample');
    const graph = buildGraphFromScip(index);

    const greetingNode = graph.nodes['src/main/kotlin/com/example/Greeting.kt'];
    expect(greetingNode).toBeDefined();
    expect(greetingNode?.language).toBe('kotlin');
    expect(greetingNode?.exports.some((e) => e.includes('greet'))).toBe(true);
  });
});

describe('buildGraphFromScip — C# (scip-dotnet fixture)', () => {
  it('parses the real scip-dotnet fixture into an Index with 2 documents', () => {
    const index = loadFixtureIndex('scip-csharp-sample');
    expect(index.documents).toHaveLength(2);
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['Main.cs', 'pkg/Greeting.cs']);
  });

  it('resolves the cross-file reference: Main.cs calls pkg/Greeting.cs', () => {
    const index = loadFixtureIndex('scip-csharp-sample');
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['Main.cs'];
    expect(mainNode).toBeDefined();
    expect(mainNode?.language).toBe('csharp');
    expect(mainNode?.imports).toContain('pkg/Greeting.cs');
  });

  it('pkg/Greeting.cs exports Greet', () => {
    const index = loadFixtureIndex('scip-csharp-sample');
    const graph = buildGraphFromScip(index);

    const greetingNode = graph.nodes['pkg/Greeting.cs'];
    expect(greetingNode).toBeDefined();
    expect(greetingNode?.exports.some((e) => e.includes('Greet'))).toBe(true);
  });
});

describe('buildGraphFromScip — PHP (scip-php fixture)', () => {
  it('parses the real scip-php fixture into an Index with 2 documents', () => {
    const index = loadFixtureIndex('scip-php-sample');
    expect(index.documents).toHaveLength(2);
    const paths = index.documents.map((d) => d.relativePath).sort();
    expect(paths).toEqual(['src/Main.php', 'src/Pkg/Greeting.php']);
  });

  it('resolves the cross-file reference: src/Main.php references src/Pkg/Greeting.php', () => {
    const index = loadFixtureIndex('scip-php-sample');
    const graph = buildGraphFromScip(index);

    const mainNode = graph.nodes['src/Main.php'];
    expect(mainNode).toBeDefined();
    // scip-php's own generated bindings mis-serialize Document.language as
    // the numeric Language enum value (see file header note); the mapper's
    // extension-based fallback still correctly maps this to 'php'.
    expect(mainNode?.language).toBe('php');
    expect(mainNode?.imports).toContain('src/Pkg/Greeting.php');
  });

  it('src/Pkg/Greeting.php exports greet', () => {
    const index = loadFixtureIndex('scip-php-sample');
    const graph = buildGraphFromScip(index);

    const greetingNode = graph.nodes['src/Pkg/Greeting.php'];
    expect(greetingNode).toBeDefined();
    expect(greetingNode?.exports.some((e) => e.includes('greet'))).toBe(true);
  });
});
