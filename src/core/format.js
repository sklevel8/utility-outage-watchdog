import { stageLabel } from './diff.js';

/**
 * Message rendering. Plain text on purpose: no Markdown parsing means no
 * injection surface and no "can't parse entities" delivery failures.
 */

export const TELEGRAM_MAX_LENGTH = 4096;

export function truncate(text, max = TELEGRAM_MAX_LENGTH) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function formatEventTime(value, timeZone) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat('en-ZA', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * @param {object} input
 * @param {string} input.areaName
 * @param {number|null} input.previousStage
 * @param {number|null} input.currentStage
 * @param {Array} [input.events]
 * @param {'stage_change'|'schedule_change'|'cleared'|'initial'} input.changeType
 */
export function formatAlert({
  areaName,
  previousStage = null,
  currentStage = null,
  events = [],
  changeType = 'stage_change',
  timeZone = 'Africa/Johannesburg',
}) {
  const area = areaName || 'Your area';
  const lines = [];

  if (changeType === 'cleared') {
    lines.push('✅ Power status update');
    lines.push('');
    lines.push(`${area}: load-shedding has been suspended.`);
  } else if (changeType === 'stage_change' && previousStage !== null && previousStage !== undefined) {
    lines.push('⚠️ Load-shedding stage change');
    lines.push('');
    lines.push(`${area}: ${stageLabel(previousStage)} → ${stageLabel(currentStage)}`);
  } else {
    lines.push('⚠️ Outage schedule update');
    lines.push('');
    lines.push(`${area}: schedule changed (${stageLabel(currentStage)}).`);
  }

  const upcoming = events.slice(0, 3);
  if (upcoming.length > 0) {
    lines.push('');
    lines.push('Upcoming slots:');
    for (const event of upcoming) {
      const start = formatEventTime(event.start, timeZone);
      const end = formatEventTime(event.end, timeZone);
      const suffix = event.cancelled ? ' (cancelled)' : '';
      if (start && end) lines.push(`• ${start} – ${end}${suffix}`);
      else if (start) lines.push(`• From ${start}${suffix}`);
      else if (event.note) lines.push(`• ${event.note}${suffix}`);
    }
  }

  lines.push('');
  lines.push('Reply /stop to unsubscribe. Sent by Utility Watchdog.');

  return truncate(lines.join('\n'));
}

export function formatWelcome() {
  return [
    '👋 Welcome to Utility Watchdog.',
    '',
    'I alert you when the load-shedding schedule for your area changes.',
    '',
    'To subscribe, send:',
    '/subscribe <zone-id>',
    '',
    'Not sure of your zone id? Check your municipality\'s published zone list, or ask the operator.',
    '',
    'By subscribing you consent to receive service alerts for the zone you choose. You can withdraw consent at any time with /stop.',
  ].join('\n');
}

export function formatHelp() {
  return [
    'Available commands:',
    '',
    '/subscribe <zone-id> – start alerts for your area',
    '/status – show your current subscription',
    '/stop – delete your details and stop all alerts',
    '/help – show this message',
    '',
    'Zone ids look like: city-of-tshwane-tshwane-1',
  ].join('\n');
}

export function formatSubscribed(zoneId) {
  return [
    `✅ Subscribed to ${zoneId}.`,
    '',
    'You will only receive alerts when the schedule for this zone actually changes.',
    'Send /stop at any time to delete your details.',
  ].join('\n');
}

export function formatUnsubscribed() {
  return [
    '🗑️ You have been unsubscribed.',
    '',
    'Your chat id and zone have been permanently deleted from our subscriber list.',
    'Send /subscribe <zone-id> whenever you want to come back.',
  ].join('\n');
}

export function formatStatus(subscription, zoneId = null) {
  if (!subscription) {
    return 'You are not subscribed. Send /subscribe <zone-id> to start.';
  }
  return [
    `Zone: ${subscription.zoneId ?? zoneId}`,
    `Status: ${subscription.status ?? 'active'}`,
    subscription.consentAt ? `Consented: ${subscription.consentAt}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatSubscribeError(error, zoneId = null) {
  switch (error) {
    case 'MISSING_ZONE':
      return 'Please include a zone id, for example:\n/subscribe city-of-tshwane-tshwane-1';
    case 'TOO_MANY_ARGUMENTS':
      return 'Zone ids cannot contain spaces. Send one id only, for example:\n/subscribe city-of-tshwane-tshwane-1';
    case 'INVALID_ZONE':
      return `"${zoneId ?? ''}" is not a valid zone id. Use lowercase letters, numbers and hyphens.`;
    case 'UNKNOWN_ZONE':
      return 'That zone is not being monitored yet. Send /help to see the format, or contact the operator.';
    default:
      return 'Something went wrong. Please try again in a minute.';
  }
}

export function formatDeliveryFailureNotice() {
  return 'We could not reach you. If you blocked the bot, unblock it and send /status.';
}
