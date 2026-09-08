import type { Recognition, Settings, WorkerReply } from "./types.ts";
import { FrameScheduler, MAX_TRACKING_FPS } from "./frame-scheduler.ts";

export class Camera {
  private worker: Worker | null = null;
  private stream: MediaStream | null = null;
  private stopped = false;
  private frames = new FrameScheduler();
  private frameCallback: number | null = null;
  private captureWake: ReturnType<typeof setTimeout> | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelStart: ((reason: Error) => void) | null = null;
  private backendLoading = false;
  private callbackTimes: number[] = [];
  delegate = "";
  backendStatus: "loading" | "comparing" | "selected" = "selected";
  constructor(
    privateVideo: HTMLVideoElement,
    onState: (state: Recognition) => void,
    onError: (error: Error) => void,
  ) {
    this.video = privateVideo;
    this.onState = onState;
    this.onError = onError;
  }
  private video: HTMLVideoElement;
  private onState: (state: Recognition) => void;
  private onError: (error: Error) => void;
  async start(settings: Settings) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Use localhost or HTTPS to access your camera.");
    this.worker = new Worker(new URL("./vision.worker.ts", import.meta.url), {
      type: "module",
    });
    const worker = this.worker;
    const ready = new Promise<void>((resolve, reject) => {
      this.cancelStart = reject;
      this.loadTimer = setTimeout(
        () =>
          this.fail(
            new Error(
              "The camera model could not load in time. Check your connection or play with keys.",
            ),
          ),
        40000,
      );
      worker.addEventListener(
        "message",
        ({ data }: MessageEvent<WorkerReply>) => {
          if (this.stopped || this.worker !== worker) return;
          if (data.type === "ready") {
            clearTimeout(this.loadTimer!);
            this.cancelStart = null;
            this.delegate = data.delegate;
            worker.postMessage({ type: "settings", settings });
            resolve();
          } else if (data.type === "result") {
            this.frames.complete();
            clearTimeout(this.frameTimer!);
            if (data.state.backend) this.delegate = data.state.backend.delegate;
            this.onState(data.state);
            void this.frame();
          } else if (data.type === "backend") {
            this.delegate = data.delegate;
            this.backendStatus = data.status;
            this.backendLoading = data.status === "loading";
            // A model comparison loads from cached bytes but initializing WASM can
            // exceed the normal frame watchdog on some devices.
            if (this.backendLoading || this.frames.busy) this.armFrameTimeout();
            else clearTimeout(this.frameTimer!);
            if (!this.backendLoading) void this.frame();
          } else this.fail(new Error(data.message));
        },
      );
      worker.addEventListener("error", (e) => {
        if (!this.stopped)
          this.fail(new Error(e.message || "The recognition worker stopped."));
      });
      worker.addEventListener("messageerror", () =>
        this.fail(new Error("Recognition returned an unreadable frame.")),
      );
      worker.postMessage({ type: "init" });
    });
    const permission = navigator.mediaDevices
      .getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: MAX_TRACKING_FPS, max: MAX_TRACKING_FPS },
          facingMode: "user",
        },
        audio: false,
      })
      .then((stream) => {
        if (this.stopped) {
          stream.getTracks().forEach((t) => t.stop());
          throw new Error("Camera start cancelled.");
        }
        this.stream = stream;
        stream.getVideoTracks()[0]?.addEventListener("ended", () => {
          if (!this.stopped)
            this.fail(
              new Error("The camera disconnected. You can continue with keys."),
            );
        });
      });
    try {
      await Promise.all([ready, permission]);
      if (this.stopped) throw new Error("Camera start cancelled.");
      this.video.srcObject = this.stream;
      await this.video.play();
      if (this.stopped) throw new Error("Camera start cancelled.");
      this.schedule();
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  configure(settings: Settings) {
    this.worker?.postMessage({ type: "settings", settings });
  }
  get captureFps() {
    return this.stream?.getVideoTracks()[0]?.getSettings().frameRate ?? 0;
  }
  get captureStatus() {
    const times = this.callbackTimes;
    const fps =
      times.length > 1
        ? ((times.length - 1) * 1000) / (times.at(-1)! - times[0])
        : 0;
    return `${fps.toFixed(1)} callbacks/sec; last ${Math.round(performance.now() - (times.at(-1) ?? performance.now()))} ms ago; page ${document.visibilityState}; video ${this.video.paused ? "paused" : "playing"}`;
  }
  private schedule() {
    if (this.stopped || this.frameCallback !== null) return;
    const onFrame = (mediaTime: number) => {
      this.callbackTimes.push(performance.now());
      while (this.callbackTimes.length > 30) this.callbackTimes.shift();
      this.frameCallback = null;
      this.frames.offer(mediaTime);
      this.schedule();
      void this.frame();
    };
    this.frameCallback = this.video.requestVideoFrameCallback
      ? this.video.requestVideoFrameCallback((_time, metadata) =>
          onFrame(metadata.mediaTime),
        )
      : requestAnimationFrame(() => onFrame(this.video.currentTime));
  }
  private async frame() {
    if (this.stopped || this.backendLoading || this.video.readyState < 2)
      return;
    const timestamp = performance.now();
    const delay = this.frames.delay(timestamp);
    if (delay === null) return;
    if (delay > 0) {
      if (this.captureWake === null)
        this.captureWake = setTimeout(() => {
          this.captureWake = null;
          void this.frame();
        }, Math.ceil(delay));
      return;
    }
    if (!this.frames.start(timestamp)) return;
    clearTimeout(this.captureWake!);
    this.captureWake = null;
    this.armFrameTimeout();
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(this.video, {
        resizeWidth: 640,
        resizeHeight: Math.round(
          (640 * this.video.videoHeight) / this.video.videoWidth,
        ),
      });
      if (this.stopped || !this.worker) {
        bitmap.close();
        return;
      }
      if (this.backendLoading) {
        bitmap.close();
        this.frames.complete();
        return;
      }
      this.worker.postMessage(
        {
          type: "frame",
          bitmap,
          timestamp,
          timeOrigin: performance.timeOrigin,
        },
        [bitmap],
      );
    } catch (error) {
      bitmap?.close();
      if (!this.stopped)
        this.fail(
          error instanceof Error
            ? error
            : new Error("Could not read the camera."),
        );
    }
  }
  private armFrameTimeout() {
    clearTimeout(this.frameTimer!);
    this.frameTimer = setTimeout(
      () =>
        this.fail(
          new Error(
            "Recognition stopped responding. Please restart the camera.",
          ),
        ),
      this.backendLoading ? 40000 : 4000,
    );
  }
  private fail(error: Error) {
    if (this.stopped) return;
    const reject = this.cancelStart;
    this.cancelStart = null;
    this.stop();
    if (reject) reject(error);
    else this.onError(error);
  }
  stop() {
    this.stopped = true;
    this.frames.stop();
    clearTimeout(this.captureWake!);
    this.captureWake = null;
    clearTimeout(this.loadTimer!);
    clearTimeout(this.frameTimer!);
    if (this.frameCallback !== null) {
      if (this.video.cancelVideoFrameCallback)
        this.video.cancelVideoFrameCallback(this.frameCallback);
      else cancelAnimationFrame(this.frameCallback);
    }
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
    this.cancelStart?.(new Error("Camera start cancelled."));
    this.cancelStart = null;
  }
}
