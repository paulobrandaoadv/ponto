import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import {
  getPasskeyContext,
  getWebAuthnConfig,
  isNextResponse,
  isRecord,
  isRegistrationResponse,
} from '@/lib/passkey-server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const context = await getPasskeyContext(request);
  if (isNextResponse(context)) return context;

  const config = getWebAuthnConfig();
  if (isNextResponse(config)) return config;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Os dados enviados são inválidos.' }, { status: 400 });
  }

  if (
    !isRecord(body) ||
    typeof body.challengeId !== 'string' ||
    !isRegistrationResponse(body.response)
  ) {
    return NextResponse.json({ error: 'A resposta do dispositivo está incompleta.' }, { status: 400 });
  }

  const { data: challenge, error: challengeError } = await context.admin
    .from('passkey_challenges')
    .select('challenge')
    .eq('id', body.challengeId)
    .eq('user_id', context.userId)
    .eq('company_id', context.companyId)
    .eq('purpose', 'register')
    .is('verified_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (challengeError) {
    return NextResponse.json({ error: 'Não foi possível validar o desafio de cadastro.' }, { status: 500 });
  }
  if (!challenge) {
    return NextResponse.json({ error: 'O cadastro expirou. Inicie novamente.' }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
  } catch {
    return NextResponse.json({ error: 'O dispositivo não conseguiu confirmar o cadastro da passkey.' }, { status: 400 });
  }

  if (!verification.verified || !verification.registrationInfo.userVerified) {
    return NextResponse.json({ error: 'O dispositivo não confirmou a verificação do usuário.' }, { status: 400 });
  }

  const { data: consumedChallenge, error: consumeError } = await context.admin
    .from('passkey_challenges')
    .update({ verified_at: new Date().toISOString() })
    .eq('id', body.challengeId)
    .eq('user_id', context.userId)
    .eq('purpose', 'register')
    .is('verified_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();

  if (consumeError) {
    return NextResponse.json({ error: 'Não foi possível concluir o cadastro da passkey.' }, { status: 500 });
  }
  if (!consumedChallenge) {
    return NextResponse.json({ error: 'O cadastro já foi usado ou expirou. Inicie novamente.' }, { status: 400 });
  }

  const credential = verification.registrationInfo.credential;
  const createdAt = new Date().toISOString();
  const { error: saveError } = await context.admin.from('employee_passkeys').insert({
    credential_id: credential.id,
    user_id: context.userId,
    company_id: context.companyId,
    public_key: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports || [],
    device_type: verification.registrationInfo.credentialDeviceType,
    backed_up: verification.registrationInfo.credentialBackedUp,
    created_at: createdAt,
  });

  if (saveError) {
    return NextResponse.json({ error: 'Não foi possível salvar a passkey. Tente cadastrar o dispositivo novamente.' }, { status: 500 });
  }

  return NextResponse.json(
    {
      success: true,
      passkey: {
        id: credential.id,
        deviceType: verification.registrationInfo.credentialDeviceType,
        backedUp: verification.registrationInfo.credentialBackedUp,
        createdAt,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
