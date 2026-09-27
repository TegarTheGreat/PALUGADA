/**
 * Recording the owner's voice in the browser, for the assistant and for
 * trying a Listening provider. Kept in memory until it is sent; nothing is
 * stored in the browser.
 */
import { useRef, useState } from 'react';

export interface Recording {
  /** The audio as base64, without a data: prefix. */
  audio: string;
  mime: string;
}

/** The formats a provider takes, in the order browsers support them: Chrome and Firefox record WebM, Safari MP4. */
const FORMATS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export function recordingSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const finished = useRef<((recording: Recording | null) => void) | null>(null);

  const start = async (): Promise<void> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = FORMATS.find((one) => MediaRecorder.isTypeSupported(one)) ?? '';
    const next = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    next.onstop = () => {
      // The microphone is let go as soon as the clip ends: a browser shows it in use until then.
      stream.getTracks().forEach((track) => track.stop());
      const type = next.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks.current, { type });
      if (blob.size === 0) {
        finished.current?.(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => finished.current?.({ audio: String(reader.result).replace(/^data:[^,]*,/, ''), mime: type.split(';')[0]! });
      reader.onerror = () => finished.current?.(null);
      reader.readAsDataURL(blob);
    };
    recorder.current = next;
    next.start();
    setRecording(true);
  };

  /** Ends the clip and hands it back, or null when nothing was heard. */
  const stop = (): Promise<Recording | null> => new Promise((resolve) => {
    const current = recorder.current;
    setRecording(false);
    if (!current || current.state === 'inactive') {
      resolve(null);
      return;
    }
    finished.current = resolve;
    current.stop();
    recorder.current = null;
  });

  return { recording, start, stop };
}

/** Plays an answer said aloud; the previous one stops. */
let playing: HTMLAudioElement | null = null;
export function play(dataUrl: string): void {
  playing?.pause();
  playing = new Audio(dataUrl);
  void playing.play().catch(() => undefined);
}
