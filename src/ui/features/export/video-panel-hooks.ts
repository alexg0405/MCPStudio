import { useEffect, useState, type RefObject } from 'react';
import { probeFormats, type FormatSupport } from '@app/export/video/support';
import type { VideoSize, VideoStyle } from '@core/video/formats';
import { readTheme } from '../../timeline/canvas';
import { drawPreview, videoThemeOf } from './video-preview';

/** Which video formats this browser can make at a picture size and frame rate (null until it has been checked). */
export function useFormatSupport(size: VideoSize, fps: 30 | 60): FormatSupport | null {
  const [support, setSupport] = useState<FormatSupport | null>(null);
  useEffect(() => {
    let isCurrent = true;
    void probeFormats(size, fps).then((result) => isCurrent && setSupport(result));
    return () => {
      isCurrent = false;
    };
  }, [size, fps]);
  return support;
}

/** The cover picture the user chose, decoded for the preview (the export decodes it again when it starts). */
export function useCoverPicture() {
  const [image, setImage] = useState<File | null>(null);
  const [decoded, setDecoded] = useState<{ file: File; bitmap: ImageBitmap } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  /** Only a bitmap made from the file that is chosen now counts (an older decode may still be in `decoded`). */
  const bitmap = decoded && decoded.file === image ? decoded.bitmap : null;

  useEffect(() => {
    if (!image) return;
    let isCurrent = true;
    let made: ImageBitmap | null = null;
    createImageBitmap(image)
      .then((b) => {
        if (!isCurrent) return b.close();
        made = b;
        setDecoded({ file: image, bitmap: b });
        setImageError(null);
      })
      .catch(() => {
        if (!isCurrent) return;
        setImage(null);
        setImageError('That file is not a picture AGstudio can read. Choose a JPEG, PNG, WebP or GIF image.');
      });
    return () => {
      isCurrent = false;
      made?.close();
    };
  }, [image]);

  const choose = (file: File) => {
    setImageError(null);
    setImage(file);
  };
  const clear = () => setImage(null);
  return { image, bitmap, imageError, choose, clear };
}

/** What the preview frame is drawn from. */
interface PreviewLook {
  style: VideoStyle;
  /** The preview's size in pixels. */
  width: number;
  height: number;
  title: string;
  artist: string;
  image: ImageBitmap | null;
  /** The app's theme and accent: the preview takes its colors from them, so it redraws when they change. */
  theme: string;
  accent: string;
}

/** Draws one frame over example music into the canvas, and again whenever anything about the look changes. */
export function useVideoPreview(canvasRef: RefObject<HTMLCanvasElement | null>, look: PreviewLook): void {
  const { style, width, height, title, artist, image, theme, accent } = look;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      drawPreview(canvas, { style, width, height, title, artist, theme: videoThemeOf(readTheme()), image });
    } catch (e) {
      console.warn('Video preview failed', e);
    }
    // `theme` and `accent` are not read here: they are CSS the preview takes its colors from (`readTheme`).
  }, [canvasRef, style, width, height, title, artist, image, theme, accent]);
}
