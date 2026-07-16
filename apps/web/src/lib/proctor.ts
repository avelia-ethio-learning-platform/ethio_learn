'use client';

/**
 * Client-side exam proctoring engine.
 *
 * Watches the webcam with an on-device face detector (MediaPipe BlazeFace,
 * served from /public — no third-party calls) plus browser focus/clipboard
 * events. Each violation captures a webcam snapshot and is reported to the
 * backend; the caller decides warning UX. Types:
 *   no_face         – nobody / looking away from the screen for ~4s
 *   multiple_faces  – more than one person in frame
 *   tab_switch      – left the exam tab or window
 *   copy_paste      – copy / cut / paste attempt (the event itself is blocked)
 */

export type ViolationType = 'no_face' | 'multiple_faces' | 'tab_switch' | 'copy_paste';

export interface Violation {
  type: ViolationType;
  description: string;
  screenshot_base64: string | null;
}

export interface ProctorStatus {
  camera: 'off' | 'starting' | 'on' | 'denied';
  faceModel: 'loading' | 'ready' | 'unavailable';
  /** Live face count from the last detector tick (null until first tick). */
  faces: number | null;
}

interface EngineOptions {
  onViolation: (v: Violation) => void;
  onStatus?: (s: ProctorStatus) => void;
}

const TICK_MS = 1200;
/** Consecutive ticks before a face violation fires (~4s absent, ~2.4s multi-face). */
const NO_FACE_TICKS = 3;
const MULTI_FACE_TICKS = 2;
/** Per-type cooldown so one incident (e.g. blur + visibilitychange) counts once. */
const COOLDOWN_MS = 6000;

export class ProctorEngine {
  private opts: EngineOptions;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private detector: any = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFired: Partial<Record<ViolationType, number>> = {};
  private noFaceRun = 0;
  private multiFaceRun = 0;
  /** Violations only count while armed (the exam is live); status ticks run from preflight. */
  private armed = false;
  private stopped = false;
  private status: ProctorStatus = { camera: 'off', faceModel: 'loading', faces: null };

  // Bound handlers so removeEventListener works.
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.fire('tab_switch', 'Switched away from the exam tab');
  };
  private onBlur = () => this.fire('tab_switch', 'Exam window lost focus');
  private onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    this.fire('copy_paste', 'Attempted to copy exam content');
  };
  private onCut = (e: ClipboardEvent) => {
    e.preventDefault();
    this.fire('copy_paste', 'Attempted to cut exam content');
  };
  private onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    this.fire('copy_paste', 'Attempted to paste into the exam');
  };
  private onContextMenu = (e: MouseEvent) => e.preventDefault();

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  /** (Re)bind the preview <video> element — call whenever the element (re)mounts. */
  attachVideo(el: HTMLVideoElement) {
    this.video = el;
    if (this.stream) {
      el.srcObject = this.stream;
      void el.play().catch(() => undefined);
    }
  }

  /** Ask for the camera. Resolves true when a stream is attached to the video element. */
  async startCamera(): Promise<boolean> {
    this.setStatus({ camera: 'starting' });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      if (this.video) {
        this.video.srcObject = this.stream;
        await this.video.play().catch(() => undefined);
      }
      this.setStatus({ camera: 'on' });
      this.startTicking();
      return true;
    } catch {
      this.setStatus({ camera: 'denied' });
      return false;
    }
  }

  /** Load the on-device face detector (wasm + model from /public/mediapipe). */
  async loadFaceModel(): Promise<boolean> {
    try {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      this.detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/mediapipe/blaze_face_short_range.tflite' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });
      this.setStatus({ faceModel: 'ready' });
      this.startTicking();
      return true;
    } catch {
      this.setStatus({ faceModel: 'unavailable' });
      return false;
    }
  }

  /** Face-status ticks run from preflight (for the live preview); violations need arm(). */
  private startTicking() {
    if (this.timer || !this.detector || !this.stream) return;
    this.timer = setInterval(() => this.faceTick(), TICK_MS);
  }

  /** Arm violation reporting + focus/clipboard guards. Call when the exam begins. */
  arm() {
    this.stopped = false;
    this.armed = true;
    this.noFaceRun = 0;
    this.multiFaceRun = 0;
    this.lastFired = {};
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('copy', this.onCopy as EventListener);
    document.addEventListener('cut', this.onCut as EventListener);
    document.addEventListener('paste', this.onPaste as EventListener);
    document.addEventListener('contextmenu', this.onContextMenu);
    this.startTicking();
  }

  /** Stop monitoring and release the camera. */
  stop() {
    this.stopped = true;
    this.armed = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('copy', this.onCopy as EventListener);
    document.removeEventListener('cut', this.onCut as EventListener);
    document.removeEventListener('paste', this.onPaste as EventListener);
    document.removeEventListener('contextmenu', this.onContextMenu);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.detector?.close?.();
    this.detector = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  getStatus(): ProctorStatus {
    return this.status;
  }

  /** JPEG snapshot of the current webcam frame, kept small (< ~60KB) for upload. */
  capture(): string | null {
    const video = this.video;
    if (!this.stream || !video || video.videoWidth === 0) return null;
    const canvas = document.createElement('canvas');
    const w = 400;
    canvas.width = w;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * w) || 300;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let data = canvas.toDataURL('image/jpeg', 0.55);
    if (data.length > 80_000) data = canvas.toDataURL('image/jpeg', 0.35);
    return data;
  }

  private setStatus(patch: Partial<ProctorStatus>) {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus?.(this.status);
  }

  private faceTick() {
    if (this.stopped || !this.detector || !this.video || this.video.videoWidth === 0) return;
    let count = 0;
    try {
      const res = this.detector.detectForVideo(this.video, performance.now());
      count = res?.detections?.length ?? 0;
    } catch {
      return; // transient detector hiccup — skip the tick
    }
    this.setStatus({ faces: count });
    if (!this.armed) return; // preflight: live status only, no violations

    if (count === 0) {
      this.noFaceRun += 1;
      this.multiFaceRun = 0;
      if (this.noFaceRun >= NO_FACE_TICKS) {
        this.noFaceRun = 0;
        this.fire('no_face', 'No face visible — left the seat or looked away from the screen');
      }
    } else if (count > 1) {
      this.multiFaceRun += 1;
      this.noFaceRun = 0;
      if (this.multiFaceRun >= MULTI_FACE_TICKS) {
        this.multiFaceRun = 0;
        this.fire('multiple_faces', `${count} faces detected in the camera frame`);
      }
    } else {
      this.noFaceRun = 0;
      this.multiFaceRun = 0;
    }
  }

  private fire(type: ViolationType, description: string) {
    if (this.stopped || !this.armed) return;
    const now = Date.now();
    if (now - (this.lastFired[type] ?? 0) < COOLDOWN_MS) return;
    this.lastFired[type] = now;
    this.opts.onViolation({ type, description, screenshot_base64: this.capture() });
  }
}

export const VIOLATION_LABELS: Record<string, string> = {
  no_face: 'Face not visible',
  multiple_faces: 'Multiple faces',
  tab_switch: 'Left the exam tab',
  copy_paste: 'Copy / paste attempt',
  other: 'Other',
};
