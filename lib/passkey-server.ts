import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export type PasskeyContext = {
  admin: SupabaseClient;
  caller: SupabaseClient;
  companyId: string;
  email: string;
  token: string;
  userId: string;
};

export async function getPasskeyContext(
  request: NextRequest,
): Promise<PasskeyContext | NextResponse> {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return NextResponse.json({ error: 'Sua sessão expirou. Entre novamente.' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceRoleKey) {
    return NextResponse.json({ error: 'A biometria do aparelho não está configurada no servidor.' }, { status: 503 });
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
    return NextResponse.json({ error: 'Não foi possível validar seu perfil.' }, { status: 500 });
  }
  if (
    !profile ||
    profile.role !== 'funcionario' ||
    profile.status !== 'ativo' ||
    !profile.company_id
  ) {
    return NextResponse.json({ error: 'Somente funcionários ativos podem configurar a biometria.' }, { status: 403 });
  }

  const { data: employee, error: employeeError } = await admin
    .from('employees')
    .select('id')
    .eq('user_id', userData.user.id)
    .eq('company_id', profile.company_id)
    .ilike('status', 'ativo')
    .maybeSingle();

  if (employeeError) {
    return NextResponse.json({ error: 'Não foi possível validar o cadastro de funcionário.' }, { status: 500 });
  }
  if (!employee) {
    return NextResponse.json({ error: 'Não há cadastro ativo de funcionário vinculado a esta conta.' }, { status: 403 });
  }

  return {
    admin,
    caller,
    companyId: profile.company_id,
    email: userData.user.email || userData.user.id,
    token,
    userId: userData.user.id,
  };
}

export function getWebAuthnConfig(): { origin: string; rpID: string } | NextResponse {
  const configuredSite = process.env.NEXT_PUBLIC_SITE_URL;
  const siteUrl = configuredSite
    ? configuredSite
    : process.env.NODE_ENV === 'development'
      ? 'http://localhost:3000'
      : process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : '';

  if (!siteUrl) {
    return NextResponse.json(
      { error: 'Configure NEXT_PUBLIC_SITE_URL no ambiente de produção para ativar a passkey.' },
      { status: 503 },
    );
  }

  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return NextResponse.json({ error: 'NEXT_PUBLIC_SITE_URL não é uma URL válida.' }, { status: 503 });
  }

  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocalhost) {
    return NextResponse.json({ error: 'A passkey exige HTTPS, exceto em localhost.' }, { status: 503 });
  }

  return { origin: url.origin, rpID: url.hostname };
}

export function isNextResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.rawId === 'string' &&
    value.type === 'public-key' &&
    isRecord(value.clientExtensionResults) &&
    isRecord(value.response) &&
    typeof value.response.clientDataJSON === 'string' &&
    typeof value.response.attestationObject === 'string'
  );
}

export function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.rawId === 'string' &&
    value.type === 'public-key' &&
    isRecord(value.clientExtensionResults) &&
    isRecord(value.response) &&
    typeof value.response.clientDataJSON === 'string' &&
    typeof value.response.authenticatorData === 'string' &&
    typeof value.response.signature === 'string' &&
    (value.response.userHandle === undefined || value.response.userHandle === null || typeof value.response.userHandle === 'string')
  );
}
