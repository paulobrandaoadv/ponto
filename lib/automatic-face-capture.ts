import { FaceRecognitionError } from './face-recognition';

export function startAutomaticFaceCapture(
  capture: () => Promise<number[]>,
  verify: (descriptor: number[]) => Promise<void>,
  showGuidance: (message: string) => void,
  fail: (error: unknown) => void,
  intervalMs = 1500,
) {
  let active = true;
  let timer: ReturnType<typeof setTimeout>;

  const run = async () => {
    let descriptor: number[];
    try {
      descriptor = await capture();
    } catch (error) {
      if (!active) return;
      if (error instanceof FaceRecognitionError && error.kind !== 'model') {
        showGuidance(error.message);
        timer = setTimeout(run, intervalMs);
      } else {
        fail(error);
      }
      return;
    }
    if (!active) return;
    try {
      await verify(descriptor);
    } catch (error) {
      if (active) fail(error);
      return;
    }
    if (active) timer = setTimeout(run, intervalMs);
  };

  timer = setTimeout(run, intervalMs);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
