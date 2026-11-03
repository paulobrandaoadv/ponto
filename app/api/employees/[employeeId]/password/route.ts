import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

type RouteContext = {
  params: { employeeId: string };
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.employeeId)) {
    return NextResponse.json({ error: 'Funcionário inválido.' }, { status: 400 });
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
    !('password' in body) ||
    typeof body.password !== 'string' ||
    body.password.length < 8 ||
    body.password.length > 72
  ) {
    return NextResponse.json(
      { error: 'A senha temporária deve ter entre 8 e 72 caracteres.' },
      { status: 400 },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'A redefinição de senha não está configurada no servidor.' },
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
  const { data: managerProfile, error: managerError } = await admin
    .from('profiles')
    .select('role, company_id, status')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (managerError) {
    return NextResponse.json({ error: 'Não foi possível validar seu perfil de acesso.' }, { status: 500 });
  }
  if (
    !managerProfile ||
    !['admin', 'gestor'].includes(managerProfile.role) ||
    managerProfile.status !== 'ativo' ||
    !managerProfile.company_id
  ) {
    return NextResponse.json({ error: 'Somente administradores e gestores podem redefinir senhas.' }, { status: 403 });
  }

  const { data: employee, error: employeeError } = await admin
    .from('employees')
    .select('id, user_id, nome')
    .eq('id', params.employeeId)
    .eq('company_id', managerProfile.company_id)
    .maybeSingle();

  if (employeeError) {
    return NextResponse.json({ error: 'Não foi possível localizar o funcionário.' }, { status: 500 });
  }
  if (!employee?.user_id) {
    return NextResponse.json(
      { error: 'Este funcionário ainda não tem uma conta de acesso vinculada.' },
      { status: 404 },
    );
  }

  const { data: targetProfile, error: targetProfileError } = await admin
    .from('profiles')
    .select('role, company_id')
    .eq('id', employee.user_id)
    .maybeSingle();

  if (targetProfileError) {
    return NextResponse.json({ error: 'Não foi possível validar a conta do funcionário.' }, { status: 500 });
  }
  if (
    !targetProfile ||
    targetProfile.role !== 'funcionario' ||
    targetProfile.company_id !== managerProfile.company_id
  ) {
    return NextResponse.json({ error: 'A conta vinculada não é um perfil de funcionário desta empresa.' }, { status: 403 });
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(employee.user_id, {
    password: body.password,
  });
  if (updateError) {
    return NextResponse.json(
      { error: `Não foi possível redefinir a senha: ${updateError.message}` },
      { status: 400 },
    );
  }

  const { error: auditError } = await admin.from('audit_logs').insert({
    table_name: 'employees',
    record_id: employee.id,
    user_id: userData.user.id,
    action: 'employee_password_reset',
    new_values: { user_id: employee.user_id },
  });
  if (auditError) {
    return NextResponse.json(
      { error: 'A senha foi alterada, mas não foi possível registrar a auditoria. Avise o suporte.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}
