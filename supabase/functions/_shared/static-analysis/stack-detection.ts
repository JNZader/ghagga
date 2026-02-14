/**
 * Stack Detection (in-process)
 *
 * Detects the project's technology stack from filenames in the PR.
 * Provides stack-specific context hints for the LLM reviewer.
 * Runs entirely in-process (~1ms).
 */

import type { DetectedStack } from './types.ts';

/** Stack detection rules in priority order */
const STACK_RULES: Array<{
  files: string[];
  lockFiles?: Record<string, DetectedStack>;
  stack: DetectedStack;
}> = [
  {
    files: ['build.gradle', 'build.gradle.kts'],
    stack: 'java-gradle',
  },
  {
    files: ['pom.xml'],
    stack: 'java-maven',
  },
  {
    files: ['package.json'],
    lockFiles: {
      'yarn.lock': 'node-yarn',
      'pnpm-lock.yaml': 'node-pnpm',
    },
    stack: 'node-npm', // Default if no lock file matches
  },
  {
    files: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    stack: 'python',
  },
  {
    files: ['go.mod'],
    stack: 'go',
  },
  {
    files: ['Cargo.toml'],
    stack: 'rust',
  },
];

/**
 * Detect the project stack from a list of filenames in the PR.
 *
 * Priority: gradle > maven > node > python > go > rust > unknown
 */
export function detectStack(filenames: string[]): DetectedStack {
  // Extract just the base filenames for matching
  const basenameSet = new Set(filenames.map((f) => {
    const parts = f.split('/');
    return parts[parts.length - 1];
  }));

  // Also keep full paths for matching
  const fullPathSet = new Set(filenames);

  for (const rule of STACK_RULES) {
    const hasMatch = rule.files.some(
      (f) => basenameSet.has(f) || fullPathSet.has(f)
    );

    if (hasMatch) {
      // Check for lock file variants (e.g., node package managers)
      if (rule.lockFiles) {
        for (const [lockFile, stack] of Object.entries(rule.lockFiles)) {
          if (basenameSet.has(lockFile) || fullPathSet.has(lockFile)) {
            return stack;
          }
        }
      }
      return rule.stack;
    }
  }

  return 'unknown';
}

/** Stack-specific context hints for the LLM */
const STACK_CONTEXT: Record<DetectedStack, string> = {
  'java-gradle': `Stack: Java/Kotlin (Gradle)
- Check for proper null handling (use Optional, @Nullable/@NonNull)
- Verify Gradle task configuration and dependency management
- Look for Spring Boot best practices if applicable
- Check serialization safety (Jackson, Gson)`,

  'java-maven': `Stack: Java/Kotlin (Maven)
- Check for proper null handling (use Optional, @Nullable/@NonNull)
- Verify Maven dependency scope and version management
- Look for Spring Boot best practices if applicable
- Check serialization safety (Jackson, Gson)`,

  'node-npm': `Stack: Node.js (npm)
- Check for proper async/await error handling
- Verify no callback hell or unhandled promise rejections
- Look for proper input validation (especially in Express/Fastify routes)
- Check for proper dependency management (exact versions preferred)`,

  'node-yarn': `Stack: Node.js (Yarn)
- Check for proper async/await error handling
- Verify no callback hell or unhandled promise rejections
- Look for proper input validation (especially in Express/Fastify routes)
- Ensure yarn.lock is committed and up to date`,

  'node-pnpm': `Stack: Node.js (pnpm)
- Check for proper async/await error handling
- Verify no callback hell or unhandled promise rejections
- Look for proper input validation
- Ensure pnpm-lock.yaml is committed`,

  'python': `Stack: Python
- Check for proper type hints and type safety
- Verify exception handling (avoid bare except)
- Look for proper resource management (context managers, with statements)
- Check for f-string injection risks in SQL/shell commands`,

  'go': `Stack: Go
- Check for proper error handling (don't ignore returned errors)
- Verify goroutine safety (race conditions, proper synchronization)
- Look for proper resource cleanup (defer statements)
- Check for proper context propagation`,

  'rust': `Stack: Rust
- Check for proper error handling (Result, ? operator)
- Review any unsafe blocks carefully
- Verify proper ownership and borrowing patterns
- Look for potential panics (unwrap, expect)`,

  'unknown': `Stack: Unknown
- Apply general code review best practices
- Focus on logic errors, security, and error handling`,
};

/**
 * Get stack-specific context hints for the LLM reviewer.
 */
export function getStackContext(stack: DetectedStack): string {
  return STACK_CONTEXT[stack];
}
