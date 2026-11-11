import { attendanceDate, attendanceDateTimeToIso } from './attendance-time';
import { collectWorkShifts } from './attendance-worked';

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
    const [entry, breakStart, breakEnd, exit] = shift.map((punch) => Date.parse(punch.recordedAt));
    const date = attendanceDate(new Date(entry));
    if (month && !date.startsWith(`${month}-`)) continue;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const workedMs = (breakStart - entry) + (exit - breakEnd);
    let overtimeMs: number;
    if (weekday === 0 || (weekday === 6 && !saturdayUntilNoon)) {
      overtimeMs = workedMs;
    } else if (weekday === 6) {
      const noon = Date.parse(attendanceDateTimeToIso(date, '12:00'));
      overtimeMs = Math.max(0, breakStart - Math.max(entry, noon)) +
        Math.max(0, exit - Math.max(breakEnd, noon));
    } else {
      overtimeMs = Math.max(0, workedMs - standardMinutes * 60000);
    }
    const minutes = Math.floor(overtimeMs / 60000);
    if (!minutes) continue;
    if (shift.some((punch) => punch.status === 'pending')) pendingMinutes += minutes;
    else confirmedMinutes += minutes;
    days.set(date, (days.get(date) || 0) + minutes);
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
