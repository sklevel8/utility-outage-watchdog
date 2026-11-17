import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, isValidZoneId, COMMANDS } from '../src/core/commands.js';

test('/subscribe with a valid zone', () => {
  const parsed = parseCommand('/subscribe city-of-tshwane-tshwane-1');
  assert.equal(parsed.command, COMMANDS.SUBSCRIBE);
  assert.equal(parsed.zoneId, 'city-of-tshwane-tshwane-1');
  assert.equal(parsed.error, null);
});

test('/subscribe@BotName with a group-chat suffix', () => {
  const parsed = parseCommand('/subscribe@UtilityWatchdogBot city-of-tshwane-tshwane-1');
  assert.equal(parsed.command, COMMANDS.SUBSCRIBE);
  assert.equal(parsed.zoneId, 'city-of-tshwane-tshwane-1');
});

test('/subscribe without a zone is rejected with MISSING_ZONE', () => {
  const parsed = parseCommand('/subscribe');
  assert.equal(parsed.command, COMMANDS.SUBSCRIBE);
  assert.equal(parsed.error, 'MISSING_ZONE');
  assert.equal(parsed.zoneId, null);
});

test('zone ids with spaces are rejected instead of truncated', () => {
  const parsed = parseCommand('/subscribe city of tshwane');
  assert.equal(parsed.error, 'TOO_MANY_ARGUMENTS');
});

test('uppercase and punctuation are rejected as INVALID_ZONE', () => {
  assert.equal(parseCommand('/subscribe BAD_ZONE!').error, 'INVALID_ZONE');
  assert.equal(parseCommand('/subscribe ..').error, 'INVALID_ZONE');
});

test('/stop and /unsubscribe are aliases', () => {
  assert.equal(parseCommand('/stop').command, COMMANDS.STOP);
  assert.equal(parseCommand('/unsubscribe').command, COMMANDS.STOP);
  assert.equal(parseCommand('/stop.').command, COMMANDS.STOP);
});

test('help, status and start are recognised', () => {
  assert.equal(parseCommand('/help').command, COMMANDS.HELP);
  assert.equal(parseCommand('/status').command, COMMANDS.STATUS);
  assert.equal(parseCommand('/start').command, COMMANDS.START);
  assert.equal(parseCommand('/start payload123').command, COMMANDS.START);
});

test('empty input and plain conversation are distinguished', () => {
  assert.equal(parseCommand('   ').command, COMMANDS.EMPTY);
  assert.equal(parseCommand('hello there').command, COMMANDS.UNKNOWN);
});

test('zone id validation matches the documented format', () => {
  assert.equal(isValidZoneId('city-of-tshwane-tshwane-1'), true);
  assert.equal(isValidZoneId('a1'), true);
  assert.equal(isValidZoneId('a'), false);
  assert.equal(isValidZoneId('-leading'), false);
  assert.equal(isValidZoneId('has space'), false);
  assert.equal(isValidZoneId('x'.repeat(65)), false);
  assert.equal(isValidZoneId(null), false);
});
