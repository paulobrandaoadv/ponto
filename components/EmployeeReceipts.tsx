'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { attendanceDate } from '@/lib/attendance-time';
import { displayCpf } from '@/lib/cpf';
import { fetchEmployeeReceipts, receiptDate, receiptMoney, type EmployeeReceipt } from '@/lib/employee-receipts';
import { receiptMoneyWords } from '@/lib/money-words';
import { parseHourlyRateCents } from '@/lib/report-payment';
import { supabase } from '@/lib/supabase';

type Props = {
  companyId: string;
  employees: Array<{ id: string; name: string; cpf: string }>;
};

export default function EmployeeReceipts({ companyId, employees }: Props) {
  const [employeeId, setEmployeeId] = useState('');
  const [type, setType] = useState<'advance' | 'payment'>('advance');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => attendanceDate(new Date()));
  const [location, setLocation] = useState('Mundo Novo/MS');
  const [notes, setNotes] = useState('');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [receipts, setReceipts] = useState<EmployeeReceipt[]>([]);
  const [knownEmployees, setKnownEmployees] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<EmployeeReceipt | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (from && to && from > to) throw new Error('A data inicial deve ser anterior ou igual à final.');
    const data = await fetchEmployeeReceipts(companyId, { employeeId: filterEmployee, from, to });
    setReceipts(data);
    setKnownEmployees((known) => {
      const names = new Map(known.map((item) => [item.id, item.name]));
      data.forEach((item) => names.set(item.employee_id, item.employee_name));
      return Array.from(names, ([id, name]) => ({ id, name }));
    });
    setSelected((current) => current ? data.find((item) => item.id === current.id) || null : null);
  }, [companyId, filterEmployee, from, to]);

  useEffect(() => {
    if (!companyId) return;
    let active = true;
    fetchEmployeeReceipts(companyId, {}).then((data) => {
      if (active) {
        setReceipts(data);
        const names = new Map(data.map((item) => [item.employee_id, item.employee_name]));
        setKnownEmployees(Array.from(names, ([id, name]) => ({ id, name })));
      }
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Erro ao consultar recibos.');
    });
    return () => { active = false; };
  }, [companyId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current) return;
    const cents = parseHourlyRateCents(amount);
    if (!supabase || !employeeId || !date || !location.trim() || cents === null) {
      setError('Informe funcionário, data, local e valor válido maior que zero.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    requestId.current ||= crypto.randomUUID();
    try {
      const { data, error: saveError } = await supabase.rpc('create_employee_receipt_with_notes', {
        p_id: requestId.current, p_employee_id: employeeId, p_type: type,
        p_amount_cents: cents, p_date: date, p_location: location, p_notes: notes,
      });
      if (saveError) throw new Error(saveError.message);
      setLocked(false);
      requestId.current = null;
      setAmount('');
      setNotes('');
      setMessage('Recibo registrado.');
      try {
        await load();
      } catch (failure) {
        setReceipts([]);
        setError(`O recibo foi registrado, mas o histórico não foi atualizado: ${failure instanceof Error ? failure.message : 'erro de conexão'}. Consulte o histórico novamente.`);
      }
      if (data && !data.cancelled_at) setSelected(data as EmployeeReceipt);
    } catch (failure) {
      setLocked(true);
      setError(`${failure instanceof Error ? failure.message : 'Erro ao emitir recibo.'} Tente novamente com os mesmos dados; antes de alterar o formulário, confira o histórico para evitar duplicação.`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const cancel = async (receipt: EmployeeReceipt) => {
    if (!supabase || inFlight.current) return;
    if (!reason.trim()) { setError('Informe o motivo do cancelamento.'); return; }
    if (!window.confirm('Cancelar este recibo? A ação não pode ser desfeita e ficará no histórico.')) return;
    setSelected(null);
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { error: cancelError } = await supabase.rpc('cancel_employee_receipt', {
        p_id: receipt.id, p_reason: reason.trim(),
      });
      if (cancelError) throw new Error(cancelError.message);
      setReason('');
      setMessage('Recibo cancelado; o histórico foi preservado.');
      await load();
    } catch (failure) {
      setReceipts([]);
      setError(`${failure instanceof Error ? failure.message : 'Erro ao cancelar recibo.'} Consulte o histórico antes de tentar novamente.`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const printReceipt = async (receipt: EmployeeReceipt) => {
    if (!supabase || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const { data, error: readError } = await supabase.from('employee_receipts')
        .select('id, cancelled_at').eq('company_id', companyId).eq('id', receipt.id).maybeSingle();
      if (readError) throw new Error(readError.message);
      if (!data || data.cancelled_at) {
        setSelected(null);
        throw new Error('O recibo não está mais disponível ou foi cancelado. Atualize o histórico.');
      }
      window.print();
    } catch (failure) {
      setError(`Não foi possível imprimir: ${failure instanceof Error ? failure.message : 'erro de conexão'}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const employee = employees.find((item) => item.id === employeeId);
  return (
    <div className="panel receipts-panel">
      {error ? <p role="alert" className="employee-overtime-error">{error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <h2>Emitir recibo</h2>
      <p className="subtle">A emissão de um documento não comprova pagamento ou recebimento. Imprima e recolha a assinatura.</p>
      <form onSubmit={submit}>
        <div className="form-grid">
          <div className="field"><label htmlFor="receipt-employee">Funcionário</label>
            <select id="receipt-employee" required value={employeeId} disabled={busy || locked} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Selecione</option>
              {employees.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {employee ? <span className="subtle">CPF: {displayCpf(employee.cpf)}</span> : null}
          </div>
          <div className="field"><label htmlFor="receipt-type">Tipo</label>
            <select id="receipt-type" value={type} disabled={busy || locked} onChange={(e) => setType(e.target.value === 'payment' ? 'payment' : 'advance')}>
              <option value="advance">Adiantamento (vale)</option><option value="payment">Pagamento</option>
            </select>
          </div>
          <div className="field"><label htmlFor="receipt-amount">Valor (R$)</label>
            <input id="receipt-amount" required inputMode="decimal" placeholder="Ex.: 150,00" value={amount} disabled={busy || locked} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field"><label htmlFor="receipt-date">Data do recibo</label>
            <input id="receipt-date" required type="date" value={date} disabled={busy || locked} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field"><label htmlFor="receipt-location">Local</label>
            <input id="receipt-location" required maxLength={200} value={location} disabled={busy || locked} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <div className="field full"><label htmlFor="receipt-notes">Observação (opcional)</label>
            <textarea id="receipt-notes" maxLength={1000} rows={3} value={notes} disabled={busy || locked}
              placeholder="Ex.: pagamento referente a 30 horas entre 01 e 20 de novembro"
              onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <button className="btn primary" disabled={busy} type="submit">{busy ? 'Aguarde...' : locked ? 'Tentar novamente' : 'Registrar recibo'}</button>
        {locked ? <button className="btn secondary" type="button" disabled={busy} onClick={() => {
          if (window.confirm('Confira o histórico antes de alterar os dados. Prosseguir?')) {
            requestId.current = null; setLocked(false); setError('');
          }
        }}>Alterar dados</button> : null}
      </form>

      <h2>Histórico de recibos</h2>
      <form onSubmit={async (event) => {
        event.preventDefault(); setError(''); setBusy(true);
        try { await load(); } catch (failure) {
          setReceipts([]); setSelected(null);
          setError(failure instanceof Error ? failure.message : 'Erro ao consultar recibos.');
        } finally { setBusy(false); }
      }}>
        <div className="form-grid">
          <div className="field"><label htmlFor="receipt-filter-employee">Funcionário</label>
            <select id="receipt-filter-employee" value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
              <option value="">Todos</option>
              {[...employees, ...knownEmployees.filter((item) => !employees.some((employee) => employee.id === item.id))]
                .map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="receipt-filter-from">De</label><input id="receipt-filter-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label htmlFor="receipt-filter-to">Até</label><input id="receipt-filter-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <button className="btn secondary" disabled={busy} type="submit">Filtrar</button>
      </form>
      <div className="table-wrap">
        <table><thead><tr><th>Data</th><th>Funcionário</th><th>Tipo</th><th>Valor</th><th>Situação</th><th>Ação</th></tr></thead>
          <tbody>{receipts.map((item) => <tr key={item.id}>
            <td>{receiptDate(item.receipt_date)}</td><td>{item.employee_name}</td>
            <td>{item.receipt_type === 'advance' ? 'Vale' : 'Pagamento'}</td><td>{receiptMoney(item.amount_cents)}</td>
            <td>{item.cancelled_at ? `Cancelado: ${item.cancellation_reason}` : 'Ativo'}</td>
            <td><button className="btn secondary" type="button" onClick={() => { setSelected(item); setReason(''); }}>Ver</button></td>
          </tr>)}
          {!receipts.length ? <tr><td colSpan={6} className="empty">Nenhum recibo encontrado.</td></tr> : null}</tbody>
        </table>
      </div>
      {selected ? <section className="receipt-selection">
        <h3>Recibo selecionado</h3>
        {selected.cancelled_at ? <p role="alert">Cancelado: {selected.cancellation_reason}. Não pode ser impresso como recibo ativo.</p> : <>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void printReceipt(selected)}>Imprimir / salvar como PDF</button>
          <div className="field"><label htmlFor="receipt-reason">Motivo do cancelamento</label>
            <input id="receipt-reason" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => void cancel(selected)}>Cancelar recibo</button>
          <article className="receipt-print">
            <h2>{selected.receipt_type === 'advance' ? 'RECIBO DE ADIANTAMENTO (VALE)' : 'RECIBO DE PAGAMENTO'}</h2>
            <p><strong>Valor: {receiptMoney(selected.amount_cents)}</strong></p>
            <p>Recebi de <strong>{selected.employer_name}</strong>{selected.employer_cnpj
              ? selected.receipt_type === 'payment'
                ? `, inscrita no CNPJ sob o nº ${selected.employer_cnpj},`
                : `, CNPJ ${selected.employer_cnpj},`
              : ','} a importância líquida de <strong>{receiptMoney(selected.amount_cents)} ({receiptMoneyWords(selected.amount_cents)})</strong>,
              {selected.receipt_type === 'advance'
                ? ' referente a adiantamento salarial (vale), a ser descontado integralmente no próximo pagamento/fechamento.'
                : ' referente a pagamento.'}</p>
            <p>Para maior clareza, assino o presente recibo dando quitação da quantia recebida.</p>
            {selected.notes ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><strong>Obs.:</strong> {selected.notes}</p> : null}
            <p><strong>Local e data:</strong> {selected.location}, {receiptDate(selected.receipt_date)}.</p>
            <p><strong>Nome completo do(a) funcionário(a):</strong> {selected.employee_name}</p>
            <p><strong>CPF:</strong> {displayCpf(selected.employee_cpf)}</p>
            <p className="receipt-signature">________________________________________<br />Assinatura do(a) funcionário(a)</p>
          </article>
        </>}
      </section> : null}
    </div>
  );
}
