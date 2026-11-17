/**
 * Conversational command parser (SRS FR-2, SDD §2).
 *
 * Deliberately strict about zone ids: an unvalidated id lets a typo create a
 * zone row and lets a user subscribe into a zone nobody polls.
 */

const ZONE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/;

export const COMMANDS = Object.freeze({
  START: 'start',
  HELP: 'help',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  STOP: 'stop',
  STATUS: 'status',
  UNKNOWN: 'unknown',
  EMPTY: 'empty',
});

export function isValidZoneId(value) {
  return typeof value === 'string' && ZONE_ID_RE.test(value);
}

/**
 * @returns {{command: string, args: string[], zoneId?: string|null, error?: string, raw: string}}
 */
export function parseCommand(rawText) {
  const raw = String(rawText ?? '').trim();

  if (raw === '') return { command: COMMANDS.EMPTY, args: [], raw };

  // Plain text (no leading slash) is treated as conversation, not a command.
  const match = raw.match(COMMAND_RE);
  if (!match) {
    // Allow `/stop.` and similar trailing punctuation from mobile keyboards.
    const loose = raw.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?\s*[.!]?$/);
    if (!loose) return { command: COMMANDS.UNKNOWN, args: [], raw };
    return finish(loose[1].toLowerCase(), '');
  }

  return finish(match[1].toLowerCase(), (match[3] ?? '').trim());
}

function finish(name, rest) {
  const alias = name === 'unsubscribe' ? COMMANDS.STOP : name;
  const args = rest === '' ? [] : rest.split(/\s+/);

  switch (alias) {
    case COMMANDS.START: {
      // /start <deeplink-payload> is allowed; payload is informational only.
      return { command: COMMANDS.START, args, raw: rest };
    }
    case COMMANDS.HELP:
      return { command: COMMANDS.HELP, args, raw: rest };
    case COMMANDS.STATUS:
      return { command: COMMANDS.STATUS, args, raw: rest };
    case COMMANDS.STOP:
      return { command: COMMANDS.STOP, args, raw: rest };
    case COMMANDS.SUBSCRIBE: {
      if (args.length === 0) {
        return {
          command: COMMANDS.SUBSCRIBE,
          args,
          raw: rest,
          zoneId: null,
          error: 'MISSING_ZONE',
        };
      }
      if (args.length > 1) {
        return {
          command: COMMANDS.SUBSCRIBE,
          args,
          raw: rest,
          zoneId: null,
          error: 'TOO_MANY_ARGUMENTS',
        };
      }
      const zoneId = args[0].toLowerCase();
      if (!isValidZoneId(zoneId)) {
        return { command: COMMANDS.SUBSCRIBE, args, raw: rest, zoneId: null, error: 'INVALID_ZONE' };
      }
      return { command: COMMANDS.SUBSCRIBE, args, raw: rest, zoneId, error: null };
    }
    default:
      return { command: COMMANDS.UNKNOWN, args, raw: rest };
  }
}
