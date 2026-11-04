'use client';

import { useEffect, useRef, useState } from 'react';
import { extractFaceDescriptor, preloadFaceModels } from '@/lib/face-recognition';

type FaceCameraProps = {
  buttonText: string;
  disabled?: boolean;
  onCameraError: (error: Error) => void;
  onCapture: (descriptor: number[]) => Promise<void>;
  onCaptureError: (error: unknown) => void;
};

export default function FaceCamera({
  buttonText,
  disabled = false,
  onCameraError,
  onCapture,
  onCaptureError,
}: FaceCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onCaptureErrorRef = useRef(onCaptureError);
  const [cameraReady, setCameraReady] = useState(false);
  const [modelsReady, setModelsReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  onCaptureErrorRef.current = onCaptureError;

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
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label="Visualização da câmera facial"
        style={{
          width: '100%',
          maxHeight: 360,
          borderRadius: 16,
          objectFit: 'cover',
          background: '#101828',
          transform: 'scaleX(-1)',
        }}
      />
      <p className="subtle" style={{ margin: 0 }}>
        {!cameraReady
          ? 'Iniciando a câmera...'
          : !modelsReady
            ? 'Preparando o leitor facial...'
            : 'Leitor pronto. Centralize um único rosto, com boa iluminação.'}
      </p>
      <button
        type="button"
        className="btn primary"
        onClick={() => void handleCapture()}
        disabled={!cameraReady || !modelsReady || capturing || disabled}
      >
        {capturing ? 'Lendo rosto...' : buttonText}
      </button>
    </div>
  );
}
