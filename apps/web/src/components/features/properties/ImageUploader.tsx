'use client';

import { useCallback, useState } from 'react';
import { AlertCircle, Loader2, Star, Upload, X } from 'lucide-react';

interface ImageItem {
  id?: string;
  url: string;
  file?: File;
  isPrimary?: boolean;
  /** Set by the server once the image is saved. Undefined for a local preview. */
  moderationStatus?: 'pending' | 'approved' | 'rejected';
  /** Host-facing reason when a photo was rejected, so the host can correct it. */
  moderationReason?: string | null;
}

type UploadStatus = 'idle' | 'uploading' | 'error';

interface UploadSlot {
  image: ImageItem;
  status: UploadStatus;
  progress: number;
  error?: string;
  retryCount?: number;
}

interface ImageUploaderProps {
  propertyId?: string;
  initialImages?: ImageItem[];
  onChange?: (images: ImageItem[]) => void;
  maxImages?: number;
  onUploadStatusChange?: (hasUploadsInProgress: boolean) => void;
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DIMENSION = 1920;
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Compresses an image file client-side using Canvas before upload.
 * Resizes to fit within MAX_DIMENSION and encodes as WebP (with JPEG fallback).
 */
async function compressImage(file: File): Promise<File> {
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);

      const supportsWebP = canvas.toDataURL('image/webp').startsWith('data:image/webp');
      const mimeType = supportsWebP ? 'image/webp' : 'image/jpeg';
      const ext = supportsWebP ? 'webp' : 'jpg';
      const baseName = file.name.replace(/\.[^.]+$/, '');

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          resolve(new File([blob], `${baseName}.${ext}`, { type: mimeType }));
        },
        mimeType,
        0.82,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}

/**
 * Uploads a file via XHR so we can track per-file progress.
 */
function uploadWithProgress(
  url: string,
  token: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('image', file);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener('load', () => {
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.send(form);
  });
}

/**
 * ImageUploader provides drag-and-drop image upload with preview, reordering,
 * primary image selection, and deletion. When propertyId is provided it syncs
 * with the backend API; otherwise it operates in local-only mode (for new listings).
 */
