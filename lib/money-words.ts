const units = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
const teens = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const tens = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const hundreds = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function underThousand(value: number): string {
  if (value === 100) return 'cem';
  const parts: string[] = [];
  if (value >= 100) parts.push(hundreds[Math.floor(value / 100)]);
  const rest = value % 100;
  if (rest >= 10 && rest < 20) parts.push(teens[rest - 10]);
  else {
    if (rest >= 20) parts.push(tens[Math.floor(rest / 10)]);
    if (rest % 10) parts.push(units[rest % 10]);
  }
  return parts.join(' e ');
}

function integerWords(value: number): string {
  const millions = Math.floor(value / 1000000);
  const thousands = Math.floor(value / 1000) % 1000;
  const rest = value % 1000;
  const parts: string[] = [];
  if (millions) parts.push(`${underThousand(millions)} ${millions === 1 ? 'milhão' : 'milhões'}`);
  if (thousands) parts.push(thousands === 1 ? 'mil' : `${underThousand(thousands)} mil`);
  if (rest) parts.push(underThousand(rest));
  if (parts.length <= 1) return parts[0] || 'zero';
  const last = rest || thousands;
  return `${parts.slice(0, -1).join(', ')}${last < 100 || last % 100 === 0 ? ' e ' : ' '}${parts[parts.length - 1]}`;
}

export function receiptMoneyWords(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > 999999999) {
    throw new Error('Valor de recibo inválido.');
  }
  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;
  const parts: string[] = [];
  if (reais) {
    const connector = reais >= 1000000 && reais % 1000000 === 0 ? ' de' : '';
    parts.push(`${integerWords(reais)}${connector} ${reais === 1 ? 'real' : 'reais'}`);
  }
  if (centavos) parts.push(`${integerWords(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`);
  return parts.join(' e ');
}
