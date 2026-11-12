export function isDuplicateFaceAttendanceError(
  error: { code?: string; message: string } | null,
): error is { code: string; message: string } {
  return error?.code === 'P0001' && (
    error.message.startsWith('Já existe uma jornada aberta. Não é possível registrar outra entrada.')
    || error.message.startsWith('A última marcação já é deste tipo. Não é possível registrá-la novamente em sequência.')
  );
}
