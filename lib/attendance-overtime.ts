import { attendanceDate, attendanceDateTimeToIso } from './attendance-time';
import { collectWorkShifts, getWorkIntervals, splitIntervalByDay } from './attendance-worked';

export type WorkSchedule = {
  start: string;
  lunchStart: string;
  lunchEnd: string;
  end: string;
};

export type OvertimePunch = {
  type: string;
  recordedAt: string;
  status: string;
};

export type MonthlyOvertime = {
  confirmedMinutes: number;
  pendingMinutes: number;
  days: { date: string; minutes: number }[];
};

export const DEFAULT_WORK_SCHEDULE: WorkSchedule = {
  start: '07:00',
  lunchStart: '11:30',
  lunchEnd: '13:00',
  end: '17:30',
};

const timeToMinutes = (value: string) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export function parseWorkSchedule(value: string | null | undefined): WorkSchedule | null {
  if (!value || /flex/i.test(value)) return null;
  const times = value.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g);
  if (!times || times.length < 2) return null;
  if (times.length >= 4) {
    return { start: times[0], lunchStart: times[1], lunchEnd: times[2], end: times[3] };
  }
  return {
    start: times[0],
    lunchStart: DEFAULT_WORK_SCHEDULE.lunchStart,
    lunchEnd: DEFAULT_WORK_SCHEDULE.lunchEnd,
    end: times[1],
  };
}

export function isValidWorkSchedule(schedule: WorkSchedule) {
  const start = timeToMinutes(schedule.start);
  const lunchStart = timeToMinutes(schedule.lunchStart);
  const lunchEnd = timeToMinutes(schedule.lunchEnd);
  const end = timeToMinutes(schedule.end);
  return start !== null && lunchStart !== null && lunchEnd !== null && end !== null &&
    start < lunchStart && lunchStart < lunchEnd && lunchEnd < end;
}

export function serializeWorkSchedule(schedule: WorkSchedule) {
  return `${schedule.start}-${schedule.lunchStart}|${schedule.lunchEnd}-${schedule.end}`;
}

export function calculateMonthlyOvertime(
  punches: OvertimePunch[],
  schedule: WorkSchedule | null,
  saturdayUntilNoon = false,
  month?: string,
): MonthlyOvertime {
  const effectiveSchedule = schedule || DEFAULT_WORK_SCHEDULE;
  if (!isValidWorkSchedule(effectiveSchedule)) {
    throw new Error('A jornada cadastrada é inválida para o cálculo de horas extras.');
  }
  const start = timeToMinutes(effectiveSchedule.start);
  const lunchStart = timeToMinutes(effectiveSchedule.lunchStart);
  const lunchEnd = timeToMinutes(effectiveSchedule.lunchEnd);
  const end = timeToMinutes(effectiveSchedule.end);
  if (start === null || lunchStart === null || lunchEnd === null || end === null) {
    throw new Error('A jornada cadastrada é inválida para o cálculo de horas extras.');
  }
  const standardMinutes = lunchStart - start + end - lunchEnd;
  const days = new Map<string, number>();
  let confirmedMinutes = 0;
  let pendingMinutes = 0;
  for (const shift of collectWorkShifts(punches).shifts) {
    const entry = Date.parse(shift[0].recordedAt);
    const date = attendanceDate(new Date(entry));
    if (month && !date.startsWith(`${month}-`)) continue;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const intervals = getWorkIntervals(shift);
    const overtimeByDay = new Map<string, number>();
    if (weekday === 0 || (weekday === 6 && !saturdayUntilNoon)) {
      for (const [start, end] of intervals) {
        for (const segment of splitIntervalByDay(start, end)) {
          overtimeByDay.set(segment.date, (overtimeByDay.get(segment.date) || 0) + segment.milliseconds);
        }
      }
    } else if (weekday === 6) {
      const noon = Date.parse(attendanceDateTimeToIso(date, '12:00'));
      for (const [start, end] of intervals) {
        for (const segment of splitIntervalByDay(start, end)) {
          const minutes = Math.max(0, segment.end - Math.max(segment.start, noon));
          if (minutes) overtimeByDay.set(segment.date, (overtimeByDay.get(segment.date) || 0) + minutes);
        }
      }
    } else {
      let normalMinutesRemaining = standardMinutes;
      for (const [start, end] of intervals) {
        for (const segment of splitIntervalByDay(start, end)) {
          const segmentMinutes = segment.milliseconds / 60000;
          const normalMinutes = Math.min(normalMinutesRemaining, segmentMinutes);
          normalMinutesRemaining -= normalMinutes;
          const overtimeMs = segment.milliseconds - normalMinutes * 60000;
          if (overtimeMs) overtimeByDay.set(segment.date, (overtimeByDay.get(segment.date) || 0) + overtimeMs);
        }
      }
    }
    const totalOvertimeMs = Array.from(overtimeByDay.values()).reduce((total, value) => total + value, 0);
    const totalMinutes = Math.floor(totalOvertimeMs / 60000);
    const roundedDays = Array.from(overtimeByDay, ([day, milliseconds]) => ({
      date: day,
      minutes: Math.floor(milliseconds / 60000),
      remainder: milliseconds % 60000,
    })).sort((a, b) => b.remainder - a.remainder || a.date.localeCompare(b.date));
    let remainingMinutes = totalMinutes - roundedDays.reduce((total, day) => total + day.minutes, 0);
    for (const day of roundedDays) {
      if (remainingMinutes <= 0) break;
      day.minutes += 1;
      remainingMinutes -= 1;
    }
    if (shift.some((punch) => punch.status === 'pending')) pendingMinutes += totalMinutes;
    else confirmedMinutes += totalMinutes;
    for (const day of roundedDays) {
      if (day.minutes) days.set(day.date, (days.get(day.date) || 0) + day.minutes);
    }
  }
  return {
    confirmedMinutes,
    pendingMinutes,
    days: Array.from(days, ([date, minutes]) => ({ date, minutes }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  };
}

export function formatOvertimeMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, '0')}min`;
}
