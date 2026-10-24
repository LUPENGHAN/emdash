import { COMMAND_CATALOG } from '@core/manifests/shared/command-catalog';
import type { CommandDef } from '@core/primitives/commands/api';
import { scopes } from '@core/primitives/view-scopes/browser';
import { NAVIGATION_COMMAND_IDS } from '../api';

const navigationCommandIds: ReadonlySet<string> = new Set(NAVIGATION_COMMAND_IDS);

function navigationCommand(commandId: string): CommandDef {
  if (!navigationCommandIds.has(commandId)) {
    throw new Error(`Command ${commandId} is not available`);
  }
  const command = COMMAND_CATALOG.byId(commandId);
  if (!command) throw new Error(`Command ${commandId} is not available`);
  return command;
}

function commandTitle(command: CommandDef, title: string | undefined): string {
  return title ?? command.title;
}

/** One line per allowlisted command: id, availability, title. Does not run anything. */
export function listNavigationCommands(): string {
  return NAVIGATION_COMMAND_IDS.map((commandId) => {
    const command = navigationCommand(commandId);
    const bound = scopes.getActiveCommand(command, { belowActiveCapture: true });
    const availability = bound?.availability.kind ?? 'hidden';
    return `${commandId}, ${availability}, ${commandTitle(command, bound?.presentation?.title)}`;
  }).join('\n');
}

/**
 * Runs one allowlisted command the way the command palette does.
 * Hidden, disabled, and unbound commands are refused.
 */
export function runNavigationCommand(commandId: string): string {
  const command = navigationCommand(commandId);
  const bound = scopes.getActiveCommand(command, { belowActiveCapture: true });
  if (!bound || bound.availability.kind !== 'enabled') {
    throw new Error(`Command ${commandId} is not available`);
  }
  bound.execute(undefined, 'palette');
  return `Ran ${commandTitle(command, bound.presentation?.title)}.`;
}
