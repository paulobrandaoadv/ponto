export function cpfDigits(value: string) {
  return value.replace(/\D/g, '');
}

export function formatCpfInput(value: string) {
  const digits = cpfDigits(value).slice(0, 11);
  let result = digits.slice(0, 3);
  if (digits.length > 3) result += `.${digits.slice(3, 6)}`;
  if (digits.length > 6) result += `.${digits.slice(6, 9)}`;
  if (digits.length > 9) result += `-${digits.slice(9)}`;
  return result;
}

export function displayCpf(value: string) {
  return cpfDigits(value).length === 11 ? formatCpfInput(value) : value;
}

export function cpfSearchPattern(value: string) {
  return `%${cpfDigits(value).split('').join('%')}%`;
}

export function sameCpf(left: string, right: string) {
  const digits = cpfDigits(left);
  return digits.length === 11
    ? digits === cpfDigits(right)
    : left.trim() === right.trim();
}
