export class PerformanceCapture {
  private recorder: MediaRecorder | null = null;
  private canvasStream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private source: HTMLCanvasElement | null = null;
  private surface: HTMLCanvasElement | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  get active() {
    return this.recorder?.state === "recording";
  }
  start(
    canvas: HTMLCanvasElement,
    audio: MediaStream,
    onComplete: (blob: Blob) => void,
    onError: (message: string) => void,
  ) {
    if (this.recorder)
      throw new Error("The previous recording is still finishing.");
    if (!canvas.captureStream || !globalThis.MediaRecorder)
      throw new Error(
        "Performance video recording is unavailable in this browser.",
      );
    try {
      this.source = canvas;
      this.surface = document.createElement("canvas");
      this.surface.width = Math.min(1280, Math.ceil(canvas.width / 2) * 2);
      this.surface.height =
        Math.ceil((this.surface.width * canvas.height) / canvas.width / 2) * 2;
      this.copyFrame();
      this.canvasStream = this.surface.captureStream(30);
      const combined = new MediaStream([
        ...this.canvasStream.getVideoTracks(),
        ...audio.getAudioTracks(),
      ]);
      const mime = [
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm",
      ].find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime)
        throw new Error(
          "This browser cannot record WebM video. Export audio instead.",
        );
      const recorder = new MediaRecorder(combined, {
        mimeType: mime,
        videoBitsPerSecond: 3500000,
      });
      this.recorder = recorder;
      const chunks: Blob[] = [];
      let failed = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onerror = () => {
        failed = true;
        onError("Performance recording failed.");
        this.stop();
      };
      recorder.onstop = () => {
        this.release();
        if (!failed) {
          const blob = new Blob(chunks, { type: recorder.mimeType });
          if (blob.size) onComplete(blob);
          else onError("The recording was empty.");
        }
      };
      recorder.start(250);
      this.frameTimer = setInterval(() => this.copyFrame(), 1000 / 30);
      this.timer = setTimeout(() => this.stop(), 60000);
      this.frame();
    } catch (error) {
      this.release();
      throw error;
    }
  }
  stop() {
    if (this.recorder?.state === "recording") this.recorder.stop();
  }
  frame() {
    if (this.active) {
      const track = this.canvasStream?.getVideoTracks()[0] as
        | CanvasCaptureMediaStreamTrack
        | undefined;
      track?.requestFrame();
    }
  }
  private copyFrame() {
    if (!this.surface || !this.source) return;
    this.surface
      .getContext("2d")!
      .drawImage(this.source, 0, 0, this.surface.width, this.surface.height);
  }
  private release() {
    clearTimeout(this.timer!);
    clearInterval(this.frameTimer!);
    this.canvasStream?.getTracks().forEach((t) => t.stop());
    this.canvasStream = null;
    this.recorder = null;
    this.source = null;
    this.surface = null;
  }
}
