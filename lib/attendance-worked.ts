import { attendanceDate, attendanceDateTimeToIso, nextAttendanceDate } from './attendance-time';
import type { OvertimePunch } from './attendance-overtime';

export type WorkSessionPunch = OvertimePunch & { id?: string };

export type WorkSession = WorkSessionPunch[];

export function getEmployeePunchEvent(
  state: 'not_started' | 'closed' | 'working' | 'on_break',
  selected: 'entrada' | 'saida_almoco' | 'retorno_almoco' | 'saida',
) {
  if (state === 'not_started' || state === 'closed') return 'entrada';
  if (state === 'on_break') return 'retorno_almoco';
  return selected === 'saida' ? 'saida' : 'saida_almoco';
}

export function getWorkIntervals(session: WorkSession) {
  const intervals: Array<[number, number]> = [];
  let workStartedAt = Date.parse(session[0].recordedAt);
  for (const punch of session.slice(1)) {
    const time = Date.parse(punch.recordedAt);
    if (punch.type === 'saida_almoco') {
      intervals.push([workStartedAt, time]);
    } else if (punch.type === 'retorno_almoco') {
      workStartedAt = time;
    } else if (punch.type === 'saida') {
      intervals.push([workStartedAt, time]);
    }
  }
  return intervals;
}

export function splitIntervalByDay(start: number, end: number) {
  const parts: Array<{ date: string; milliseconds: number; start: number; end: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const date = attendanceDate(new Date(cursor));
    const nextDay = Date.parse(attendanceDateTimeToIso(nextAttendanceDate(date)));
    const segmentEnd = Math.min(end, nextDay);
    parts.push({ date, milliseconds: segmentEnd - cursor, start: cursor, end: segmentEnd });
    cursor = segmentEnd;
  }
  return parts;
}

function distributeRoundedMinutes(
  buckets: Map<string, number>,
  milliseconds: number,
  date: string,
) {
  if (!milliseconds) return;
  buckets.set(date, (buckets.get(date) || 0) + milliseconds);
}

export function splitWorkSessionByDay(session: WorkSession) {
  const millisecondsByDay = new Map<string, number>();
  const intervals = getWorkIntervals(session);
  for (const [start, end] of intervals) {
    for (const part of splitIntervalByDay(start, end)) {
      distributeRoundedMinutes(millisecondsByDay, part.milliseconds, part.date);
    }
  }
  const totalMinutes = Math.floor(
    Array.from(millisecondsByDay.values()).reduce((total, value) => total + value, 0) / 60000,
  );
  const dailyMinutes = Array.from(millisecondsByDay, ([date, milliseconds]) => ({
    date,
    minutes: Math.floor(milliseconds / 60000),
    remainder: milliseconds % 60000,
  }));
  let remaining = totalMinutes - dailyMinutes.reduce((total, day) => total + day.minutes, 0);
  dailyMinutes.sort((a, b) => b.remainder - a.remainder || a.date.localeCompare(b.date));
  for (const day of dailyMinutes) {
    if (remaining <= 0) break;
    day.minutes += 1;
    remaining -= 1;
  }
  return {
    totalMinutes,
    days: dailyMinutes.map(({ date, minutes }) => ({ date, minutes }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  };
}

export function collectWorkShifts(punches: WorkSessionPunch[], now = new Date()) {
  const sorted = punches
    .filter((punch) => punch.status === 'confirmed' || punch.status === 'pending')
    .slice()
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  const shifts: WorkSession[] = [];
  const anomalies: WorkSessionPunch[] = [];
  let current: WorkSession = [];
  let incomplete = 0;
  let onBreak = false;

  for (const punch of sorted) {
    const time = Date.parse(punch.recordedAt);
    if (!Number.isFinite(time)) {
      incomplete += 1;
      anomalies.push(punch);
      continue;
    }
    if (!current.length) {
      if (punch.type === 'entrada') {
        current = [punch];
        onBreak = false;
      } else {
        incomplete += 1;
        anomalies.push(punch);
      }
      continue;
    }

    const previous = Date.parse(current[current.length - 1].recordedAt);
    if (time < previous) {
      incomplete += 1;
      anomalies.push(punch);
      continue;
    }
    if (punch.type === 'entrada') {
      incomplete += 1;
      anomalies.push(punch);
      continue;
    }
    if (onBreak) {
      if (punch.type === 'retorno_almoco') {
        current.push(punch);
        onBreak = false;
      } else {
        incomplete += 1;
        anomalies.push(punch);
      }
      continue;
    }
    if (punch.type === 'saida_almoco') {
      current.push(punch);
      onBreak = true;
    } else if (punch.type === 'saida') {
      current.push(punch);
      shifts.push(current);
      current = [];
      onBreak = false;
    } else {
      incomplete += 1;
      anomalies.push(punch);
    }
  }

  const duration = current.length ? now.getTime() - Date.parse(current[0].recordedAt) : 0;
  const lastType = current.length ? current[current.length - 1].type : null;
  const lastRecordedType = sorted.length ? sorted[sorted.length - 1].type : null;
  return {
    shifts,
    current,
    anomalies,
    incomplete,
    inProgress: current.length > 0,
    state: current.length === 0
      ? lastRecordedType === 'saida' ? 'closed' as const : 'not_started' as const
      : onBreak ? 'on_break' as const : 'working' as const,
    nextEvent: current.length === 0 ? 'entrada' : onBreak ? 'retorno_almoco' : lastType === 'entrada' || lastType === 'retorno_almoco'
      ? 'saida_almoco' : null,
    openHours: current.length ? duration / 3600000 : 0,
  };
}

export function calculateWorkedHours(punches: WorkSessionPunch[], now = new Date()) {
  const result = collectWorkShifts(punches, now);
  const days = new Map<string, number>();
  for (const shift of result.shifts) {
    const split = splitWorkSessionByDay(shift);
    for (const day of split.days) {
      days.set(day.date, (days.get(day.date) || 0) + day.minutes);
    }
  }
  const totals = Array.from(days, ([date, minutes]) => ({ date, minutes }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return {
    totalMinutes: totals.reduce((total, day) => total + day.minutes, 0),
    days: totals,
    incomplete: result.incomplete,
    inProgress: result.inProgress,
    state: result.state,
    nextEvent: result.nextEvent,
    openHours: result.openHours,
    anomalies: result.anomalies,
  };
}
