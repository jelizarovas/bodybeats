import { FRAME_BUDGET_MS } from "./frame-scheduler.ts";

export type Backend = "GPU" | "CPU";
export type BackendReading = {
  ms: number;
  hands: { x: number; y: number; handedness: string }[];
};
export type BackendDecision = Backend | "pending";

/** A single bounded comparison per camera session, after initial model warmup. */
export class BackendSelection {
  private frames = 0;
  private slowFrames = 0;
  private attempted = false;

  observeGpu(ms: number, handCount: number): boolean {
    this.frames++;
    if (this.attempted || this.frames <= 8) return false;
    this.slowFrames =
      handCount > 0 && Number.isFinite(ms) && ms > FRAME_BUDGET_MS
        ? this.slowFrames + 1
        : 0;
    if (this.slowFrames < 3) return false;
    this.attempted = true;
    return true;
  }
}

function compatible(a: BackendReading["hands"], b: BackendReading["hands"]) {
  if (a.length !== b.length) return false;
  const same = (left: (typeof a)[number], right: (typeof a)[number]) =>
    Math.hypot(left.x - right.x, left.y - right.y) <= 0.12 &&
    (left.handedness === right.handedness ||
      left.handedness === "Unknown" ||
      right.handedness === "Unknown");
  if (a.length === 1) return same(a[0], b[0]);
  if (a.length === 2)
    return (
      (same(a[0], b[0]) && same(a[1], b[1])) ||
      (same(a[0], b[1]) && same(a[1], b[0]))
    );
  return false;
}

/** Both readings must come from the same fresh bitmap, with increasing timestamps. */
export class BackendTrial {
  private warmup = 2;
  private examined = 0;
  private pairs: { gpu: number; cpu: number }[] = [];
  private decision: BackendDecision = "pending";

  compare(gpu: BackendReading, cpu: BackendReading): BackendDecision {
    if (this.decision !== "pending") return this.decision;
    if (this.warmup > 0) {
      this.warmup--;
      return "pending";
    }
    this.examined++;
    if (
      !Number.isFinite(gpu.ms) ||
      !Number.isFinite(cpu.ms) ||
      gpu.ms <= 0 ||
      cpu.ms <= 0
    )
      return this.finish("GPU");
    // Empty scenes cannot establish whether a backend can track playing hands.
    if (gpu.hands.length > 0) {
      if (!compatible(gpu.hands, cpu.hands)) return this.finish("GPU");
      this.pairs.push({ gpu: gpu.ms, cpu: cpu.ms });
    }
    if (this.pairs.length >= 6) {
      const wins = this.pairs.filter(
        ({ gpu, cpu }) => cpu <= gpu * 0.8 && gpu - cpu >= 4,
      ).length;
      const ratios = this.pairs
        .map(({ gpu, cpu }) => cpu / gpu)
        .sort((a, b) => a - b);
      return this.finish(
        wins >= 5 && (ratios[2] + ratios[3]) / 2 <= 0.8 ? "CPU" : "GPU",
      );
    }
    return this.examined >= 12 ? this.finish("GPU") : "pending";
  }

  private finish(backend: Backend): BackendDecision {
    this.decision = backend;
    return backend;
  }
}
