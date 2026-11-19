export interface ImageCompressOptions {
  maxDim?: number;
  quality?: number;
  maxChars?: number;
}

function encodeResizedCanvas(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  maxDim: number,
  quality: number,
  maxChars: number
): string {
  let width = Math.max(1, srcWidth);
  let height = Math.max(1, srcHeight);

  if (width > maxDim || height > maxDim) {
    if (width >= height) {
      height = Math.max(1, Math.round((height * maxDim) / width));
      width = maxDim;
    } else {
      width = Math.max(1, Math.round((width * maxDim) / height));
      height = maxDim;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas unavailable');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);

  let out = canvas.toDataURL('image/jpeg', quality);
  if (out.length > maxChars) {
    out = canvas.toDataURL('image/jpeg', Math.max(0.45, quality - 0.14));
  }
  if (out.length > maxChars) {
    out = canvas.toDataURL('image/jpeg', 0.42);
  }
  return out;
}

export async function checkImageHasDetail(
  dataUrl: string
): Promise<{ ok: boolean; reason?: string }> {
  if (!dataUrl || !dataUrl.startsWith('data:image/') || dataUrl.length < 1500) {
    return {
      ok: false,
      reason: 'Photo bahut chhota ya blank hai — kripya dubara selfie len.',
    };
  }
  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 48;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve({ ok: true });
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let sum = 0;
        let sumSq = 0;
        const count = size * size;
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += lum;
          sumSq += lum * lum;
        }
        const mean = sum / count;
        const variance = Math.max(0, sumSq / count - mean * mean);
        const stdDev = Math.sqrt(variance);

        if (mean < 14) {
          resolve({
            ok: false,
            reason: 'Photo bilkul andhera (black) hai — thodi roshni me selfie len.',
          });
          return;
        }
        if (stdDev < 6) {
          resolve({
            ok: false,
            reason: 'Camera dhaka hua ya bilkul blank photo hai — saaf selfie len.',
          });
          return;
        }
        resolve({ ok: true });
      } catch {
        resolve({ ok: true });
      }
    };
    img.onerror = () => resolve({ ok: false, reason: 'Photo read nahi ho paya — dubara try karen.' });
    img.src = dataUrl;
  });
}

export function captureVideoFrameAsDataUrl(
  video: HTMLVideoElement,
  options: ImageCompressOptions = {}
): string | null {
  const maxDim = options.maxDim ?? 1024;
  const quality = options.quality ?? 0.68;
  const maxChars = options.maxChars ?? 220_000;
  const srcWidth = video.videoWidth || 1280;
  const srcHeight = video.videoHeight || 960;
  if (!srcWidth || !srcHeight) return null;
  return encodeResizedCanvas(video, srcWidth, srcHeight, maxDim, quality, maxChars);
}

export async function compressImageFile(
  file: File,
  options: ImageCompressOptions = {}
): Promise<string> {
  const maxDim = options.maxDim ?? 1024;
  const quality = options.quality ?? 0.68;
  const maxChars = options.maxChars ?? 220_000;

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        return encodeResizedCanvas(
          bitmap,
          bitmap.width,
          bitmap.height,
          maxDim,
          quality,
          maxChars
        );
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall back to ObjectURL + HTMLImageElement below
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<string>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          resolve(
            encodeResizedCanvas(
              img,
              img.naturalWidth || img.width,
              img.naturalHeight || img.height,
              maxDim,
              quality,
              maxChars
            )
          );
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to decode image file'));
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function compressImageFilesInBatches(
  files: File[],
  options: ImageCompressOptions = {},
  onProgress?: (completed: number, total: number) => void,
  concurrency = 3
): Promise<string[]> {
  const total = files.length;
  if (total === 0) return [];
  const results: Array<string | null> = new Array(total).fill(null);
  let nextIndex = 0;
  let completed = 0;

  const worker = async () => {
    while (nextIndex < total) {
      const idx = nextIndex++;
      try {
        results[idx] = await compressImageFile(files[idx], options);
      } catch {
        results[idx] = null;
      } finally {
        completed++;
        onProgress?.(completed, total);
      }
    }
  };

  const workerCount = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter((item): item is string => Boolean(item));
}
