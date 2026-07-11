/**
 * Memory command group barrel.
 *
 * Registers all seven `ghagga memory` subcommands (list, search, show,
 * delete, stats, clear, backfill) and exports the parent Command for
 * registration in the CLI entry point.
 */

import { Command } from 'commander';
import { registerBackfillCommand } from './backfill.js';
import { registerClearCommand } from './clear.js';
import { registerDeleteCommand } from './delete.js';
import { registerListCommand } from './list.js';
import { registerSearchCommand } from './search.js';
import { registerShowCommand } from './show.js';
import { registerStatsCommand } from './stats.js';

export const memoryCommand = new Command('memory').description(
  'Inspect, search, and manage review memory',
);

registerListCommand(memoryCommand);
registerSearchCommand(memoryCommand);
registerShowCommand(memoryCommand);
registerDeleteCommand(memoryCommand);
registerStatsCommand(memoryCommand);
registerClearCommand(memoryCommand);
registerBackfillCommand(memoryCommand);
