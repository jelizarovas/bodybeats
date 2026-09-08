export const MAX_TRACKING_FPS = 60;
export const FRAME_BUDGET_MS = 1000 / MAX_TRACKING_FPS;

/** Latest decoded frame only: one inference in flight and a fixed capture ceiling. */
export class FrameScheduler {
  private latest = -Infinity;
  private consumed = -Infinity;
  private lastStarted = -Infinity;
  private inFlight = false;
  private stopped = false;
  readonly interval = FRAME_BUDGET_MS;

  get busy() {
    return this.inFlight;
  }

  offer(mediaTime: number) {
    if (!this.stopped && Number.isFinite(mediaTime) && mediaTime > this.latest)
      this.latest = mediaTime;
  }

  delay(now: number): number | null {
    if (
      this.stopped ||
      this.inFlight ||
      !Number.isFinite(now) ||
      this.latest <= this.consumed
    )
      return null;
    return Math.max(0, this.lastStarted + this.interval - now);
  }

  start(now: number): boolean {
    if (this.delay(now) !== 0) return false;
    this.inFlight = true;
    this.consumed = this.latest;
    this.lastStarted = now;
    return true;
  }

  complete() {
    this.inFlight = false;
  }

  stop() {
    this.stopped = true;
    this.inFlight = false;
  }
}
