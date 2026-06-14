/**
 * PageIndex for GHAGGA Project Memory
 *
 * Exports all PageIndex components for navigable project memory.
 */

export * from './chunker.js';
export * from './service.js';
export * from './types.js';

import { type DatabaseWithParams, ProjectPageIndexService } from './service.js';

export { ProjectPageIndexService };

/**
 * Quick factory function
 */
export function createProjectPageIndex(db: DatabaseWithParams) {
  return new ProjectPageIndexService(db);
}
