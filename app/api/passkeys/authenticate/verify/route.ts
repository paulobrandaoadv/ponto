import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  getPasskeyContext,
  getWebAuthnConfig,
  isAuthenticationResponse,
  isNextResponse,
  isRecord,
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
    !isAuthenticationResponse(body.response)
  ) {
    return NextResponse.json({ error: 'A resposta do dispositivo está incompleta.' }, { status: 400 });
  }

  const { latitude, longitude, accuracy, location, notes } = body;
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof accuracy !== 'number' ||
    !Number.isFinite(accuracy) ||
    accuracy < 0 ||
    (location !== null && location !== undefined && typeof location !== 'string') ||
    (notes !== null && notes !== undefined && typeof notes !== 'string') ||
    (typeof location === 'string' && location.length > 200) ||
    (typeof notes === 'string' && notes.length > 1000)
  ) {
    return NextResponse.json({ error: 'A localização ou as observações são inválidas.' }, { status: 400 });
  }

  const { data: challenge, error: challengeError } = await context.admin
    .from('passkey_challenges')
    .select('challenge')
    .eq('id', body.challengeId)
    .eq('user_id', context.userId)
    .eq('company_id', context.companyId)
    .eq('purpose', 'authenticate')
    .is('verified_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (challengeError) {
    return NextResponse.json({ error: 'Não foi possível validar a solicitação de verificação.' }, { status: 500 });
  }
  if (!challenge) {
    return NextResponse.json({ error: 'A verificação expirou. Tente novamente.' }, { status: 400 });
  }

  const { data: credential, error: credentialError } = await context.admin
    .from('employee_passkeys')
    .select('credential_id, public_key, counter, transports')
    .eq('credential_id', body.response.id)
    .eq('user_id', context.userId)
    .eq('company_id', context.companyId)
    .maybeSingle();

  if (credentialError) {
    return NextResponse.json({ error: 'Não foi possível carregar a passkey deste aparelho.' }, { status: 500 });
  }
  if (!credential) {
    return NextResponse.json({ error: 'Esta passkey não está cadastrada para sua conta.' }, { status: 401 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: {
        id: credential.credential_id,
        publicKey: Buffer.from(credential.public_key, 'base64url'),
        counter: Number(credential.counter),
        transports: credential.transports,
      },
      requireUserVerification: true,
    });
  } catch {
    return NextResponse.json({ error: 'A biometria ou o desbloqueio do aparelho não foi confirmado.' }, { status: 401 });
  }

  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return NextResponse.json({ error: 'O aparelho não confirmou a verificação do usuário.' }, { status: 401 });
  }

  const { data: consumedChallenge, error: consumeError } = await context.admin
    .from('passkey_challenges')
    .update({ verified_at: new Date().toISOString() })
    .eq('id', body.challengeId)
    .eq('user_id', context.userId)
    .eq('purpose', 'authenticate')
    .is('verified_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();

  if (consumeError) {
    return NextResponse.json({ error: 'Não foi possível concluir a verificação.' }, { status: 500 });
  }
  if (!consumedChallenge) {
    return NextResponse.json({ error: 'Esta verificação já foi usada ou expirou. Tente novamente.' }, { status: 400 });
  }

  const { data: updatedCredential, error: counterError } = await context.admin
    .from('employee_passkeys')
    .update({ counter: verification.authenticationInfo.newCounter })
    .eq('credential_id', credential.credential_id)
    .eq('user_id', context.userId)
    .eq('counter', credential.counter)
    .select('credential_id')
    .maybeSingle();

  if (counterError) {
    return NextResponse.json({ error: 'Não foi possível atualizar a segurança da passkey. Tente novamente.' }, { status: 500 });
  }
  if (!updatedCredential) {
    return NextResponse.json({ error: 'Esta passkey foi utilizada em outra verificação. Tente novamente.' }, { status: 409 });
  }

  const { data: recordId, error: attendanceError } = await context.caller.rpc('record_own_attendance_with_passkey', {
    p_location: typeof location === 'string' ? location.trim() || null : null,
    p_notes: typeof notes === 'string' ? notes.trim() || null : null,
    p_latitude: latitude,
    p_longitude: longitude,
    p_accuracy: accuracy,
    p_challenge_id: body.challengeId,
  });

  if (attendanceError || !recordId) {
    return NextResponse.json(
      { error: `Não foi possível registrar seu ponto: ${attendanceError?.message || 'registro não retornado'}` },
      { status: 400 },
    );
  }

  return NextResponse.json(
    { recordId },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
