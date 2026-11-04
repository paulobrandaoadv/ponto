export function isFaceDescriptor(value: unknown): value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== 128 ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1)
  ) {
    return false;
  }
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  return norm >= 0.98 && norm <= 1.02;
}
