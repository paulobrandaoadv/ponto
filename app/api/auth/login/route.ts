import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const genericLoginError = 'Nome ou senha inválidos.';
const attemptWindowMs = 15 * 60 * 1000;
const maxAttempts = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

const normalizedName = (name: string) => name.trim().replace(/\s+/g, ' ');

const requestIp = (request: NextRequest) =>
  request.headers.get('x-real-ip') ||
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
  'unknown';

const attemptKey = (ip: string, name: string) =>
  `${ip}:${name.toLocaleLowerCase('pt-BR')}`;

const validName = (name: string) =>
  name.length >= 2 &&
  name.length <= 100 &&
  /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ\s'.-]*$/.test(name);

const validRegistrationIdentity = (identity: string) =>
  identity.length >= 1 &&
  identity.length <= 60 &&
  /^[A-Za-z0-9][A-Za-z0-9 .-]*$/.test(identity);

function isRateLimited(request: NextRequest, name: string) {
  const ip = requestIp(request);
  const keys = [attemptKey(ip, name), `${ip}:all`];
  const now = Date.now();

  attempts.forEach((value, key) => {
    if (value.resetAt <= now) attempts.delete(key);
  });

  let limited = false;
  keys.forEach((key, index) => {
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + attemptWindowMs });
      return;
    }

    current.count += 1;
    if (current.count > (index === 0 ? maxAttempts : maxAttempts * 4)) limited = true;
  });
  return limited;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: genericLoginError }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('password' in body) ||
    typeof body.password !== 'string'
  ) {
    return NextResponse.json({ error: genericLoginError }, { status: 400 });
  }

  const identityValue = 'identity' in body && typeof body.identity === 'string'
    ? body.identity
    : 'name' in body && typeof body.name === 'string'
      ? body.name
      : '';
  const identity = normalizedName(identityValue);
  const password = body.password;
  if (
    (!validName(identity) && !validRegistrationIdentity(identity)) ||
    password.length === 0 ||
    password.length > 256
  ) {
    return NextResponse.json({ error: genericLoginError }, { status: 400 });
  }

  if (isRateLimited(request, identity)) {
    return NextResponse.json(
      { error: 'Muitas tentativas. Aguarde 15 minutos e tente novamente.' },
      { status: 429, headers: { 'Retry-After': String(attemptWindowMs / 1000) } },
    );
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'Login por nome não está configurado no servidor. Verifique as variáveis de ambiente.' },
      { status: 503 },
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const authClient = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const matchingUserIds = new Set<string>();
  if (validName(identity)) {
    const { data: profiles, error: profileError } = await admin
      .from('profiles')
      .select('id')
      .eq('status', 'ativo')
      .ilike('nome', identity)
      .limit(2);
    if (profileError) {
      return NextResponse.json({ error: genericLoginError }, { status: 401 });
    }
    profiles?.forEach((profile) => matchingUserIds.add(profile.id));
  }

  if (validRegistrationIdentity(identity)) {
    const [matriculaResult, registrationResult] = await Promise.all([
      admin
        .from('employees')
        .select('user_id')
        .ilike('status', 'ativo')
        .eq('matricula', identity)
        .not('user_id', 'is', null)
        .limit(2),
      admin
        .from('employees')
        .select('user_id')
        .ilike('status', 'ativo')
        .eq('codigo_registro', identity)
        .not('user_id', 'is', null)
        .limit(2),
    ]);
    if (matriculaResult.error || registrationResult.error) {
      return NextResponse.json({ error: genericLoginError }, { status: 401 });
    }
    matriculaResult.data?.forEach((employee) => {
      if (employee.user_id) matchingUserIds.add(employee.user_id);
    });
    registrationResult.data?.forEach((employee) => {
      if (employee.user_id) matchingUserIds.add(employee.user_id);
    });
  }

  if (matchingUserIds.size !== 1) {
    return NextResponse.json({ error: genericLoginError }, { status: 401 });
  }

  const userId = Array.from(matchingUserIds)[0];
  const { data: activeProfile, error: activeProfileError } = await admin
    .from('profiles')
    .select('status')
    .eq('id', userId)
    .maybeSingle();
  if (activeProfileError || activeProfile?.status !== 'ativo') {
    return NextResponse.json({ error: genericLoginError }, { status: 401 });
  }

  const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(userId);
  const email = authUser.user?.email;
  if (authUserError || !email) {
    return NextResponse.json({ error: genericLoginError }, { status: 401 });
  }

  const { data: signInData, error: signInError } = await authClient.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signInData.session) {
    return NextResponse.json({ error: genericLoginError }, { status: 401 });
  }

  attempts.delete(attemptKey(requestIp(request), identity));

  return NextResponse.json(
    {
      session: {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
