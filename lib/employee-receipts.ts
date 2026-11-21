import { supabase } from '@/lib/supabase';

export type EmployeeReceipt = {
  id: string;
  company_id: string;
  employee_id: string;
  employee_name: string;
  employee_cpf: string;
  employer_name: string;
  employer_cnpj: string | null;
  receipt_type: 'advance' | 'payment';
  amount_cents: number;
  receipt_date: string;
  location: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
};

export const receiptMoney = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
export const receiptDate = (date: string) => date.split('-').reverse().join('/');

export async function fetchEmployeeReceipts(companyId: string, filters: {
  employeeId?: string;
  from?: string;
  to?: string;
  activeOnly?: boolean;
}): Promise<EmployeeReceipt[]> {
  if (!supabase || !companyId) throw new Error('Não foi possível acessar a empresa da sessão.');
  const receipts: EmployeeReceipt[] = [];
  const size = 500;
  for (let offset = 0; ; offset += size) {
    let query = supabase.from('employee_receipts').select('*')
      .eq('company_id', companyId).order('receipt_date').order('id');
    if (filters.employeeId) query = query.eq('employee_id', filters.employeeId);
    if (filters.from) query = query.gte('receipt_date', filters.from);
    if (filters.to) query = query.lte('receipt_date', filters.to);
    if (filters.activeOnly) query = query.is('cancelled_at', null);
    const { data, error } = await query.range(offset, offset + size - 1);
    if (error) throw new Error(`Não foi possível consultar os recibos: ${error.message}`);
    receipts.push(...(data as EmployeeReceipt[]));
    if (data.length < size) return receipts;
  }
}
