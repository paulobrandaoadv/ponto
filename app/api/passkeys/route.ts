import { NextRequest, NextResponse } from 'next/server';
import { getPasskeyContext, isNextResponse } from '@/lib/passkey-server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const context = await getPasskeyContext(request);
  if (isNextResponse(context)) return context;

  const { data, error } = await context.admin
    .from('employee_passkeys')
    .select('credential_id, device_type, backed_up, created_at')
    .eq('user_id', context.userId)
    .eq('company_id', context.companyId)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'Não foi possível carregar as passkeys cadastradas.' }, { status: 500 });
  }

  return NextResponse.json(
    {
      passkeys: (data || []).map((passkey) => ({
        id: passkey.credential_id,
        deviceType: passkey.device_type,
        backedUp: passkey.backed_up,
        createdAt: passkey.created_at,
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function DELETE(request: NextRequest) {
  const context = await getPasskeyContext(request);
  if (isNextResponse(context)) return context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Os dados enviados são inválidos.' }, { status: 400 });
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('credentialId' in body) ||
    typeof body.credentialId !== 'string' ||
    body.credentialId.length < 1 ||
    body.credentialId.length > 1024
  ) {
    return NextResponse.json({ error: 'Informe a passkey que deseja remover.' }, { status: 400 });
  }

  const { data, error } = await context.admin
    .from('employee_passkeys')
    .delete()
    .eq('credential_id', body.credentialId)
    .eq('user_id', context.userId)
    .eq('company_id', context.companyId)
    .select('credential_id')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: 'Não foi possível remover a passkey.' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Passkey não encontrada para esta conta.' }, { status: 404 });
  }

  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}
