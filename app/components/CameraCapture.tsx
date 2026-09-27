'use client';

import { useRef, useState } from 'react';

const MAX_EDGE = 2200;
const JPEG_QUALITY = 0.85;

/**
 * "Take a photo" for phones: opens the rear camera, shrinks each shot to a sensible size (phone
 * photos are often 4–8 MB, over the upload limit) and hands it back as one more page. `load` and
 * `count` name the photo (photo-L2-3.jpg: load 2, third photo) so photos of one load stay together.
 */
export function CameraCapture({ onCapture, disabled = false, count, load = 1 }: { onCapture: (file: File) => void; disabled?: boolean; count: number; load?: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handle(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      onCapture(await shrinkPhoto(file, `photo-L${load}-${count + 1}.jpg`));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return <label className={`cameraButton ${disabled ? 'disabled' : ''}`}>
    <input ref={input} type="file" accept="image/*" capture="environment" disabled={disabled || busy} onChange={(e) => void handle(e.target.files?.[0])} />
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
    <span>{busy ? 'Preparing photo…' : count ? `Another photo (load ${load})` : load > 1 ? `Take a photo (load ${load})` : 'Take a photo'}</span>
  </label>;
}

async function shrinkPhoto(file: File, name: string): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('encode failed');
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    // Formats the browser can't decode (e.g. some HEIC) go up as taken; the server checks the type.
    return new File([file], name, { type: file.type, lastModified: Date.now() });
  }
}
