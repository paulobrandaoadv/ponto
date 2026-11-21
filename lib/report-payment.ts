export function parseHourlyRateCents(value: string) {
  const trimmed = value.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  const brazilian = /^(?:\d{1,7}|\d{1,3}(?:\.\d{3}){1,2})(?:,\d{1,2})?$/;
  const decimal = /^\d{1,7}\.\d{1,2}$/;
  if (!brazilian.test(trimmed) && !decimal.test(trimmed)) return null;
  const normalized = decimal.test(trimmed)
    ? trimmed
    : trimmed.replace(/\./g, '').replace(',', '.');
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function calculatePaymentCents(minutes: number, hourlyRateCents: number) {
  if (!Number.isSafeInteger(minutes) || minutes < 0 ||
      !Number.isSafeInteger(hourlyRateCents) || hourlyRateCents < 0) {
    throw new Error('Informe horas e valor-hora válidos para calcular o pagamento.');
  }
  const product = minutes * hourlyRateCents;
  if (!Number.isSafeInteger(product)) {
    throw new Error('O valor calculado excede o limite permitido.');
  }
  return Math.round(product / 60);
}

export function calculateAdvanceSimulation(paymentCents: number, advanceCents: number[]) {
  if (!Number.isSafeInteger(paymentCents) || paymentCents < 0 ||
      advanceCents.some((amount) => !Number.isSafeInteger(amount) || amount <= 0)) {
    throw new Error('Valores inválidos para simular os vales.');
  }
  const total = advanceCents.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isSafeInteger(total)) throw new Error('O total dos vales excede o limite permitido.');
  return { total, remaining: total <= paymentCents ? paymentCents - total : null };
}
