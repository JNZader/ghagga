/**
 * Workflow step definitions for code review process
 *
 * Each step represents a specialized analysis phase with its own agent prompt.
 * Steps can be executed in parallel (1-5) with a final synthesis step.
 */

/**
 * Defines a single step in the workflow
 */
export interface WorkflowStepDefinition {
  id: string;
  name: string;
  description: string;
  agentPrompt: string;
  requiredActions: string[];
}

/**
 * Result from executing a single workflow step
 */
export interface StepResult {
  stepId: string;
  stepName: string;
  findings: string;
  status: 'success' | 'failed' | 'skipped';
  duration_ms: number;
  error?: string;
}

/**
 * CODE_REVIEW_WORKFLOW defines the standard code review process.
 *
 * Steps 1-5 (scope, standards, errors, security, performance) run in parallel.
 * Step 6 (synthesis) runs after all parallel steps complete and combines findings.
 */
export const CODE_REVIEW_WORKFLOW: WorkflowStepDefinition[] = [
  {
    id: 'scope',
    name: 'Scope Analysis',
    description: 'Analyzes the scope and impact of code changes',
    agentPrompt: `You analyze code scope. Identify what files are changed, affected modules, and dependencies.

Your task is to:
1. List all modified files and their purposes
2. Identify which modules/components are affected
3. Map out dependencies that might be impacted
4. Assess the overall scope (small, medium, large)

Output format:
- Changed Files: [list files with brief descriptions]
- Affected Modules: [list modules]
- Dependencies: [list impacted dependencies]
- Scope Assessment: [small/medium/large with reasoning]`,
    requiredActions: ['identify_files', 'map_dependencies', 'assess_scope'],
  },
  {
    id: 'standards',
    name: 'Coding Standards',
    description: 'Enforces coding standards and style guidelines',
    agentPrompt: `You enforce coding standards. Check naming conventions, formatting, and DRY violations.

Your task is to:
1. Check naming conventions (variables, functions, classes)
2. Verify code formatting and consistency
3. Identify DRY (Don't Repeat Yourself) violations
4. Check for proper documentation/comments
5. Verify import organization

Output format:
- Naming Issues: [list any naming convention violations]
- Formatting Issues: [list formatting problems]
- DRY Violations: [list duplicated code/logic]
- Documentation: [note missing or poor documentation]
- Recommendations: [specific suggestions for improvement]`,
    requiredActions: ['check_naming', 'verify_formatting', 'identify_dry_violations'],
  },
  {
    id: 'errors',
    name: 'Error Handling',
    description: 'Reviews defensive programming and error handling',
    agentPrompt: `You are a defensive programming expert. Check null handling, edge cases, and error messages.

Your task is to:
1. Check for proper null/undefined handling
2. Identify missing edge case handling
3. Review error messages for clarity and usefulness
4. Check try/catch usage and error propagation
5. Verify input validation

Output format:
- Null Safety Issues: [list potential null/undefined problems]
- Edge Cases: [list unhandled edge cases]
- Error Messages: [review of error message quality]
- Exception Handling: [issues with try/catch or error propagation]
- Input Validation: [missing or weak validation]`,
    requiredActions: ['check_null_safety', 'identify_edge_cases', 'review_error_handling'],
  },
  {
    id: 'security',
    name: 'Security Audit',
    description: 'Performs security vulnerability analysis',
    agentPrompt: `You are a security auditor. Check SQL injection, XSS, auth flaws, and data exposure.

Your task is to:
1. Check for SQL injection vulnerabilities
2. Identify XSS (Cross-Site Scripting) risks
3. Review authentication/authorization logic
4. Check for sensitive data exposure
5. Identify insecure dependencies or patterns

Output format:
- SQL Injection: [any vulnerabilities found]
- XSS Risks: [cross-site scripting issues]
- Auth Issues: [authentication/authorization problems]
- Data Exposure: [sensitive data handling issues]
- Security Recommendations: [specific security improvements]

SEVERITY LEVELS: CRITICAL, HIGH, MEDIUM, LOW`,
    requiredActions: ['check_injection', 'check_xss', 'review_auth', 'check_data_exposure'],
  },
  {
    id: 'performance',
    name: 'Performance Review',
    description: 'Analyzes performance implications and optimizations',
    agentPrompt: `You are a performance engineer. Check algorithm complexity, N+1 queries, memory leaks.

Your task is to:
1. Analyze algorithm complexity (time and space)
2. Identify N+1 query problems
3. Check for potential memory leaks
4. Review resource usage patterns
5. Identify unnecessary computations

Output format:
- Complexity Issues: [O(n) analysis and concerns]
- Database Issues: [N+1 queries, missing indexes]
- Memory Concerns: [potential leaks or excessive usage]
- Resource Usage: [inefficient patterns]
- Performance Recommendations: [specific optimizations]`,
    requiredActions: [
      'analyze_complexity',
      'check_queries',
      'identify_memory_issues',
    ],
  },
  {
    id: 'synthesis',
    name: 'Final Synthesis',
    description: 'Synthesizes all findings into a final review',
    agentPrompt: `Synthesize all findings. Deduplicate, prioritize by severity, give STATUS: PASSED or FAILED.

You have received findings from 5 specialized reviewers:
1. Scope Analysis
2. Coding Standards
3. Error Handling
4. Security Audit
5. Performance Review

Your task is to:
1. Combine all findings into a unified report
2. Remove duplicate issues mentioned by multiple reviewers
3. Prioritize by severity: CRITICAL > HIGH > MEDIUM > LOW
4. Determine final status based on findings

Output format:
## Summary
[Brief overview of the review]

## Critical Issues
[List critical issues that MUST be fixed]

## High Priority Issues
[List high priority issues]

## Medium/Low Priority Issues
[List remaining issues]

## STATUS: [PASSED/FAILED]
[Reasoning for the decision]

FAILED if: Any CRITICAL issues, or more than 3 HIGH issues
PASSED if: No CRITICAL issues and 3 or fewer HIGH issues`,
    requiredActions: ['deduplicate', 'prioritize', 'determine_status'],
  },
];

/**
 * Get a step definition by ID
 */
export function getStepById(stepId: string): WorkflowStepDefinition | undefined {
  return CODE_REVIEW_WORKFLOW.find((step) => step.id === stepId);
}

/**
 * Get all parallel steps (excluding synthesis)
 */
export function getParallelSteps(): WorkflowStepDefinition[] {
  return CODE_REVIEW_WORKFLOW.filter((step) => step.id !== 'synthesis');
}

/**
 * Get the synthesis step
 */
export function getSynthesisStep(): WorkflowStepDefinition {
  const synthesis = CODE_REVIEW_WORKFLOW.find((step) => step.id === 'synthesis');
  if (!synthesis) {
    throw new Error('Synthesis step not found in workflow definition');
  }
  return synthesis;
}
