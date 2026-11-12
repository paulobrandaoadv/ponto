'use client';

import { FormEvent, useCallback, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import FaceCamera from '@/components/FaceCamera';
import { FaceRecognitionError } from '@/lib/face-recognition';
import { supabase } from '@/lib/supabase';

type LoginMode = 'face' | 'face-action' | 'manual' | 'processing' | 'punch-error';
type FacePunchType = 'entrada' | 'saida_almoco' | 'retorno_almoco' | 'saida';

type FaceAuthResult = {
  error?: string;
  matched?: boolean;
  employeeName?: string;
  tokenHash?: string;
  challengeId?: string;
};

const facePunchLabels: Record<FacePunchType, string> = {
  entrada: 'Entrada',
  saida_almoco: 'Iniciar intervalo',
  retorno_almoco: 'Retorno do intervalo',
  saida: 'Encerrar jornada',
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
  const [showPassword, setShowPassword] = useState(false);
  const [pendingFacePunch, setPendingFacePunch] = useState<{ employeeName: string; challengeId: string } | null>(null);
  const facePunchInFlight = useRef(false);

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

    setPendingFacePunch({ employeeName: result.employeeName, challengeId: result.challengeId });
    setMode('face-action');
  };

  const handleFaceAttendance = async (eventType: FacePunchType) => {
    if (!supabase || !pendingFacePunch) {
      setMode('punch-error');
      setError('A verificação facial expirou. Abra Meu ponto e registre a marcação após entrar novamente.');
      return;
    }
    if (facePunchInFlight.current) return;
    facePunchInFlight.current = true;

    setMode('processing');
    setError('');
    let locationSnapshot: { latitude: number; longitude: number; accuracy: number };
    try {
      locationSnapshot = await getLocationSnapshot();
    } catch (locationError) {
      setMode('punch-error');
      setError(locationError instanceof Error ? locationError.message : 'Não foi possível obter o GPS.');
      facePunchInFlight.current = false;
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
        p_challenge_id: pendingFacePunch.challengeId,
        p_request_id: crypto.randomUUID(),
        p_event_type: eventType,
      });
      recordId = attendanceResult.data;
      attendanceError = attendanceResult.error;
    } catch {
      setMode('punch-error');
      setError('Sua identidade foi validada e a sessão foi iniciada, mas não foi possível registrar o ponto. Abra Meu ponto para concluir manualmente.');
      facePunchInFlight.current = false;
      return;
    }
    if (attendanceError || !recordId) {
      setMode('punch-error');
      setError(
        `Sua identidade foi validada e a sessão foi iniciada, mas não foi possível registrar o ponto: ${attendanceError?.message || 'registro não retornado'}`,
      );
      facePunchInFlight.current = false;
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
        ? `${facePunchLabels[eventType]} registrada. ${pendingFacePunch.employeeName}. A sessão foi removida deste aparelho; avise o administrador se esta mensagem persistir.`
        : `${facePunchLabels[eventType]} registrada. ${pendingFacePunch.employeeName}`,
    );
    setPendingFacePunch(null);
    setMode('face');
    facePunchInFlight.current = false;
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
    <main className="login-page">
      <section key={mode} className="login-panel">
        <div className="login-heading">
          <Image className="login-logo" src="/anbelo-logo.png" alt="Logo Anbelo" width={48} height={52} priority />
          <h1>
            {mode === 'face' ? 'Bater o Ponto pela Facial' : mode === 'face-action' ? 'Escolha a marcação' : mode === 'processing' ? pendingFacePunch ? 'Registrando ponto' : 'Validando identidade' : mode === 'punch-error' ? 'Marcação não concluída' : 'Acessar sistema'}
          </h1>
          <p className="login-description">
            {mode === 'face'
              ? 'Centralize seu rosto para validar sua identidade. Você terá até três tentativas.'
              : mode === 'face-action'
                ? `Identidade validada para ${pendingFacePunch?.employeeName || 'funcionário'}. Escolha exatamente o que deseja registrar.`
              : mode === 'processing'
                ? pendingFacePunch
                  ? 'Estamos solicitando sua localização e registrando a marcação escolhida.'
                  : 'Estamos confirmando sua identidade e preparando as opções de marcação.'
                : mode === 'punch-error'
                  ? 'Sua identidade foi validada, mas a marcação precisa ser concluída no sistema.'
                  : 'Entre com seu e-mail, nome, matrícula ou código de registro e senha.'}
          </p>
        </div>

        {mode === 'face' ? (
          <div>
            {successMessage ? (
              <p
                role="status"
                aria-live="polite"
                className="login-success"
              >
                {successMessage}
              </p>
            ) : null}
            <FaceCamera
              buttonText="Validar identidade"
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

        {mode === 'face-action' ? (
          <div style={{ display: 'grid', gap: 10 }}>
            <p className="subtle">
              A virada do dia não encerra a jornada. Uma nova entrada é bloqueada enquanto houver jornada aberta; outras marcações fora da sequência serão preservadas e sinalizadas para revisão.
            </p>
            {(Object.keys(facePunchLabels) as FacePunchType[]).map((eventType) => (
              <button
                key={eventType}
                type="button"
                className={eventType === 'entrada' ? 'btn secondary' : 'btn primary'}
                disabled={loading}
                onClick={() => handleFaceAttendance(eventType)}
              >
                {facePunchLabels[eventType]}
              </button>
            ))}
            <button type="button" className="btn secondary" onClick={() => router.replace('/dashboard')}>
              Abrir Meu ponto sem marcar agora
            </button>
          </div>
        ) : null}

        {mode === 'manual' ? (
          <form onSubmit={handleManualSubmit}>
            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <label htmlFor="identity">E-mail, nome, matrícula ou código de registro</label>
                <input id="identity" name="identity" type="text" autoComplete="username" placeholder="Seu e-mail, nome ou código" required />
              </div>
              <div>
                <label htmlFor="password">Senha</label>
                <div className="password-field">
                  <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="Sua senha" required />
                  <button type="button" className="password-toggle" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
                      <circle cx="12" cy="12" r="3" />
                      {showPassword ? <path d="M3 3l18 18" /> : null}
                    </svg>
                  </button>
                </div>
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
          <div role="status" aria-live="polite" className="login-processing">Aguarde enquanto o ponto é registrado...</div>
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
