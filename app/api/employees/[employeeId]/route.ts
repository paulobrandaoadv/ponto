import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

type RouteContext = {
  params: { employeeId: string };
};

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.employeeId)) {
    return NextResponse.json({ error: 'Funcionário inválido.' }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'A exclusão definitiva não está configurada no servidor.' },
      { status: 503 },
    );
  }

  const caller = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser(token);
  if (userError || !userData.user) {
    return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('role, company_id, status')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: 'Não foi possível validar seu perfil de acesso.' }, { status: 500 });
  }
  if (
    !profile ||
    !['admin', 'gestor'].includes(profile.role) ||
    profile.status !== 'ativo' ||
    !profile.company_id
  ) {
    return NextResponse.json({ error: 'Somente administradores e gestores podem excluir funcionários.' }, { status: 403 });
  }

  const { data: linkedUserId, error: deleteError } = await caller.rpc(
    'delete_employee_permanently',
    { p_employee_id: params.employeeId },
  );
  if (deleteError) {
    return NextResponse.json(
      { error: `Não foi possível excluir o funcionário: ${deleteError.message}` },
      { status: 400 },
    );
  }

  if (typeof linkedUserId === 'string') {
    const { error: authDeleteError } = await admin.auth.admin.deleteUser(linkedUserId);
    if (authDeleteError) {
      return NextResponse.json(
        {
          error: `O cadastro, as marcações e o perfil foram apagados, mas não foi possível remover a conta de autenticação: ${authDeleteError.message}. O acesso está bloqueado por falta de perfil.`,
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}
