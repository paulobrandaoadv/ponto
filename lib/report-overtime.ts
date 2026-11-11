import { calculateMonthlyOvertime, parseWorkSchedule, type OvertimePunch } from './attendance-overtime';
import { attendanceDate } from './attendance-time';
import { calculateWorkedHours, collectWorkShifts } from './attendance-worked';

type ReportEmployee = {
  id: string;
  name: string;
  shift: string;
  saturdayUntilNoon: boolean;
  modalidade: 'mensalista' | 'diarista';
};

type ReportPunch = OvertimePunch & { employeeId: string };

export function calculateReportOvertime(
  employees: ReportEmployee[],
  punches: ReportPunch[],
  from: string,
  to: string,
) {
  const employeeIds = new Set(employees.map((employee) => employee.id));
  if (punches.some((punch) => !employeeIds.has(punch.employeeId))) {
    throw new Error('Há marcações de um funcionário que não foi carregado. Atualize a página e tente novamente.');
  }
  const punchesByEmployee = new Map<string, OvertimePunch[]>();
  for (const punch of punches) {
    const employeePunches = punchesByEmployee.get(punch.employeeId) || [];
    employeePunches.push(punch);
    punchesByEmployee.set(punch.employeeId, employeePunches);
  }

  return employees.map((employee) => {
    const shifts = collectWorkShifts(punchesByEmployee.get(employee.id) || []).shifts.filter((shift) => {
      const date = attendanceDate(new Date(shift[0].recordedAt));
      return date >= from && date <= to;
    });
    const selectedPunches = shifts.flat();
    if (employee.modalidade === 'diarista') {
      const worked = calculateWorkedHours(selectedPunches);
      const pendingMinutes = shifts.reduce((total, shift) =>
        total + (shift.some((punch) => punch.status === 'pending')
          ? calculateWorkedHours(shift).totalMinutes : 0), 0);
      return { employee, totalMinutes: worked.totalMinutes, pendingMinutes, days: worked.days };
    }

    try {
      const overtime = calculateMonthlyOvertime(
        selectedPunches, parseWorkSchedule(employee.shift), employee.saturdayUntilNoon,
      );
      return {
        employee,
        totalMinutes: overtime.confirmedMinutes + overtime.pendingMinutes,
        pendingMinutes: overtime.pendingMinutes,
        days: overtime.days,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Erro no cálculo de horas extras.';
      throw new Error(`${employee.name}: ${detail}`);
    }
  });
}
