export type FacePunchType = 'entrada' | 'saida_almoco' | 'retorno_almoco' | 'saida';

export function facePunchOptions(lastEvent: string | null): FacePunchType[] {
  if (lastEvent === 'saida') return ['entrada'];
  return ['entrada', 'saida_almoco', 'retorno_almoco', 'saida'];
}

export function isRetryableFaceAttendanceError(
  error: { code?: string; message: string } | null,
): error is { code: string; message: string } {
  return error?.code === 'P0001' && (
    error.message.startsWith('Já existe uma jornada aberta. Não é possível registrar outra entrada.')
    || error.message.startsWith('A última marcação já é deste tipo. Não é possível registrá-la novamente em sequência.')
    || error.message.startsWith('A jornada anterior foi encerrada. A próxima marcação deve ser uma entrada.')
  );
}
