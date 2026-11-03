import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const validName = (value: string) =>
  value.length >= 2 &&
  value.length <= 100 &&
  /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\s'.-]*$/.test(value);

export async function POST(request: NextRequest) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Os dados enviados são inválidos.' }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('name' in body) ||
    !('email' in body) ||
    !('password' in body) ||
    !('cpf' in body) ||
    !('department' in body) ||
    !('jobTitle' in body) ||
    !('shift' in body) ||
    !('status' in body) ||
    typeof body.name !== 'string' ||
    typeof body.email !== 'string' ||
    typeof body.password !== 'string' ||
    typeof body.cpf !== 'string' ||
    typeof body.department !== 'string' ||
    typeof body.jobTitle !== 'string' ||
    typeof body.shift !== 'string' ||
    typeof body.status !== 'string'
  ) {
    return NextResponse.json({ error: 'Preencha todos os dados do funcionário e da conta.' }, { status: 400 });
  }

  const name = body.name.trim().replace(/\s+/g, ' ');
  const email = body.email.trim().toLowerCase();
  const password = body.password;
  const cpf = body.cpf.trim();
  const department = body.department.trim();
  const jobTitle = body.jobTitle.trim();
  const shift = body.shift.trim();
  const status = body.status.trim();

  if (
    !validName(name) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    password.length < 8 ||
    password.length > 72 ||
    !cpf ||
    cpf.length > 30 ||
    !department ||
    department.length > 100 ||
    !jobTitle ||
    jobTitle.length > 100 ||
    !shift ||
    shift.length > 50 ||
    !['Ativo', 'Férias', 'Licença'].includes(status)
  ) {
    return NextResponse.json({ error: 'Confira os dados. A senha deve ter entre 8 e 72 caracteres.' }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'A criação automática de contas não está configurada no servidor.' },
      { status: 503 },
    );
  }

  const callerClient = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData.user) {
    return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: managerProfile, error: profileError } = await admin
    .from('profiles')
    .select('role, company_id, status')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: 'Não foi possível validar seu perfil de acesso.' }, { status: 500 });
  }
  if (
    !managerProfile ||
    !['admin', 'gestor'].includes(managerProfile.role) ||
    managerProfile.status !== 'ativo' ||
    !managerProfile.company_id
  ) {
    return NextResponse.json({ error: 'Somente administradores e gestores podem cadastrar funcionários.' }, { status: 403 });
  }

  const { data: newUser, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nome: name },
  });

  if (authError || !newUser.user) {
    return NextResponse.json(
      { error: authError?.message || 'Não foi possível criar a conta de acesso.' },
      { status: 400 },
    );
  }

  const { data: employeeId, error: createError } = await callerClient.rpc(
    'create_employee_with_auth_account',
    {
      p_auth_user_id: newUser.user.id,
      p_email: email,
      p_name: name,
      p_cpf: cpf,
      p_department_name: department,
      p_job_title: jobTitle,
      p_shift: shift,
      p_status: status,
    },
  );

  if (createError || !employeeId) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(newUser.user.id);
    if (cleanupError) {
      return NextResponse.json(
        {
          error: `Não foi possível concluir o cadastro (${createError?.message || 'erro no banco'}). A conta de acesso foi criada, mas não foi possível removê-la automaticamente; exclua-a em Supabase → Authentication → Users.`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { error: createError?.message || 'Não foi possível salvar o cadastro do funcionário.' },
      { status: 400 },
    );
  }

  const { data: employee, error: employeeError } = await admin
    .from('employees')
    .select('codigo_registro')
    .eq('id', employeeId)
    .maybeSingle();

  return NextResponse.json(
    {
      employeeId,
      registrationCode: employee?.codigo_registro || null,
      warning: employeeError || !employee?.codigo_registro
        ? 'Funcionário criado; atualize a página para carregar o código.'
        : undefined,
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
