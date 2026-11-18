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
