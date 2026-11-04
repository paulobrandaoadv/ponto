import { NextRequest, NextResponse } from 'next/server';
import { createFaceAdminClient, isNextResponse, isRecord } from '@/lib/face-server';
import { isFaceDescriptor } from '@/lib/face-shared';
import { cosineSimilarity, decryptFaceTemplate } from '@/lib/face-template';

export const runtime = 'nodejs';

const pageSize = 500;
const maxTemplates = 5000;
const minimumSimilarity = 0.363;
const minimumMargin = 0.05;
const attemptWindowMs = 15 * 60 * 1000;
const maxAttempts = 20;
const attempts = new Map<string, { count: number; resetAt: number }>();

function requestIp(request: NextRequest) {
  return request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
}

function isRateLimited(ip: string) {
  const now = Date.now();
  attempts.forEach((value, key) => {
    if (value.resetAt <= now) attempts.delete(key);
  });
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + attemptWindowMs });
    return false;
  }
  current.count += 1;
  return current.count > maxAttempts;
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 16_000) {
    return NextResponse.json({ error: 'Os dados enviados são muito grandes.' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Os dados enviados são inválidos.' }, { status: 400 });
  }
  if (!isRecord(body) || !isFaceDescriptor(body.descriptor)) {
    return NextResponse.json({ error: 'Não foi possível validar os dados faciais.' }, { status: 400 });
  }
  const descriptor = body.descriptor;

  if (isRateLimited(requestIp(request))) {
    return NextResponse.json(
      { error: 'Muitas tentativas de reconhecimento. Aguarde 15 minutos ou use o login manual.' },
      { status: 429, headers: { 'Retry-After': String(attemptWindowMs / 1000) } },
    );
  }

  const result = createFaceAdminClient();
  if (isNextResponse(result)) return result;
  const { admin } = result;

  const templates: Array<{
    employee_id: string;
    user_id: string;
    company_id: string;
    template_ciphertext: string;
    template_iv: string;
    template_auth_tag: string;
    key_version: number;
  }> = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin
      .from('employee_face_templates')
      .select('employee_id, user_id, company_id, template_ciphertext, template_iv, template_auth_tag, key_version')
      .order('employee_id')
      .range(offset, offset + pageSize - 1);
    if (error) {
      return NextResponse.json({ error: 'Não foi possível consultar os cadastros faciais.' }, { status: 503 });
    }

    templates.push(...(data || []));
    if (!data || data.length < pageSize) break;
    if (templates.length >= maxTemplates) {
      const { data: extraTemplate, error: countError } = await admin
        .from('employee_face_templates')
        .select('employee_id')
        .order('employee_id')
        .range(maxTemplates, maxTemplates);
      if (countError) {
        return NextResponse.json({ error: 'Não foi possível validar a quantidade de cadastros faciais.' }, { status: 503 });
      }
      if (extraTemplate?.length) {
        return NextResponse.json(
          { error: 'A busca facial excedeu o limite de cadastros. Use o login manual e fale com o administrador.' },
          { status: 503 },
        );
      }
      break;
    }
  }

  let ranked: Array<{ userId: string; companyId: string; employeeId: string; similarity: number }>;
  try {
    ranked = templates
      .map((template) => ({
        userId: template.user_id,
        companyId: template.company_id,
        employeeId: template.employee_id,
        similarity: cosineSimilarity(
          descriptor,
          decryptFaceTemplate(template),
        ),
      }))
      .sort((left, right) => right.similarity - left.similarity);
  } catch (error) {
    console.error('Could not compare face templates.', error);
    return NextResponse.json(
      { error: 'Os cadastros faciais não puderam ser lidos. Use o login manual e avise o administrador.' },
      { status: 503 },
    );
  }

  const best = ranked[0];
  const nextBest = ranked[1];
  if (
    !best ||
    best.similarity < minimumSimilarity ||
    (nextBest && best.similarity - nextBest.similarity < minimumMargin)
  ) {
    return NextResponse.json({ matched: false }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { data: employee, error: employeeError } = await admin
    .from('employees')
    .select('id')
    .eq('id', best.employeeId)
    .eq('user_id', best.userId)
    .eq('company_id', best.companyId)
    .ilike('status', 'ativo')
    .maybeSingle();
  if (employeeError) {
    return NextResponse.json({ error: 'Não foi possível validar o vínculo do funcionário.' }, { status: 503 });
  }
  if (!employee) {
    return NextResponse.json({ matched: false }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('email')
    .eq('id', best.userId)
    .eq('company_id', best.companyId)
    .eq('role', 'funcionario')
    .eq('status', 'ativo')
    .maybeSingle();
  if (profileError) {
    return NextResponse.json({ error: 'Não foi possível validar a conta do funcionário.' }, { status: 503 });
  }
  if (!profile?.email) {
    return NextResponse.json({ matched: false }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: profile.email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    console.error('Could not generate a face-authenticated session.', linkError);
    return NextResponse.json({ error: 'Não foi possível iniciar a sessão facial.' }, { status: 503 });
  }

  const challengeId = crypto.randomUUID();
  const { error: challengeError } = await admin.from('face_auth_challenges').insert({
    id: challengeId,
    user_id: best.userId,
    company_id: best.companyId,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  if (challengeError) {
    return NextResponse.json({ error: 'Não foi possível preparar a marcação facial.' }, { status: 503 });
  }

  return NextResponse.json(
    { matched: true, tokenHash, challengeId },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
