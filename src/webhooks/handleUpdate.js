import { parseCommand, COMMANDS } from '../core/commands.js';
import {
  formatHelp,
  formatStatus,
  formatSubscribeError,
  formatSubscribed,
  formatUnsubscribed,
  formatWelcome,
} from '../core/format.js';

/**
 * Telegram update handler (SRS FR-2).
 *
 * `my_chat_member` is handled as well: if the user blocks or removes the bot we
 * delete their row, because a blocked user is no longer a consenting one.
 */
export function createUpdateHandler({ subscribers, transport, zones = [], logger = console }) {
  const knownZones = new Set(zones.map((zone) => zone.id));

  async function reply(userId, text) {
    try {
      await transport.sendMessage({ userId, text });
      return true;
    } catch (error) {
      // A failed courtesy reply must not 500 the webhook: Telegram would retry
      // the whole update, re-running the command.
      logger.warn?.({ err: error.message }, 'failed to reply to user');
      return false;
    }
  }

  return async function handleUpdate(update = {}) {
    if (update.my_chat_member) {
      const userId = update.my_chat_member.chat?.id;
      const status = update.my_chat_member.new_chat_member?.status;
      if (userId !== undefined && (status === 'kicked' || status === 'left')) {
        await subscribers.unsubscribe({ platform: 'telegram', userId: String(userId) });
        return { handled: true, action: 'purged_blocked_user' };
      }
      return { handled: false, reason: 'chat_member_update' };
    }

    const message = update.message ?? update.edited_message;
    const text = message?.text;
    const chatId = message?.chat?.id;
    if (!text || chatId === undefined || chatId === null) {
      return { handled: false, reason: 'no_text' };
    }

    const userId = String(chatId);
    const parsed = parseCommand(text);

    switch (parsed.command) {
      case COMMANDS.EMPTY:
      case COMMANDS.START: {
        await reply(userId, formatWelcome());
        return { handled: true, command: parsed.command };
      }

      case COMMANDS.HELP: {
        await reply(userId, formatHelp());
        return { handled: true, command: parsed.command };
      }

      case COMMANDS.SUBSCRIBE: {
        if (parsed.error) {
          await reply(userId, formatSubscribeError(parsed.error, parsed.args[0]));
          return { handled: true, command: parsed.command, error: parsed.error };
        }
        if (knownZones.size > 0 && !knownZones.has(parsed.zoneId)) {
          await reply(userId, formatSubscribeError('UNKNOWN_ZONE', parsed.zoneId));
          return { handled: true, command: parsed.command, error: 'UNKNOWN_ZONE' };
        }

        const subscription = await subscribers.subscribe({
          platform: 'telegram',
          userId,
          zoneId: parsed.zoneId,
        });
        await reply(userId, formatSubscribed(parsed.zoneId));
        return { handled: true, command: parsed.command, subscription };
      }

      case COMMANDS.STOP: {
        const { deleted } = await subscribers.unsubscribe({ platform: 'telegram', userId });
        await reply(userId, formatUnsubscribed());
        return { handled: true, command: parsed.command, deleted };
      }

      case COMMANDS.STATUS: {
        const subscription = await subscribers.status({ platform: 'telegram', userId });
        await reply(userId, formatStatus(subscription));
        return { handled: true, command: parsed.command, subscribed: Boolean(subscription) };
      }

      default: {
        await reply(userId, formatHelp());
        return { handled: true, command: COMMANDS.UNKNOWN };
      }
    }
  };
}
