function two(value) {
  return String(value).padStart(2, '0');
}

function three(value) {
  return String(value).padStart(3, '0');
}

function localOffset(date) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${two(Math.floor(absolute / 60))}:${two(absolute % 60)}`;
}

function formatLocalLogTime(date = new Date()) {
  return [
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`,
    localOffset(date),
  ].join(' ');
}

module.exports = { formatLocalLogTime, localOffset };
