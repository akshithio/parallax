const test = require('node:test');
const assert = require('node:assert/strict');
const { formatLocalLogTime, localOffset } = require('../lib/logTime');

function localDate(parts) {
  return {
    getFullYear: () => parts.year,
    getMonth: () => parts.month - 1,
    getDate: () => parts.day,
    getHours: () => parts.hour,
    getMinutes: () => parts.minute,
    getSeconds: () => parts.second,
    getMilliseconds: () => parts.millisecond,
    getTimezoneOffset: () => parts.timezoneOffset,
  };
}

test('formats log timestamps in local wall-clock time with the UTC offset', () => {
  const date = localDate({
    year: 2026,
    month: 8,
    day: 13,
    hour: 14,
    minute: 7,
    second: 9,
    millisecond: 42,
    timezoneOffset: 420,
  });

  assert.equal(formatLocalLogTime(date), '2026-08-13 14:07:09.042 -07:00');
});

test('formats positive and fractional local UTC offsets', () => {
  assert.equal(localOffset(localDate({ timezoneOffset: -330 })), '+05:30');
  assert.equal(localOffset(localDate({ timezoneOffset: 210 })), '-03:30');
});
