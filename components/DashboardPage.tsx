'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import FaceCamera from '@/components/FaceCamera';
import {
  calculateMonthlyOvertime,
  DEFAULT_WORK_SCHEDULE,
  formatOvertimeMinutes,
  isValidWorkSchedule,
  parseWorkSchedule,
  serializeWorkSchedule,
  type OvertimePunch,
  type WorkSchedule,
} from '@/lib/attendance-overtime';
import {
  ATTENDANCE_TIME_ZONE,
  attendanceDate as localDate,
  attendanceTime as localTime,
  attendanceDateTimeToIso,
  nextAttendanceDate,
} from '@/lib/attendance-time';
import { supabase } from '@/lib/supabase';
import { cpfDigits, cpfSearchPattern, displayCpf, formatCpfInput, sameCpf } from '@/lib/cpf';
import { calculateWorkedHours, getEmployeePunchEvent, getWorkIntervals } from '@/lib/attendance-worked';
import { dashboardPeople } from '@/lib/dashboard-people';
import { calculateReportOvertime } from '@/lib/report-overtime';
import { buildReportTimesheet, buildTimesheetExportRows, formatReportTimesheetPunch } from '@/lib/report-timesheet';

type Employee = {
  id: string;
  registrationCode: string;
  name: string;
  cpf: string;
  hasLogin: boolean;
  department: string;
  role: string;
  shift: string;
  saturdayUntilNoon: boolean;
  modalidade: 'mensalista' | 'diarista';
  status: string;
};

type AttendanceEntry = {
  id: string;
  employeeId: string;
  employeeName: string;
  type: 'entrada' | 'saida_almoco' | 'retorno_almoco' | 'saida';
  date: string;
  time: string;
  location: string;
  notes: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
};

type AttendanceAlert = {
  id: string;
  employeeId: string;
  employeeName: string;
  workSessionId: string | null;
  attendanceRecordId: string | null;
  alertType: string;
  severity: string;
  description: string;
  status: 'pending' | 'viewed' | 'in_review' | 'resolved';
  resolutionNotes: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  workedMinutes: number | null;
  breakMinutes: number | null;
};

type SessionProcessingError = {
  id: string;
  employeeName: string;
  eventType: string;
  recordedAt: string;
  error: string;
};

type LocationSnapshot = {
  latitude: number;
  longitude: number;
  accuracy: number;
};

const getLocationSnapshot = () =>
  new Promise<LocationSnapshot>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Este navegador não oferece suporte à localização.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
      }),
      (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? 'Permita o acesso à localização no navegador para registrar o ponto.'
          : error.code === error.POSITION_UNAVAILABLE
            ? 'A localização não está disponível. Ative o GPS ou tente novamente em uma área aberta.'
            : 'A captura da localização demorou demais. Tente novamente.';
        reject(new Error(message));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  });

const displayEventType = (type: AttendanceEntry['type']) => ({
  entrada: 'Entrada',
  saida_almoco: 'Saída almoço',
  retorno_almoco: 'Retorno almoço',
  saida: 'Saída',
}[type]);

const displayPunchType = (type: string) => {
  switch (type) {
    case 'entrada': return 'Entrada';
    case 'saida_almoco': return 'Saída almoço';
    case 'retorno_almoco': return 'Retorno almoço';
    case 'saida': return 'Saída';
    default: return type;
  }
};

const displayAlertType = (type: string) => ({
  prolonged_work: 'Jornada prolongada',
  exceptional_work: 'Jornada excepcional',
  open_too_long: 'Jornada aberta',
  short_break: 'Intervalo menor que o cadastrado',
  outside_schedule: 'Fora do horário cadastrado',
  inconsistent_sequence: 'Sequência inconsistente',
  rejected_punch: 'Marcação rejeitada',
}[type] || type);

const displayAlertStatus = (status: AttendanceAlert['status']) => ({
  pending: 'Pendente',
  viewed: 'Visualizado',
  in_review: 'Em análise',
  resolved: 'Resolvido',
}[status]);

const normalizeShift = (shift: string | null) =>
  shift?.toLowerCase() === 'flex' || shift?.toLowerCase() === 'flexível'
    ? 'Flexível'
    : shift || serializeWorkSchedule(DEFAULT_WORK_SCHEDULE);

const displayShift = (shift: string) => {
  const schedule = parseWorkSchedule(shift);
  return schedule
    ? `${schedule.start}–${schedule.lunchStart} / ${schedule.lunchEnd}–${schedule.end}`
    : shift;
};

const normalizeEmployeeStatus = (status: string) => {
  const normalized = status.toLowerCase();
  if (normalized === 'ativo') return 'Ativo';
  if (normalized === 'férias' || normalized === 'ferias') return 'Férias';
  if (normalized === 'licença' || normalized === 'licenca') return 'Licença';
  if (normalized === 'inativo') return 'Arquivado';
  return status;
};

const csvField = (value: string) => {
  const safeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
};

