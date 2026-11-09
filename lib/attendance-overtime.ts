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
  saturdayUntilNoon = false,
): MonthlyOvertime {
  const expectedEnd = schedule ? timeToMinutes(schedule.end) : null;
  if (schedule && expectedEnd === null) return { confirmedMinutes: 0, pendingMinutes: 0, days: [] };

  const punchesByDay = new Map<string, {
    entry?: number;
    lunchStart?: number;
    lunchEnd?: number;
    exit?: { minutes: number; status: string };
    last?: { minutes: number; status: string };
  }>();
  punches.forEach((punch) => {
    if (punch.status === 'rejected') return;
    const time = localDateAndMinutes(punch.recordedAt);
    if (!time) return;
    const day = punchesByDay.get(time.date) || {};
    if (!day.last || time.minutes > day.last.minutes) {
      day.last = { minutes: time.minutes, status: punch.status };
    }
    if (punch.type === 'entrada' && day.entry === undefined) {
      day.entry = time.minutes;
    } else if (punch.type === 'saida_almoco' && day.lunchStart === undefined) {
      day.lunchStart = time.minutes;
    } else if (punch.type === 'retorno_almoco' && day.lunchEnd === undefined) {
      day.lunchEnd = time.minutes;
    } else if (punch.type === 'saida' && (!day.exit || time.minutes > day.exit.minutes)) {
      day.exit = { minutes: time.minutes, status: punch.status };
    }
    punchesByDay.set(time.date, day);
  });

  return Array.from(punchesByDay.entries()).sort(([a], [b]) => b.localeCompare(a)).reduce<MonthlyOvertime>(
    (total, [date, day]) => {
      const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
      const isSaturday = dayOfWeek === 6;
      const isSunday = dayOfWeek === 0;
      // Em fim de semana o funcionário pode ter só entrada e uma segunda marcação
      // (registrada como saída de almoço); a última marcação vale como saída.
      const exit = day.exit ?? (isSaturday || isSunday ? day.last : undefined);
      if (!exit) return total;
      let minutes = 0;

      if (isSunday || (isSaturday && !saturdayUntilNoon)) {
        if (day.entry === undefined || exit.minutes <= day.entry) return total;
        const recordedBreak =
          day.lunchStart !== undefined &&
          day.lunchEnd !== undefined &&
          day.lunchEnd > day.lunchStart
            ? day.lunchEnd - day.lunchStart
            : 0;
        minutes = Math.max(0, exit.minutes - day.entry - recordedBreak);
      } else if (isSaturday && saturdayUntilNoon) {
        const overtimeStart = 12 * 60;
        if (exit.minutes <= overtimeStart) return total;
        const overtimeWindow = exit.minutes - overtimeStart;
        const recordedBreakOverlap =
          day.lunchStart !== undefined &&
          day.lunchEnd !== undefined &&
          day.lunchEnd > day.lunchStart
            ? Math.max(
                0,
                Math.min(exit.minutes, day.lunchEnd) -
                  Math.max(overtimeStart, day.lunchStart),
              )
            : 0;
        minutes = Math.max(0, overtimeWindow - recordedBreakOverlap);
      } else {
        let normalEnd = expectedEnd;
        if (normalEnd === null && day.entry !== undefined) {
          const standardWorkMinutes =
            (timeToMinutes(DEFAULT_WORK_SCHEDULE.lunchStart) || 0) -
            (timeToMinutes(DEFAULT_WORK_SCHEDULE.start) || 0) +
            (timeToMinutes(DEFAULT_WORK_SCHEDULE.end) || 0) -
            (timeToMinutes(DEFAULT_WORK_SCHEDULE.lunchEnd) || 0);
          const recordedBreakMinutes =
            day.lunchStart !== undefined &&
            day.lunchEnd !== undefined &&
            day.lunchEnd > day.lunchStart
              ? day.lunchEnd - day.lunchStart
              : (timeToMinutes(DEFAULT_WORK_SCHEDULE.lunchEnd) || 0) -
                (timeToMinutes(DEFAULT_WORK_SCHEDULE.lunchStart) || 0);
          normalEnd = day.entry + standardWorkMinutes + recordedBreakMinutes;
        }

        if (normalEnd === null) return total;
        minutes = Math.max(0, exit.minutes - normalEnd);
      }

      if (exit.status === 'confirmed') total.confirmedMinutes += minutes;
      else if (exit.status === 'pending') total.pendingMinutes += minutes;
      else return total;
      if (minutes > 0) total.days.push({ date, minutes });
      return total;
    },
    { confirmedMinutes: 0, pendingMinutes: 0, days: [] },
  );
}

export function formatOvertimeMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, '0')}min`;
}
