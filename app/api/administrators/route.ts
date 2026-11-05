import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const validName = (value: string) =>
  value.length >= 2 &&
  value.length <= 100 &&
  /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\s'.-]*$/.test(value);

export async function POST(request: NextRequest) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
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
    typeof body.name !== 'string' ||
    typeof body.email !== 'string' ||
    typeof body.password !== 'string'
  ) {
    return NextResponse.json({ error: 'Informe nome, e-mail e senha.' }, { status: 400 });
  }

  const name = body.name.trim().replace(/\s+/g, ' ');
  const email = body.email.trim().toLowerCase();
  if (
    !validName(name) ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    body.password.length < 8 ||
    body.password.length > 72
  ) {
    return NextResponse.json(
      { error: 'Confira os dados. A senha deve ter entre 8 e 72 caracteres.' },
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
      { error: 'A criação de administradores não está configurada no servidor.' },
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
  const { data: creatorProfile, error: profileError } = await admin
    .from('profiles')
    .select('role, company_id, status')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: 'Não foi possível validar seu perfil de acesso.' }, { status: 500 });
  }
  if (
    !creatorProfile ||
    creatorProfile.role !== 'admin' ||
    creatorProfile.status !== 'ativo' ||
    !creatorProfile.company_id
  ) {
    return NextResponse.json(
      { error: 'Somente um administrador ativo pode cadastrar outro administrador.' },
      { status: 403 },
    );
  }

  const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
    email,
    password: body.password,
    email_confirm: true,
    user_metadata: { nome: name },
  });
  if (createUserError || !createdUser.user) {
    return NextResponse.json(
      { error: createUserError?.message || 'Não foi possível criar a conta de acesso.' },
      { status: 400 },
    );
  }

  const { error: createProfileError } = await admin.from('profiles').insert({
    id: createdUser.user.id,
    email,
    nome: name,
    role: 'admin',
    company_id: creatorProfile.company_id,
    status: 'ativo',
  });

  if (createProfileError) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(createdUser.user.id);
    if (cleanupError) {
      return NextResponse.json(
        {
          error: `Não foi possível criar o perfil (${createProfileError.message}). A conta Auth permaneceu sem perfil; remova-a em Supabase → Authentication → Users.`,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: `Não foi possível criar o perfil do administrador: ${createProfileError.message}` },
      { status: 400 },
    );
  }

  const { error: auditError } = await admin.from('audit_logs').insert({
    table_name: 'profiles',
    record_id: createdUser.user.id,
    user_id: userData.user.id,
    action: 'administrator_created',
    new_values: { role: 'admin', company_id: creatorProfile.company_id },
  });

  if (auditError) {
    const { error: deleteProfileError } = await admin
      .from('profiles')
      .delete()
      .eq('id', createdUser.user.id);
    const { error: deleteUserError } = await admin.auth.admin.deleteUser(createdUser.user.id);
    if (deleteProfileError || deleteUserError) {
      return NextResponse.json(
        {
          error: `O administrador foi criado, mas a auditoria falhou (${auditError.message}) e a limpeza não foi concluída. Verifique public.profiles e Authentication → Users.`,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: `A criação foi cancelada porque não foi possível registrar a auditoria: ${auditError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { success: true, name, email },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
