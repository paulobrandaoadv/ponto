export class FaceRecognitionError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-face' | 'multiple-faces' | 'low-quality' | 'model',
  ) {
    super(message);
    this.name = 'FaceRecognitionError';
  }
}

type FaceDetection = {
  box: [number, number, number, number];
  landmarks: Array<[number, number]>;
  score: number;
};

const MODEL_SIZE = 640;
const EMBEDDING_SIZE = 128;
const strides = [8, 16, 32];
const sfaceLandmarks: Array<[number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

let sessionsPromise: ReturnType<typeof createSessions> | undefined;

async function createSessions() {
  const runtimeUrl = new URL('/models/ort.wasm.min.mjs', window.location.origin).href;
  const ort = await import(/* webpackIgnore: true */ runtimeUrl);
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = {
    mjs: '/models/ort-wasm-simd-threaded.mjs',
    wasm: '/models/ort-wasm-simd-threaded.wasm',
  };

  const [detector, recognizer] = await Promise.all([
    ort.InferenceSession.create('/models/face_detection_yunet_2023mar.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }),
    ort.InferenceSession.create('/models/face_recognition_sface_2021dec_int8.onnx', {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }),
  ]);
  return { detector, ort, recognizer };
}

function getSessions() {
  sessionsPromise ??= createSessions().catch((error: unknown) => {
    sessionsPromise = undefined;
    throw new FaceRecognitionError(
      error instanceof Error ? error.message : 'Não foi possível carregar os modelos faciais.',
      'model',
    );
  });
  return sessionsPromise;
}

function outputData(outputs: Record<string, { data: unknown }>, name: string) {
  const data = outputs[name]?.data;
  if (!(data instanceof Float32Array)) {
    throw new FaceRecognitionError('O modelo facial retornou dados inválidos.', 'model');
  }
  return data;
}

function buildDetectionTensor(
  ort: Awaited<ReturnType<typeof createSessions>>['ort'],
  pixels: Uint8ClampedArray,
) {
  const planeSize = MODEL_SIZE * MODEL_SIZE;
  const tensorData = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const source = pixel * 4;
    tensorData[pixel] = pixels[source + 2];
    tensorData[planeSize + pixel] = pixels[source + 1];
    tensorData[planeSize * 2 + pixel] = pixels[source];
  }
  return new ort.Tensor('float32', tensorData, [1, 3, MODEL_SIZE, MODEL_SIZE]);
}

function intersectionOverUnion(left: FaceDetection, right: FaceDetection) {
  const [leftX, leftY, leftWidth, leftHeight] = left.box;
  const [rightX, rightY, rightWidth, rightHeight] = right.box;
  const width = Math.max(0, Math.min(leftX + leftWidth, rightX + rightWidth) - Math.max(leftX, rightX));
  const height = Math.max(0, Math.min(leftY + leftHeight, rightY + rightHeight) - Math.max(leftY, rightY));
  const intersection = width * height;
  const union = leftWidth * leftHeight + rightWidth * rightHeight - intersection;
  return union > 0 ? intersection / union : 0;
}

function detectFaces(outputs: Record<string, { data: unknown }>) {
  const detections: FaceDetection[] = [];
  const threshold = 0.85;

  strides.forEach((stride) => {
    const columns = MODEL_SIZE / stride;
    const rows = MODEL_SIZE / stride;
    const classes = outputData(outputs, `cls_${stride}`);
    const objects = outputData(outputs, `obj_${stride}`);
    const boxes = outputData(outputs, `bbox_${stride}`);
    const landmarks = outputData(outputs, `kps_${stride}`);

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const score = Math.sqrt(Math.max(0, classes[index]) * Math.max(0, objects[index]));
        if (score < threshold) continue;

        const centerX = (column + boxes[index * 4]) * stride;
        const centerY = (row + boxes[index * 4 + 1]) * stride;
        const width = Math.exp(boxes[index * 4 + 2]) * stride;
        const height = Math.exp(boxes[index * 4 + 3]) * stride;
        if (
          ![centerX, centerY, width, height].every(Number.isFinite) ||
          width <= 0 ||
          height <= 0 ||
          width > MODEL_SIZE * 2 ||
          height > MODEL_SIZE * 2
        ) continue;

        const faceLandmarks = Array.from({ length: 5 }, (_, pointIndex) => [
          (landmarks[index * 10 + pointIndex * 2] + column) * stride,
          (landmarks[index * 10 + pointIndex * 2 + 1] + row) * stride,
        ] as [number, number]);
        if (
          faceLandmarks.some(
            ([x, y]) =>
              !Number.isFinite(x) ||
              !Number.isFinite(y) ||
              x < 0 ||
              y < 0 ||
              x > MODEL_SIZE ||
              y > MODEL_SIZE,
          )
        ) continue;

        detections.push({
          box: [centerX - width / 2, centerY - height / 2, width, height],
          landmarks: faceLandmarks,
          score,
        });
      }
    }

  });

  detections.sort((left, right) => right.score - left.score);
  const selected: FaceDetection[] = [];
  for (const detection of detections) {
    if (selected.every((item) => intersectionOverUnion(item, detection) <= 0.3)) {
      selected.push(detection);
    }
  }
  return selected;
}

