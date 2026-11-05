'use client';

import { FormEvent, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import FaceCamera from '@/components/FaceCamera';
import { FaceRecognitionError } from '@/lib/face-recognition';
import { supabase } from '@/lib/supabase';

type LoginMode = 'face' | 'manual' | 'processing' | 'punch-error';

type FaceAuthResult = {
  error?: string;
  matched?: boolean;
  employeeName?: string;
  tokenHash?: string;
  challengeId?: string;
};

const getLocationSnapshot = () =>
  new Promise<{ latitude: number; longitude: number; accuracy: number }>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Este navegador não oferece suporte à localização GPS.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
      }),
      (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? 'O rosto foi validado, mas o GPS foi recusado. Abra Meu ponto para registrar manualmente.'
          : error.code === error.POSITION_UNAVAILABLE
            ? 'O rosto foi validado, mas a localização GPS não está disponível. Abra Meu ponto para registrar manualmente.'
            : 'A captura do GPS demorou demais. Abra Meu ponto para registrar manualmente.';
        reject(new Error(message));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  });

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>('face');
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCameraError = useCallback((cameraError: Error) => {
    setMode('manual');
    setError(`${cameraError.message} Entre com seu nome ou matrícula e senha.`);
  }, []);

  const handleFaceFailure = useCallback((message: string) => {
    const nextAttempt = attempts + 1;
    setAttempts(nextAttempt);
    if (nextAttempt >= 3) {
      setMode('manual');
      setError(`${message} As três tentativas foram usadas; entre com seu nome ou matrícula e senha.`);
      return;
    }
    setError(`${message} Tentativa ${nextAttempt} de 3.`);
  }, [attempts]);

  const handleCaptureError = useCallback((captureError: unknown) => {
    if (captureError instanceof FaceRecognitionError && captureError.kind === 'model') {
      setMode('manual');
      setError('O reconhecimento facial está indisponível neste navegador. Entre com seu nome ou matrícula e senha.');
      return;
    }
    handleFaceFailure(
      captureError instanceof Error
        ? captureError.message
        : 'Não foi possível validar o rosto. Tente novamente.',
    );
  }, [handleFaceFailure]);

  const handleFaceCapture = async (descriptor: number[]) => {
    if (!supabase) {
      setMode('manual');
      setError('O Supabase ainda não está configurado. Verifique as variáveis do servidor.');
      return;
    }

    setError('');
    setSuccessMessage('');
    let response: Response;
    let result: FaceAuthResult;
    try {
      response = await fetch('/api/faces/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ descriptor }),
      });
      result = await response.json() as FaceAuthResult;
    } catch {
      setError('Não foi possível conectar ao reconhecimento facial. Tente novamente ou use o login manual.');
      return;
    }

    if (!response.ok) {
      if (response.status === 429) setMode('manual');
      setError(result.error || 'Não foi possível verificar o rosto. Use o login manual.');
      return;
    }
    if (!result.matched) {
      handleFaceFailure('Rosto não reconhecido. Confira a iluminação e tente novamente.');
      return;
    }
    if (!result.employeeName || !result.tokenHash || !result.challengeId) {
      setMode('manual');
      setError('O servidor não concluiu a validação facial. Use o login manual.');
      return;
    }

    setMode('processing');
    let sessionEstablished = false;
    try {
      const { data, error: sessionError } = await supabase.auth.verifyOtp({
        token_hash: result.tokenHash,
        type: 'magiclink',
      });
      sessionEstablished = !sessionError && Boolean(data.session);
    } catch {
      setMode('manual');
      setError('O rosto foi validado, mas não foi possível iniciar a sessão. Use o login manual.');
      return;
    }
    if (!sessionEstablished) {
      setMode('manual');
      setError('O rosto foi validado, mas não foi possível iniciar a sessão. Use o login manual.');
      return;
    }

    let locationSnapshot: { latitude: number; longitude: number; accuracy: number };
    try {
      locationSnapshot = await getLocationSnapshot();
    } catch (locationError) {
      setMode('punch-error');
      setError(locationError instanceof Error ? locationError.message : 'Não foi possível obter o GPS.');
      return;
    }

    let recordId: string | null = null;
    let attendanceError: { message: string } | null = null;
    try {
      const attendanceResult = await supabase.rpc('record_own_attendance_with_face', {
        p_location: null,
        p_notes: null,
        p_latitude: locationSnapshot.latitude,
        p_longitude: locationSnapshot.longitude,
        p_accuracy: locationSnapshot.accuracy,
        p_challenge_id: result.challengeId,
      });
      recordId = attendanceResult.data;
      attendanceError = attendanceResult.error;
    } catch {
      setMode('punch-error');
      setError('Sua identidade foi validada e a sessão foi iniciada, mas não foi possível registrar o ponto. Abra Meu ponto para concluir manualmente.');
      return;
    }
    if (attendanceError || !recordId) {
      setMode('punch-error');
      setError(
        `Sua identidade foi validada e a sessão foi iniciada, mas não foi possível registrar o ponto: ${attendanceError?.message || 'registro não retornado'}`,
      );
      return;
    }

    let signOutFailed = false;
    try {
      const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
      if (signOutError) {
        signOutFailed = true;
        console.error('Attendance recorded, but local sign-out returned an error.', signOutError);
      }
    } catch (signOutError) {
      signOutFailed = true;
      console.error('Attendance recorded, but local sign-out failed.', signOutError);
    }

    setAttempts(0);
    setError('');
    setSuccessMessage(
      signOutFailed
        ? `Ponto batido com sucesso. ${result.employeeName}. A sessão foi removida deste aparelho; avise o administrador se esta mensagem persistir.`
        : `Ponto batido com sucesso. ${result.employeeName}`,
    );
    setMode('face');
  };

  const handleManualSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    const formData = new FormData(event.currentTarget);
    const identity = String(formData.get('identity') || '').trim();
    const password = String(formData.get('password') || '');

    if (!identity || !password) {
      setError('Informe seu nome ou matrícula e senha para continuar.');
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
        body: JSON.stringify({ identity, password }),
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

  const openManualLogin = () => {
    setMode('manual');
    setError('');
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#edf4fd', padding: 20 }}>
      <section key={mode} className="login-panel" style={{ width: '100%', maxWidth: 430, background: '#fff', border: '1px solid rgba(18,58,114,0.12)', borderRadius: 20, padding: 28, boxShadow: '0 16px 36px rgba(18,58,114,0.09)' }}>
        <div style={{ marginBottom: 18 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: '#123a72', color: 'white', display: 'grid', placeItems: 'center', fontWeight: 700, marginBottom: 12 }}>A</div>
          <h1 style={{ margin: 0, marginBottom: 8 }}>
            {mode === 'face' ? 'Bater o Ponto pela Facial' : mode === 'processing' ? 'Validando marcação' : mode === 'punch-error' ? 'Marcação não concluída' : 'Acessar sistema'}
          </h1>
          <p style={{ margin: 0, color: '#5c6f85' }}>
            {mode === 'face'
              ? 'Centralize seu rosto e toque em Bater Ponto. Você terá até três tentativas.'
              : mode === 'processing'
                ? 'Rosto validado. Estamos solicitando sua localização e registrando o ponto.'
                : mode === 'punch-error'
                  ? 'Sua identidade foi validada, mas a marcação precisa ser concluída no sistema.'
                  : 'Entre com seu nome, matrícula ou código de registro e senha.'}
          </p>
        </div>

        {mode === 'face' ? (
          <div>
            {successMessage ? (
              <p
                role="status"
                aria-live="polite"
                style={{
                  margin: '0 0 14px',
                  padding: '0.85rem 1rem',
                  borderRadius: 12,
                  background: 'rgba(24, 128, 72, 0.1)',
                  color: '#17643b',
                  fontWeight: 700,
                }}
              >
                {successMessage}
              </p>
            ) : null}
            <FaceCamera
              buttonText="Bater Ponto"
              onCameraError={handleCameraError}
              onCapture={handleFaceCapture}
              onCaptureError={handleCaptureError}
            />
            <p className="subtle" style={{ marginTop: 12, textAlign: 'center' }}>
              Tentativas: {attempts} de 3
            </p>
            <button type="button" className="btn secondary" onClick={openManualLogin} style={{ width: '100%', marginTop: 4 }}>
              Entrar com nome ou matrícula e senha
            </button>
          </div>
        ) : null}

        {mode === 'manual' ? (
          <form onSubmit={handleManualSubmit}>
            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <label htmlFor="identity" style={{ display: 'block', marginBottom: 8, color: '#5c6f85', fontWeight: 600 }}>Nome, matrícula ou código de registro</label>
                <input id="identity" name="identity" type="text" autoComplete="username" placeholder="Seu nome ou código" required style={{ width: '100%', padding: '0.8rem 0.9rem', borderRadius: 12, border: '1px solid rgba(18,58,114,0.12)' }} />
              </div>
              <div>
                <label htmlFor="password" style={{ display: 'block', marginBottom: 8, color: '#5c6f85', fontWeight: 600 }}>Senha</label>
                <input id="password" name="password" type="password" autoComplete="current-password" placeholder="Sua senha" required style={{ width: '100%', padding: '0.8rem 0.9rem', borderRadius: 12, border: '1px solid rgba(18,58,114,0.12)' }} />
              </div>
              <button type="submit" disabled={loading} className="btn primary">
                {loading ? 'Entrando...' : 'Entrar'}
              </button>
              <button type="button" className="btn secondary" onClick={() => {
                setAttempts(0);
                setMode('face');
                setError('');
                setSuccessMessage('');
              }}>
                Voltar à leitura facial
              </button>
            </div>
          </form>
        ) : null}

        {mode === 'processing' ? (
          <div role="status" aria-live="polite" style={{ color: '#5c6f85' }}>Aguarde enquanto o ponto é registrado...</div>
        ) : null}

        {mode === 'punch-error' ? (
          <button type="button" className="btn primary" onClick={() => router.replace('/dashboard')}>
            Abrir Meu ponto
          </button>
        ) : null}

        {error ? (
          <div role="alert" style={{ marginTop: 14, padding: '0.75rem 0.9rem', borderRadius: 12, background: 'rgba(217, 90, 90, 0.08)', color: '#a63232', fontSize: '0.9rem' }}>
            {error}
          </div>
        ) : null}
      </section>
      <style jsx>{`
        .login-panel {
          animation: enter 220ms ease-out;
        }
        @keyframes enter {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </main>
  );
}
