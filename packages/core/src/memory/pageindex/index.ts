/**
 * PageIndex for GHAGGA Project Memory
 * 
 * Exports all PageIndex components for navigable project memory.
 */

export * from './types.js';
export * from './chunker.js';
export * from './service.js';

import { ProjectPageIndexService } from './service.js';

export { ProjectPageIndexService };

/**
 * Quick factory function
 */
export function createProjectPageIndex(db: any) {
  return new ProjectPageIndexService(db);
}
