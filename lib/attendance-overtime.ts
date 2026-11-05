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
};

export const ATTENDANCE_TIME_ZONE = 'America/Campo_Grande';

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
    return {
      start: times[0],
      lunchStart: times[1],
      lunchEnd: times[2],
      end: times[3],
    };
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
  return (
    start !== null &&
    lunchStart !== null &&
    lunchEnd !== null &&
    end !== null &&
    start < lunchStart &&
    lunchStart < lunchEnd &&
    lunchEnd < end
  );
}

export function serializeWorkSchedule(schedule: WorkSchedule) {
  return `${schedule.start}-${schedule.lunchStart}|${schedule.lunchEnd}-${schedule.end}`;
}

function localDateAndMinutes(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ATTENDANCE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  const hour = part('hour');
  const minute = part('minute');
  if (!year || !month || !day || !hour || !minute) return null;
  return {
    date: `${year}-${month}-${day}`,
    minutes: Number(hour) * 60 + Number(minute),
  };
}

export function calculateMonthlyOvertime(
  punches: OvertimePunch[],
  schedule: WorkSchedule | null,
): MonthlyOvertime {
  if (!schedule) return { confirmedMinutes: 0, pendingMinutes: 0 };
  const expectedEnd = timeToMinutes(schedule.end);
  if (expectedEnd === null) return { confirmedMinutes: 0, pendingMinutes: 0 };

  const lastExitByDay = new Map<string, { minutes: number; status: string }>();
  punches.forEach((punch) => {
    if (punch.type !== 'saida' || punch.status === 'rejected') return;
    const time = localDateAndMinutes(punch.recordedAt);
    if (!time) return;
    const previous = lastExitByDay.get(time.date);
    if (!previous || time.minutes > previous.minutes) {
      lastExitByDay.set(time.date, { minutes: time.minutes, status: punch.status });
    }
  });

  return Array.from(lastExitByDay.values()).reduce<MonthlyOvertime>(
    (total, exit) => {
      const minutes = Math.max(0, exit.minutes - expectedEnd);
      if (exit.status === 'confirmed') total.confirmedMinutes += minutes;
      if (exit.status === 'pending') total.pendingMinutes += minutes;
      return total;
    },
    { confirmedMinutes: 0, pendingMinutes: 0 },
  );
}

export function formatOvertimeMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, '0')}min`;
}