export default function ImageUploader({
  propertyId,
  initialImages = [],
  onChange,
  maxImages = 10,
  onUploadStatusChange,
}: ImageUploaderProps) {
  const [slots, setSlots] = useState<UploadSlot[]>(
    initialImages.map((img) => ({ image: img, status: 'idle', progress: 0 })),
  );
  const [draggingOver, setDraggingOver] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

  const images = slots.map((s) => s.image);

  const notifyParent = (updated: UploadSlot[]) => {
    setSlots(updated);
    onChange?.(updated.map((s) => s.image));
    const hasUploadsInProgress = updated.some((s) => s.status === 'uploading');
    onUploadStatusChange?.(hasUploadsInProgress);
  };

  const updateSlot = (index: number, patch: Partial<UploadSlot>) => {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const retryUpload = useCallback(
    async (index: number) => {
      const slot = slots[index];
      if (!slot.image.file || !propertyId) return;

      const token = localStorage.getItem('token') ?? '';
      const retryCount = (slot.retryCount ?? 0) + 1;

      if (retryCount > MAX_RETRY_ATTEMPTS) {
        updateSlot(index, {
          status: 'error',
          error: `Failed after ${MAX_RETRY_ATTEMPTS} attempts`,
          progress: 0,
        });
        return;
      }

      updateSlot(index, {
        status: 'uploading',
        progress: 0,
        error: undefined,
        retryCount,
      });

      try {
        const compressed = await compressImage(slot.image.file);
        const res = await uploadWithProgress(
          `${API_URL}/api/v1/properties/${propertyId}/images`,
          token,
          compressed,
          (pct) => updateSlot(index, { progress: pct }),
        );

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
        }

        const img = await res.json();
        updateSlot(index, {
          image: {
            id: img.id,
            url: img.url,
            isPrimary: img.is_primary,
            moderationStatus: img.moderation_status,
            moderationReason: img.moderation_reason ?? null,
          },
          status: 'idle',
          progress: 100,
          error: undefined,
          retryCount: 0,
        });
      } catch (err) {
        updateSlot(index, {
          status: 'error',
          error: err instanceof Error ? err.message : 'Upload failed',
          progress: 0,
          retryCount,
        });
      }
    },
    [slots, propertyId, API_URL],
  );

  const validateFile = (file: File): string | null => {
    if (!ALLOWED_TYPES.includes(file.type)) return 'Only JPEG, PNG, and WebP are allowed';
    if (file.size > MAX_FILE_BYTES) return 'File exceeds 5 MB limit';
    return null;
  };

  const addFiles = useCallback(
    async (files: File[]) => {
      const remaining = maxImages - slots.length;
      const toAdd = files.slice(0, remaining);

      if (propertyId) {
        const token = localStorage.getItem('token') ?? '';
        const placeholders: UploadSlot[] = toAdd.map((file) => ({
          image: { url: URL.createObjectURL(file), file },
          status: 'uploading' as UploadStatus,
          progress: 0,
        }));

        const startIndex = slots.length;
        setSlots((prev) => [...prev, ...placeholders]);

        for (let i = 0; i < toAdd.length; i++) {
          const file = toAdd[i];
          const slotIndex = startIndex + i;

          const validationError = validateFile(file);
          if (validationError) {
            updateSlot(slotIndex, { status: 'error', error: validationError, progress: 0 });
            continue;
          }

          try {
            const compressed = await compressImage(file);
            const res = await uploadWithProgress(
              `${API_URL}/api/v1/properties/${propertyId}/images`,
              token,
              compressed,
              (pct) => updateSlot(slotIndex, { progress: pct }),
            );

            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
            }

            const img = await res.json();
            updateSlot(slotIndex, {
              image: {
            id: img.id,
            url: img.url,
            isPrimary: img.is_primary,
            moderationStatus: img.moderation_status,
            moderationReason: img.moderation_reason ?? null,
          },
              status: 'idle',
              progress: 100,
            });
          } catch (err) {
            updateSlot(slotIndex, {
              status: 'error',
              error: err instanceof Error ? err.message : 'Upload failed',
              progress: 0,
            });
          }
        }
      } else {
        // Local mode: compress client-side and create preview URLs
        const newSlots: UploadSlot[] = await Promise.all(
          toAdd.map(async (file, i) => {
            const validationError = validateFile(file);
            if (validationError) {
              return {
                image: { url: URL.createObjectURL(file), file },
                status: 'error' as UploadStatus,
                progress: 0,
                error: validationError,
              };
            }
            const compressed = await compressImage(file);
            return {
              image: {
                url: URL.createObjectURL(compressed),
                file: compressed,
                isPrimary: slots.length + i === 0,
              },
              status: 'idle' as UploadStatus,
              progress: 0,
            };
          }),
        );

        notifyParent([...slots, ...newSlots]);
      }
    },
    [slots, propertyId, maxImages],
  );

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    addFiles(files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDraggingOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    addFiles(files);
  };

  const removeImage = async (index: number) => {
    const slot = slots[index];

    if (propertyId && slot.image.id) {
      const token = localStorage.getItem('token') ?? '';
      await fetch(`${API_URL}/api/v1/properties/${propertyId}/images/${slot.image.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    const updated = slots.filter((_, i) => i !== index);
    if (slot.image.isPrimary && updated.length > 0) {
      updated[0] = { ...updated[0], image: { ...updated[0].image, isPrimary: true } };
    }
    notifyParent(updated);
  };

  const setPrimary = async (index: number) => {
    const slot = slots[index];

    if (propertyId && slot.image.id) {
      const token = localStorage.getItem('token') ?? '';
      await fetch(`${API_URL}/api/v1/properties/${propertyId}/images/${slot.image.id}/primary`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
    }

    const updated = slots.map((s, i) => ({
      ...s,
      image: { ...s.image, isPrimary: i === index },
    }));
    notifyParent(updated);
  };

  const handleDragStart = (index: number) => setDragIndex(index);

  const handleDropOnItem = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === targetIndex) return;

    const updated = [...slots];
    const [moved] = updated.splice(dragIndex, 1);
    updated.splice(targetIndex, 0, moved);
    setDragIndex(null);
    notifyParent(updated);

    if (propertyId) {
      const token = localStorage.getItem('token') ?? '';
      const orderedIds = updated.map((s) => s.image.id).filter(Boolean) as string[];
      await fetch(`${API_URL}/api/v1/properties/${propertyId}/images/reorder`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
    }
  };

  const isAtCapacity = slots.length >= maxImages;

  return (
    <div className="space-y-4" aria-label="Image uploader">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload images by clicking or dragging files here"
        aria-disabled={isAtCapacity}
        onDragOver={(e) => {
          e.preventDefault();
          setDraggingOver(true);
        }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={handleDrop}
        onClick={() => !isAtCapacity && document.getElementById('image-file-input')?.click()}
        onKeyDown={(e) =>
          e.key === 'Enter' && !isAtCapacity && document.getElementById('image-file-input')?.click()
        }
        className={`border-2 border-dashed rounded-lg p-8 text-center transition ${
          draggingOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400'
        } ${isAtCapacity ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <Upload size={32} className="mx-auto text-gray-400 mb-2" aria-hidden="true" />
        <p className="font-semibold text-gray-700">Drag & drop or click to upload</p>
        <p className="text-sm text-gray-500 mt-1">
          JPEG, PNG, WebP up to 5 MB ({images.length}/{maxImages})
        </p>
        <input
          id="image-file-input"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileInput}
          className="hidden"
          aria-hidden="true"
        />
      </div>

      {/* Image grid */}
      {slots.length > 0 && (
        <div className="grid grid-cols-3 gap-3" role="list" aria-label="Uploaded images">
          {slots.map((slot, idx) => (
            <div
              key={slot.image.id ?? slot.image.url}
              role="listitem"
              draggable={slot.status !== 'uploading'}
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => handleDropOnItem(e, idx)}
              className={`relative group rounded-lg overflow-hidden border aspect-video bg-gray-100 ${
                slot.status === 'error'
                  ? 'border-red-400'
                  : 'border-gray-200 cursor-grab'
              }`}
              aria-label={`Image ${idx + 1}${slot.image.isPrimary ? ' (primary)' : ''}${slot.status === 'error' ? ' — upload failed' : ''}`}
            >
              <img
                src={slot.image.url}
                alt={`Property image ${idx + 1}`}
                className={`w-full h-full object-cover transition ${slot.status === 'uploading' ? 'opacity-50' : ''}`}
              />

              {/* Upload progress overlay */}
              {slot.status === 'uploading' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/30">
                  <Loader2 size={24} className="text-white animate-spin mb-1" aria-hidden="true" />
                  <span className="text-white text-xs font-medium">{slot.progress}%</span>
                  <div className="w-3/4 mt-2 bg-white/30 rounded-full h-1.5">
                    <div
                      className="bg-white h-1.5 rounded-full transition-all"
                      style={{ width: `${slot.progress}%` }}
                      role="progressbar"
                      aria-valuenow={slot.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    />
                  </div>
                </div>
              )}

              {/* Error overlay */}
              {slot.status === 'error' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-900/60 p-2">
                  <AlertCircle size={20} className="text-white mb-1" aria-hidden="true" />
                  <p className="text-white text-xs text-center leading-tight">{slot.error}</p>
                  <div className="mt-2 flex gap-1">
                    {propertyId && (slot.retryCount ?? 0) < MAX_RETRY_ATTEMPTS && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          retryUpload(idx);
                        }}
                        className="text-xs text-white bg-blue-500 hover:bg-blue-600 px-2 py-1 rounded transition"
                        aria-label="Retry uploading image"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeImage(idx);
                      }}
                      className="text-xs text-white underline hover:no-underline"
                      aria-label="Dismiss error and remove image"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}

              {/* Primary badge */}
              {slot.image.isPrimary && slot.status === 'idle' && (
                <span className="absolute top-1 left-1 bg-yellow-400 text-yellow-900 text-xs font-semibold px-1.5 py-0.5 rounded">
                  Primary
                </span>
              )}

              {/* Saved state: a local preview is not on the listing yet. */}
              {slot.status === 'idle' && (
                <span className="absolute bottom-1 left-1 bg-white/90 text-gray-800 text-xs font-medium px-1.5 py-0.5 rounded">
                  {!slot.image.id
                    ? 'Not saved yet'
                    : slot.image.moderationStatus === 'pending'
                      ? 'Awaiting review'
                      : slot.image.moderationStatus === 'rejected'
                        ? 'Rejected'
                        : 'Saved'}
                </span>
              )}
              {slot.status === 'idle' && slot.image.moderationStatus === 'rejected' && (
                <p role="note" className="absolute inset-x-0 bottom-0 bg-red-700/90 text-white text-xs p-1 leading-tight">
                  {slot.image.moderationReason ?? 'This photo was not approved. Remove it and upload a replacement.'}
                </p>
              )}

              {/* Actions overlay (idle only) */}
              {slot.status === 'idle' && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
                  {!slot.image.isPrimary && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPrimary(idx);
                      }}
                      className="p-1.5 bg-yellow-400 rounded-full hover:bg-yellow-500 transition"
                      aria-label="Set as primary image"
                      title="Set as primary"
                    >
                      <Star size={14} className="text-yellow-900" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(idx);
                    }}
                    className="p-1.5 bg-red-500 rounded-full hover:bg-red-600 transition"
                    aria-label={`Remove image ${idx + 1}`}
                    title="Remove"
                  >
                    <X size={14} className="text-white" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
