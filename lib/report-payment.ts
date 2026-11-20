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
