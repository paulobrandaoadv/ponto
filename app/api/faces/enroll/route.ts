import { NextRequest, NextResponse } from 'next/server';
import { isFaceDescriptor } from '@/lib/face-shared';
import { encryptFaceTemplate, FaceTemplateKeyError } from '@/lib/face-template';
import { getFaceManagerContext, isNextResponse, isRecord, isUuid } from '@/lib/face-server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const context = await getFaceManagerContext(request);
  if (isNextResponse(context)) return context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Os dados enviados são inválidos.' }, { status: 400 });
  }
  if (
    !isRecord(body) ||
    typeof body.employeeId !== 'string' ||
    !isUuid(body.employeeId) ||
    !isFaceDescriptor(body.descriptor)
  ) {
    return NextResponse.json({ error: 'Não foi possível validar os dados faciais.' }, { status: 400 });
  }

  const { data: employee, error: employeeError } = await context.admin
    .from('employees')
    .select('id, user_id')
    .eq('id', body.employeeId)
    .eq('company_id', context.companyId)
    .ilike('status', 'ativo')
    .maybeSingle();
  if (employeeError) {
    return NextResponse.json({ error: 'Não foi possível validar o funcionário.' }, { status: 500 });
  }
  if (!employee?.user_id) {
    return NextResponse.json(
      { error: 'O funcionário precisa ter uma conta ativa vinculada antes de cadastrar o rosto.' },
      { status: 400 },
    );
  }

  const { data: profile, error: profileError } = await context.admin
    .from('profiles')
    .select('id')
    .eq('id', employee.user_id)
    .eq('company_id', context.companyId)
    .eq('role', 'funcionario')
    .eq('status', 'ativo')
    .maybeSingle();
  if (profileError) {
    return NextResponse.json({ error: 'Não foi possível validar a conta do funcionário.' }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ error: 'A conta vinculada ao funcionário não está ativa.' }, { status: 400 });
  }

  let encrypted: ReturnType<typeof encryptFaceTemplate>;
  try {
    encrypted = encryptFaceTemplate(body.descriptor, {
      employeeId: employee.id,
      userId: employee.user_id,
      companyId: context.companyId,
    });
  } catch (error) {
    console.error('Could not encrypt face template.', error);
    if (error instanceof FaceTemplateKeyError && error.reason === 'missing') {
      return NextResponse.json(
        {
          error: 'O deploy do site não recebeu FACE_TEMPLATE_ENCRYPTION_KEY. Adicione a variável em Settings → Environment Variables no Vercel, habilite Production e faça um novo deploy.',
        },
        { status: 503 },
      );
    }
    if (error instanceof FaceTemplateKeyError && error.reason === 'invalid') {
      return NextResponse.json(
        {
          error: 'O servidor recebeu FACE_TEMPLATE_ENCRYPTION_KEY, mas o formato é inválido. Use exatamente 64 caracteres hexadecimais, sem espaços ou texto adicional.',
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: 'O servidor encontrou uma falha interna ao criptografar o cadastro facial. Confira os logs da função /api/faces/enroll no Vercel.' },
      { status: 503 },
    );
  }

  const { data: existingTemplate, error: lookupError } = await context.admin
    .from('employee_face_templates')
    .select('employee_id')
    .eq('employee_id', employee.id)
    .eq('company_id', context.companyId)
    .maybeSingle();
  if (lookupError) {
    return NextResponse.json({ error: 'Não foi possível consultar o cadastro facial atual.' }, { status: 500 });
  }

  const { error: saveError } = await context.admin
    .from('employee_face_templates')
    .upsert(
      {
        employee_id: employee.id,
        user_id: employee.user_id,
        company_id: context.companyId,
        template_ciphertext: encrypted.ciphertext,
        template_iv: encrypted.iv,
        template_auth_tag: encrypted.authTag,
        key_version: encrypted.keyVersion,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'employee_id' },
    );
  if (saveError) {
    return NextResponse.json({ error: 'Não foi possível salvar o cadastro facial.' }, { status: 500 });
  }

  const { error: auditError } = await context.admin.from('audit_logs').insert({
    table_name: 'employee_face_templates',
    record_id: employee.id,
    user_id: context.userId,
    action: existingTemplate ? 'face_template_replaced' : 'face_template_enrolled',
    old_values: existingTemplate ? { template_replaced: true } : null,
    new_values: { template_encrypted: true },
  });
  if (auditError) {
    console.error('Face template saved, but audit logging failed.', auditError);
    return NextResponse.json(
      {
        success: true,
        warning: 'O rosto foi salvo, mas não foi possível registrar a ação na auditoria. Avise o administrador do sistema.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}
