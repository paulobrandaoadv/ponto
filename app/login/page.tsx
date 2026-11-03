'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const redirectIfAuthenticated = async () => {
      if (!supabase) {
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (data.session) {
        router.replace('/dashboard');
      }
    };

    redirectIfAuthenticated();
  }, [router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get('name') || '').trim();
    const password = String(formData.get('password') || '');

    if (!name || !password) {
      setError('Informe seu nome e senha para continuar.');
      return;
    }

    if (!supabase) {
      setError('As variáveis do Supabase ainda não foram configuradas. Verifique .env.local.');
      return;
    }

    setLoading(true);

    let response: Response;
    let result: {
      error?: string;
      session?: { access_token: string; refresh_token: string };
    };
    try {
      response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      result = await response.json() as typeof result;
    } catch {
      setLoading(false);
      setError('Não foi possível conectar ao servidor de autenticação. Tente novamente.');
      return;
    }

    if (!response.ok || !result.session) {
      setLoading(false);
      setError(result.error || 'Não foi possível entrar no sistema.');
      return;
    }

    const { error: sessionError } = await supabase.auth.setSession(result.session);
    setLoading(false);

    if (sessionError) {
      setError('A autenticação foi aceita, mas não foi possível iniciar a sessão. Tente novamente.');
      return;
    }

    router.push('/dashboard');
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#edf4fd', padding: 20 }}>
      <div style={{ width: '100%', maxWidth: 430, background: '#fff', border: '1px solid rgba(18,58,114,0.12)', borderRadius: 20, padding: 28, boxShadow: '0 16px 36px rgba(18,58,114,0.09)' }}>
        <div style={{ marginBottom: 18 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: '#123a72', color: 'white', display: 'grid', placeItems: 'center', fontWeight: 700, marginBottom: 12 }}>A</div>
          <h1 style={{ margin: 0, marginBottom: 8 }}>Acessar sistema</h1>
          <p style={{ margin: 0, color: '#5c6f85' }}>Entre com seu nome de colaborador e senha.</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <label htmlFor="name" style={{ display: 'block', marginBottom: 8, color: '#5c6f85', fontWeight: 600 }}>Nome do colaborador</label>
              <input id="name" name="name" type="text" autoComplete="username" placeholder="Seu nome completo" required style={{ width: '100%', padding: '0.8rem 0.9rem', borderRadius: 12, border: '1px solid rgba(18,58,114,0.12)' }} />
            </div>
            <div>
              <label htmlFor="password" style={{ display: 'block', marginBottom: 8, color: '#5c6f85', fontWeight: 600 }}>Senha</label>
              <input id="password" name="password" type="password" autoComplete="current-password" placeholder="Sua senha" required style={{ width: '100%', padding: '0.8rem 0.9rem', borderRadius: 12, border: '1px solid rgba(18,58,114,0.12)' }} />
            </div>

            {error ? (
              <div style={{ padding: '0.75rem 0.9rem', borderRadius: 12, background: 'rgba(217, 90, 90, 0.08)', color: '#a63232', fontSize: '0.9rem' }}>
                {error}
              </div>
            ) : null}

            <button type="submit" disabled={loading} style={{ background: loading ? '#4d6ea8' : 'linear-gradient(135deg, #123a72, #1d5bb4)', color: 'white', border: 0, borderRadius: 12, padding: '0.9rem 1rem', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Entrando...' : 'Entrar'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
