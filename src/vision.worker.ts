import {
  FilesetResolver,
  GestureRecognizer,
  type GestureRecognizerResult,
} from "@mediapipe/tasks-vision";
import { Recognizer } from "./recognition.ts";
import { MotionTracker } from "./motion-tracker.ts";
import {
  BackendSelection,
  BackendTrial,
  type Backend,
} from "./backend-selection.ts";
import type {
  HandSample,
  Point,
  Recognition,
  WorkerRequest,
  WorkerReply,
} from "./types.ts";
const scope = self as unknown as {
  postMessage(message: WorkerReply): void;
  addEventListener(
    type: "message",
    handler: (e: MessageEvent<WorkerRequest>) => void,
  ): void;
  ModuleFactory?: unknown;
};
const recognizer = new Recognizer();
let model: GestureRecognizer | null = null;
let delegate: Backend = "GPU";
let candidate: GestureRecognizer | null = null;
let trial: BackendTrial | null = null;
const backendSelection = new BackendSelection();
let comparedFrames = 0;
let processedFrames = 0;
let acceptFramesAfter = -Infinity;
let backend: NonNullable<Recognition["backend"]> = {
  delegate,
  status: "warming",
};
let previous: HandSample[] = [];
const lastSeen = new Map<HandSample["id"], number>();
const motion = new MotionTracker();
const motionCanvas = new OffscreenCanvas(192, 144);
const motionContext = motionCanvas.getContext("2d", {
  willReadFrequently: true,
})!;
const WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
let resources: Promise<{
  files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  bytes: Uint8Array;
  factory: unknown;
}> | null = null;
async function create(delegate: Backend) {
  resources ??= (async () => {
    const files = await FilesetResolver.forVisionTasks(WASM, true);
    const module = await import(/* @vite-ignore */ files.wasmLoaderPath);
    const response = await fetch(MODEL);
    if (!response.ok)
      throw new Error(`Could not load the hand model (${response.status}).`);
    return {
      files,
      bytes: new Uint8Array(await response.arrayBuffer()),
      factory: module.default,
    };
  })();
  const { files, bytes, factory } = await resources;
  scope.ModuleFactory = factory;
  return GestureRecognizer.createFromOptions(files, {
    baseOptions: { modelAssetBuffer: bytes, delegate },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
    cannedGesturesClassifierOptions: { scoreThreshold: 0.55 },
  });
}
function reportBackend(
  status: "loading" | "comparing" | "selected",
  reason: string,
) {
  backend = { delegate, status, reason };
  scope.postMessage({ type: "backend", delegate, status, reason });
}
function closeModel(task: GestureRecognizer | null) {
  try {
    task?.close();
  } catch {
    /* A losing backend cannot stop the active camera. */
  }
}
function finishComparison(useCpu: boolean, reason: string) {
  if (useCpu && candidate) {
    const old = model;
    model = candidate;
    candidate = null;
    delegate = "CPU";
    closeModel(old);
  } else {
    closeModel(candidate);
    candidate = null;
  }
  trial = null;
  reportBackend("selected", reason);
}
async function startComparison() {
  recognizer.reset();
  motion.clear();
  previous = [];
  lastSeen.clear();
  reportBackend(
    "loading",
    "Checking a faster camera engine. Your camera will resume shortly.",
  );
  try {
    candidate = await create("CPU");
    trial = new BackendTrial();
    reportBackend(
      "comparing",
      "Comparing CPU and GPU on the same camera frames.",
    );
  } catch {
    finishComparison(false, "Keeping GPU; the CPU comparison could not start.");
  } finally {
    // A frame transferred just as loading began must never become a delayed hit.
    acceptFramesAfter = performance.timeOrigin + performance.now();
  }
}
function measure(
  task: GestureRecognizer,
  bitmap: ImageBitmap,
  timestamp: number,
) {
  const started = performance.now();
  const result = task.recognizeForVideo(bitmap, timestamp);
  return { result, ms: performance.now() - started };
}
function reading(measured: { result: GestureRecognizerResult; ms: number }) {
  return {
    ms: measured.ms,
    hands: measured.result.landmarks.map((points, i) => ({
      x: [0, 5, 9, 13, 17].reduce((sum, n) => sum + points[n].x, 0) / 5,
      y: [0, 5, 9, 13, 17].reduce((sum, n) => sum + points[n].y, 0) / 5,
      handedness: measured.result.handedness[i]?.[0]?.categoryName ?? "Unknown",
    })),
  };
}
const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
async function handle(data: WorkerRequest) {
  try {
    if (data.type === "init") {
      try {
        model = await create("GPU");
      } catch {
        delegate = "CPU";
        model = await create("CPU");
        backend = {
          delegate,
          status: "selected",
          reason: "CPU is available; GPU could not initialize.",
        };
      }
      scope.postMessage({ type: "ready", delegate });
    } else if (data.type === "settings") {
      recognizer.configure(data.settings);
      motion.clear();
    } else if (data.type === "frame") {
      let requestComparison = false;
      try {
        if (!model) throw new Error("Vision is not ready.");
        if (
          data.timeOrigin !== undefined &&
          data.timeOrigin + data.timestamp < acceptFramesAfter
        ) {
          scope.postMessage({
            type: "result",
            state: {
              timestamp: data.timestamp,
              samples: [],
              hands: [],
              actions: [],
              inferenceMs: 0,
              backend,
            },
          });
          return;
        }
        const started = performance.now();
        let probe: ReturnType<typeof measure> | null = null;
        const compareFirst = trial && ++comparedFrames % 2 === 0;
        const runCandidate = () => {
          if (!candidate) return null;
          try {
            return measure(candidate, data.bitmap, data.timestamp);
          } catch {
            finishComparison(
              false,
              "Keeping GPU; CPU could not process a comparison frame.",
            );
            return null;
          }
        };
        if (compareFirst) probe = runCandidate();
        const current = measure(model, data.bitmap, data.timestamp);
        if (!compareFirst && trial) probe = runCandidate();
        let result = current.result;
        let modelMs = current.ms;
        // Alternate execution order to avoid always favouring the first backend.
        if (trial && probe) {
          const decision = trial.compare(reading(current), reading(probe));
          if (decision !== "pending") {
            if (decision === "CPU") {
              result = probe.result;
              modelMs = probe.ms;
            }
            finishComparison(
              decision === "CPU",
              decision === "CPU"
                ? "CPU consistently processed matching hand frames faster."
                : "Keeping GPU; CPU did not show a consistent speed and tracking advantage.",
            );
          }
        }
        processedFrames++;
        if (backend.status === "warming" && processedFrames > 8)
          backend = { delegate, status: "watching" };
        if (delegate === "GPU" && !trial)
          requestComparison = backendSelection.observeGpu(
            current.ms,
            current.result.landmarks.length,
          );
        const aspect = data.bitmap.width / data.bitmap.height;
        const hands = result.landmarks.map((points, i): HandSample => {
          const palm = [0, 5, 9, 13, 17].map((n) => points[n]);
          const metric =
            result.worldLandmarks[i]?.length === 21
              ? result.worldLandmarks[i]
              : points.map((p) => ({ ...p, y: p.y / aspect }));
          return {
            source: "landmarks",
            id: i === 0 ? "hand-0" : "hand-1",
            handedness: result.handedness[i]?.[0]?.categoryName ?? "Unknown",
            x: 1 - palm.reduce((sum, p) => sum + p.x, 0) / 5,
            y: palm.reduce((sum, p) => sum + p.y, 0) / 5,
            scale: Math.hypot(
              points[5].x - points[17].x,
              points[5].y - points[17].y,
            ),
            pinchRatio:
              distance(metric[4], metric[8]) /
              Math.max(0.00001, distance(metric[5], metric[17])),
            pose: result.gestures[i]?.[0]?.categoryName ?? "None",
            score: result.gestures[i]?.[0]?.score ?? 0,
            points: points.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })),
          };
        });
        previous = previous.filter(
          (h) => data.timestamp - (lastSeen.get(h.id) ?? 0) <= 600,
        );
        const cost = (hand: HandSample, id: HandSample["id"]) => {
          const old = previous.find((h) => h.id === id);
          return old
            ? Math.hypot(old.x - hand.x, old.y - hand.y) +
                (old.handedness === hand.handedness ? 0 : 0.3)
            : 0.65;
        };
        if (hands.length === 2) {
          if (
            cost(hands[0], "hand-1") + cost(hands[1], "hand-0") <
            cost(hands[0], "hand-0") + cost(hands[1], "hand-1")
          ) {
            hands[0].id = "hand-1";
            hands[1].id = "hand-0";
          }
        } else if (
          hands.length === 1 &&
          cost(hands[0], "hand-1") < cost(hands[0], "hand-0")
        )
          hands[0].id = "hand-1";
        const readbackStarted = performance.now();
        const motionHeight = Math.round(motionCanvas.width / aspect);
        if (motionCanvas.height !== motionHeight)
          motionCanvas.height = motionHeight;
        motionContext.drawImage(
          data.bitmap,
          0,
          0,
          motionCanvas.width,
          motionCanvas.height,
        );
        const rgba = motionContext.getImageData(
          0,
          0,
          motionCanvas.width,
          motionCanvas.height,
        ).data;
        const pixels = new Uint8Array(motionCanvas.width * motionCanvas.height);
        for (let i = 0; i < pixels.length; i++)
          pixels[i] =
            (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >>
            8;
        const gray = {
          width: motionCanvas.width,
          height: motionCanvas.height,
          pixels,
        };
        const readbackMs = performance.now() - readbackStarted;
        const motionStarted = performance.now();
        const recovered = motion.recover(gray, data.timestamp, hands);
        motion.observe(hands, gray, data.timestamp);
        const motionMs = performance.now() - motionStarted;
        for (const hand of hands) lastSeen.set(hand.id, data.timestamp);
        previous = [
          ...hands,
          ...previous.filter((p) => !hands.some((h) => h.id === p.id)),
        ];
        const state = recognizer.update(
          [...hands, ...recovered],
          data.timestamp,
          performance.now() - started,
        );
        scope.postMessage({
          type: "result",
          state: {
            ...state,
            backend,
            timings: {
              modelMs,
              readbackMs,
              motionMs,
              comparisonMs: probe ? current.ms + probe.ms - modelMs : 0,
            },
          },
        });
      } finally {
        data.bitmap.close();
      }
      // The completed frame is delivered before loading; no delayed hit is replayed.
      // Loading reuses the already fetched model bytes and is covered by its own deadline.
      if (requestComparison) await startComparison();
    }
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
// Candidate initialization awaits WASM. Serialize messages so neither settings nor
// another frame can run against a partially constructed model during that await.
let requests = Promise.resolve();
scope.addEventListener("message", ({ data }) => {
  requests = requests.then(() => handle(data));
});
