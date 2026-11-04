import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { getPasskeyContext, getWebAuthnConfig, isNextResponse } from '@/lib/passkey-server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const context = await getPasskeyContext(request);
  if (isNextResponse(context)) return context;

  const config = getWebAuthnConfig();
  if (isNextResponse(config)) return config;

  const { data: existingPasskeys, error: passkeysError } = await context.admin
    .from('employee_passkeys')
    .select('credential_id, transports')
    .eq('user_id', context.userId)
    .eq('company_id', context.companyId);

  if (passkeysError) {
    return NextResponse.json({ error: 'Não foi possível verificar passkeys existentes.' }, { status: 500 });
  }

  const { error: cleanupError } = await context.admin
    .from('passkey_challenges')
    .delete()
    .eq('user_id', context.userId)
    .lt('expires_at', new Date().toISOString());
  if (cleanupError) {
    return NextResponse.json({ error: 'Não foi possível preparar o cadastro da passkey.' }, { status: 500 });
  }

  let options;
  try {
    options = await generateRegistrationOptions({
      rpName: 'Anbelo Ponto',
      rpID: config.rpID,
      userName: context.email,
      userDisplayName: context.email,
      userID: Buffer.from(context.userId.replace(/-/g, ''), 'hex'),
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      excludeCredentials: (existingPasskeys || []).map((passkey) => ({
        id: passkey.credential_id,
        transports: passkey.transports,
      })),
    });
  } catch (error) {
    console.error('Could not generate passkey registration options.', error);
    return NextResponse.json({ error: 'Não foi possível iniciar o cadastro da passkey.' }, { status: 500 });
  }

  const challengeId = randomUUID();
  const { error: challengeError } = await context.admin.from('passkey_challenges').insert({
    id: challengeId,
    user_id: context.userId,
    company_id: context.companyId,
    challenge: options.challenge,
    purpose: 'register',
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  if (challengeError) {
    return NextResponse.json({ error: 'Não foi possível iniciar o cadastro da passkey.' }, { status: 500 });
  }

  return NextResponse.json(
    { challengeId, options },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
