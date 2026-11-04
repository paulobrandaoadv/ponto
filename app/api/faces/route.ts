import { NextRequest, NextResponse } from 'next/server';
import { getFaceManagerContext, isNextResponse, isRecord, isUuid } from '@/lib/face-server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const context = await getFaceManagerContext(request);
  if (isNextResponse(context)) return context;

  const { data, error } = await context.admin
    .from('employee_face_templates')
    .select('employee_id')
    .eq('company_id', context.companyId);
  if (error) {
    return NextResponse.json({ error: 'Não foi possível consultar os cadastros faciais.' }, { status: 500 });
  }

  return NextResponse.json(
    { enrolledEmployeeIds: (data || []).map((item) => item.employee_id) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function DELETE(request: NextRequest) {
  const context = await getFaceManagerContext(request);
  if (isNextResponse(context)) return context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Os dados enviados são inválidos.' }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.employeeId !== 'string' || !isUuid(body.employeeId)) {
    return NextResponse.json({ error: 'Selecione um funcionário válido.' }, { status: 400 });
  }

  const { data, error } = await context.admin
    .from('employee_face_templates')
    .delete()
    .eq('employee_id', body.employeeId)
    .eq('company_id', context.companyId)
    .select('employee_id')
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: 'Não foi possível remover o cadastro facial.' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Cadastro facial não encontrado nesta empresa.' }, { status: 404 });
  }

  const { error: auditError } = await context.admin.from('audit_logs').insert({
    table_name: 'employee_face_templates',
    record_id: body.employeeId,
    user_id: context.userId,
    action: 'face_template_removed',
    old_values: { template_removed: true },
    new_values: null,
  });
  if (auditError) {
    console.error('Face template removed, but audit logging failed.', auditError);
    return NextResponse.json(
      {
        success: true,
        warning: 'O rosto foi removido, mas não foi possível registrar a ação na auditoria. Avise o administrador do sistema.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}
