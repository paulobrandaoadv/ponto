import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { getPasskeyContext, getWebAuthnConfig, isNextResponse } from '@/lib/passkey-server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const context = await getPasskeyContext(request);
  if (isNextResponse(context)) return context;

  const config = getWebAuthnConfig();
  if (isNextResponse(config)) return config;

  const { data: credentials, error: credentialsError } = await context.admin
    .from('employee_passkeys')
    .select('credential_id, transports')
    .eq('user_id', context.userId)
    .eq('company_id', context.companyId);

  if (credentialsError) {
    return NextResponse.json({ error: 'Não foi possível carregar as passkeys cadastradas.' }, { status: 500 });
  }
  if (!credentials?.length) {
    return NextResponse.json({ error: 'Cadastre primeiro a biometria deste aparelho ou use a marcação manual.' }, { status: 404 });
  }

  const { error: cleanupError } = await context.admin
    .from('passkey_challenges')
    .delete()
    .eq('user_id', context.userId)
    .lt('expires_at', new Date().toISOString());
  if (cleanupError) {
    return NextResponse.json({ error: 'Não foi possível preparar a verificação do aparelho.' }, { status: 500 });
  }

  let options;
  try {
    options = await generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: credential.transports,
      })),
      userVerification: 'required',
    });
  } catch (error) {
    console.error('Could not generate passkey authentication options.', error);
    return NextResponse.json({ error: 'Não foi possível iniciar a verificação do aparelho.' }, { status: 500 });
  }

  const challengeId = randomUUID();
  const { error: challengeError } = await context.admin.from('passkey_challenges').insert({
    id: challengeId,
    user_id: context.userId,
    company_id: context.companyId,
    challenge: options.challenge,
    purpose: 'authenticate',
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  if (challengeError) {
    return NextResponse.json({ error: 'Não foi possível iniciar a verificação do aparelho.' }, { status: 500 });
  }

  return NextResponse.json(
    { challengeId, options },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
