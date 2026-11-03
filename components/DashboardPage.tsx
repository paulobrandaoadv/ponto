'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

type Employee = {
  id: string;
  registrationCode: string;
  name: string;
  cpf: string;
  hasLogin: boolean;
  department: string;
  role: string;
  shift: string;
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

const localDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const localTime = (date: Date) => {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const displayEventType = (type: AttendanceEntry['type']) => ({
  entrada: 'Entrada',
  saida_almoco: 'Saída almoço',
  retorno_almoco: 'Retorno almoço',
  saida: 'Saída',
}[type]);

const normalizeShift = (shift: string | null) =>
  shift?.toLowerCase() === 'flex' || shift?.toLowerCase() === 'flexível' ? 'Flexível' : shift || '';

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
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceEntry[]>([]);
  const [activeView, setActiveView] = useState<'dashboard' | 'point' | 'employees' | 'approvals' | 'reports'>('dashboard');
  const [userEmail, setUserEmail] = useState('');
  const [userRole, setUserRole] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [linkingEmployeeId, setLinkingEmployeeId] = useState('');
  const [resettingPasswordEmployeeId, setResettingPasswordEmployeeId] = useState('');
  const [reportFrom, setReportFrom] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [reportTo, setReportTo] = useState(() => localDate(new Date()));
  const [reportEmployeeId, setReportEmployeeId] = useState('');
  const [reportEntries, setReportEntries] = useState<AttendanceEntry[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportLoaded, setReportLoaded] = useState(false);
  const pendingAttendance = useMemo(
    () => attendance.filter((entry) => entry.status === 'pending'),
    [attendance],
  );
  const isManager = userRole === 'admin' || userRole === 'gestor';
  const isEmployee = userRole === 'funcionario';
  const nextEmployeeEvent = useMemo(() => {
    const todayEntries = attendance
      .filter((entry) => entry.date === localDate(new Date()) && entry.status !== 'rejected')
      .sort((left, right) => left.time.localeCompare(right.time));
    const lastEvent = todayEntries[todayEntries.length - 1]?.type;
    if (!lastEvent) return 'entrada';
    if (lastEvent === 'entrada') return 'saida_almoco';
    if (lastEvent === 'saida_almoco') return 'retorno_almoco';
    if (lastEvent === 'retorno_almoco') return 'saida';
    return null;
  }, [attendance]);

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

      const [employeesResult, departmentsResult, attendanceResult] = await Promise.all([
        supabase
          .from('employees')
          .select('id, codigo_registro, nome, cpf, user_id, departamento_id, cargo, jornada, status')
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
        status: normalizeEmployeeStatus(employee.status),
      }));
      const employeeNames = new Map(loadedEmployees.map((employee) => [employee.id, employee.name]));

      setEmployees(loadedEmployees);
      const attendanceById = new Map(
        [...(attendanceResult.data || []), ...pendingRecords].map((record) => [record.id, record]),
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
      setLoading(false);
    };

    loadDashboard();
  }, [router]);

  const stats = useMemo(() => {
    const activeEmployees = employees.filter((employee) => employee.status !== 'Arquivado');
    const activeEmployeeIds = new Set(activeEmployees.map((employee) => employee.id));
    const today = localDate(new Date());
    const todaysEntries = attendance.filter((item) => item.date === today && item.status !== 'rejected');
    const present = new Set(
      todaysEntries
        .filter((item) => item.type === 'entrada' && activeEmployeeIds.has(item.employeeId))
        .map((item) => item.employeeId),
    ).size;
    const late = todaysEntries.filter((entry) => {
      if (entry.type !== 'entrada' || !activeEmployeeIds.has(entry.employeeId)) return false;
      const employee = employees.find((item) => item.id === entry.employeeId);
      const scheduledStart = employee?.shift.match(/\d{2}:\d{2}/)?.[0];
      return scheduledStart ? entry.time > scheduledStart : false;
    }).length;
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
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
      missing: Math.max(0, activeEmployees.length - present),
      departmentCount: new Set(activeEmployees.map((employee) => employee.department)).size,
    };
  }, [attendance, employees]);

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

    const start = new Date(`${reportFrom}T00:00:00`);
    const end = new Date(`${reportTo}T00:00:00`);
    end.setDate(end.getDate() + 1);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

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
        .gte('recorded_at', startIso)
        .lt('recorded_at', endIso)
        .order('recorded_at', { ascending: true });

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

    const employeeNames = new Map(employees.map((employee) => [employee.id, employee.name]));
    setReportEntries(
      records.map((record) => ({
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
    const csv = [headers, ...rows]
      .map((row) => row.map((field) => csvField(field)).join(';'))
      .join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    const employeeSuffix = reportEmployeeId
      ? `_${employees.find((employee) => employee.id === reportEmployeeId)?.name.replace(/[^A-Za-z0-9-]+/g, '_') || 'funcionario'}`
      : '';
    downloadLink.download = `anbelo-ponto${employeeSuffix}_${reportFrom}_${reportTo}.csv`;
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
    const shift = String(formData.get('shift') || '08:00-17:00');
    const status = String(formData.get('status') || 'Ativo');
    const accountEmail = String(formData.get('accountEmail') || '').trim();
    const accountPassword = String(formData.get('accountPassword') || '');

    if (!supabase || !companyId || !name || !cpf || !department || !role) return;
    if (!editingEmployee && (!accountEmail || !accountPassword)) {
      setErrorMessage('Informe o e-mail e a senha inicial para criar o acesso do funcionário.');
      return;
    }

    setSaving(true);
    setMessage('');
    setErrorMessage('');

    let duplicateQuery = supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .eq('cpf', cpf)
      .limit(1)
      .maybeSingle();
    if (editingEmployee) {
      duplicateQuery = supabase
        .from('employees')
        .select('id')
        .eq('company_id', companyId)
        .eq('cpf', cpf)
        .neq('id', editingEmployee.id)
        .limit(1)
        .maybeSingle();
    }
    const { data: duplicate, error: duplicateError } = await duplicateQuery;

    if (duplicateError) {
      setErrorMessage(`Não foi possível verificar o CPF: ${duplicateError.message}`);
      setSaving(false);
      return;
    }

    if (duplicate) {
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

    const savedEmployee = {
      id: employeeRecord.id,
      registrationCode: editingEmployee?.registrationCode || '',
      name,
      cpf,
      hasLogin: editingEmployee?.hasLogin || false,
      department,
      role,
      shift,
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
      if (!nextEmployeeEvent) {
        setErrorMessage('Você já registrou os quatro pontos previstos para hoje.');
        return;
      }

      setSaving(true);
      setMessage('');
      setErrorMessage('');
      let locationSnapshot: LocationSnapshot;
      try {
        locationSnapshot = await getLocationSnapshot();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Não foi possível obter sua localização.');
        setSaving(false);
        return;
      }

      const { data: recordId, error: punchError } = await supabase.rpc('record_own_attendance', {
        p_location: location || null,
        p_notes: notes || null,
        p_latitude: locationSnapshot.latitude,
        p_longitude: locationSnapshot.longitude,
        p_accuracy: locationSnapshot.accuracy,
      });

      if (punchError || !recordId) {
        setErrorMessage(`Não foi possível registrar seu ponto: ${punchError?.message || 'registro não retornado'}`);
        setSaving(false);
        return;
      }

      const now = new Date();
      setAttendance((current) => [
        {
          id: recordId,
          employeeId: employee.id,
          employeeName: employee.name,
          type: nextEmployeeEvent,
          date: localDate(now),
          time: localTime(now),
          location: location || '—',
          notes,
          status: 'pending',
          latitude: locationSnapshot.latitude,
          longitude: locationSnapshot.longitude,
          accuracy: locationSnapshot.accuracy,
        },
        ...current,
      ]);
      setMessage(
        `${displayEventType(nextEmployeeEvent)} registrada com localização GPS (precisão aproximada de ${Math.round(locationSnapshot.accuracy)} m) e enviada para revisão.`,
      );
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
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const recordedAt = new Date(`${date}T${time}:00`);
    const { data: record, error: insertError } = await supabase
      .from('attendance_records')
      .insert({
        employee_id: employee.id,
        company_id: companyId,
        source: 'web',
        event_type: type,
        recorded_at: recordedAt.toISOString(),
        timezone,
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
    setMessage(
      isArchived
        ? `${employee.name} foi restaurado. O acesso ao sistema foi reativado.`
        : `${employee.name} foi arquivado. As marcações de ponto foram preservadas.`,
    );
    setSaving(false);
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
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-box">
          <div className="brand-mark">A</div>
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
              <button
                className={`nav-link ${activeView === 'reports' ? 'active' : ''}`}
                onClick={() => setActiveView('reports')}
              >
                Relatórios
              </button>
            </>
          ) : null}
        </nav>

        <div className="side-card">
          <h4>{isEmployee ? 'Registros hoje' : 'Equipe presente hoje'}</h4>
          <strong>{isEmployee ? attendance.filter((entry) => entry.date === localDate(new Date()) && entry.status !== 'rejected').length : stats.activeTeam}</strong>
          <div className="subtle">{dateLabel}</div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <h1>{activeView === 'dashboard' ? 'Dashboard' : activeView === 'point' ? isEmployee ? 'Meu ponto' : 'Registro de ponto' : activeView === 'employees' ? 'Funcionários' : activeView === 'approvals' ? 'Revisar marcações' : 'Relatórios'}</h1>
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
        {message ? (
          <div className="panel" role="status" style={{ marginBottom: 18, borderColor: '#1ea67a', color: '#147653' }}>
            {message}
          </div>
        ) : null}
        {loading ? <div className="panel" role="status">Carregando dados do Supabase...</div> : null}

        {isManager && activeView === 'dashboard' && (
          <>
            <div className="stats-grid">
              <div className="stat-card primary">
                <div className="stat-label">Colaboradores</div>
                <div className="stat-value">{stats.employees}</div>
              </div>
              <div className="stat-card success">
                <div className="stat-label">Presentes hoje</div>
                <div className="stat-value">{stats.present}</div>
              </div>
              <div className="stat-card warning">
                <div className="stat-label">Atrasos</div>
                <div className="stat-value">{stats.late}</div>
              </div>
              <div className="stat-card primary">
                <div className="stat-label">Marcações no mês</div>
                <div className="stat-value">{stats.monthlyEntries}</div>
              </div>
            </div>

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
                    <strong>{stats.activeTeam}</strong>
                  </div>
                  <div className="mini-box">
                    <span className="subtle">Faltas</span>
                    <strong>{stats.missing}</strong>
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
          <div className="content-grid">
            <div className="panel">
              <h3>{isEmployee ? 'Registrar meu ponto' : 'Registrar ponto'}</h3>
              {isEmployee ? (
                <div className="subtle">
                  <p>
                    O horário será registrado pelo servidor no momento da marcação. O registro não pode ser editado e ficará pendente de revisão.
                  </p>
                  <p>
                    O navegador solicitará sua localização apenas ao registrar o ponto. Não há rastreamento em segundo plano; sem permissão de GPS, a marcação não será enviada.
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
                        <label>Próxima marcação</label>
                        <input value={nextEmployeeEvent ? displayEventType(nextEmployeeEvent) : 'Limite diário atingido'} readOnly />
                      </div>
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
                        <label htmlFor="time">Hora</label>
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

                <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={saving || loading || employees.length === 0 || (isEmployee && !nextEmployeeEvent)}
                  >
                    {saving
                      ? 'Salvando...'
                      : isEmployee && nextEmployeeEvent
                        ? `Registrar ${displayEventType(nextEmployeeEvent).toLowerCase()}`
                        : 'Salvar marcação'}
                  </button>
                  {!isEmployee ? <button type="reset" className="btn secondary">Limpar</button> : null}
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
              <div className="table-wrap">
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
          <div className="content-grid">
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
                    <input id="cpf" name="cpf" type="text" inputMode="numeric" defaultValue={editingEmployee?.cpf || ''} required />
                  </div>

                  <div className="field">
                    <label htmlFor="department">Departamento</label>
                    <input id="department" name="department" type="text" defaultValue={editingEmployee?.department || ''} required />
                  </div>

                  <div className="field">
                    <label htmlFor="role">Cargo</label>
                    <input id="role" name="role" type="text" defaultValue={editingEmployee?.role || ''} required />
                  </div>

                  <div className="field">
                    <label htmlFor="shift">Jornada</label>
                    <select id="shift" name="shift" defaultValue={editingEmployee?.shift || '08:00-17:00'}>
                      <option value="08:00-17:00">08:00–17:00</option>
                      <option value="09:00-18:00">09:00-18:00</option>
                      <option value="12:00-21:00">12:00-21:00</option>
                      <option value="Flexível">Flexível</option>
                    </select>
                  </div>

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
              <div className="table-wrap">
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
                        <td>{employee.cpf}</td>
                        <td>{employee.shift}</td>
                        <td>{employee.status}</td>
                        <td>
                          {employee.status === 'Arquivado'
                            ? employee.hasLogin ? 'Bloqueada' : 'Arquivada'
                            : employee.hasLogin ? 'Vinculada' : 'Sem conta'}
                        </td>
                        <td>
                          <div className="employee-actions">
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
          </div>
        )}

        {isManager && activeView === 'approvals' && (
          <div className="panel">
            <h3>Marcações aguardando revisão</h3>
            <p className="subtle">
              A revisão altera apenas o status. Data, hora, tipo e demais dados da marcação permanecem preservados.
            </p>
            <div className="table-wrap">
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
                  {pendingAttendance.map((entry) => (
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
                        <div style={{ display: 'flex', gap: 8 }}>
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
                  {!loading && pendingAttendance.length === 0 ? (
                    <tr><td colSpan={8} className="empty">Não há marcações pendentes para revisar.</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
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
                <span className="subtle">Atrasos hoje (últimos registros)</span>
                <strong>{stats.late}</strong>
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
                    onChange={(event) => setReportFrom(event.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="reportTo">Data final</label>
                  <input
                    id="reportTo"
                    type="date"
                    value={reportTo}
                    onChange={(event) => setReportTo(event.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="reportEmployee">Funcionário</label>
                  <select
                    id="reportEmployee"
                    value={reportEmployeeId}
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
                <button
                  type="button"
                  className="btn secondary"
                  onClick={handleReportExport}
                  disabled={!reportLoaded || reportEntries.length === 0}
                >
                  Exportar CSV
                </button>
                {reportLoaded ? <span className="subtle">{reportEntries.length} marcação(ões) no período</span> : null}
              </div>
            </form>

            {reportLoaded ? (
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
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
