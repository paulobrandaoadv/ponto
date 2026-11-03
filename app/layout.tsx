import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Anbelo | Sistema de Ponto',
  description: 'Sistema de controle de ponto para colaboradores e gestores.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