function alignFace(source: HTMLCanvasElement, landmarks: Array<[number, number]>) {
  const sourceMean = landmarks.reduce(
    ([sumX, sumY], [x, y]) => [sumX + x / landmarks.length, sumY + y / landmarks.length],
    [0, 0],
  );
  const targetMean = sfaceLandmarks.reduce(
    ([sumX, sumY], [x, y]) => [sumX + x / sfaceLandmarks.length, sumY + y / sfaceLandmarks.length],
    [0, 0],
  );
  let numeratorA = 0;
  let numeratorB = 0;
  let denominator = 0;

  landmarks.forEach(([sourceX, sourceY], index) => {
    const x = sourceX - sourceMean[0];
    const y = sourceY - sourceMean[1];
    const targetX = sfaceLandmarks[index][0] - targetMean[0];
    const targetY = sfaceLandmarks[index][1] - targetMean[1];
    numeratorA += x * targetX + y * targetY;
    numeratorB += x * targetY - y * targetX;
    denominator += x * x + y * y;
  });

  if (denominator < 1e-8) {
    throw new FaceRecognitionError('A imagem não tem qualidade suficiente. Centralize o rosto e tente novamente.', 'low-quality');
  }

  const a = numeratorA / denominator;
  const b = numeratorB / denominator;
  const targetX = targetMean[0] - a * sourceMean[0] + b * sourceMean[1];
  const targetY = targetMean[1] - b * sourceMean[0] - a * sourceMean[1];
  const aligned = document.createElement('canvas');
  aligned.width = 112;
  aligned.height = 112;
  const context = aligned.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new FaceRecognitionError('Não foi possível preparar a imagem facial.', 'model');
  }

  context.setTransform(a, b, -b, a, targetX, targetY);
  context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, 112, 112).data;
}

export async function extractFaceDescriptor(video: HTMLVideoElement): Promise<number[]> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
    throw new FaceRecognitionError('A câmera ainda está iniciando. Aguarde um instante e tente novamente.', 'low-quality');
  }

  try {
    const frame = document.createElement('canvas');
    frame.width = MODEL_SIZE;
    frame.height = MODEL_SIZE;
    const frameContext = frame.getContext('2d', { willReadFrequently: true });
    if (!frameContext) {
      throw new FaceRecognitionError('Não foi possível ler a imagem da câmera.', 'model');
    }

    const scale = Math.min(MODEL_SIZE / video.videoWidth, MODEL_SIZE / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const x = (MODEL_SIZE - width) / 2;
    const y = (MODEL_SIZE - height) / 2;
    frameContext.fillStyle = '#000';
    frameContext.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
    frameContext.drawImage(video, x, y, width, height);

    const { detector, ort, recognizer } = await getSessions();
    const framePixels = frameContext.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    const detectionOutputs = await detector.run({
      [detector.inputNames[0]]: buildDetectionTensor(ort, framePixels),
    });
    const faces = detectFaces(detectionOutputs);
    if (faces.length === 0) {
      throw new FaceRecognitionError('Rosto não identificado. Centralize o rosto e tente novamente.', 'no-face');
    }
    if (faces.length > 1) {
      throw new FaceRecognitionError('Mais de um rosto foi identificado. Deixe apenas o funcionário diante da câmera.', 'multiple-faces');
    }
    if (faces[0].box[2] < 80 || faces[0].box[3] < 80) {
      throw new FaceRecognitionError('Aproxime o rosto da câmera e tente novamente.', 'low-quality');
    }

    const alignedPixels = alignFace(frame, faces[0].landmarks);
    const planeSize = 112 * 112;
    const recognitionInput = new Float32Array(planeSize * 3);
    for (let pixel = 0; pixel < planeSize; pixel += 1) {
      const source = pixel * 4;
      recognitionInput[pixel] = alignedPixels[source];
      recognitionInput[planeSize + pixel] = alignedPixels[source + 1];
      recognitionInput[planeSize * 2 + pixel] = alignedPixels[source + 2];
    }

    const recognitionOutput = await recognizer.run({
      [recognizer.inputNames[0]]: new ort.Tensor('float32', recognitionInput, [1, 3, 112, 112]),
    });
    const embedding = recognitionOutput.fc1?.data;
    if (!(embedding instanceof Float32Array) || embedding.length !== EMBEDDING_SIZE) {
      throw new FaceRecognitionError('O modelo facial retornou um identificador inválido.', 'model');
    }

    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm === 0) {
      throw new FaceRecognitionError('Não foi possível validar esta imagem facial.', 'model');
    }
    return Array.from(embedding, (value) => value / norm);
  } catch (error) {
    if (error instanceof FaceRecognitionError) throw error;
    throw new FaceRecognitionError(
      error instanceof Error ? error.message : 'Não foi possível processar a imagem facial.',
      'model',
    );
  }
}
