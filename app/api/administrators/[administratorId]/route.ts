import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

type RouteContext = { params: { administratorId: string } };

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.administratorId)) {
    return NextResponse.json({ error: 'Administrador inválido.' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Os dados enviados são inválidos.' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || !('currentPassword' in body) ||
      typeof body.currentPassword !== 'string' || body.currentPassword.length === 0 ||
      body.currentPassword.length > 256 || !('action' in body)) {
    return NextResponse.json({ error: 'Informe sua senha atual e a operação desejada.' }, { status: 400 });
  }

  let name = '';
  let password = '';
  if (body.action === 'name' && 'name' in body && typeof body.name === 'string') {
    name = body.name.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 100 || !/^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\s'.-]*$/.test(name)) {
      return NextResponse.json({ error: 'Informe um nome válido com 2 a 100 caracteres.' }, { status: 400 });
    }
  } else if (body.action === 'password' && 'password' in body && typeof body.password === 'string') {
    password = body.password;
    if (password.length < 8 || password.length > 72) {
      return NextResponse.json({ error: 'A nova senha deve ter entre 8 e 72 caracteres.' }, { status: 400 });
    }
  } else {
    return NextResponse.json({ error: 'Operação ou dados inválidos.' }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !serviceKey) {
    return NextResponse.json({ error: 'A gestão de administradores não está configurada no servidor.' }, { status: 503 });
  }
  const caller = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser(token);
  if (userError || !userData.user) {
    return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  }
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: actor, error: actorError } = await admin.from('profiles')
    .select('role, company_id, status')
    .eq('id', userData.user.id).maybeSingle();
  if (actorError) return NextResponse.json({ error: 'Não foi possível validar seu perfil.' }, { status: 500 });
  if (!actor || actor.role !== 'admin' || actor.status !== 'ativo' || !actor.company_id) {
    return NextResponse.json({ error: 'Somente administradores ativos podem realizar esta operação.' }, { status: 403 });
  }

  const { data: target, error: targetError } = await admin.from('profiles')
    .select('id, nome, role, company_id, status')
    .eq('id', params.administratorId).eq('company_id', actor.company_id).maybeSingle();
  if (targetError) return NextResponse.json({ error: 'Não foi possível consultar o administrador.' }, { status: 500 });
  if (!target || target.role !== 'admin' || target.status !== 'ativo') {
    return NextResponse.json({ error: 'Administrador ativo não encontrado nesta empresa.' }, { status: 404 });
  }
  if (!userData.user.email) {
    return NextResponse.json({ error: 'Sua conta não possui e-mail para confirmar a identidade.' }, { status: 400 });
  }
  const verifier = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: verified, error: verifyError } = await verifier.auth.signInWithPassword({
    email: userData.user.email,
    password: body.currentPassword,
  });
  if (verifyError) {
    if (verifyError.code === 'invalid_credentials') {
      return NextResponse.json({ error: 'Senha atual incorreta.' }, { status: 403 });
    }
    return NextResponse.json({ error: `Não foi possível verificar sua senha: ${verifyError.message}` }, { status: 503 });
  }
  if (verified.user?.id !== userData.user.id) {
    return NextResponse.json({ error: 'Não foi possível confirmar a identidade do administrador.' }, { status: 403 });
  }

  const { data: audit, error: auditError } = await admin.from('audit_logs').insert({
    table_name: 'profiles',
    record_id: target.id,
    user_id: userData.user.id,
    action: body.action === 'name' ? 'administrator_name_change_requested' : 'administrator_password_reset_requested',
    old_values: body.action === 'name' ? { nome: target.nome } : null,
    new_values: body.action === 'name' ? { nome: name } : null,
  }).select('id').single();
  if (auditError || !audit) {
    return NextResponse.json({ error: 'A operação foi cancelada porque não foi possível registrar a auditoria.' }, { status: 500 });
  }

  if (body.action === 'name') {
    const { data: updated, error } = await admin.from('profiles').update({ nome: name })
      .eq('id', target.id).eq('company_id', actor.company_id).eq('role', 'admin').eq('status', 'ativo')
      .eq('nome', target.nome)
      .select('id').maybeSingle();
    if (error) {
      return NextResponse.json({ error: 'Não foi possível alterar o nome. A tentativa foi registrada na auditoria.' }, { status: 500 });
    }
    if (!updated) {
      return NextResponse.json({ error: 'O cadastro mudou durante a operação. Confira a lista atualizada antes de tentar novamente.' }, { status: 409 });
    }
  } else {
    const { error } = await admin.auth.admin.updateUserById(target.id, { password });
    if (error) {
      return NextResponse.json({ error: `Não foi possível alterar a senha: ${error.message}` }, { status: 400 });
    }
  }

  const { data: completedAudit, error: completionError } = await admin.from('audit_logs').update({
    action: body.action === 'name' ? 'administrator_name_changed' : 'administrator_password_reset',
  }).eq('id', audit.id).select('id').maybeSingle();
  if (completionError || !completedAudit) {
    return NextResponse.json({
      error: 'A alteração foi feita, mas não foi possível concluir o registro de auditoria. Avise o suporte.',
      changed: true,
    }, { status: 500 });
  }
  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}
