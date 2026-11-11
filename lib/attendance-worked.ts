import { attendanceDate } from './attendance-time';
import type { OvertimePunch } from './attendance-overtime';

const sequence = ['entrada', 'saida_almoco', 'retorno_almoco', 'saida'] as const;
const maxDurationMs = 48 * 60 * 60 * 1000;

export function collectWorkShifts(punches: OvertimePunch[], now = new Date()) {
  const sorted = punches
    .filter((punch) => punch.status === 'confirmed' || punch.status === 'pending')
    .slice()
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const shifts: OvertimePunch[][] = [];
  let current: OvertimePunch[] = [];
  let incomplete = 0;
  for (const punch of sorted) {
    const time = Date.parse(punch.recordedAt);
    if (!Number.isFinite(time)) {
      incomplete += 1;
      current = [];
      continue;
    }
    if (punch.type === 'entrada') {
      if (current.length) incomplete += 1;
      current = [punch];
      continue;
    }
    if (!current.length || punch.type !== sequence[current.length]) {
      incomplete += 1;
      current = [];
      continue;
    }
    const start = Date.parse(current[0].recordedAt);
    const previous = Date.parse(current[current.length - 1].recordedAt);
    if (time < previous || time - start > maxDurationMs) {
      incomplete += 1;
      current = [];
      continue;
    }
    current.push(punch);
    if (current.length === sequence.length) {
      shifts.push(current);
      current = [];
    }
  }

  const expired = current.length > 0 && now.getTime() - Date.parse(current[0].recordedAt) > maxDurationMs;
  return {
    shifts,
    incomplete: incomplete + (expired ? 1 : 0),
    inProgress: current.length > 0 && !expired,
    nextEvent: expired ? null : sequence[current.length],
    expired,
  };
}

export function calculateWorkedHours(punches: OvertimePunch[], now = new Date()) {
  const result = collectWorkShifts(punches, now);
  const days = new Map<string, number>();
  for (const shift of result.shifts) {
    const [entry, lunchStart, lunchEnd, exit] = shift.map((punch) => Date.parse(punch.recordedAt));
    const minutes = Math.floor((exit - entry - (lunchEnd - lunchStart)) / 60000);
    const date = attendanceDate(new Date(entry));
    days.set(date, (days.get(date) || 0) + minutes);
  }
  const totals = Array.from(days, ([date, minutes]) => ({ date, minutes }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    totalMinutes: totals.reduce((total, day) => total + day.minutes, 0),
    days: totals,
    incomplete: result.incomplete,
    inProgress: result.inProgress,
    nextEvent: result.nextEvent,
    expired: result.expired,
  };
}
