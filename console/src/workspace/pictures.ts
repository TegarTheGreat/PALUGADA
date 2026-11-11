/**
 * A picture made small enough to be drawn in a room (F19.4, F19.16; STATUS
 * 2.212, 2.218).
 *
 * A room draws a PNG, JPEG or WebP of 2 MB at most (`drawnInline` on the
 * server); anything larger arrives as a file to save. A phone's camera and a
 * screenshot of a large screen are usually larger, so a picture is made
 * smaller here, in the tab, before it is sent: no longer side over 2,048
 * pixels, and under 2 MB, as WebP where the browser writes it (which keeps
 * what is transparent) or else JPEG on white. A picture that is already small
 * enough is sent as it is, and so is a GIF, whose frames a canvas would lose,
 * and any picture the browser cannot read. Nothing is kept: the canvas and
 * the bytes go once the file is read for sending.
 */

/** The most a room draws, as the server holds it (STATUS 2.212). */
export const DRAWN_MOST_BYTES = 2 * 1024 * 1024;
/** The longest side a picture is sent at. */
const LONGEST_SIDE = 2_048;
/** Sizes and qualities tried in turn until a picture is small enough. */
const TRIES: ReadonlyArray<{ side: number; quality: number }> = [
  { side: LONGEST_SIDE, quality: 0.86 }, { side: LONGEST_SIDE, quality: 0.72 }, { side: 1_600, quality: 0.72 }, { side: 1_280, quality: 0.66 },
  { side: 1_024, quality: 0.6 }, { side: 800, quality: 0.55 },
];
/** The kinds of picture made smaller: what a canvas reads and a room draws, without frames. */
const MADE_SMALLER = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** The canvas's picture as bytes of one kind, or null when the browser writes another. */
function encoded(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality));
}

/** A file's name with another extension. */
function renamed(name: string, extension: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/** The picture as it is sent: the file itself when it is drawn already, or a smaller copy of it. */
export async function drawable(file: File): Promise<File> {
  if (!MADE_SMALLER.has(file.type) || typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    if (file.size <= DRAWN_MOST_BYTES && Math.max(bitmap.width, bitmap.height) <= LONGEST_SIDE) return file;
    for (const { side, quality } of TRIES) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) return file;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let blob = await encoded(canvas, 'image/webp', quality);
      if (!blob) {
        // JPEG has nothing transparent: what was is drawn on white.
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        blob = await encoded(canvas, 'image/jpeg', quality);
      }
      if (blob && blob.size <= DRAWN_MOST_BYTES) {
        return new File([blob], renamed(file.name, blob.type === 'image/webp' ? 'webp' : 'jpg'), { type: blob.type, lastModified: file.lastModified });
      }
    }
    return file;
  } finally {
    bitmap.close();
  }
}
