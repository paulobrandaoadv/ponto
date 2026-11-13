import { attendanceDate, attendanceTime } from './attendance-time';
import { collectWorkShifts, type WorkSessionPunch } from './attendance-worked';

type ReportPunch = WorkSessionPunch & { employeeId: string };
type ReportEmployee = { id: string; name: string };

export function formatReportTimesheetPunch(punch: WorkSessionPunch, entryDate: string) {
  const date = attendanceDate(new Date(punch.recordedAt));
  const time = attendanceTime(new Date(punch.recordedAt));
  return `${time}${date !== entryDate ? ` (${date.split('-').reverse().join('/')})` : ''}${punch.status === 'pending' ? ' *' : ''}`;
}

export function buildReportTimesheet(
  employees: ReportEmployee[],
  punches: ReportPunch[],
  from: string,
  to: string,
) {
  const punchesByEmployee = new Map<string, WorkSessionPunch[]>();
  const employeeIds = new Set(employees.map((employee) => employee.id));
  for (const punch of punches) {
    if (!employeeIds.has(punch.employeeId)) {
      throw new Error('Há marcações de um funcionário que não foi carregado. Atualize a página e tente novamente.');
    }
    const employeePunches = punchesByEmployee.get(punch.employeeId) || [];
    employeePunches.push(punch);
    punchesByEmployee.set(punch.employeeId, employeePunches);
  }

  const rows: Array<{
    employee: ReportEmployee;
    date: string;
    entry: WorkSessionPunch;
    breakStarts: WorkSessionPunch[];
    breakEnds: WorkSessionPunch[];
    exit: WorkSessionPunch | undefined;
  }> = [];
  const anomalies: Array<{ employee: ReportEmployee; punch: WorkSessionPunch }> = [];
  const inPeriod = (date: string) => date >= from && date <= to;

  for (const employee of employees) {
    const result = collectWorkShifts(punchesByEmployee.get(employee.id) || []);
    const shifts = result.current.length ? [...result.shifts, result.current] : result.shifts;
    for (const shift of shifts) {
      const date = attendanceDate(new Date(shift[0].recordedAt));
      if (!inPeriod(date)) continue;
      rows.push({
        employee,
        date,
        entry: shift[0],
        breakStarts: shift.filter((punch) => punch.type === 'saida_almoco'),
        breakEnds: shift.filter((punch) => punch.type === 'retorno_almoco'),
        exit: shift.find((punch) => punch.type === 'saida'),
      });
    }
    for (const punch of result.anomalies) {
      if (inPeriod(attendanceDate(new Date(punch.recordedAt)))) anomalies.push({ employee, punch });
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) ||
    a.employee.name.localeCompare(b.employee.name) ||
    a.entry.recordedAt.localeCompare(b.entry.recordedAt));
  return { rows, anomalies };
}
