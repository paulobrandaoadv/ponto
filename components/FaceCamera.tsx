'use client';

import { useEffect, useRef, useState } from 'react';
import { extractFaceDescriptor, preloadFaceModels } from '@/lib/face-recognition';
import { startAutomaticFaceCapture } from '@/lib/automatic-face-capture';

type FaceCameraProps = {
  buttonText: string;
  disabled?: boolean;
  automatic?: boolean;
  onCameraError: (error: Error) => void;
  onCapture: (descriptor: number[]) => Promise<void>;
  onCaptureError: (error: unknown) => void;
};

export default function FaceCamera({
  buttonText,
  disabled = false,
  automatic = false,
  onCameraError,
  onCapture,
  onCaptureError,
}: FaceCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCaptureErrorRef = useRef(onCaptureError);
  const onCaptureRef = useRef(onCapture);
  const [cameraReady, setCameraReady] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [guidance, setGuidance] = useState('');
  onCaptureErrorRef.current = onCaptureError;
  onCaptureRef.current = onCapture;

  useEffect(() => {
    let active = true;
    let stream: MediaStream | null = null;

    void preloadFaceModels()
      .then(() => {
        if (active) setModelsReady(true);
      })
      .catch((error: unknown) => {
        if (active) onCaptureErrorRef.current(error);
      });

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('Este navegador não permite acessar a câmera.');
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        });
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        if (!videoRef.current) {
          throw new Error('Não foi possível iniciar a visualização da câmera.');
        }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        if (active) setCameraReady(true);
      } catch (error) {
        if (active) {
          onCameraError(error instanceof Error ? error : new Error('Não foi possível acessar a câmera.'));
        }
      }
    };

    void startCamera();
    return () => {
      active = false;
      stream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [onCameraError]);

  useEffect(() => {
    if (!automatic || !cameraReady || !modelsReady || disabled) return;
    return startAutomaticFaceCapture(
      async () => {
        if (!videoRef.current) throw new Error('A câmera não está disponível.');
        setScanning(true);
        try {
          return await extractFaceDescriptor(videoRef.current);
        } finally {
          setScanning(false);
        }
      },
      async (descriptor) => {
        setGuidance('');
        setCapturing(true);
        try {
          await onCaptureRef.current(descriptor);
        } finally {
          setCapturing(false);
        }
      },
      setGuidance,
      (error) => onCaptureErrorRef.current(error),
    );
  }, [automatic, cameraReady, modelsReady, disabled]);

  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video || !cameraReady || !modelsReady || capturing || disabled) return;

    setCapturing(true);
    try {
      const descriptor = await extractFaceDescriptor(video);
      await onCapture(descriptor);
    } catch (error) {
      onCaptureError(error);
    } finally {
      setCapturing(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div
        className="face-camera-preview"
      >
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Visualização da câmera facial"
          className="face-camera-video"
        />
        <div
          aria-hidden="true"
          className={`face-camera-oval${automatic && cameraReady && modelsReady
            ? capturing ? ' face-camera-oval-verifying' : ' face-camera-oval-searching'
            : ''}${automatic && scanning ? ' face-camera-oval-scanning' : ''}`}
        />
      </div>
      <p className="subtle" style={{ margin: 0 }} role={automatic ? 'status' : undefined}>
        {!cameraReady
          ? 'Iniciando a câmera...'
          : !modelsReady
            ? 'Preparando o leitor facial...'
            : capturing ? automatic ? 'Rosto detectado. Verificando identidade...' : 'Validando identidade...'
              : guidance || (automatic
                ? 'Buscando rosto automaticamente. Posicione-se diante da câmera com boa iluminação.'
                : 'Posicione o rosto dentro do oval e mantenha boa iluminação.')}
      </p>
      {!automatic ? <button
        type="button"
        className="btn primary"
        onClick={() => void handleCapture()}
        disabled={!cameraReady || !modelsReady || capturing || disabled}
      >
        {capturing ? 'Lendo rosto...' : buttonText}
      </button> : null}
    </div>
  );
}
