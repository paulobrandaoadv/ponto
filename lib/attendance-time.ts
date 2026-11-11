export const ATTENDANCE_TIME_ZONE = 'America/Campo_Grande';

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ATTENDANCE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parts(date: Date) {
  const values = dateTimeFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => {
    const value = values.find((part) => part.type === type)?.value;
    if (!value) throw new Error('Não foi possível determinar o horário de Mato Grosso do Sul.');
    return value;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

export function attendanceDate(date: Date) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function attendanceTime(date: Date) {
  const p = parts(date);
  return `${p.hour}:${p.minute}`;
}

export function attendanceDateTimeToIso(date: string, time = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('Informe uma data e um horário válidos.');
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const checked = new Date(target);
  if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 ||
      checked.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error('Informe uma data e um horário válidos.');
  }
  let timestamp = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const p = parts(new Date(timestamp));
    const localAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour), Number(p.minute), Number(p.second));
    const correction = target - localAsUtc;
    timestamp += correction;
    if (correction === 0) break;
  }
  const result = new Date(timestamp);
  if (attendanceDate(result) !== date || attendanceTime(result) !== time) {
    throw new Error('Este horário não existe no fuso de Mato Grosso do Sul.');
  }
  return result.toISOString();
}

export function nextAttendanceDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Informe uma data válida.');
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new Error('Informe uma data válida.');
  }
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}