export default function DashboardPage() {
  const router = useRouter();
  const employeePunchInFlight = useRef(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceEntry[]>([]);
  const [monthlyOvertimePunches, setMonthlyOvertimePunches] = useState<OvertimePunch[]>([]);
  const [overtimeLoadError, setOvertimeLoadError] = useState('');
  const [activeView, setActiveView] = useState<'dashboard' | 'point' | 'employees' | 'administrators' | 'approvals' | 'reports' | 'alerts'>('dashboard');
  const [userEmail, setUserEmail] = useState('');
  const [userRole, setUserRole] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [faceEnrolledEmployeeIds, setFaceEnrolledEmployeeIds] = useState<Set<string>>(new Set());
  const [faceEnrollmentEmployeeId, setFaceEnrollmentEmployeeId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [todayLoadError, setTodayLoadError] = useState('');
  const [peopleDialog, setPeopleDialog] = useState<'collaborators' | 'present' | 'late' | 'missing' | null>(null);
  const peopleDialogRef = useRef<HTMLDialogElement>(null);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [linkingEmployeeId, setLinkingEmployeeId] = useState('');
  const [resettingPasswordEmployeeId, setResettingPasswordEmployeeId] = useState('');
  const [reportFrom, setReportFrom] = useState(() => {
    return `${localDate(new Date()).slice(0, 7)}-01`;
  });
  const [reportTo, setReportTo] = useState(() => localDate(new Date()));
  const [reportEmployeeId, setReportEmployeeId] = useState('');
  const [reportExportType, setReportExportType] = useState<'completa' | 'dia'>('completa');
  const [reportEntries, setReportEntries] = useState<AttendanceEntry[]>([]);
  const [reviewEmployeeId, setReviewEmployeeId] = useState('');
  const [employeePunchEvent, setEmployeePunchEvent] = useState<AttendanceEntry['type']>('entrada');
  const [attendanceAlerts, setAttendanceAlerts] = useState<AttendanceAlert[]>([]);
  const [sessionProcessingErrors, setSessionProcessingErrors] = useState<SessionProcessingError[]>([]);
  const [alertsLoadError, setAlertsLoadError] = useState('');
  const [autoResolveAlerts, setAutoResolveAlerts] = useState<boolean | null>(null);
  const [autoResolveAlertsError, setAutoResolveAlertsError] = useState('');
  const [alertEmployeeFilter, setAlertEmployeeFilter] = useState('');
  const [alertTypeFilter, setAlertTypeFilter] = useState('');
  const [alertStatusFilter, setAlertStatusFilter] = useState('');
  const [alertFrom, setAlertFrom] = useState('');
  const [alertTo, setAlertTo] = useState('');
  const [alertNotes, setAlertNotes] = useState<Record<string, string>>({});
  const [reportOvertime, setReportOvertime] = useState<ReturnType<typeof calculateReportOvertime>>([]);
  const [reportTimesheet, setReportTimesheet] = useState<ReturnType<typeof buildReportTimesheet> | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportLoaded, setReportLoaded] = useState(false);
  const pendingAttendance = useMemo(
    () => attendance.filter((entry) => entry.status === 'pending'),
    [attendance],
  );
  const filteredPendingAttendance = useMemo(
    () => pendingAttendance.filter((entry) => !reviewEmployeeId || entry.employeeId === reviewEmployeeId),
    [pendingAttendance, reviewEmployeeId],
  );
  const isManager = userRole === 'admin' || userRole === 'gestor';
  const isAdmin = userRole === 'admin';
  const isEmployee = userRole === 'funcionario';
  const employeeOvertimeSchedule = useMemo(
    () => parseWorkSchedule(employees[0]?.shift),
    [employees],
  );
  const overtimeCalculation = useMemo(() => {
    try {
      return { result: calculateMonthlyOvertime(
        monthlyOvertimePunches,
        employeeOvertimeSchedule,
        employees[0]?.saturdayUntilNoon || false,
        localDate(new Date()).slice(0, 7),
      ), error: '' };
    } catch (error) {
      return { result: null, error: error instanceof Error ? error.message : 'Não foi possível calcular as horas extras.' };
    }
  }, [monthlyOvertimePunches, employeeOvertimeSchedule, employees]);
  const monthlyOvertime = overtimeCalculation.result;
  const totalMonthlyOvertimeMinutes =
    monthlyOvertime ? monthlyOvertime.confirmedMinutes + monthlyOvertime.pendingMinutes : 0;
  const isDailyWorker = employees[0]?.modalidade === 'diarista';
  const workedHours = useMemo(() => calculateWorkedHours(monthlyOvertimePunches), [monthlyOvertimePunches]);
  const scheduleDefaults = parseWorkSchedule(editingEmployee?.shift) || DEFAULT_WORK_SCHEDULE;
  const nextEmployeeEvent = workedHours.nextEvent;
  const employeeWorkState = workedHours.state;
  const effectiveEmployeePunchEvent = getEmployeePunchEvent(employeeWorkState, employeePunchEvent);
  const lastEmployeePunch = monthlyOvertimePunches.length
    ? monthlyOvertimePunches[monthlyOvertimePunches.length - 1]
    : null;

  useEffect(() => {
    const dialog = peopleDialogRef.current;
    if (peopleDialog && dialog && !dialog.open) dialog.showModal();
    if (!peopleDialog && dialog?.open) dialog.close();
  }, [peopleDialog]);

  useEffect(() => {
    if (employeeWorkState === 'not_started' || employeeWorkState === 'closed') {
      setEmployeePunchEvent('entrada');
    } else if (employeeWorkState === 'on_break') {
      setEmployeePunchEvent('retorno_almoco');
    } else {
      setEmployeePunchEvent('saida_almoco');
    }
  }, [employeeWorkState]);

  useEffect(() => {
    const loadDashboard = async () => {
      if (!supabase) {
        router.push('/login');
        return;
      }

      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) {
        setErrorMessage(`Não foi possível verificar a sessão: ${sessionError.message}`);
        setLoading(false);
        return;
      }

      if (!data.session) {
        router.push('/login');
        return;
      }

      setUserEmail(data.session.user.email || '');

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('company_id, role, status')
        .eq('id', data.session.user.id)
        .maybeSingle();

      if (profileError) {
        setErrorMessage(`Não foi possível carregar seu perfil: ${profileError.message}`);
        setLoading(false);
        return;
      }

      if (!profile) {
        setErrorMessage(
          `Não existe um perfil do sistema para ${data.session.user.email || 'este usuário'}. Crie o perfil em public.profiles no Supabase e vincule-o a uma empresa.`,
        );
        setLoading(false);
        return;
      }

      if (!profile.company_id) {
        setErrorMessage('Seu perfil não está vinculado a uma empresa. Preencha company_id em public.profiles.');
        setLoading(false);
        return;
      }

      if (!['admin', 'gestor', 'funcionario'].includes(profile.role) || profile.status !== 'ativo') {
        setErrorMessage('Seu perfil está inativo ou não tem uma função reconhecida no sistema.');
        setLoading(false);
        return;
      }

      setUserRole(profile.role);
      setActiveView(profile.role === 'funcionario' ? 'point' : 'dashboard');
      setCompanyId(profile.company_id);

      if (profile.role === 'admin' || profile.role === 'gestor') {
        try {
          const faceResponse = await fetch('/api/faces', {
            headers: { Authorization: `Bearer ${data.session.access_token}` },
          });
          const faceResult = await faceResponse.json() as {
            error?: string;
            enrolledEmployeeIds?: string[];
          };
          if (faceResponse.ok && Array.isArray(faceResult.enrolledEmployeeIds)) {
            setFaceEnrolledEmployeeIds(new Set(faceResult.enrolledEmployeeIds));
          } else {
            setErrorMessage(faceResult.error || 'Não foi possível consultar os cadastros faciais.');
          }
        } catch {
          setErrorMessage('Não foi possível consultar os cadastros faciais.');
        }
      }

      const [employeesResult, departmentsResult, attendanceResult] = await Promise.all([
        supabase
          .from('employees')
          .select('id, codigo_registro, nome, cpf, user_id, departamento_id, cargo, jornada, sabado_ate_meio_dia, modalidade, status')
          .eq('company_id', profile.company_id)
          .order('nome'),
        supabase
          .from('departments')
          .select('id, nome')
          .eq('company_id', profile.company_id)
          .order('nome'),
        supabase
          .from('attendance_records')
          .select('id, employee_id, event_type, recorded_at, location, notes, status, latitude, longitude, accuracy')
          .eq('company_id', profile.company_id)
          .order('recorded_at', { ascending: false })
          .limit(100),
      ]);

      const queryError = employeesResult.error || departmentsResult.error || attendanceResult.error;
      if (queryError) {
        setErrorMessage(`Não foi possível carregar os dados: ${queryError.message}`);
        setLoading(false);
        return;
      }

      const pendingRecords = [];
      const pendingPageSize = 500;
      let pendingOffset = 0;
      while (true) {
        const { data: pendingPage, error: pendingError } = await supabase
          .from('attendance_records')
          .select('id, employee_id, event_type, recorded_at, location, notes, status, latitude, longitude, accuracy')
          .eq('company_id', profile.company_id)
          .eq('status', 'pending')
          .order('recorded_at', { ascending: false })
          .range(pendingOffset, pendingOffset + pendingPageSize - 1);

        if (pendingError) {
          setErrorMessage(`Não foi possível carregar marcações pendentes: ${pendingError.message}`);
          setLoading(false);
          return;
        }

        pendingRecords.push(...(pendingPage || []));
        if (!pendingPage || pendingPage.length < pendingPageSize) break;
        pendingOffset += pendingPageSize;
      }

      const todayRecords: typeof pendingRecords = [];
      if (profile.role === 'admin' || profile.role === 'gestor') {
        const today = localDate(new Date());
        const start = attendanceDateTimeToIso(today);
        const end = attendanceDateTimeToIso(nextAttendanceDate(today));
        let offset = 0;
        while (true) {
          const { data: page, error: todayError } = await supabase
            .from('attendance_records')
            .select('id, employee_id, event_type, recorded_at, location, notes, status, latitude, longitude, accuracy')
            .eq('company_id', profile.company_id)
            .gte('recorded_at', start)
            .lt('recorded_at', end)
            .order('recorded_at', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + 499);
          if (todayError) {
            setTodayLoadError(`Não foi possível carregar todas as marcações de hoje: ${todayError.message}`);
            break;
          }
          todayRecords.push(...(page || []));
          if (!page || page.length < 500) break;
          offset += 500;
        }
      }

      const departmentNames = new Map(
        (departmentsResult.data || []).map((department) => [department.id, department.nome]),
      );
      const loadedEmployees = (employeesResult.data || []).map((employee) => ({
        id: employee.id,
        registrationCode: employee.codigo_registro,
        name: employee.nome,
        cpf: employee.cpf,
        hasLogin: Boolean(employee.user_id),
        department: employee.departamento_id
          ? departmentNames.get(employee.departamento_id) || 'Sem departamento'
          : 'Sem departamento',
        role: employee.cargo || '',
        shift: normalizeShift(employee.jornada),
        saturdayUntilNoon: Boolean(employee.sabado_ate_meio_dia),
        modalidade: employee.modalidade === 'diarista' ? 'diarista' as const : 'mensalista' as const,
        status: normalizeEmployeeStatus(employee.status),
      }));
      const employeeNames = new Map(loadedEmployees.map((employee) => [employee.id, employee.name]));

      setOvertimeLoadError('');
      setMonthlyOvertimePunches([]);
      if (profile.role === 'funcionario' && loadedEmployees[0]) {
        const allRecords: OvertimePunch[] = [];
        const pageSize = 500;
        let offset = 0;
        while (true) {
          const query = supabase
            .from('attendance_records')
            .select('event_type, recorded_at, status')
            .eq('company_id', profile.company_id)
            .eq('employee_id', loadedEmployees[0].id);
          const { data: overtimeRecords, error: overtimeError } = await query
            .order('recorded_at', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + pageSize - 1);
          if (overtimeError) {
            setOvertimeLoadError(`Não foi possível carregar as marcações para o cálculo de horas: ${overtimeError.message}`);
            break;
          }
          allRecords.push(...(overtimeRecords || []).map((record) => ({
              type: record.event_type,
              recordedAt: record.recorded_at,
              status: record.status,
          })));
          if (!overtimeRecords || overtimeRecords.length < pageSize) {
            setMonthlyOvertimePunches(allRecords);
            break;
          }
          offset += pageSize;
        }
      }

      setEmployees(loadedEmployees);
      const attendanceById = new Map(
        [...(attendanceResult.data || []), ...pendingRecords, ...todayRecords].map((record) => [record.id, record]),
      );
      setAttendance(
        Array.from(attendanceById.values())
          .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at))
          .map((record) => ({
          id: record.id,
          employeeId: record.employee_id,
          employeeName: employeeNames.get(record.employee_id) || 'Funcionário',
          type: record.event_type,
          date: localDate(new Date(record.recorded_at)),
          time: localTime(new Date(record.recorded_at)),
          location: record.location || '—',
          notes: record.notes || '',
          status: record.status,
            latitude: record.latitude,
            longitude: record.longitude,
            accuracy: record.accuracy,
          })),
      );
      if (profile.role === 'admin' || profile.role === 'gestor') {
        const { data: alertSettings, error: settingsError } = await supabase
          .from('attendance_alert_settings')
          .select('auto_resolve_daily')
          .eq('company_id', profile.company_id)
          .maybeSingle();
        if (settingsError) {
          setAutoResolveAlertsError(`Não foi possível carregar a configuração de encerramento automático: ${settingsError.message}`);
        } else {
          setAutoResolveAlerts(alertSettings?.auto_resolve_daily ?? false);
          setAutoResolveAlertsError('');
        }
        let alertLoadError = '';
        const { error: refreshAlertsError } = await supabase.rpc('refresh_attendance_alerts');
        if (refreshAlertsError) {
          alertLoadError = `Não foi possível atualizar os alertas. Aplique a migration de jornadas contínuas e atualize a página. Detalhe: ${refreshAlertsError.message}`;
        } else {
          const alertRows = [];
          let alertsError: { message: string } | null = null;
          for (let offset = 0; ; offset += 500) {
            const { data: page, error } = await supabase
              .from('attendance_alerts')
              .select('id, employee_id, work_session_id, attendance_record_id, alert_type, severity, description, status, resolution_notes, created_at')
              .eq('company_id', profile.company_id)
              .order('created_at', { ascending: false })
              .order('id', { ascending: false })
              .range(offset, offset + 499);
            if (error) {
              alertsError = error;
              break;
            }
            alertRows.push(...(page || []));
            if (!page || page.length < 500) break;
          }
          if (alertsError) {
            alertLoadError = `Não foi possível carregar os alertas: ${alertsError.message}`;
          } else {
            const rows = alertRows;
            const { data: processingErrors, error: processingErrorsError } = await supabase
              .from('attendance_records')
              .select('id, employee_id, event_type, recorded_at, work_session_error')
              .eq('company_id', profile.company_id)
              .not('work_session_error', 'is', null)
              .order('recorded_at', { ascending: false })
              .limit(100);
            if (processingErrorsError) {
              alertLoadError = `Não foi possível consultar falhas de associação das jornadas: ${processingErrorsError.message}`;
            } else {
              setSessionProcessingErrors((processingErrors || []).map((item) => ({
                id: item.id,
                employeeName: employeeNames.get(item.employee_id) || 'Funcionário',
                eventType: item.event_type,
                recordedAt: item.recorded_at,
                error: item.work_session_error,
              })));
            }
            const sessionIds = Array.from(new Set(rows.flatMap((row) => row.work_session_id ? [row.work_session_id] : [])));
            const sessionMap = new Map<string, { started_at: string; ended_at: string | null }>();
            const sessionPunches = new Map<string, Array<{ type: string; recordedAt: string; status: string }>>();
            if (sessionIds.length) {
              const { data: sessions, error: sessionsError } = await supabase
                .from('work_sessions')
                .select('id, started_at, ended_at')
                .in('id', sessionIds);
              const punches = [];
              let punchesError: { message: string } | null = null;
              if (!sessionsError) {
                for (let offset = 0; ; offset += 500) {
                  const { data: page, error } = await supabase.from('attendance_records')
                  .select('id, work_session_id, event_type, recorded_at, status')
                  .in('work_session_id', sessionIds)
                  .in('status', ['confirmed', 'pending'])
                  .order('recorded_at')
                  .order('id')
                  .range(offset, offset + 499);
                  if (error) {
                    punchesError = error;
                    break;
                  }
                  punches.push(...(page || []));
                  if (!page || page.length < 500) break;
                }
              }
              if (sessionsError || punchesError) {
                alertLoadError = `Não foi possível carregar os detalhes das jornadas: ${sessionsError?.message || punchesError?.message}`;
              } else {
                for (const session of sessions || []) {
                  sessionMap.set(session.id, { started_at: session.started_at, ended_at: session.ended_at });
                }
                for (const punch of punches) {
                  if (!punch.work_session_id) continue;
                  const punchesForSession = sessionPunches.get(punch.work_session_id) || [];
                  punchesForSession.push({
                    type: punch.event_type,
                    recordedAt: punch.recorded_at,
                    status: punch.status,
                  });
                  sessionPunches.set(punch.work_session_id, punchesForSession);
                }
              }
            }
            setAttendanceAlerts(rows.map((row) => {
              const session = row.work_session_id ? sessionMap.get(row.work_session_id) : null;
              const punches = row.work_session_id ? sessionPunches.get(row.work_session_id) || [] : [];
              const intervals = punches.length ? getWorkIntervals(punches) : [];
              let workedMilliseconds = intervals.reduce((total, [start, end]) => total + end - start, 0);
              let breakMilliseconds = 0;
              let breakStartedAt: number | null = null;
              for (const punch of punches) {
                const timestamp = Date.parse(punch.recordedAt);
                if (punch.type === 'saida_almoco') breakStartedAt = timestamp;
                if (punch.type === 'retorno_almoco' && breakStartedAt !== null) {
                  breakMilliseconds += timestamp - breakStartedAt;
                  breakStartedAt = null;
                }
              }
              if (session?.ended_at === null && punches.length) {
                const now = Date.now();
                if (breakStartedAt !== null) breakMilliseconds += now - breakStartedAt;
                else {
                  const lastPunch = punches[punches.length - 1];
                  if (lastPunch.type === 'entrada' || lastPunch.type === 'retorno_almoco') {
                    workedMilliseconds += now - Date.parse(lastPunch.recordedAt);
                  }
                }
              }
              const employee = loadedEmployees.find((item) => item.id === row.employee_id);
              return {
                id: row.id,
                employeeId: row.employee_id,
                employeeName: employee?.name || 'Funcionário',
                workSessionId: row.work_session_id,
                attendanceRecordId: row.attendance_record_id,
                alertType: row.alert_type,
                severity: row.severity,
                description: row.description,
                status: row.status,
                resolutionNotes: row.resolution_notes || '',
                createdAt: row.created_at,
                startedAt: session?.started_at || null,
                endedAt: session?.ended_at || null,
                workedMinutes: session ? Math.floor(workedMilliseconds / 60000) : null,
                breakMinutes: session ? Math.floor(breakMilliseconds / 60000) : null,
              };
            }));
          }
        }
        setAlertsLoadError(alertLoadError);
      }
      setLoading(false);
    };

    loadDashboard();
  }, [router]);

  const stats = useMemo(() => {
    const people = dashboardPeople(employees, attendance, localDate(new Date()));
    const activeEmployees = people.collaborators;
    const activeEmployeeIds = new Set(activeEmployees.map((employee) => employee.id));
    const today = localDate(new Date());
    const present = people.present.length;
    const late = people.late.length;
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthlyEntries = attendance.filter((item) => item.date >= monthStart);
    const validMonthlyEntries = monthlyEntries.filter((item) => item.status !== 'rejected');

    return {
      employees: activeEmployees.length,
      present,
      late,
      monthlyEntries: monthlyEntries.length,
      monthlyActiveEmployees: new Set(
        validMonthlyEntries
          .filter((item) => item.type === 'entrada' && activeEmployeeIds.has(item.employeeId))
          .map((item) => item.employeeId),
      ).size,
      activeTeam: present,
      missing: people.missing.length,
      departmentCount: new Set(activeEmployees.map((employee) => employee.department)).size,
      people,
    };
  }, [attendance, employees]);
  const filteredAttendanceAlerts = useMemo(() => attendanceAlerts.filter((alert) => {
    const date = localDate(new Date(alert.startedAt || alert.createdAt));
    return (!alertEmployeeFilter || alert.employeeId === alertEmployeeFilter) &&
      (!alertTypeFilter || alert.alertType === alertTypeFilter) &&
      (!alertStatusFilter || alert.status === alertStatusFilter) &&
      (!alertFrom || date >= alertFrom) &&
      (!alertTo || date <= alertTo);
  }), [alertEmployeeFilter, alertFrom, alertStatusFilter, alertTo, alertTypeFilter, attendanceAlerts]);

  const handleReportSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage('');
    setMessage('');

    if (!supabase || !companyId) {
      setErrorMessage('Não foi possível acessar a empresa da sessão. Entre novamente no sistema.');
      return;
    }

    if (!reportFrom || !reportTo || reportFrom > reportTo) {
      setErrorMessage('Informe um período válido: a data inicial deve ser anterior ou igual à final.');
      return;
    }

    let startIso: string;
    let endIso: string;
    try {
      startIso = attendanceDateTimeToIso(reportFrom);
      endIso = attendanceDateTimeToIso(nextAttendanceDate(reportTo));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível determinar o período do relatório.');
      return;
    }

    setReportLoading(true);
    setReportLoaded(false);
    const records: Array<{
      id: string;
      employee_id: string;
      event_type: AttendanceEntry['type'];
      recorded_at: string;
      location: string | null;
      notes: string | null;
      status: string;
      latitude: number | null;
      longitude: number | null;
      accuracy: number | null;
    }> = [];
    const pageSize = 500;
    let offset = 0;

    while (true) {
      let query = supabase
        .from('attendance_records')
        .select('id, employee_id, event_type, recorded_at, location, notes, status, latitude, longitude, accuracy')
        .eq('company_id', companyId)
        .order('recorded_at', { ascending: true })
        .order('id', { ascending: true });

      if (reportEmployeeId) {
        query = query.eq('employee_id', reportEmployeeId);
      }

      const { data, error } = await query.range(offset, offset + pageSize - 1);

      if (error) {
        setErrorMessage(`Não foi possível gerar o relatório: ${error.message}`);
        setReportLoading(false);
        return;
      }

      records.push(...(data || []));
      if (!data || data.length < pageSize) break;
      offset += pageSize;
    }

    const reportEmployees = reportEmployeeId
      ? employees.filter((employee) => employee.id === reportEmployeeId)
      : employees;
    try {
      const reportPunches = records.map((record) => ({
        id: record.id,
        employeeId: record.employee_id,
        type: record.event_type,
        recordedAt: record.recorded_at,
        status: record.status,
      }));
      setReportOvertime(calculateReportOvertime(
        reportEmployees,
        reportPunches,
        reportFrom,
        reportTo,
      ));
      setReportTimesheet(isAdmin ? buildReportTimesheet(reportEmployees, reportPunches, reportFrom, reportTo) : null);
    } catch (error) {
      setErrorMessage(`Não foi possível calcular as horas extras do relatório: ${error instanceof Error ? error.message : 'Erro desconhecido.'}`);
      setReportLoading(false);
      return;
    }

    const employeeNames = new Map(employees.map((employee) => [employee.id, employee.name]));
    setReportEntries(
      records.filter((record) => Date.parse(record.recorded_at) >= Date.parse(startIso) &&
        Date.parse(record.recorded_at) < Date.parse(endIso)).map((record) => ({
        id: record.id,
        employeeId: record.employee_id,
        employeeName: employeeNames.get(record.employee_id) || 'Funcionário',
        type: record.event_type,
        date: localDate(new Date(record.recorded_at)),
        time: localTime(new Date(record.recorded_at)),
        location: record.location || '—',
        notes: record.notes || '',
        status: record.status,
        latitude: record.latitude,
        longitude: record.longitude,
        accuracy: record.accuracy,
      })),
    );
    setReportLoaded(true);
    setReportLoading(false);
  };

  const handleReportExport = () => {
    if (reportExportType === 'dia' && (!isAdmin || !reportTimesheet)) {
      setErrorMessage('Não foi possível exportar o quadro por dia. Consulte o período novamente.');
      return;
    }
    const headers = [
      'Funcionário',
      'Data',
      'Hora',
      'Tipo',
      'Status',
      'Local informado',
      'Latitude',
      'Longitude',
      'Precisão GPS (m)',
      'Observações',
    ];
    const rows = reportEntries.map((entry) => [
      entry.employeeName,
      entry.date,
      entry.time,
      displayEventType(entry.type),
      entry.status,
      entry.location,
      entry.latitude?.toString() || '',
      entry.longitude?.toString() || '',
      entry.accuracy?.toString() || '',
      entry.notes,
    ]);
    const exportRows = reportExportType === 'dia' && reportTimesheet
      ? buildTimesheetExportRows(reportTimesheet)
      : [headers, ...rows];
    const csv = exportRows
      .map((row) => row.map((field) => csvField(field)).join(';'))
      .join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    const employeeSuffix = reportEmployeeId
      ? `_${employees.find((employee) => employee.id === reportEmployeeId)?.name.replace(/[^A-Za-z0-9-]+/g, '_') || 'funcionario'}`
      : '';
    const typeSuffix = reportExportType === 'dia' ? '_por_dia' : '';
    downloadLink.download = `anbelo-ponto${typeSuffix}${employeeSuffix}_${reportFrom}_${reportTo}.csv`;
    downloadLink.click();
    URL.revokeObjectURL(url);
  };

  const handleEmployeeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = String(formData.get('name') || '').trim();
    const cpf = String(formData.get('cpf') || '').trim();
    const department = String(formData.get('department') || '').trim();
    const role = String(formData.get('role') || '').trim();
    const flexibleSchedule = formData.get('flexibleSchedule') === 'on';
    const saturdayUntilNoon = formData.get('saturdayUntilNoon') === 'on';
    const modalidade = String(formData.get('modalidade') || '');
    const schedule: WorkSchedule = {
      start: String(formData.get('workStart') || ''),
      lunchStart: String(formData.get('lunchStart') || ''),
      lunchEnd: String(formData.get('lunchEnd') || ''),
      end: String(formData.get('workEnd') || ''),
    };

    const shift = flexibleSchedule ? 'Flexível' : serializeWorkSchedule(schedule);
    const status = String(formData.get('status') || 'Ativo');
    const accountEmail = String(formData.get('accountEmail') || '').trim();
    const accountPassword = String(formData.get('accountPassword') || '');

    if (!supabase || !companyId || !name || !cpf || !department || !role) return;
    if (modalidade !== 'mensalista' && modalidade !== 'diarista') {
      setErrorMessage('Selecione uma modalidade válida para o funcionário.');
      return;
    }
    if (!flexibleSchedule && !isValidWorkSchedule(schedule)) {
      setErrorMessage('Confira os horários: entrada, saída para almoço, retorno do almoço e saída devem estar em ordem.');
      return;
    }
    if (!editingEmployee && (!accountEmail || !accountPassword)) {
      setErrorMessage('Informe o e-mail e a senha inicial para criar o acesso do funcionário.');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');

    let duplicateQuery = supabase
      .from('employees')
      .select('id, cpf')
      .eq('company_id', companyId);
    duplicateQuery = cpfDigits(cpf).length === 11
      ? duplicateQuery.like('cpf', cpfSearchPattern(cpf))
      : duplicateQuery.eq('cpf', cpf);
    if (editingEmployee) {
      duplicateQuery = duplicateQuery.neq('id', editingEmployee.id);
    }
    const { data: matches, error: duplicateError } = await duplicateQuery;

    if (duplicateError) {
      setErrorMessage(`Não foi possível verificar o CPF: ${duplicateError.message}`);
      setSaving(false);
      return;
    }

    if (matches?.some((employee) => sameCpf(cpf, employee.cpf))) {
      setErrorMessage('Já existe um funcionário cadastrado com esse CPF nesta empresa.');
      setSaving(false);
      return;
    }

    if (!editingEmployee) {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData.session) {
        setErrorMessage('Sua sessão expirou. Entre novamente para cadastrar o funcionário.');
        setSaving(false);
        return;
      }

      let response: Response;
      let result: {
        error?: string;
        employeeId?: string;
        registrationCode?: string | null;
        warning?: string;
      };
      try {
        response = await fetch('/api/employees', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionData.session.access_token}`,
          },
          body: JSON.stringify({
            name,
            email: accountEmail,
            password: accountPassword,
            cpf,
            department,
            jobTitle: role,
            shift,
            saturdayUntilNoon,
            modalidade,
            status,
          }),
        });
        result = await response.json() as typeof result;
      } catch {
        setErrorMessage('Não foi possível conectar ao servidor para criar o acesso do funcionário.');
        setSaving(false);
        return;
      }

      const employeeId = result.employeeId;
      if (!response.ok || typeof employeeId !== 'string') {
        setErrorMessage(result.error || 'Não foi possível criar o funcionário e sua conta de acesso.');
        setSaving(false);
        return;
      }

      setEmployees((current) => [
        ...current,
        {
          id: employeeId,
          registrationCode: result.registrationCode || '—',
          name,
          cpf,
          hasLogin: true,
          department,
          role,
          shift,
          saturdayUntilNoon,
          modalidade,
          status,
        },
      ]);
      setMessage(
        result.registrationCode
          ? `Funcionário cadastrado com o código ${result.registrationCode}. Ele já pode entrar com o nome ${name} e a senha inicial definida.`
          : result.warning || `Funcionário cadastrado. Ele já pode entrar com o nome ${name} e a senha inicial definida.`,
      );
      setSaving(false);
      form.reset();
      return;
    }

    let { data: departmentRecord, error: departmentError } = await supabase
      .from('departments')
      .select('id')
      .eq('company_id', companyId)
      .eq('nome', department)
      .limit(1)
      .maybeSingle();

    if (!departmentError && !departmentRecord) {
      const result = await supabase
        .from('departments')
        .insert({ company_id: companyId, nome: department })
        .select('id')
        .single();
      departmentRecord = result.data;
      departmentError = result.error;
    }

    if (departmentError || !departmentRecord) {
      setErrorMessage(`Não foi possível salvar o departamento: ${departmentError?.message || 'registro não retornado'}`);
      setSaving(false);
      return;
    }

    const employeePayload = {
      company_id: companyId,
      nome: name,
      cpf,
      departamento_id: departmentRecord.id,
      cargo: role,
      jornada: shift,
      sabado_ate_meio_dia: saturdayUntilNoon,
      modalidade,
      situacao: status === 'Arquivado' ? 'inativo' : status.toLowerCase(),
      status: status === 'Arquivado' ? 'Inativo' : status,
    };
    const employeeQuery = editingEmployee
      ? supabase
          .from('employees')
          .update(employeePayload)
          .eq('id', editingEmployee.id)
          .eq('company_id', companyId)
          .select('id')
          .single()
      : supabase
          .from('employees')
          .insert(employeePayload)
          .select('id')
          .single();
    const { data: employeeRecord, error: employeeError } = await employeeQuery;

    if (employeeError || !employeeRecord) {
      setErrorMessage(`Não foi possível salvar o funcionário: ${employeeError?.message || 'registro não retornado'}`);
      setSaving(false);
      return;
    }

    const savedEmployee: Employee = {
      id: employeeRecord.id,
      registrationCode: editingEmployee?.registrationCode || '',
      name,
      cpf,
      hasLogin: editingEmployee?.hasLogin || false,
      department,
      role,
      shift,
      saturdayUntilNoon,
      modalidade,
      status: normalizeEmployeeStatus(status),
    };
    setEmployees((current) =>
      editingEmployee
        ? current.map((employee) => employee.id === editingEmployee.id ? savedEmployee : employee)
        : [...current, savedEmployee],
    );
    setMessage(editingEmployee ? 'Funcionário atualizado no Supabase.' : 'Funcionário cadastrado no Supabase.');
    setSaving(false);
    setEditingEmployee(null);
    form.reset();
  };

  const handleReviewAttendance = async (
    entry: AttendanceEntry,
    status: 'confirmed' | 'rejected',
  ) => {
    if (!supabase) {
      setErrorMessage('Supabase não está configurado.');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');

    const { error } = await supabase.rpc('review_attendance_record', {
      p_record_id: entry.id,
      p_status: status,
    });

    if (error) {
      setErrorMessage(`Não foi possível revisar a marcação: ${error.message}`);
      setSaving(false);
      return;
    }

    setAttendance((current) =>
      current.map((item) => item.id === entry.id ? { ...item, status } : item),
    );
    setMessage(status === 'confirmed' ? 'Marcação confirmada.' : 'Marcação rejeitada.');
    setSaving(false);
  };

  const handleReviewAlert = async (
    alert: AttendanceAlert,
    status: AttendanceAlert['status'],
  ) => {
    if (!supabase) {
      setErrorMessage('Supabase não está configurado.');
      return;
    }
    const notes = alertNotes[alert.id] || '';
    if (status === 'resolved' && !notes.trim()) {
      setErrorMessage('Informe a justificativa/providência antes de resolver o alerta.');
      return;
    }
    setSaving(true);
    setMessage('');
    setErrorMessage('');
    const { error } = await supabase.rpc('review_attendance_alert', {
      p_alert_id: alert.id,
      p_status: status,
      p_resolution_notes: notes.trim() || null,
    });
    if (error) {
      setErrorMessage(`Não foi possível atualizar o alerta: ${error.message}`);
      setSaving(false);
      return;
    }
    setAttendanceAlerts((current) => current.map((item) =>
      item.id === alert.id ? {
        ...item,
        status,
        resolutionNotes: notes.trim() || item.resolutionNotes,
      } : item));
    setMessage('Situação do alerta atualizada e registrada na auditoria.');
    setSaving(false);
  };

  const handleAutoResolveAlerts = async (enabled: boolean) => {
    if (!supabase) {
      setAutoResolveAlertsError('Supabase não está configurado.');
      return;
    }

    setSaving(true);
    setMessage('');
    setAutoResolveAlertsError('');
    try {
      const { error } = await supabase.rpc('set_daily_alert_auto_resolution', { p_enabled: enabled });
      if (error) {
        setAutoResolveAlertsError(`Não foi possível alterar o encerramento automático: ${error.message}`);
      } else {
        setAutoResolveAlerts(enabled);
        setMessage(enabled ? 'Encerramento automático ativado para esta empresa.' : 'Encerramento automático desativado para esta empresa.');
      }
    } catch (error) {
      setAutoResolveAlertsError(`Não foi possível alterar o encerramento automático: ${error instanceof Error ? error.message : 'erro de conexão desconhecido'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleAdministratorSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) {
      setErrorMessage('O sistema de autenticação não está configurado.');
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = String(formData.get('administratorName') || '').trim();
    const email = String(formData.get('administratorEmail') || '').trim();
    const password = String(formData.get('administratorPassword') || '');
    if (!name || !email || !password) {
      setErrorMessage('Preencha nome, e-mail e senha do novo administrador.');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      setErrorMessage('Sua sessão expirou. Entre novamente para cadastrar um administrador.');
      setSaving(false);
      return;
    }

    let response: Response;
    let result: { error?: string; success?: boolean; name?: string; email?: string };
    try {
      response = await fetch('/api/administrators', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify({ name, email, password }),
      });
      result = await response.json() as typeof result;
    } catch {
      setErrorMessage('Não foi possível conectar ao servidor para criar o administrador.');
      setSaving(false);
      return;
    }

    if (!response.ok || !result.success) {
      setErrorMessage(result.error || 'Não foi possível criar o administrador.');
      setSaving(false);
      return;
    }

    setMessage(`Administrador ${result.name || name} cadastrado com acesso completo à empresa.`);
    setSaving(false);
    form.reset();
  };

  const handleAttendanceSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const employeeId = String(formData.get('employeeId') || '');
    const employee = isEmployee
      ? employees[0]
      : employees.find((item) => item.id === employeeId);

    if (!supabase || !companyId || !employee) {
      setErrorMessage(
        isEmployee
          ? 'Sua conta ainda não está vinculada a um cadastro ativo de funcionário. Peça ao administrador para vincular seu usuário.'
          : 'Selecione um funcionário cadastrado antes de registrar o ponto.',
      );
      return;
    }

    const location = String(formData.get('location') || 'N/A').trim();
    const notes = String(formData.get('notes') || '').trim();

    if (isEmployee) {
      if (!employeePunchEvent || overtimeLoadError) {
        setErrorMessage('Não foi possível continuar a jornada. Solicite a revisão das marcações ao administrador.');
        return;
      }

      if (employeePunchInFlight.current) return;
      employeePunchInFlight.current = true;
      setSaving(true);
      setMessage('');
      setErrorMessage('');
      let locationSnapshot: LocationSnapshot;
      try {
        locationSnapshot = await getLocationSnapshot();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Não foi possível obter sua localização.');
        employeePunchInFlight.current = false;
        setSaving(false);
        return;
      }

      let recordId: string | null = null;
      let punchError: { message: string } | null = null;
      try {
        const punchResult = await supabase.rpc('record_own_attendance', {
          p_event_type: effectiveEmployeePunchEvent,
          p_request_id: crypto.randomUUID(),
          p_location: location || null,
          p_notes: notes || null,
          p_latitude: locationSnapshot.latitude,
          p_longitude: locationSnapshot.longitude,
          p_accuracy: locationSnapshot.accuracy,
        });
        recordId = punchResult.data;
        punchError = punchResult.error;
      } catch (error) {
        setErrorMessage(`Não foi possível registrar seu ponto: ${error instanceof Error ? error.message : 'erro de conexão desconhecido'}`);
        employeePunchInFlight.current = false;
        setSaving(false);
        return;
      }

      if (punchError || !recordId) {
        setErrorMessage(`Não foi possível registrar seu ponto: ${punchError?.message || 'registro não retornado'}`);
        employeePunchInFlight.current = false;
        setSaving(false);
        return;
      }

      const { data: savedPunch, error: savedPunchError } = await supabase
        .from('attendance_records')
        .select('event_type, recorded_at, status')
        .eq('id', recordId)
        .single();
      if (savedPunchError || !savedPunch) {
        setErrorMessage('O ponto foi registrado, mas não foi possível atualizar o horário na tela. Atualize a página antes de fazer outra marcação.');
        employeePunchInFlight.current = false;
        setSaving(false);
        return;
      }

      const recordedAt = new Date(savedPunch.recorded_at);
      setAttendance((current) => [
        {
          id: recordId,
          employeeId: employee.id,
          employeeName: employee.name,
          type: savedPunch.event_type,
          date: localDate(recordedAt),
          time: localTime(recordedAt),
          location: location || '—',
          notes,
          status: savedPunch.status,
          latitude: locationSnapshot.latitude,
          longitude: locationSnapshot.longitude,
          accuracy: locationSnapshot.accuracy,
        },
        ...current,
      ]);
      setMonthlyOvertimePunches((current) => [
        ...current,
        {
          type: savedPunch.event_type,
          recordedAt: savedPunch.recorded_at,
          status: savedPunch.status,
        },
      ]);
      setMessage(
        `${displayEventType(savedPunch.event_type)} registrada às ${localTime(recordedAt)} (horário de Mato Grosso do Sul), com localização GPS (precisão aproximada de ${Math.round(locationSnapshot.accuracy)} m) e enviada para revisão.`,
      );
      if (effectiveEmployeePunchEvent === 'saida') {
        setEmployeePunchEvent('entrada');
      } else if (effectiveEmployeePunchEvent === 'entrada' || effectiveEmployeePunchEvent === 'retorno_almoco') {
        setEmployeePunchEvent('saida_almoco');
      } else {
        setEmployeePunchEvent('retorno_almoco');
      }
      employeePunchInFlight.current = false;
      setSaving(false);
      form.reset();
      return;
    }

    const type = String(formData.get('type') || 'entrada') as AttendanceEntry['type'];
    const date = String(formData.get('date') || localDate(new Date()));
    const time = String(formData.get('time') || localTime(new Date()));
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError || !sessionData.session) {
      setErrorMessage(sessionError?.message || 'Sua sessão expirou. Entre novamente.');
      router.push('/login');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');
    let recordedAt: string;
    try {
      recordedAt = attendanceDateTimeToIso(date, time);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível determinar o horário da marcação.');
      setSaving(false);
      return;
    }
    const { data: record, error: insertError } = await supabase
      .from('attendance_records')
      .insert({
        employee_id: employee.id,
        company_id: companyId,
        source: 'web',
        event_type: type,
        recorded_at: recordedAt,
        timezone: ATTENDANCE_TIME_ZONE,
        status: 'pending',
        location: location || null,
        notes: notes || null,
        recorded_by: sessionData.session.user.id,
      })
      .select('id')
      .single();

    if (insertError || !record) {
      setErrorMessage(`Não foi possível registrar o ponto: ${insertError?.message || 'registro não retornado'}`);
      setSaving(false);
      return;
    }

    setAttendance((current) => [
      {
        id: record.id,
        employeeId: employee.id,
        employeeName: employee.name,
        type,
        date,
        time,
        location: location || '—',
        notes,
        status: 'pending',
        latitude: null,
        longitude: null,
        accuracy: null,
      },
      ...current,
    ]);
    setMessage('Marcação salva no Supabase como pendente de confirmação.');
    setSaving(false);
    form.reset();
  };

  const handleLinkEmployeeAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const employeeId = String(formData.get('employeeId') || '');
    const email = String(formData.get('accountEmail') || '').trim();
    const employee = employees.find((item) => item.id === employeeId);

    if (!supabase || !employee || !email) {
      setErrorMessage('Selecione um funcionário e informe o e-mail da conta Auth.');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');
    const { error } = await supabase.rpc('link_employee_auth_account', {
      p_employee_id: employee.id,
      p_email: email,
    });

    if (error) {
      setErrorMessage(`Não foi possível vincular a conta: ${error.message}`);
      setSaving(false);
      return;
    }

    setEmployees((current) =>
      current.map((item) => item.id === employee.id ? { ...item, hasLogin: true } : item),
    );
    setLinkingEmployeeId('');
    setMessage(`Conta vinculada ao cadastro de ${employee.name}. O funcionário entra com o nome cadastrado e a senha da conta.`);
    setSaving(false);
    form.reset();
  };

  const handleResetEmployeePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const employeeId = String(formData.get('employeeId') || '');
    const password = String(formData.get('password') || '');
    const passwordConfirmation = String(formData.get('passwordConfirmation') || '');
    const employee = employees.find((item) => item.id === employeeId);

    if (!supabase || !employee || !employee.hasLogin) {
      setErrorMessage('Selecione um funcionário com conta de acesso vinculada.');
      return;
    }
    if (password.length < 8 || password.length > 72) {
      setErrorMessage('A senha temporária deve ter entre 8 e 72 caracteres.');
      return;
    }
    if (password !== passwordConfirmation) {
      setErrorMessage('As senhas não conferem.');
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      setErrorMessage('Sua sessão expirou. Entre novamente para redefinir a senha.');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');

    let response: Response;
    let result: { error?: string; success?: boolean };
    try {
      response = await fetch(`/api/employees/${encodeURIComponent(employee.id)}/password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
        body: JSON.stringify({ password }),
      });
      result = await response.json() as typeof result;
    } catch {
      setErrorMessage('Não foi possível conectar ao servidor para redefinir a senha.');
      setSaving(false);
      return;
    }

    if (!response.ok || !result.success) {
      setErrorMessage(result.error || 'Não foi possível redefinir a senha.');
      setSaving(false);
      return;
    }

    setResettingPasswordEmployeeId('');
    setMessage(`Senha redefinida para ${employee.name}. Entregue a senha temporária em particular.`);
    setSaving(false);
    form.reset();
  };

  const handleFaceEnrollmentCameraError = useCallback((cameraError: Error) => {
    setFaceEnrollmentEmployeeId('');
    setErrorMessage(cameraError.message);
  }, []);

  const handleFaceEnrollmentCaptureError = useCallback((captureError: unknown) => {
    setErrorMessage(
      captureError instanceof Error
        ? captureError.message
        : 'Não foi possível processar o rosto. Tente novamente.',
    );
  }, []);

  const handleFaceEnrollmentCapture = async (descriptor: number[]) => {
    const employee = employees.find((item) => item.id === faceEnrollmentEmployeeId);
    if (!supabase || !employee) {
      setErrorMessage('Selecione um funcionário ativo com conta vinculada.');
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      setErrorMessage(sessionError?.message || 'Sua sessão expirou. Entre novamente.');
      setFaceEnrollmentEmployeeId('');
      router.push('/login');
      return;
    }

    setSaving(true);
    setErrorMessage('');
    try {
      const response = await fetch('/api/faces/enroll', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ employeeId: employee.id, descriptor }),
      });
      const result = await response.json() as { error?: string; success?: boolean; warning?: string };
      if (!response.ok || !result.success) {
        setErrorMessage(result.error || 'Não foi possível salvar o cadastro facial.');
        return;
      }

      setFaceEnrolledEmployeeIds((current) => {
        const next = new Set(current);
        next.add(employee.id);
        return next;
      });
      setFaceEnrollmentEmployeeId('');
      setMessage(`Cadastro facial de ${employee.name} salvo. Nenhuma foto foi enviada ou armazenada.`);
      if (result.warning) setErrorMessage(result.warning);
    } catch {
      setErrorMessage('Não foi possível conectar ao servidor para salvar o cadastro facial.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveFaceTemplate = async (employee: Employee) => {
    if (!window.confirm(`Remover o cadastro facial de ${employee.name}?`)) return;
    if (!supabase) {
      setErrorMessage('Supabase não está configurado.');
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      setErrorMessage(sessionError?.message || 'Sua sessão expirou. Entre novamente.');
      router.push('/login');
      return;
    }

    setSaving(true);
    setErrorMessage('');
    setMessage('');
    try {
      const response = await fetch('/api/faces', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ employeeId: employee.id }),
      });
      const result = await response.json() as { error?: string; success?: boolean; warning?: string };
      if (!response.ok || !result.success) {
        setErrorMessage(result.error || 'Não foi possível remover o cadastro facial.');
        return;
      }

      setFaceEnrolledEmployeeIds((current) => {
        const next = new Set(current);
        next.delete(employee.id);
        return next;
      });
      setMessage(`Cadastro facial de ${employee.name} removido.`);
      if (result.warning) setErrorMessage(result.warning);
    } catch {
      setErrorMessage('Não foi possível conectar ao servidor para remover o cadastro facial.');
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveEmployee = async (employee: Employee) => {
    if (!supabase) {
      setErrorMessage('Supabase não está configurado.');
      return;
    }

    const isArchived = employee.status === 'Arquivado';
    const confirmed = window.confirm(
      isArchived
        ? `Restaurar ${employee.name}? O acesso ao sistema será reativado.`
        : `Arquivar ${employee.name}? O acesso será bloqueado, mas todas as marcações de ponto serão preservadas.`,
    );
    if (!confirmed) return;

    setSaving(true);
    setMessage('');
    setErrorMessage('');
    const { error } = await supabase.rpc(
      isArchived ? 'restore_employee' : 'archive_employee',
      { p_employee_id: employee.id },
    );

    if (error) {
      setErrorMessage(
        `Não foi possível ${isArchived ? 'restaurar' : 'arquivar'} o funcionário: ${error.message}`,
      );
      setSaving(false);
      return;
    }

    setEmployees((current) =>
      current.map((item) =>
        item.id === employee.id
          ? { ...item, status: isArchived ? 'Ativo' : 'Arquivado' }
          : item,
      ),
    );
    if (!isArchived) {
      setFaceEnrolledEmployeeIds((current) => {
        const next = new Set(current);
        next.delete(employee.id);
        return next;
      });
    }
    setMessage(
      isArchived
        ? `${employee.name} foi restaurado. O acesso ao sistema foi reativado.`
        : `${employee.name} foi arquivado. As marcações de ponto foram preservadas.`,
    );
    setSaving(false);
  };

  const handleDeleteEmployee = async (employee: Employee) => {
    const confirmed = window.confirm(
      `Excluir DEFINITIVAMENTE ${employee.name}? Todas as marcações e os dados vinculados serão apagados e não poderão ser recuperados.`,
    );
    if (!confirmed) return;
    if (window.prompt(`Para confirmar, digite o nome do funcionário: ${employee.name}`) !== employee.name) {
      setMessage('Exclusão cancelada: o nome não corresponde.');
      return;
    }

    if (!supabase) {
      setErrorMessage('Supabase não está configurado.');
      return;
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
      setErrorMessage(sessionError?.message || 'Sua sessão expirou. Entre novamente.');
      router.push('/login');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');
    try {
      const response = await fetch(`/api/employees/${encodeURIComponent(employee.id)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
        },
      });
      const result = await response.json() as { error?: string; success?: boolean };
      if (!response.ok || !result.success) {
        setErrorMessage(result.error || 'Não foi possível excluir definitivamente o funcionário.');
        return;
      }

      setEmployees((current) => current.filter((item) => item.id !== employee.id));
      setAttendance((current) => current.filter((item) => item.employeeId !== employee.id));
      setReportEntries((current) => current.filter((item) => item.employeeId !== employee.id));
      setFaceEnrolledEmployeeIds((current) => {
        const next = new Set(current);
        next.delete(employee.id);
        return next;
      });
      setMessage(`${employee.name} e os dados vinculados foram excluídos definitivamente.`);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? `Não foi possível excluir definitivamente o funcionário: ${error.message}`
          : 'Não foi possível excluir definitivamente o funcionário.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) {
        setErrorMessage(`Não foi possível encerrar a sessão: ${error.message}`);
        return;
      }
    }

    router.push('/login');
  };

  const cancelEmployeeEdit = () => {
    setEditingEmployee(null);
    setMessage('');
    setErrorMessage('');
  };

  const displayAttendanceStatus = (status: string) => {
    if (status === 'pending') return 'Pendente';
    if (status === 'confirmed') return 'Confirmado';
    if (status === 'rejected') return 'Rejeitado';
    return status;
  };

  const mapsUrl = (entry: AttendanceEntry) =>
    entry.latitude !== null && entry.longitude !== null
      ? `https://www.google.com/maps?q=${entry.latitude},${entry.longitude}`
      : null;

  const displayCoordinates = (entry: AttendanceEntry) =>
    entry.latitude !== null && entry.longitude !== null
      ? `${entry.latitude.toFixed(5)}, ${entry.longitude.toFixed(5)}${entry.accuracy !== null ? ` (±${Math.round(entry.accuracy)} m)` : ''}`
      : 'GPS não registrado';

  const dateLabel = new Date().toLocaleDateString('pt-BR', {
    timeZone: ATTENDANCE_TIME_ZONE,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-box">
          <div className="brand-mark">
            <Image src="/anbelo-logo.png" alt="Logo Anbelo" width={34} height={36} priority />
          </div>
          <div className="brand-name">Anbelo</div>
        </div>

        <nav className="nav-menu">
          {isManager ? (
            <button
              className={`nav-link ${activeView === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveView('dashboard')}
            >
              Dashboard
            </button>
          ) : null}
          <button
            className={`nav-link ${activeView === 'point' ? 'active' : ''}`}
            onClick={() => setActiveView('point')}
          >
            {isEmployee ? 'Meu ponto' : 'Registro de ponto'}
          </button>
          {isManager ? (
            <>
              <button
                className={`nav-link ${activeView === 'employees' ? 'active' : ''}`}
                onClick={() => setActiveView('employees')}
              >
                Funcionários
              </button>
              <button
                className={`nav-link ${activeView === 'approvals' ? 'active' : ''}`}
                onClick={() => setActiveView('approvals')}
              >
                Revisar marcações ({pendingAttendance.length})
              </button>
              {isAdmin ? (
                <button
                  className={`nav-link ${activeView === 'administrators' ? 'active' : ''}`}
                  onClick={() => setActiveView('administrators')}
                >
                  Administradores
                </button>
              ) : null}
              <button
                className={`nav-link ${activeView === 'reports' ? 'active' : ''}`}
                onClick={() => setActiveView('reports')}
              >
                Relatórios
              </button>
              <button
                className={`nav-link ${activeView === 'alerts' ? 'active' : ''}`}
                onClick={() => setActiveView('alerts')}
              >
                Jornadas com Alertas ({attendanceAlerts.filter((alert) => alert.status === 'pending').length})
              </button>
            </>
          ) : null}
        </nav>

        <div className="side-card">
          <h4>{isEmployee ? 'Registros hoje' : 'Equipe presente hoje'}</h4>
          <strong>{isEmployee ? attendance.filter((entry) => entry.date === localDate(new Date()) && entry.status !== 'rejected').length : todayLoadError ? '—' : stats.activeTeam}</strong>
          <div className="subtle">{dateLabel}</div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <h1>{activeView === 'dashboard' ? 'Dashboard' : activeView === 'point' ? isEmployee ? 'Meu ponto' : 'Registro de ponto' : activeView === 'employees' ? 'Funcionários' : activeView === 'administrators' ? 'Administradores' : activeView === 'approvals' ? 'Revisar marcações' : activeView === 'alerts' ? 'Jornadas com Alertas' : 'Relatórios'}</h1>
            <div className="subtle">Sistema de controle de ponto</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="user-pill">{userEmail}</div>
            <button type="button" className="btn secondary" onClick={handleLogout}>Sair</button>
          </div>
        </header>

        {errorMessage ? (
          <div className="panel" role="alert" style={{ marginBottom: 18, borderColor: '#d95a5a', color: '#a63232' }}>
            {errorMessage}
          </div>
        ) : null}
        {todayLoadError && isManager ? (
          <div className="panel" role="alert" style={{ marginBottom: 18, borderColor: '#d95a5a', color: '#a63232' }}>
            {todayLoadError} Atualize a página para tentar novamente.
          </div>
        ) : null}
        {message ? (
          <div className="panel" role="status" style={{ marginBottom: 18, borderColor: '#1ea67a', color: '#147653' }}>
            {message}
          </div>
        ) : null}
        {loading ? <div className="panel" role="status">Carregando dados do Supabase...</div> : null}

        {isEmployee ? (
          <div className="panel employee-overtime-panel">
            <div className="employee-overtime-heading">
              <h3>Total de horas extras</h3>
              <span>
                {isDailyWorker ? 'Todo o histórico' : new Date().toLocaleDateString('pt-BR', {
                  month: 'long',
                  year: 'numeric',
                  timeZone: ATTENDANCE_TIME_ZONE,
                })}
              </span>
            </div>
            {overtimeLoadError || (!isDailyWorker && overtimeCalculation.error) ? (
              <p role="alert" className="employee-overtime-error">{overtimeLoadError || overtimeCalculation.error}</p>
            ) : (
              <>
                <strong className="employee-overtime-total">
                  {loading ? 'Carregando...' : formatOvertimeMinutes(isDailyWorker ? workedHours.totalMinutes : totalMonthlyOvertimeMinutes)}
                </strong>
                {!loading && (isDailyWorker ? workedHours.days : monthlyOvertime?.days || []).length > 0 ? (
                  <div className="employee-overtime-days">
                    <h4>Horas extras por data trabalhada</h4>
                    <ul>
                      {(isDailyWorker ? workedHours.days : monthlyOvertime?.days || []).map((day) => (
                        <li key={day.date}>
                          <time dateTime={day.date}>{day.date.split('-').reverse().join('/')}</time>
                          <strong>{formatOvertimeMinutes(day.minutes)}</strong>
                        </li>
                      ))}
                    </ul>
                    <p>O total inclui marcações pendentes de revisão.</p>
                    {isDailyWorker ? <p>Para diaristas, são somadas todas as horas trabalhadas, descontando o intervalo.</p> : null}
                  </div>
                ) : null}
                {!loading && workedHours.incomplete > 0 ? (
                  <p className="employee-overtime-error">Há marcações incompletas ou inconsistentes que não foram somadas. Solicite a revisão ao administrador.</p>
                ) : null}
                {!loading && workedHours.inProgress ? (
                  <p className="subtle">A jornada em andamento será somada após a saída final.</p>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {isManager && activeView === 'dashboard' && (
          <>
            <div className="stats-grid">
              <button type="button" className="stat-card stat-card-button primary" onClick={() => setPeopleDialog('collaborators')} disabled={loading}>
                <div className="stat-label">Colaboradores</div>
                <div className="stat-value">{stats.employees}</div>
              </button>
              <button type="button" className="stat-card stat-card-button success" onClick={() => setPeopleDialog('present')} disabled={loading || Boolean(todayLoadError)}>
                <div className="stat-label">Presentes hoje</div>
                <div className="stat-value">{todayLoadError ? '—' : stats.present}</div>
              </button>
              <button type="button" className="stat-card stat-card-button warning" onClick={() => setPeopleDialog('late')} disabled={loading || Boolean(todayLoadError)}>
                <div className="stat-label">Atrasos</div>
                <div className="stat-value">{todayLoadError ? '—' : stats.late}</div>
              </button>
              <button type="button" className="stat-card stat-card-button danger" onClick={() => setPeopleDialog('missing')} disabled={loading || Boolean(todayLoadError)}>
                <div className="stat-label">Faltas</div>
                <div className="stat-value">{todayLoadError ? '—' : stats.missing}</div>
              </button>
              <div className="stat-card primary">
                <div className="stat-label">Marcações no mês</div>
                <div className="stat-value">{stats.monthlyEntries}</div>
              </div>
            </div>

            <dialog ref={peopleDialogRef} className="people-dialog" aria-labelledby="people-dialog-title" onClose={() => setPeopleDialog(null)}>
              <div className="people-dialog-heading">
                <h3 id="people-dialog-title">
                  {peopleDialog === 'collaborators' ? 'Colaboradores' : peopleDialog === 'present' ? 'Presentes hoje' : peopleDialog === 'missing' ? 'Faltas hoje' : 'Atrasos hoje'}
                </h3>
                <button type="button" className="btn secondary compact" onClick={() => peopleDialogRef.current?.close()}>Fechar</button>
              </div>
              {peopleDialog === 'collaborators' ? (
                stats.people.collaborators.length ? <ul>{stats.people.collaborators.map((person) => <li key={person.id}>{person.name}</li>)}</ul> : <p>Nenhum colaborador cadastrado.</p>
              ) : peopleDialog === 'present' ? (
                stats.people.present.length ? <ul>{stats.people.present.map((person) => <li key={person.id}><strong>{person.name}</strong><span>Entrada: {person.entryTime}</span></li>)}</ul> : <p>Nenhuma entrada registrada hoje.</p>
              ) : peopleDialog === 'late' ? (
                stats.people.late.length ? <ul>{stats.people.late.map((person) => <li key={person.id}><strong>{person.name}</strong><span>Entrada: {person.entryTime} · Prevista: {person.scheduledStart}</span></li>)}</ul> : <p>Nenhum atraso registrado hoje.</p>
              ) : peopleDialog === 'missing' ? (
                stats.people.missing.length ? <ul>{stats.people.missing.map((person) => <li key={person.id}>{person.name}</li>)}</ul> : <p>Todos os colaboradores têm uma entrada registrada hoje.</p>
              ) : null}
              {peopleDialog === 'present' || peopleDialog === 'late' ? <p className="subtle">Inclui marcações pendentes; rejeitadas não são consideradas.</p> : null}
              {peopleDialog === 'missing' ? <p className="subtle">Colaboradores sem entrada válida registrada hoje. Isso não confirma uma falta: confira a jornada, férias, licenças e possíveis justificativas.</p> : null}
            </dialog>

            <div className="content-grid">
              <div className="panel">
                <h3>Últimos registros</h3>
                <div className="list">
                  {attendance.slice(0, 4).map((item) => (
                    <div key={item.id} className="row-item">
                      <div>
                        <strong>{item.employeeName}</strong><br />
                        <span className="subtle">{item.location} • {item.date} {item.time}</span>
                      </div>
                      <span className={`tag ${item.type === 'entrada' ? 'success' : item.type === 'saida' ? 'warning' : 'neutral'}`}>
                        {displayEventType(item.type)}
                      </span>
                    </div>
                  ))}
                  {!loading && attendance.length === 0 ? <div className="empty">Nenhuma marcação registrada ainda.</div> : null}
                </div>
              </div>

              <div className="panel">
                <h3>Resumo operacional</h3>
                <div className="summary-grid">
                  <div className="mini-box">
                    <span className="subtle">Equipe ativa</span>
                    <strong>{todayLoadError ? '—' : stats.activeTeam}</strong>
                  </div>
                  <div className="mini-box">
                    <span className="subtle">Departamentos</span>
                    <strong>{stats.departmentCount}</strong>
                  </div>
                  <div className="mini-box">
                    <span className="subtle">Marcações hoje</span>
                    <strong>{attendance.filter((item) => item.date === localDate(new Date())).length}</strong>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {activeView === 'point' && (
          <div className="content-grid attendance-management-grid">
            <div className="panel">
              {!isEmployee ? <h3>Registrar ponto</h3> : null}
              {isEmployee ? (
                <div className="subtle">
                  <p>
                    O horário será registrado pelo servidor no momento da marcação, no fuso de Mato Grosso do Sul. O registro não pode ser editado e ficará pendente de revisão.
                  </p>
                  <p>
                    O navegador solicitará sua localização apenas ao registrar o ponto. Não há rastreamento em segundo plano; sem permissão de GPS, a marcação não será enviada.
                  </p>
                  <p>
                    O login facial pela câmera do celular continua disponível. Esta tela registra o ponto pela sua sessão autenticada e envia a localização GPS para revisão.
                  </p>
                </div>
              ) : null}
              <form onSubmit={handleAttendanceSubmit}>
                <div className="form-grid">
                  {isEmployee ? (
                    <>
                      <div className="field full">
                        <label>Funcionário</label>
                        <input value={employees[0]?.name || ''} readOnly placeholder="Cadastro ainda não vinculado" />
                      </div>
                      <div className="field full">
                        <label>Situação da jornada</label>
                        <input
                          value={employeeWorkState === 'not_started'
                            ? 'Jornada não iniciada'
                            : employeeWorkState === 'closed'
                              ? 'Jornada encerrada'
                              : employeeWorkState === 'on_break'
                                ? 'Em intervalo'
                                : 'Jornada em andamento'}
                          readOnly
                        />
                      </div>
                      <div className="field full">
                        <label>Última marcação</label>
                        <input
                          value={lastEmployeePunch
                            ? `${displayPunchType(lastEmployeePunch.type)} — ${localDate(new Date(lastEmployeePunch.recordedAt))} ${localTime(new Date(lastEmployeePunch.recordedAt))}`
                            : 'Nenhuma marcação registrada'}
                          readOnly
                        />
                      </div>
                      {employeeWorkState === 'working' ? (
                        <fieldset className="field full">
                          <legend>Escolha a marcação</legend>
                          <label>
                            <input
                              type="radio"
                              name="employeePunchEvent"
                              checked={employeePunchEvent === 'saida_almoco'}
                              onChange={() => setEmployeePunchEvent('saida_almoco')}
                            />
                            {' '}Registrar intervalo
                          </label>
                          <label style={{ marginLeft: 18 }}>
                            <input
                              type="radio"
                              name="employeePunchEvent"
                              checked={employeePunchEvent === 'saida'}
                              onChange={() => setEmployeePunchEvent('saida')}
                            />
                            {' '}Encerrar jornada
                          </label>
                        </fieldset>
                      ) : null}
                      {employeeWorkState === 'on_break' ? (
                        <div className="field full">
                          <label>Próxima marcação</label>
                          <input value="Retorno do intervalo" readOnly />
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <div className="field">
                        <label htmlFor="employeeId">Funcionário</label>
                        <select id="employeeId" name="employeeId" required>
                          <option value="">Selecione</option>
                          {employees.filter((employee) => employee.status !== 'Arquivado').map((employee) => (
                            <option key={employee.id} value={employee.id}>{employee.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="field">
                        <label htmlFor="type">Tipo</label>
                        <select id="type" name="type" defaultValue="entrada">
                          <option value="entrada">Entrada</option>
                          <option value="saida_almoco">Saída almoço</option>
                          <option value="retorno_almoco">Retorno almoço</option>
                          <option value="saida">Saída</option>
                        </select>
                      </div>

                      <div className="field">
                        <label htmlFor="date">Data</label>
                        <input id="date" name="date" type="date" defaultValue={localDate(new Date())} required />
                      </div>

                      <div className="field">
                        <label htmlFor="time">Hora (Mato Grosso do Sul)</label>
                        <input id="time" name="time" type="time" defaultValue={localTime(new Date())} required />
                      </div>
                    </>
                  )}

                  <div className="field full">
                    <label htmlFor="location">Local</label>
                    <input id="location" name="location" type="text" placeholder="Ex.: Matriz / Obra / Site externo" />
                  </div>

                  <div className="field full">
                    <label htmlFor="notes">Observações</label>
                    <textarea id="notes" name="notes" placeholder="Detalhes da marcação, contingência ou justificativa"></textarea>
                  </div>
                </div>

                <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {isEmployee ? (
                    <button
                      type="submit"
                      className="btn primary"
                      disabled={saving || loading || employees.length === 0 || !nextEmployeeEvent || Boolean(overtimeLoadError)}
                    >
                      {saving
                        ? 'Registrando...'
                        : `Registrar ${displayEventType(effectiveEmployeePunchEvent).toLowerCase()}`}
                    </button>
                  ) : (
                    <>
                      <button
                        type="submit"
                        className="btn primary"
                        disabled={saving || loading || employees.length === 0}
                      >
                        {saving ? 'Salvando...' : 'Salvar marcação'}
                      </button>
                      <button type="reset" className="btn secondary">Limpar</button>
                    </>
                  )}
                </div>
                {!loading && employees.length === 0 ? (
                  <div className="empty">
                    {isEmployee
                      ? 'Sua conta ainda não está vinculada a um cadastro ativo de funcionário. Peça ao administrador para vincular seu usuário.'
                      : 'Cadastre um funcionário antes de registrar o ponto.'}
                  </div>
                ) : null}
              </form>
            </div>

            <div className="panel">
              <h3>Últimas marcações</h3>
              <div className="table-wrap employees-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Funcionário</th>
                      <th>Data</th>
                      <th>Tipo</th>
                      <th>Hora</th>
                      <th>Status</th>
                      <th>Localização GPS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendance.slice(0, 6).map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.employeeName}</td>
                        <td>{entry.date}</td>
                        <td>{displayEventType(entry.type)}</td>
                        <td>{entry.time}</td>
                        <td>{displayAttendanceStatus(entry.status)}</td>
                        <td>
                          {mapsUrl(entry) ? (
                            <a href={mapsUrl(entry) || undefined} target="_blank" rel="noreferrer">
                              {displayCoordinates(entry)}
                            </a>
                          ) : displayCoordinates(entry)}
                        </td>
                      </tr>
                    ))}
                    {!loading && attendance.length === 0 ? (
                      <tr><td colSpan={6} className="empty">Nenhuma marcação encontrada.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {isManager && activeView === 'employees' && (
          <div className="content-grid employee-management-grid">
            <div className="panel">
              <h3>{editingEmployee ? `Editar funcionário: ${editingEmployee.name}` : 'Cadastro de funcionário'}</h3>
              <form key={editingEmployee?.id || 'new-employee'} onSubmit={handleEmployeeSubmit}>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="name">Nome</label>
                    <input id="name" name="name" type="text" defaultValue={editingEmployee?.name || ''} required />
                  </div>

                  <div className="field">
                    <label htmlFor="cpf">CPF</label>
                    <input
                      id="cpf"
                      name="cpf"
                      type="text"
                      inputMode="numeric"
                      defaultValue={displayCpf(editingEmployee?.cpf || '')}
                      placeholder="000.000.000-00"
                      onChange={(event) => {
                        const input = event.currentTarget;
                        const position = input.selectionStart ?? input.value.length;
                        const cursor = formatCpfInput(input.value.slice(0, position)).length;
                        input.value = formatCpfInput(input.value);
                        input.setSelectionRange(cursor, cursor);
                      }}
                      onKeyDown={(event) => {
                        const input = event.currentTarget;
                        const start = input.selectionStart;
                        const end = input.selectionEnd;
                        if (start === null || start !== end) return;
                        const backward = event.key === 'Backspace';
                        const forward = event.key === 'Delete';
                        const separator = backward ? start - 1 : start;
                        if ((!backward && !forward) || !/[.\-]/.test(input.value[separator] || '')) return;
                        event.preventDefault();
                        const digitIndex = backward ? separator - 1 : separator + 1;
                        if (digitIndex < 0 || digitIndex >= input.value.length) return;
                        const next = input.value.slice(0, digitIndex) + input.value.slice(digitIndex + 1);
                        const cursor = formatCpfInput(next.slice(0, digitIndex)).length;
                        input.value = formatCpfInput(next);
                        input.setSelectionRange(cursor, cursor);
                      }}
                      required
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="department">Departamento</label>
                    <input id="department" name="department" type="text" defaultValue={editingEmployee?.department || ''} required />
                  </div>

                  <div className="field">
                    <label htmlFor="role">Cargo</label>
                    <input id="role" name="role" type="text" defaultValue={editingEmployee?.role || ''} required />
                  </div>

                  <div className="field full">
                    <label htmlFor="modalidade">Modalidade de trabalho</label>
                    <select id="modalidade" name="modalidade" defaultValue={editingEmployee?.modalidade || 'mensalista'}>
                      <option value="mensalista">Mensalista — horas extras do mês</option>
                      <option value="diarista">Diarista — horas extras de todo o período trabalhado</option>
                    </select>
                  </div>

                  <div className="field full">
                    <label>Jornada normal do funcionário</label>
                    <p className="subtle" style={{ margin: '0 0 8px' }}>
                      Configure os quatro horários. Em dias úteis, as horas extras são calculadas pelo tempo trabalhado além da duração da jornada normal.
                    </p>
                    <div className="form-grid">
                      <div className="field">
                        <label htmlFor="workStart">Entrada</label>
                        <input id="workStart" name="workStart" type="time" defaultValue={scheduleDefaults.start} />
                      </div>
                      <div className="field">
                        <label htmlFor="lunchStart">Saída para almoço</label>
                        <input id="lunchStart" name="lunchStart" type="time" defaultValue={scheduleDefaults.lunchStart} />
                      </div>
                      <div className="field">
                        <label htmlFor="lunchEnd">Retorno do almoço</label>
                        <input id="lunchEnd" name="lunchEnd" type="time" defaultValue={scheduleDefaults.lunchEnd} />
                      </div>
                      <div className="field">
                        <label htmlFor="workEnd">Saída normal</label>
                        <input id="workEnd" name="workEnd" type="time" defaultValue={scheduleDefaults.end} />
                      </div>
                    </div>
                    <label className="field full" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <input
                        type="checkbox"
                        name="flexibleSchedule"
                        defaultChecked={Boolean(editingEmployee && /flex/i.test(editingEmployee.shift))}
                        style={{ width: 18, height: 18 }}
                      />
                      Jornada flexível (referência de 9 horas por jornada em dias úteis)
                    </label>
                  </div>

                  <label className="field full" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <input
                      type="checkbox"
                      name="saturdayUntilNoon"
                      defaultChecked={editingEmployee?.saturdayUntilNoon || false}
                      style={{ width: 18, height: 18 }}
                    />
                    Trabalha aos sábados até 12h (sábado até meio-dia é jornada normal)
                  </label>

                    <div className="field">
                    <label htmlFor="status">Situação</label>
                      <select
                        id="status"
                        name="status"
                        defaultValue={editingEmployee?.status || 'Ativo'}
                      >
                        {editingEmployee?.status === 'Arquivado' ? (
                          <option value="Arquivado">Arquivado</option>
                        ) : (
                          <>
                            <option value="Ativo">Ativo</option>
                            <option value="Férias">Férias</option>
                            <option value="Licença">Licença</option>
                          </>
                        )}
                      </select>
                    </div>

                  {!editingEmployee ? (
                    <>
                      <div className="field">
                        <label htmlFor="accountEmail">E-mail do funcionário</label>
                        <input
                          id="accountEmail"
                          name="accountEmail"
                          type="email"
                          autoComplete="email"
                          placeholder="Usado para criar a conta do sistema"
                          required
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="accountPassword">Senha inicial de acesso</label>
                        <input
                          id="accountPassword"
                          name="accountPassword"
                          type="password"
                          autoComplete="new-password"
                          minLength={8}
                          maxLength={72}
                          placeholder="Mínimo de 8 caracteres"
                          required
                        />
                      </div>
                    </>
                  ) : null}
                </div>
                {!editingEmployee ? (
                  <p className="subtle" style={{ marginTop: 10 }}>
                    A conta será criada e vinculada automaticamente. O e-mail é usado internamente; o funcionário entra com nome e senha.
                  </p>
                ) : null}

                <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
                  <button type="submit" className="btn primary" disabled={saving || loading}>
                    {saving ? 'Salvando...' : editingEmployee ? 'Salvar alterações' : 'Adicionar funcionário'}
                  </button>
                  {editingEmployee ? (
                    <button type="button" className="btn secondary" onClick={cancelEmployeeEdit} disabled={saving}>
                      Cancelar edição
                    </button>
                  ) : (
                    <button type="reset" className="btn secondary">Limpar</button>
                  )}
                </div>
              </form>
            </div>

            <div className="panel">
              <h3>Funcionários cadastrados</h3>
              <div className="table-wrap employees-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Nome</th>
                      <th>Dept.</th>
                      <th>CPF</th>
                      <th>Jornada</th>
                      <th>Situação</th>
                      <th>Conta de acesso</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((employee) => (
                      <tr key={employee.id}>
                        <td>{employee.registrationCode}</td>
                        <td>{employee.name}</td>
                        <td>{employee.department}</td>
                        <td>{displayCpf(employee.cpf)}</td>
                        <td>
                          {displayShift(employee.shift)}
                          {employee.saturdayUntilNoon ? ' · Sáb até 12h' : ''}
                        </td>
                        <td>{employee.status}</td>
                        <td>
                          {employee.status === 'Arquivado'
                            ? employee.hasLogin ? 'Bloqueada' : 'Arquivada'
                            : employee.hasLogin ? 'Vinculada' : 'Sem conta'}
                        </td>
                        <td>
                          <div className="employee-actions">
                            {employee.status === 'Ativo' ? (
                              <>
                                <button
                                  type="button"
                                  className="btn secondary compact"
                                  onClick={() => {
                                    setFaceEnrollmentEmployeeId(employee.id);
                                    setErrorMessage('');
                                    setMessage('');
                                  }}
                                  disabled={saving || !employee.hasLogin}
                                  title={!employee.hasLogin ? 'Vincule uma conta ao funcionário antes do cadastro facial.' : 'Cadastrar ou atualizar o rosto'}
                                >
                                  {faceEnrolledEmployeeIds.has(employee.id) ? 'Atualizar rosto' : 'Cadastrar rosto'}
                                </button>
                                {faceEnrolledEmployeeIds.has(employee.id) ? (
                                  <button
                                    type="button"
                                    className="btn secondary compact"
                                    onClick={() => void handleRemoveFaceTemplate(employee)}
                                    disabled={saving}
                                  >
                                    Remover rosto
                                  </button>
                                ) : null}
                              </>
                            ) : null}
                            <button
                              type="button"
                              className="btn secondary compact"
                              title="Redefinir senha"
                              aria-label={`Redefinir senha de ${employee.name}`}
                              onClick={() => {
                                setEditingEmployee(employee);
                                setErrorMessage('');
                                setMessage('');
                              }}
                            >
                              Editar
                            </button>
                            {employee.status === 'Arquivado' ? (
                              <button
                                type="button"
                                className="btn primary compact"
                                onClick={() => handleArchiveEmployee(employee)}
                                disabled={saving}
                              >
                                {saving ? 'Restaurando...' : 'Restaurar'}
                              </button>
                            ) : (
                              <>
                            {employee.hasLogin ? (
                              resettingPasswordEmployeeId === employee.id ? (
                                <form onSubmit={handleResetEmployeePassword} className="employee-action-form">
                                  <input type="hidden" name="employeeId" value={employee.id} />
                                  <label htmlFor={`newPassword-${employee.id}`}>Nova senha temporária</label>
                                  <input
                                    id={`newPassword-${employee.id}`}
                                    name="password"
                                    type="password"
                                    autoComplete="new-password"
                                    minLength={8}
                                    maxLength={72}
                                    required
                                  />
                                  <label htmlFor={`confirmPassword-${employee.id}`}>Confirme a senha</label>
                                  <input
                                    id={`confirmPassword-${employee.id}`}
                                    name="passwordConfirmation"
                                    type="password"
                                    autoComplete="new-password"
                                    minLength={8}
                                    maxLength={72}
                                    required
                                  />
                                  <button type="submit" className="btn primary compact" disabled={saving}>
                                    {saving ? 'Redefinindo...' : 'Salvar senha'}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn secondary compact"
                                    disabled={saving}
                                    onClick={() => setResettingPasswordEmployeeId('')}
                                  >
                                    Cancelar
                                  </button>
                                </form>
                              ) : (
                                <button
                                  type="button"
                                  className="btn secondary compact"
                                  onClick={() => {
                                    setResettingPasswordEmployeeId(employee.id);
                                    setErrorMessage('');
                                    setMessage('');
                                  }}
                                >
                                  Senha
                                </button>
                              )
                            ) : (
                              linkingEmployeeId === employee.id ? (
                                <form onSubmit={handleLinkEmployeeAccount} className="employee-action-form">
                                  <input type="hidden" name="employeeId" value={employee.id} />
                                  <label htmlFor={`accountEmail-${employee.id}`}>E-mail criado no Supabase Auth</label>
                                  <input
                                    id={`accountEmail-${employee.id}`}
                                    name="accountEmail"
                                    type="email"
                                    placeholder="funcionario@empresa.com"
                                    required
                                  />
                                  <button type="submit" className="btn primary compact" disabled={saving}>
                                    {saving ? 'Vinculando...' : 'Vincular conta'}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn secondary compact"
                                    disabled={saving}
                                    onClick={() => setLinkingEmployeeId('')}
                                  >
                                    Cancelar
                                  </button>
                                </form>
                              ) : (
                                <button
                                  type="button"
                                  className="btn secondary compact"
                                  onClick={() => {
                                    setLinkingEmployeeId(employee.id);
                                    setErrorMessage('');
                                    setMessage('');
                                  }}
                                >
                                  Vincular
                                </button>
                              )
                            )}
                            <button
                              type="button"
                              className="btn secondary compact"
                              title="Arquivar funcionário e preservar marcações"
                              onClick={() => handleArchiveEmployee(employee)}
                              disabled={saving}
                            >
                              Arquivar
                            </button>
                              </>
                            )}
                           <button
                             type="button"
                             className="btn secondary compact"
                             onClick={() => void handleDeleteEmployee(employee)}
                             disabled={saving}
                             aria-label={`Excluir definitivamente ${employee.name}`}
                           >
                             Excluir
                           </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!loading && employees.length === 0 ? (
                      <tr><td colSpan={8} className="empty">Nenhum funcionário cadastrado.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
            {faceEnrollmentEmployeeId ? (
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="face-enrollment-title"
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1000,
                  display: 'grid',
                  placeItems: 'center',
                  padding: 20,
                  background: 'rgba(16, 24, 40, 0.62)',
                }}
              >
                <div className="panel" style={{ width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <h3 id="face-enrollment-title" style={{ margin: 0 }}>
                      Cadastrar rosto de {employees.find((employee) => employee.id === faceEnrollmentEmployeeId)?.name}
                    </h3>
                    <button
                      type="button"
                      className="btn secondary compact"
                      onClick={() => setFaceEnrollmentEmployeeId('')}
                      disabled={saving}
                    >
                      Fechar
                    </button>
                  </div>
                  <p className="subtle">
                    Faça o cadastro somente após obter o consentimento escrito do funcionário. A imagem é processada neste aparelho; somente o modelo facial criptografado é enviado e armazenado.
                  </p>
                  <FaceCamera
                    buttonText={saving ? 'Salvando...' : 'Salvar cadastro facial'}
                    disabled={saving}
                    onCameraError={handleFaceEnrollmentCameraError}
                    onCapture={handleFaceEnrollmentCapture}
                    onCaptureError={handleFaceEnrollmentCaptureError}
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}

        {isManager && activeView === 'approvals' && (
          <div className="panel">
            <h3>Marcações aguardando revisão</h3>
            <p className="subtle">
              A revisão altera apenas o status. Data, hora, tipo e demais dados da marcação permanecem preservados.
            </p>
            <div className="form-grid" style={{ marginBottom: 16 }}>
              <div className="field">
                <label htmlFor="reviewEmployeeId">Funcionário</label>
                <select
                  id="reviewEmployeeId"
                  value={reviewEmployeeId}
                  onChange={(event) => setReviewEmployeeId(event.target.value)}
                >
                  <option value="">Todos os funcionários</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="table-wrap review-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Funcionário</th>
                    <th>Data</th>
                    <th>Hora</th>
                    <th>Tipo</th>
                    <th>Local</th>
                    <th>Localização GPS</th>
                    <th>Observação</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPendingAttendance.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.employeeName}</td>
                      <td>{entry.date}</td>
                      <td>{entry.time}</td>
                      <td>{displayEventType(entry.type)}</td>
                      <td>{entry.location}</td>
                      <td>
                        {mapsUrl(entry) ? (
                          <a href={mapsUrl(entry) || undefined} target="_blank" rel="noreferrer">
                            {displayCoordinates(entry)}
                          </a>
                        ) : displayCoordinates(entry)}
                      </td>
                      <td>{entry.notes || '—'}</td>
                      <td>
                        <div className="review-actions" style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className="btn primary"
                            onClick={() => handleReviewAttendance(entry, 'confirmed')}
                            disabled={saving}
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => handleReviewAttendance(entry, 'rejected')}
                            disabled={saving}
                          >
                            Rejeitar
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!loading && filteredPendingAttendance.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="empty">
                        {reviewEmployeeId
                          ? 'Não há marcações pendentes para este funcionário.'
                          : 'Não há marcações pendentes para revisar.'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {isAdmin && activeView === 'administrators' && (
          <div className="panel">
            <h3>Cadastrar administrador</h3>
            <p className="subtle">
              O novo administrador terá acesso completo aos dados e às configurações da empresa vinculada à sua conta.
              Informe uma senha inicial segura e entregue-a em particular.
            </p>
            <form onSubmit={handleAdministratorSubmit}>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="administratorName">Nome completo</label>
                  <input
                    id="administratorName"
                    name="administratorName"
                    type="text"
                    autoComplete="name"
                    minLength={2}
                    maxLength={100}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="administratorEmail">E-mail de acesso</label>
                  <input
                    id="administratorEmail"
                    name="administratorEmail"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="administratorPassword">Senha inicial</label>
                  <input
                    id="administratorPassword"
                    name="administratorPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={72}
                    required
                  />
                  <span className="subtle">A senha deve ter entre 8 e 72 caracteres.</span>
                </div>
              </div>
              <div style={{ marginTop: 16 }}>
                <button type="submit" className="btn primary" disabled={saving || loading}>
                  {saving ? 'Cadastrando...' : 'Cadastrar administrador'}
                </button>
              </div>
            </form>
          </div>
        )}

        {isManager && activeView === 'alerts' && (
          <div className="panel">
            <h3>Jornadas com Alertas</h3>
            <p className="subtle">
              Os alertas são operacionais e não substituem a análise da legislação, da categoria ou de acordos coletivos.
              Intervalos curtos são comparados ao intervalo cadastrado na escala, não a um mínimo legal.
              Escalas flexíveis sem horários definidos não geram alertas de horário fora da escala.
            </p>
            <div className="panel" style={{ marginBottom: 16 }}>
              <strong>Encerramento automático diário</strong>
              <p className="subtle">
                Quando ativado, alertas de dias anteriores são encerrados automaticamente e mantidos no histórico.
                Isso não significa que foram revisados ou corrigidos. O mesmo tipo de alerta para a mesma jornada
                ou marcação não será gerado novamente, mas outros tipos de alerta ainda poderão aparecer.
                A rotina está agendada a cada hora e depende do Supabase Cron; atualize a página para ver os resultados.
              </p>
              {autoResolveAlertsError && <p role="alert" className="employee-overtime-error">{autoResolveAlertsError}</p>}
              {autoResolveAlerts !== null && (
                <button type="button" className="btn secondary" disabled={saving}
                  onClick={() => handleAutoResolveAlerts(!autoResolveAlerts)}>
                  {autoResolveAlerts ? 'Desativar encerramento automático' : 'Ativar encerramento automático'}
                </button>
              )}
            </div>
            {alertsLoadError ? (
              <p role="alert" className="employee-overtime-error">{alertsLoadError}</p>
            ) : (
              <>
                {sessionProcessingErrors.length ? (
                  <div className="panel" role="alert" style={{ marginBottom: 16, borderColor: '#d95a5a' }}>
                    <h4>Registros que precisam de conferência técnica</h4>
                    <p className="subtle">A batida foi preservada, mas o sistema não conseguiu associá-la a uma jornada.</p>
                    {sessionProcessingErrors.map((item) => (
                      <p key={item.id}>
                        {item.employeeName} — {displayPunchType(item.eventType)} em {localDate(new Date(item.recordedAt))} {localTime(new Date(item.recordedAt))}: {item.error}
                      </p>
                    ))}
                  </div>
                ) : null}
                <div className="form-grid" style={{ marginTop: 16 }}>
                  <div className="field">
                    <label htmlFor="alertEmployeeFilter">Funcionário</label>
                    <select id="alertEmployeeFilter" value={alertEmployeeFilter} onChange={(event) => setAlertEmployeeFilter(event.target.value)}>
                      <option value="">Todos</option>
                      {employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="alertFrom">Data inicial</label>
                    <input id="alertFrom" type="date" value={alertFrom} onChange={(event) => setAlertFrom(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="alertTo">Data final</label>
                    <input id="alertTo" type="date" value={alertTo} onChange={(event) => setAlertTo(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="alertTypeFilter">Tipo de alerta</label>
                    <select id="alertTypeFilter" value={alertTypeFilter} onChange={(event) => setAlertTypeFilter(event.target.value)}>
                      <option value="">Todos</option>
                      {Array.from(new Set(attendanceAlerts.map((alert) => alert.alertType))).map((type) => (
                        <option key={type} value={type}>{displayAlertType(type)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="alertStatusFilter">Situação</label>
                    <select id="alertStatusFilter" value={alertStatusFilter} onChange={(event) => setAlertStatusFilter(event.target.value)}>
                      <option value="">Todas</option>
                      <option value="pending">Pendente</option>
                      <option value="viewed">Visualizado</option>
                      <option value="in_review">Em análise</option>
                      <option value="resolved">Resolvido</option>
                    </select>
                  </div>
                </div>
                <p className="subtle">{filteredAttendanceAlerts.length} alerta(s) encontrados.</p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Funcionário</th>
                        <th>Entrada</th>
                        <th>Saída</th>
                        <th>Trabalhadas</th>
                        <th>Intervalos</th>
                        <th>Alerta / gravidade</th>
                        <th>Situação / providência</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAttendanceAlerts.map((alert) => (
                        <tr key={alert.id}>
                          <td>{alert.employeeName}</td>
                          <td>{alert.startedAt ? `${localDate(new Date(alert.startedAt))} ${localTime(new Date(alert.startedAt))}` : '—'}</td>
                          <td>{alert.endedAt ? `${localDate(new Date(alert.endedAt))} ${localTime(new Date(alert.endedAt))}` : 'Em andamento'}</td>
                          <td>{alert.workedMinutes === null ? '—' : formatOvertimeMinutes(alert.workedMinutes)}</td>
                          <td>{alert.breakMinutes === null ? '—' : formatOvertimeMinutes(alert.breakMinutes)}</td>
                          <td>
                            <strong>{displayAlertType(alert.alertType)}</strong>
                            <div>{alert.severity === 'critical' ? 'Crítico' : alert.severity === 'warning' ? 'Atenção' : 'Informativo'}</div>
                            <div className="subtle">{alert.description}</div>
                            {alert.attendanceRecordId ? <div className="subtle">Marcação: {alert.attendanceRecordId}</div> : null}
                          </td>
                          <td>
                            <strong>{displayAlertStatus(alert.status)}</strong>
                            {alert.resolutionNotes ? <div className="subtle">{alert.resolutionNotes}</div> : null}
                            {alert.status !== 'resolved' ? (
                              <div style={{ minWidth: 220 }}>
                                <textarea
                                  aria-label={`Justificativa para ${alert.employeeName}`}
                                  placeholder="Justificativa/providência (obrigatória para resolver)"
                                  value={alertNotes[alert.id] || ''}
                                  onChange={(event) => setAlertNotes((current) => ({ ...current, [alert.id]: event.target.value }))}
                                />
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                                  {alert.status === 'pending' ? (
                                    <button type="button" className="btn secondary" disabled={saving} onClick={() => handleReviewAlert(alert, 'viewed')}>Visualizado</button>
                                  ) : null}
                                  {alert.status !== 'in_review' ? (
                                    <button type="button" className="btn secondary" disabled={saving} onClick={() => handleReviewAlert(alert, 'in_review')}>Em análise</button>
                                  ) : null}
                                  <button type="button" className="btn primary" disabled={saving} onClick={() => handleReviewAlert(alert, 'resolved')}>Resolver</button>
                                </div>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                      {filteredAttendanceAlerts.length === 0 ? (
                        <tr><td colSpan={7} className="empty">Nenhum alerta corresponde aos filtros.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {isManager && activeView === 'reports' && (
          <div className="panel">
            <h3>Relatórios</h3>
            <div className="summary-grid">
              <div className="mini-box">
                <span className="subtle">Colaboradores com marcação no mês (últimos registros)</span>
                <strong>{stats.monthlyActiveEmployees}/{stats.employees}</strong>
              </div>
              <div className="mini-box">
                <span className="subtle">Atrasos hoje</span>
                <strong>{todayLoadError ? '—' : stats.late}</strong>
              </div>
              <div className="mini-box">
                <span className="subtle">Marcações carregadas neste mês</span>
                <strong>{stats.monthlyEntries}</strong>
              </div>
              <div className="mini-box">
                <span className="subtle">Escalas flexíveis</span>
                <strong>{employees.filter((employee) => employee.shift.toLowerCase() === 'flexível' || employee.shift.toLowerCase() === 'flex').length}</strong>
              </div>
            </div>
            <form onSubmit={handleReportSubmit} style={{ marginTop: 22 }}>
              <h3>Relatório detalhado de marcações</h3>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="reportFrom">Data inicial</label>
                  <input
                    id="reportFrom"
                    type="date"
                    value={reportFrom}
                    disabled={reportLoading}
                    onChange={(event) => {
                      setReportFrom(event.target.value);
                      setReportLoaded(false);
                    }}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="reportTo">Data final</label>
                  <input
                    id="reportTo"
                    type="date"
                    value={reportTo}
                    disabled={reportLoading}
                    onChange={(event) => {
                      setReportTo(event.target.value);
                      setReportLoaded(false);
                    }}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="reportEmployee">Funcionário</label>
                  <select
                    id="reportEmployee"
                    value={reportEmployeeId}
                    disabled={reportLoading}
                    onChange={(event) => {
                      setReportEmployeeId(event.target.value);
                      setReportLoaded(false);
                    }}
                  >
                    <option value="">Todos os funcionários</option>
                    {employees.map((employee) => (
                      <option key={employee.id} value={employee.id}>{employee.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button type="submit" className="btn primary" disabled={reportLoading || loading}>
                  {reportLoading ? 'Consultando...' : 'Consultar período'}
                </button>
                {isAdmin ? (
                  <div className="field">
                    <label htmlFor="reportExportType">Tipo de exportação</label>
                    <select id="reportExportType" value={reportExportType} disabled={reportLoading}
                      onChange={(event) => setReportExportType(event.target.value === 'dia' ? 'dia' : 'completa')}>
                      <option value="completa">Consulta completa</option>
                      <option value="dia">Por dia</option>
                    </select>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="btn secondary"
                  onClick={handleReportExport}
                  disabled={!reportLoaded || reportLoading || (reportExportType === 'dia'
                    ? !reportTimesheet || (reportTimesheet.rows.length === 0 && reportTimesheet.anomalies.length === 0)
                    : reportEntries.length === 0)}
                >
                  Exportar CSV
                </button>
                {reportLoaded ? <span className="subtle">{reportEntries.length} marcação(ões) no período</span> : null}
              </div>
            </form>

            {reportLoaded ? (
              <>
              {isAdmin && reportTimesheet ? (
                <div style={{ marginTop: 22 }}>
                  <h3>Quadro de marcações por jornada</h3>
                  <p className="subtle">
                    Cada linha pertence à data da entrada. Horários de outros dias incluem a data real;
                    vários intervalos aparecem na mesma célula. * indica marcação pendente.
                    Marcações rejeitadas não entram no quadro, mas permanecem no extrato abaixo.
                  </p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Funcionário</th><th>Data</th><th>Entrada</th><th>Saída intervalo</th><th>Retorno</th><th>Saída definitiva</th></tr>
                      </thead>
                      <tbody>
                        {reportTimesheet.rows.map((row, index) => (
                          <tr key={`${row.employee.id}-${row.entry.id || index}`}>
                            <td>{row.employee.name}</td>
                            <td>{row.date.split('-').reverse().join('/')}</td>
                            <td>{formatReportTimesheetPunch(row.entry, row.date)}</td>
                            <td>{row.breakStarts.length ? row.breakStarts.map((punch, i) => <div key={punch.id || i}>{formatReportTimesheetPunch(punch, row.date)}</div>) : '—'}</td>
                            <td>{row.breakEnds.length ? row.breakEnds.map((punch, i) => <div key={punch.id || i}>{formatReportTimesheetPunch(punch, row.date)}</div>) : '—'}</td>
                            <td>{row.exit ? formatReportTimesheetPunch(row.exit, row.date) : '—'}</td>
                          </tr>
                        ))}
                        {reportTimesheet.rows.length === 0 ? (
                          <tr><td colSpan={6} className="empty">Nenhuma jornada encontrada pela data de entrada no período.</td></tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                  {reportTimesheet.anomalies.length ? (
                    <div className="employee-overtime-error" role="alert">
                      <p>As seguintes marcações não formam uma sequência válida e precisam de revisão:</p>
                      <ul>
                        {reportTimesheet.anomalies.map(({ employee, punch }, index) => (
                          <li key={`${employee.id}-${punch.id || index}`}>
                            {employee.name} — {punch.type === 'entrada' ? 'Entrada' : punch.type === 'saida_almoco' ? 'Saída almoço' : punch.type === 'retorno_almoco' ? 'Retorno almoço' : punch.type === 'saida' ? 'Saída' : punch.type} em {localDate(new Date(punch.recordedAt)).split('-').reverse().join('/')} {localTime(new Date(punch.recordedAt))}{punch.status === 'pending' ? ' (pendente)' : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div style={{ marginTop: 22 }}>
                <h3>Horas extras no período</h3>
                <p className="subtle">
                  Total: <strong>{formatOvertimeMinutes(reportOvertime.reduce((total, item) => total + item.totalMinutes, 0))}</strong>.
                  {' '}O período seleciona jornadas pela data da entrada; as horas são distribuídas pelas datas locais efetivamente trabalhadas, inclusive após a data final.
                  Marcações pendentes são incluídas; rejeitadas e jornadas incompletas ou com mais de 48 horas não são somadas.
                  Revise eventuais marcações inconsistentes.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Funcionário</th><th>Total de horas extras</th><th>Inclui pendentes</th><th>Data trabalhada</th></tr>
                    </thead>
                    <tbody>
                      {reportOvertime.map((item) => (
                        <tr key={item.employee.id}>
                          <td>{item.employee.name}</td>
                          <td>{formatOvertimeMinutes(item.totalMinutes)}</td>
                          <td>{formatOvertimeMinutes(item.pendingMinutes)}</td>
                          <td>{item.days.length
                            ? item.days.map((day) => `${day.date.split('-').reverse().join('/')}: ${formatOvertimeMinutes(day.minutes)}`).join(' · ')
                            : '—'}</td>
                        </tr>
                      ))}
                      {reportOvertime.length === 0 ? (
                        <tr><td colSpan={4} className="empty">Nenhum funcionário encontrado.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="table-wrap" style={{ marginTop: 18 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Funcionário</th>
                      <th>Data</th>
                      <th>Hora</th>
                      <th>Tipo</th>
                      <th>Status</th>
                      <th>Local</th>
                      <th>Localização GPS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{entry.employeeName}</td>
                        <td>{entry.date}</td>
                        <td>{entry.time}</td>
                        <td>{displayEventType(entry.type)}</td>
                        <td>{entry.status === 'pending' ? 'Pendente' : entry.status === 'confirmed' ? 'Confirmado' : 'Rejeitado'}</td>
                        <td>{entry.location}</td>
                        <td>
                          {mapsUrl(entry) ? (
                            <a href={mapsUrl(entry) || undefined} target="_blank" rel="noreferrer">
                              {displayCoordinates(entry)}
                            </a>
                          ) : displayCoordinates(entry)}
                        </td>
                      </tr>
                    ))}
                    {reportEntries.length === 0 ? (
                      <tr><td colSpan={7} className="empty">Nenhuma marcação encontrada no período.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              </>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
