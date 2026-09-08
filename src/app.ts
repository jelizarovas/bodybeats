import { AudioEngine } from "./audio.ts";
import { Camera } from "./camera.ts";
import { Stage } from "./stage.ts";
import { LoopStation } from "./loops.ts";
import { Recognizer } from "./recognition.ts";
import {
  cameraToPlay,
  playToCamera,
  laneAt,
  PLAY_LEFT,
  PLAY_RIGHT,
} from "./play-area.ts";
import {
  Calibration,
  parseProject,
  parseTrace,
  readProject,
  readSettings,
  saveProject,
  saveSettings,
} from "./storage.ts";
import { PerformanceCapture } from "./capture.ts";
import {
  COLORS,
  DEFAULT_SETTINGS,
  LOOP_BEATS,
  NOTE_NAMES,
  PAD_NAMES,
  clamp,
} from "./types.ts";
import type { Action, Instrument, Recognition, Trace } from "./types.ts";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element ${id}`);
  return element as T;
}
const button = (id: string) => $<HTMLButtonElement>(id);
const audio = new AudioEngine(),
  loops = new LoopStation(),
  capture = new PerformanceCapture();
const canvas = $<HTMLCanvasElement>("stage-canvas"),
  video = $<HTMLVideoElement>("camera-video"),
  stage = new Stage(canvas, video);
let settings = readSettings(),
  camera: Camera | null = null,
  session: "idle" | "starting" | "keys" | "camera" = "idle",
  generation = 0;
let hitCount = 0,
  backendWasLoading = false,
  lastHandsAt = -Infinity,
  lastFrameAt = 0,
  captureToResultMs = 0,
  lastUI = 0,
  frameTimes: number[] = [],
  stale = false;
let state: Recognition = {
  timestamp: 0,
  hands: [],
  actions: [],
  samples: [],
  inferenceMs: 0,
};
let toastTimer: ReturnType<typeof setTimeout> | null = null,
  metronome = false,
  lastClickBeat = -Infinity;
let calibration: Calibration | null = null,
  trace: Trace | null = null,
  traceStart: number | null = null;
let replaying = false,
  replayGeneration = 0,
  replayTimer: ReturnType<typeof setTimeout> | null = null;
const liveNotes = new Map<string, number>();
const keys = ["a", "s", "d", "f", "g", "h", "j"];
const names: Record<string, string> = {
  Open_Palm: "Open palm",
  Closed_Fist: "Fist",
  Thumb_Up: "Thumbs up",
  Thumb_Down: "Thumbs down",
  Victory: "Victory",
  Pointing_Up: "Pointing",
  ILoveYou: "I love you",
  None: "Hand visible",
};

function toast(text: string) {
  $("toast").textContent = text;
  $("toast").classList.add("visible");
  clearTimeout(toastTimer!);
  toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 5000);
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function save() {
  const ok = saveProject(loops.snapshot());
  $("save-state").textContent = ok
    ? "Saved on this device."
    : "Browser storage is unavailable. Use Save project.";
}
function releaseLive() {
  for (const id of liveNotes.keys()) loops.noteOff(id, audio.now);
  liveNotes.clear();
  audio.releaseLive();
  stage.clear();
}
function silence() {
  releaseLive();
  audio.panic();
}
function setSessionUI() {
  const active = session === "keys" || session === "camera";
  stage.active = active;
  const geometryBounds =
    session === "camera" ? settings.bounds : DEFAULT_SETTINGS.bounds;
  stage.bounds = geometryBounds;
  const stageElement = $("stage");
  for (const [name, value] of Object.entries({
    "--play-left": playToCamera({ x: PLAY_LEFT, y: 0 }, geometryBounds).x,
    "--play-right": playToCamera({ x: PLAY_RIGHT, y: 0 }, geometryBounds).x,
    "--drum-top": playToCamera({ x: 0, y: 0.64 }, geometryBounds).y,
    "--drum-bottom": playToCamera({ x: 0, y: 0.875 }, geometryBounds).y,
    "--melody-top": playToCamera({ x: 0, y: 0.43 }, geometryBounds).y,
    "--melody-bottom": playToCamera({ x: 0, y: 0.83 }, geometryBounds).y,
  }))
    stageElement.style.setProperty(name, `${value * 100}%`);
  document
    .querySelector(".instrument-panel")!
    .classList.toggle("camera-active", session === "camera");
  if (session === "camera") {
    $("stage").style.setProperty(
      "--camera-aspect",
      String((video.videoWidth || 640) / (video.videoHeight || 480)),
    );
  }
  $("stage-intro").hidden = active;
  button("start-camera").disabled = session !== "idle";
  button("start-pointer").disabled = session !== "idle";
  button("stop-session").disabled = session === "idle";
  button("play").disabled = !active;
  button("record-layer").disabled =
    !active || loops.layers.length >= 4 || replaying;
  button("capture").disabled = !active || replaying;
  button("calibrate").disabled =
    session !== "camera" || !!loops.recording || replaying;
  button("camera-view").disabled = session !== "camera";
  button("record-trace").disabled = session !== "camera" || replaying;
  $("input-tag").textContent =
    session === "camera"
      ? "CAMERA LIVE"
      : session === "keys"
        ? "KEYS / TOUCH"
        : "CAMERA / KEYS";
  $("session-state").textContent =
    session === "camera"
      ? "CAMERA SESSION"
      : session === "keys"
        ? "KEYS / TOUCH"
        : session === "starting"
          ? "GETTING READY"
          : "READY WHEN YOU ARE";
  if (session === "idle") {
    $("tracking-label").textContent = "Your stage is quiet";
    $("recognized").textContent = "Waiting for you";
    $("tracking-health").textContent = "NOT CONNECTED";
    $("fps").textContent = "—";
    $("latency").textContent = "—";
    $("tracking-dot").classList.remove("live");
  }
  if (session === "starting") {
    $("tracking-label").textContent = "Loading camera and gesture model…";
    $("tracking-advice").textContent =
      "The model downloads once the camera starts. You can cancel with End session.";
  }
  if (session === "keys") {
    $("tracking-label").textContent = "Keys and touch are live";
    $("recognized").textContent = "Ready to play";
    $("tracking-health").textContent = "DIRECT INPUT";
    $("fps").textContent = "—";
    $("latency").textContent = "—";
    $("tracking-dot").classList.add("live");
    $("tracking-advice").textContent =
      "Use the pads or your keyboard. Switch to Melody for held notes. End this session to start the camera.";
  }
}
async function start(method: "camera" | "keys") {
  if (session !== "idle") return;
  const token = ++generation;
  session = "starting";
  setSessionUI();
  try {
    await audio.start();
    if (token !== generation) return;
    if (method === "camera") {
      const next = new Camera(video, recognized, (error) => {
        if (camera !== next) return;
        endSession();
        toast(error.message);
        $("tracking-health").textContent = "CAMERA STOPPED";
      });
      camera = next;
      await next.start(settings);
      if (token !== generation) return;
    }
    session = method;
    if (method === "camera") {
      stage.showCamera = true;
      button("camera-view").setAttribute("aria-pressed", "true");
      button("camera-view").textContent = "Hide camera";
    }
    lastHandsAt = -Infinity;
    lastFrameAt = performance.now();
    frameTimes = [];
    stale = false;
    setSessionUI();
    toast(
      method === "camera"
        ? "Camera ready. Lift a hand above a pad, then strike through the line."
        : "Your instrument is ready. A S D F play the drums.",
    );
  } catch (error) {
    if (token !== generation) return;
    endSession();
    $("tracking-health").textContent = "CAMERA UNAVAILABLE";
    toast(
      error instanceof Error
        ? error.message
        : "Could not start. Try playing with keys.",
    );
  }
}
function stopReplay() {
  ++replayGeneration;
  clearTimeout(replayTimer!);
  replaying = false;
  button("replay-trace").textContent = "Replay trace";
  silence();
  camera?.configure(settings);
  setSessionUI();
}
function endSession() {
  ++generation;
  stopReplay();
  camera?.stop();
  camera = null;
  loops.stop();
  lastClickBeat = -Infinity;
  silence();
  capture.stop();
  if (calibration) cancelCalibration();
  traceStart = null;
  button("record-trace").textContent = "Record gesture trace";
  session = "idle";
  stage.active = false;
  stage.showCamera = false;
  button("camera-view").setAttribute("aria-pressed", "false");
  button("camera-view").textContent = "Show camera";
  state = { timestamp: 0, hands: [], actions: [], samples: [], inferenceMs: 0 };
  setSessionUI();
  renderTracks();
  updateTransport();
}
function setInstrument(instrument: Instrument) {
  if (loops.recording) {
    toast("Finish or cancel this layer before switching instruments.");
    return;
  }
  if (replaying) {
    toast("Stop the replay before switching instruments.");
    return;
  }
  releaseLive();
  settings.instrument = instrument;
  stage.instrument = instrument;
  camera?.configure(settings);
  button("mode-drums").setAttribute(
    "aria-selected",
    String(instrument === "drums"),
  );
  button("mode-melody").setAttribute(
    "aria-selected",
    String(instrument === "melody"),
  );
  $("stage").setAttribute(
    "aria-label",
    instrument === "drums" ? "Air drums playing area" : "Melody playing area",
  );
  $("pad-controls").hidden = instrument !== "drums";
  $("melody-control").hidden = instrument !== "melody";
  $("guide-title").textContent =
    instrument === "drums" ? "Feel the hit." : "Hold a little feeling.";
  $("guide-copy").textContent =
    instrument === "drums"
      ? "Raise your hand above a pad. Bring it down through the dotted line to play."
      : "Touch thumb to index finger to hold a note. Open your fingers to let it go.";
  const steps =
    instrument === "drums"
      ? [
          "Get your whole hand in frame",
          "Lift, then strike down",
          "Lift again for the next hit",
        ]
      : [
          "Pinch to start a note",
          "Move sideways to choose pitch",
          "Move up to brighten the tone",
        ];
  $("guide-steps").replaceChildren(
    ...steps.map((text, i) => {
      const p = document.createElement("p"),
        n = document.createElement("span");
      n.textContent = `0${i + 1}`;
      p.append(n, text);
      return p;
    }),
  );
  $("stage-instruction").textContent =
    instrument === "drums"
      ? "Lift above the line. Strike down. Lift to rearm."
      : "Pinch and move to play. Open your fingers to release.";
  $("stage-intro").querySelector("h2")!.innerHTML =
    instrument === "drums"
      ? "Go on.<br/>Make some noise."
      : "A small gesture.<br/>A new melody.";
  $("stage-intro").querySelector("p")!.textContent =
    instrument === "drums"
      ? "Four pads. Your hands. A rhythm only you can make."
      : "Pinch to hold a note. Move to make it your own.";
  $("stage-intro").querySelector("small")!.textContent =
    instrument === "drums"
      ? "No camera? Use A S D F, or tap the pads."
      : "No camera? Hold and drag, or use A S D F G H J.";
  $("recognized").textContent = "Ready to play";
}
function act(action: Action) {
  if (
    (session !== "camera" && session !== "keys") ||
    document.hidden ||
    calibration ||
    document.querySelector("dialog[open]")
  )
    return;
  // Preserve observed event timing in loops; live voices still sound immediately.
  const now = audio.now;
  const eventTime =
    session === "camera" && !replaying
      ? Math.max(0, now - clamp((performance.now() - action.at) / 1000, 0, 1))
      : now;
  if (action.type === "hit") {
    audio.hit(action.pad, action.velocity);
    loops.recordHit(action.pad, action.velocity, eventTime);
    hitCount++;
    $("recognized").textContent = PAD_NAMES[action.pad];
  } else if (action.type === "note-on") {
    audio.noteOn(action.hand, action.note, action.brightness);
    loops.noteOn(action.hand, action.note, action.brightness, eventTime);
    liveNotes.set(action.hand, action.note);
    hitCount++;
    $("recognized").textContent = `${NOTE_NAMES[action.note]} · holding`;
  } else if (action.type === "note-change") {
    if (!liveNotes.has(action.hand)) return;
    audio.noteChange(action.hand, action.note, action.brightness);
    loops.noteChange(action.hand, action.note, action.brightness, eventTime);
    liveNotes.set(action.hand, action.note);
    $("recognized").textContent = `${NOTE_NAMES[action.note]} · holding`;
  } else {
    audio.noteOff(action.hand);
    loops.noteOff(action.hand, eventTime);
    liveNotes.delete(action.hand);
    $("recognized").textContent = "Released";
  }
  stage.action(action);
  $("hit-count").textContent = String(hitCount).padStart(2, "0");
}
function recognized(next: Recognition) {
  if (session !== "camera" || replaying) return;
  lastFrameAt = performance.now();
  captureToResultMs = Math.max(0, lastFrameAt - next.timestamp);
  stale = false;
  state = next;
  if (next.hands.length) lastHandsAt = performance.now();
  stage.update(next);
  frameTimes.push(next.timestamp);
  while (frameTimes.length > 60) frameTimes.shift();
  if (traceStart !== null && trace) {
    trace.frames.push({
      timestamp: next.timestamp,
      hands: structuredClone(next.samples),
    });
    const elapsed = next.timestamp - traceStart;
    $("trace-status").textContent =
      `Recording ${(elapsed / 1000).toFixed(1)} / 15 seconds · ${trace.frames.length} frames`;
    if (elapsed >= 15000 || trace.frames.length >= 900) finishTrace();
  }
  if (calibration) {
    const sample = next.samples.find(
      (h) =>
        h.source !== "motion" &&
        (!calibration!.handId || h.id === calibration!.handId) &&
        (settings.preferredHand === "any" ||
          h.handedness === settings.preferredHand),
    );
    const result = calibration.feed(sample, next.timestamp);
    $<HTMLProgressElement>("calibration-progress").value = result.progress;
    $("calibration-status").textContent =
      result.error ?? (sample ? "Hold steady…" : "Waiting for a steady hand");
    if (result.next) {
      $("calibration-dialog").dataset.step = "second";
      $("calibration-title").textContent = "Now hold at the bottom right.";
      $("calibration-copy").textContent =
        "Move to the lower-right corner of your comfortable reach. Hold still again.";
    }
    if (result.bounds) {
      settings.bounds = result.bounds;
      stage.bounds = settings.bounds;
      saveSettings(settings);
      camera?.configure(settings);
      cancelCalibration();
      setSessionUI();
      toast("Playing area saved. The full camera stays visible.");
    }
    return;
  }
  next.actions.forEach(act);
}
function updateRecognitionUI() {
  if (session !== "camera" || replaying) return;
  const hands = state.hands;
  const optimizing = camera?.backendStatus === "loading";
  const motionOnly =
    hands.length > 0 && hands.every((h) => h.source === "motion");
  const nearEdge = state.samples.some(
    (h) =>
      h.source !== "motion" &&
      h.points.some(
        (p) => p.x < 0.04 || p.x > 0.96 || p.y < 0.04 || p.y > 0.96,
      ),
  );
  const reacquiring = !hands.length && performance.now() - lastHandsAt < 350;
  $("tracking-dot").classList.toggle("live", !!hands.length && !stale);
  $("tracking-label").textContent = optimizing
    ? "Checking tracking performance…"
    : stale
      ? "Waiting for fresh camera frames"
      : hands.length
        ? `${hands.length} hand${hands.length === 1 ? "" : "s"} · ${hands.map((h) => (h.phase === "holding" ? "pinch" : h.phase)).join(" / ")}`
        : reacquiring
          ? "Reacquiring your hand…"
          : "Raise your hand into frame";
  $("tracking-health").textContent = optimizing
    ? "CHECKING"
    : stale
      ? "WAITING"
      : hands.length
        ? motionOnly
          ? "MOTION RECOVERY"
          : "TRACKING"
        : reacquiring
          ? "REACQUIRING"
          : "LOOKING FOR HANDS";
  $("fps").textContent =
    frameTimes.length > 1
      ? Math.round(
          ((frameTimes.length - 1) * 1000) /
            (frameTimes.at(-1)! - frameTimes[0]),
        ).toString()
      : "—";
  $("latency").textContent = captureToResultMs
    ? Math.round(captureToResultMs).toString()
    : "—";
  $("tracking-advice").textContent = stale
    ? "Camera frames paused. Held notes have been released."
    : nearEdge
      ? "Move inward a little. Every pad and note is reachable inside the playing area."
      : hands.length
        ? "Keep your hands lit and fully in frame. Set your playing area if reaching feels awkward."
        : "Bring your whole hand into view, with your fingers clearly lit.";
  if (!hands.length)
    $("recognized").textContent = reacquiring
      ? "Reacquiring"
      : "No hand visible";
  else if (!state.actions.length)
    $("recognized").textContent = hands
      .map((h) =>
        h.source === "motion"
          ? "Following motion"
          : h.pinching
            ? "Pinch"
            : (names[h.pose] ?? "Hand visible"),
      )
      .join(" + ");
  $("diagnostic-values").textContent =
    `Input: ${camera?.delegate ?? "—"} worker\nBackend: ${state.backend?.status ?? "starting"}${state.backend?.reason ? ` · ${state.backend.reason}` : ""}\nCamera setting: ${Math.round(camera?.captureFps ?? 0)} FPS\nCapture delivery: ${camera?.captureStatus ?? "starting"}\nTracking ceiling: 60 FPS / 16.7 ms budget\nWorker processing: ${state.inferenceMs.toFixed(1)} ms\nModel: ${(state.timings?.modelMs ?? 0).toFixed(1)} ms\nPixel readback: ${(state.timings?.readbackMs ?? 0).toFixed(1)} ms\nMotion recovery: ${(state.timings?.motionMs ?? 0).toFixed(1)} ms\nComparison overhead: ${(state.timings?.comparisonMs ?? 0).toFixed(1)} ms\nCapture to result: ${captureToResultMs.toFixed(1)} ms\nCapture age: ${Math.round(performance.now() - state.timestamp)} ms\nAudio base latency: ${audio.latency.toFixed(1)} ms\n${hands.map((h) => `${h.id}: ${h.phase}\n  source: ${h.source ?? "landmarks"}\n  pose: ${h.pose} (${Math.round(h.score * 100)}%)\n  pinch ratio: ${h.pinchRatio.toFixed(2)}\n  position: ${h.x.toFixed(2)}, ${h.y.toFixed(2)}`).join("\n")}`;
}
function renderTracks() {
  const container = $("tracks");
  container.replaceChildren();
  const total = Math.max(
    3,
    loops.layers.length + Number(loops.layers.length < 4),
  );
  for (let i = 0; i < total; i++) {
    const layer = loops.layers[i],
      row = document.createElement("div");
    row.className = `track${layer ? "" : " empty"}${layer?.muted ? " muted" : ""}`;
    const label = document.createElement("div");
    label.className = "track-label";
    const number = document.createElement("span");
    number.className = "track-number";
    number.textContent = `0${i + 1}`;
    const name = document.createElement("b");
    name.textContent = layer ? layer.name : "Empty layer";
    label.append(number, name);
    if (layer) {
      const mute = document.createElement("button");
      mute.textContent = layer.muted ? "M" : "●";
      mute.setAttribute(
        "aria-label",
        `${layer.muted ? "Unmute" : "Mute"} ${layer.name}`,
      );
      mute.setAttribute("aria-pressed", String(layer.muted));
      mute.addEventListener("click", () => {
        layer.muted = !layer.muted;
        audio.muteLayer(layer.id, layer.muted);
        save();
        renderTracks();
      });
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${layer.name}`);
      remove.addEventListener("click", () => {
        if (loops.recording) {
          toast("Finish recording before removing a layer.");
          return;
        }
        loops.layers = loops.layers.filter((l) => l.id !== layer.id);
        audio.muteLayer(layer.id, true);
        if (!loops.layers.length) loops.stop();
        save();
        renderTracks();
      });
      label.append(mute, remove);
    }
    const lane = document.createElement("div");
    lane.className = "track-lane";
    lane.setAttribute(
      "aria-label",
      layer
        ? `${layer.notes.length} notes in ${layer.name}`
        : "Empty loop slot",
    );
    if (layer) {
      for (const note of layer.notes) {
        const mark = document.createElement("span");
        mark.className = "note-block";
        mark.style.left = `${(note.beat / LOOP_BEATS) * 100}%`;
        mark.style.width = `${Math.max(0.4, ((note.instrument === "drums" ? 0.08 : note.duration) / LOOP_BEATS) * 100)}%`;
        mark.style.background =
          note.instrument === "drums" ? COLORS[note.pitch] : COLORS[2];
        if (note.instrument === "melody") {
          mark.style.top = `${22 - note.pitch * 2}px`;
          mark.style.height = "7px";
        }
        mark.title =
          note.instrument === "drums"
            ? PAD_NAMES[note.pitch]
            : NOTE_NAMES[note.pitch];
        lane.append(mark);
      }
      const head = document.createElement("i");
      head.className = "playhead";
      lane.append(head);
    }
    row.append(label, lane);
    container.append(row);
  }
  button("export-wav").disabled = !loops.layers.length;
  button("save-session").disabled = !loops.layers.length;
  button("undo").disabled = !loops.layers.length || !!loops.recording;
  setSessionUI();
}
function updateTransport() {
  const now = audio.now,
    recording = loops.recording,
    beat = loops.beat(now);
  button("play").textContent = loops.playing ? "Ⅱ" : "▶";
  button("play").setAttribute(
    "aria-label",
    loops.playing ? "Pause loops" : "Play loops",
  );
  button("record-layer").classList.toggle("recording", !!recording);
  button("record-layer").innerHTML = recording
    ? "<i></i> Cancel layer"
    : "<i></i> Record a layer";
  button("record-layer").disabled =
    (session !== "camera" && session !== "keys") ||
    (!recording && loops.layers.length >= 4) ||
    replaying;
  $<HTMLInputElement>("tempo").disabled = loops.playing;
  button("tempo-down").disabled = loops.playing;
  button("tempo-up").disabled = loops.playing;
  if (recording) {
    const until = recording.startBeat - beat;
    $("transport-label").textContent =
      until > 0
        ? `Get ready · ${Math.ceil(until)}`
        : `Recording · ${Math.min(8, Math.floor(beat - recording.startBeat) + 1)} / 8`;
    $("transport-subtitle").textContent =
      until > 0
        ? "A count-in, then eight beats to play."
        : "Your notes become the next layer.";
    $("loop-message").textContent =
      until > 0 ? "Listen for the count-in" : "Recording your performance";
  } else {
    $("transport-label").textContent = loops.playing
      ? "Your loop is playing."
      : loops.layers.length
        ? "Your loop is ready."
        : "Nothing on repeat. Yet.";
    $("transport-subtitle").textContent = loops.layers.length
      ? `${loops.layers.length} layer${loops.layers.length === 1 ? "" : "s"} · ${loops.bpm} BPM`
      : "Play a few notes, then make a loop.";
    $("loop-message").textContent = loops.layers.length
      ? "Eight beats. All yours."
      : "Your first layer starts here";
  }
  for (const head of document.querySelectorAll<HTMLElement>(".playhead")) {
    head.style.left = `${(loops.phase(now) / LOOP_BEATS) * 100}%`;
    head.hidden = !loops.playing;
  }
}
function scheduler() {
  if (!loops.playing) return;
  const now = audio.now,
    wasRecording = !!loops.recording;
  const layer = loops.advance(now);
  if (wasRecording && !loops.recording) {
    save();
    renderTracks();
    toast(
      layer
        ? "Layer saved. It is now part of your loop."
        : "No notes were played. Try recording another layer.",
    );
  }
  loops.schedule(now, 0.1, (note, at, layer) =>
    audio.scheduled(note, at, loops.secondsPerBeat, layer.id),
  );
  if (metronome || loops.recording) {
    const from = Math.max(lastClickBeat + 1, Math.ceil(loops.beat(now) - 0.01)),
      end = Math.floor(loops.beat(now + 0.1));
    for (let beat = from; beat <= end; beat++) {
      const countIn =
        loops.recording &&
        beat >= loops.recording.startBeat - 4 &&
        beat < loops.recording.startBeat;
      if (metronome || countIn)
        audio.click(
          Math.max(now, loops.origin + beat * loops.secondsPerBeat),
          beat % 4 === 0,
        );
      lastClickBeat = beat;
    }
  }
}
function togglePlay() {
  if (session !== "keys" && session !== "camera") return;
  if (loops.playing) {
    loops.stop();
    silence();
    renderTracks();
  } else if (loops.layers.length || metronome) {
    loops.play(audio.now);
    lastClickBeat = -Infinity;
  } else toast("Record a layer first, or turn on Click for a metronome.");
  updateTransport();
}
function cancelCalibration() {
  calibration = null;
  $<HTMLDialogElement>("calibration-dialog").close();
  releaseLive();
  camera?.configure(settings);
}
function finishTrace() {
  traceStart = null;
  button("record-trace").textContent = "Record gesture trace";
  button("replay-trace").disabled = !trace?.frames.length;
  button("export-trace").disabled = !trace?.frames.length;
  $("trace-status").textContent =
    `${trace?.frames.length ?? 0} frames ready to replay. No camera images were recorded.`;
}
async function replay() {
  if (replaying) {
    stopReplay();
    return;
  }
  if (!trace?.frames.length) return;
  if (loops.recording) {
    toast("Finish the layer before replaying gestures.");
    return;
  }
  if (session === "idle") await start("keys");
  if (session === "starting" || session === "idle") return;
  const replayTrace = trace;
  setInstrument(replayTrace.settings.instrument);
  silence();
  loops.stop();
  replaying = true;
  const token = ++replayGeneration;
  const recognizer = new Recognizer();
  recognizer.configure(replayTrace.settings);
  button("replay-trace").textContent = "Stop replay";
  setSessionUI();
  const started = performance.now(),
    first = replayTrace.frames[0].timestamp;
  let index = 0,
    total = 0;
  function step() {
    if (token !== replayGeneration) return;
    const elapsed = performance.now() - started;
    while (
      index < replayTrace.frames.length &&
      replayTrace.frames[index].timestamp - first <= elapsed
    ) {
      const frame = replayTrace.frames[index++],
        result = recognizer.update(frame.hands, frame.timestamp);
      stage.update(result);
      result.actions.forEach(act);
      total += result.actions.filter(
        (a) => a.type === "hit" || a.type === "note-on",
      ).length;
    }
    $("trace-status").textContent =
      `Replaying ${index} / ${replayTrace.frames.length} frames · ${total} musical actions`;
    $("tracking-label").textContent = "Replaying gesture trace";
    if (index < replayTrace.frames.length) replayTimer = setTimeout(step, 10);
    else {
      stopReplay();
      $("trace-status").textContent =
        `Replay complete · ${replayTrace.frames.length} frames · ${total} musical actions`;
    }
  }
  step();
}

button("start-camera").onclick = () => void start("camera");
button("start-pointer").onclick = () => void start("keys");
button("stop-session").onclick = endSession;
button("mode-drums").onclick = () => setInstrument("drums");
button("mode-melody").onclick = () => setInstrument("melody");
for (const tab of [button("mode-drums"), button("mode-melody")])
  tab.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = settings.instrument === "drums" ? "melody" : "drums";
      setInstrument(next);
      button(`mode-${next}`).focus();
    }
  });
button("play").onclick = togglePlay;
button("record-layer").onclick = () => {
  if (loops.recording) {
    loops.cancelRecord();
    silence();
    toast("Layer cancelled.");
  } else {
    try {
      loops.beginRecord(settings.instrument, audio.now);
      lastClickBeat = -Infinity;
      toast("Listen for the count-in, then play for eight beats.");
    } catch (error) {
      toast((error as Error).message);
    }
  }
  setSessionUI();
  updateTransport();
};
button("metronome").onclick = () => {
  metronome = !metronome;
  button("metronome").setAttribute("aria-pressed", String(metronome));
  if (
    metronome &&
    !loops.playing &&
    (session === "keys" || session === "camera")
  ) {
    loops.play(audio.now);
    lastClickBeat = -Infinity;
  }
  if (!metronome && !loops.layers.length && !loops.recording) {
    loops.stop();
    silence();
  }
  updateTransport();
};
function tempo(value: number) {
  try {
    loops.setTempo(value);
    $<HTMLInputElement>("tempo").value = String(loops.bpm);
    save();
  } catch (error) {
    $<HTMLInputElement>("tempo").value = String(loops.bpm);
    toast((error as Error).message);
  }
}
button("tempo-down").onclick = () => tempo(loops.bpm - 2);
button("tempo-up").onclick = () => tempo(loops.bpm + 2);
$<HTMLInputElement>("tempo").onchange = (e) =>
  tempo(Number((e.target as HTMLInputElement).value));
$<HTMLInputElement>("volume").oninput = (e) =>
  audio.setVolume(Number((e.target as HTMLInputElement).value) / 100);
button("undo").onclick = () => {
  if (loops.recording) return;
  const removed = loops.layers.pop();
  if (removed) audio.muteLayer(removed.id, true);
  if (!loops.layers.length) loops.stop();
  save();
  renderTracks();
};
button("camera-view").onclick = () => {
  stage.showCamera = !stage.showCamera;
  button("camera-view").setAttribute("aria-pressed", String(stage.showCamera));
  button("camera-view").textContent = stage.showCamera
    ? "Hide camera"
    : "Show camera";
};
button("fullscreen").onclick = () => {
  const promise = document.fullscreenElement
    ? document.exitFullscreen()
    : $("stage").requestFullscreen();
  promise.catch(() => toast("Full screen is unavailable here."));
};
button("help").onclick = () => {
  $<HTMLDialogElement>("help-dialog").showModal();
  releaseLive();
};
$<HTMLDialogElement>("help-dialog").addEventListener("close", () => {
  releaseLive();
  camera?.configure(settings);
});
document
  .querySelectorAll(".dialog-close")
  .forEach((b) =>
    b.addEventListener("click", () =>
      $<HTMLDialogElement>("help-dialog").close(),
    ),
  );
button("calibrate").onclick = () => {
  if (session !== "camera") return;
  loops.stop();
  silence();
  calibration = new Calibration();
  $("calibration-dialog").dataset.step = "first";
  $("calibration-title").textContent = "Hold at the top left.";
  $("calibration-copy").textContent =
    "Place one open hand at the upper-left corner of your comfortable reach. Hold it steady.";
  $<HTMLProgressElement>("calibration-progress").value = 0;
  $("calibration-status").textContent = "Waiting for a steady hand";
  $("stage").append($("calibration-dialog"));
  $<HTMLDialogElement>("calibration-dialog").show();
};
button("cancel-calibration").onclick = cancelCalibration;
$<HTMLDialogElement>("calibration-dialog").addEventListener("cancel", () => {
  calibration = null;
  camera?.configure(settings);
});
button("reset-calibration").onclick = () => {
  settings.bounds = structuredClone(DEFAULT_SETTINGS.bounds);
  stage.bounds = settings.bounds;
  saveSettings(settings);
  camera?.configure(settings);
  cancelCalibration();
  setSessionUI();
  toast("Full camera frame restored.");
};
$<HTMLSelectElement>("preferred-hand").value = settings.preferredHand;
$<HTMLSelectElement>("preferred-hand").onchange = (e) => {
  releaseLive();
  settings.preferredHand = (e.target as HTMLSelectElement)
    .value as typeof settings.preferredHand;
  saveSettings(settings);
  camera?.configure(settings);
};
button("diagnostics-toggle").onclick = () => {
  $("diagnostics").hidden = !$("diagnostics").hidden;
  button("diagnostics-toggle").setAttribute(
    "aria-expanded",
    String(!$("diagnostics").hidden),
  );
};
button("record-trace").onclick = () => {
  if (traceStart !== null) {
    finishTrace();
    return;
  }
  trace = { version: 1, settings: structuredClone(settings), frames: [] };
  traceStart = performance.now();
  button("record-trace").textContent = "Stop trace";
  button("replay-trace").disabled = true;
  button("export-trace").disabled = true;
  toast("Recording hand landmarks locally for up to 15 seconds.");
};
button("replay-trace").onclick = () => void replay();
button("export-trace").onclick = () => {
  if (trace)
    download(
      new Blob([JSON.stringify(trace)], { type: "application/json" }),
      "bodybeats-gesture-trace.json",
    );
};
button("save-session").onclick = () =>
  download(
    new Blob([JSON.stringify(loops.snapshot(), null, 2)], {
      type: "application/json",
    }),
    "bodybeats-project.json",
  );
for (const kind of ["trace", "session"])
  $<HTMLInputElement>(`import-${kind}`).onchange = async (e) => {
    const input = e.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2000000)
        throw new Error("Choose a file smaller than 2 MB.");
      const value = JSON.parse(await file.text());
      if (kind === "trace") {
        const parsed = parseTrace(value);
        stopReplay();
        trace = parsed;
        finishTrace();
        $("diagnostics").hidden = false;
        button("diagnostics-toggle").setAttribute("aria-expanded", "true");
        toast(
          "Gesture trace loaded. Replay runs through the same recognition rules.",
        );
      } else {
        const project = parseProject(value);
        stopReplay();
        silence();
        loops.load(project);
        $<HTMLInputElement>("tempo").value = String(loops.bpm);
        save();
        renderTracks();
        toast("Project loaded. Press Play when you are ready.");
      }
    } catch (error) {
      toast((error as Error).message);
    } finally {
      input.value = "";
    }
  };
button("export-wav").onclick = async () => {
  button("export-wav").disabled = true;
  try {
    const blob = await audio.exportWav(loops.snapshot());
    download(blob, "bodybeats-loop.wav");
    toast("Audio exported. Muted layers are left out.");
  } catch (error) {
    toast((error as Error).message);
  } finally {
    button("export-wav").disabled = !loops.layers.length;
  }
};
button("capture").onclick = () => {
  if (capture.active) {
    capture.stop();
    return;
  }
  if (!audio.stream) return;
  try {
    capture.start(
      canvas,
      audio.stream,
      (blob) => {
        download(blob, "bodybeats-performance.webm");
        button("capture").textContent = "Record performance";
        toast("Performance video saved.");
      },
      (message) => {
        toast(message);
        button("capture").textContent = "Record performance";
      },
    );
    button("capture").textContent = "Stop recording";
    toast("Recording the stage and its audio. Stops after 60 seconds.");
  } catch (error) {
    toast((error as Error).message);
  }
};

const canPlay = () =>
  !replaying &&
  !calibration &&
  !document.querySelector("dialog[open]") &&
  (session === "keys" || session === "camera");
document.querySelectorAll<HTMLButtonElement>("[data-pad]").forEach((pad) => {
  pad.addEventListener("pointerdown", (e) => {
    if (!canPlay()) return;
    e.preventDefault();
    act({
      type: "hit",
      pad: Number(pad.dataset.pad) as 0 | 1 | 2 | 3,
      velocity: 0.7,
      at: performance.now(),
    });
  });
});
const melodyControl = $("melody-control");
function pointerNote(e: PointerEvent, type: "note-on" | "note-change") {
  const box = $("stage").getBoundingClientRect();
  const { x, y } = cameraToPlay(
    {
      x: clamp((e.clientX - box.left) / box.width),
      y: clamp((e.clientY - box.top) / box.height),
    },
    stage.bounds,
  );
  act({
    type,
    hand: `pointer-${e.pointerId}`,
    note: laneAt(x, 7),
    brightness: clamp(1 - y),
    at: performance.now(),
  });
}
melodyControl.addEventListener("pointerdown", (e) => {
  if (!canPlay()) return;
  e.preventDefault();
  melodyControl.setPointerCapture(e.pointerId);
  pointerNote(e, "note-on");
});
melodyControl.addEventListener("pointermove", (e) => {
  if (canPlay() && liveNotes.has(`pointer-${e.pointerId}`))
    pointerNote(e, "note-change");
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
  melodyControl.addEventListener(event, (e) => {
    const id = `pointer-${(e as PointerEvent).pointerId}`;
    if (liveNotes.has(id))
      act({ type: "note-off", hand: id, at: performance.now() });
  });
window.addEventListener("keydown", (e) => {
  if (
    !canPlay() ||
    e.repeat ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(
      (document.activeElement as HTMLElement)?.tagName,
    )
  )
    return;
  if (e.code === "Space") {
    if (document.activeElement?.tagName === "BUTTON") return;
    e.preventDefault();
    togglePlay();
    return;
  }
  const index = keys.indexOf(e.key.toLowerCase());
  if (index < 0) return;
  e.preventDefault();
  if (settings.instrument === "drums" && index < 4)
    act({
      type: "hit",
      pad: index as 0 | 1 | 2 | 3,
      velocity: 0.7,
      at: performance.now(),
    });
  else if (settings.instrument === "melody")
    act({
      type: "note-on",
      hand: `key-${index}`,
      note: index,
      brightness: 0.55,
      at: performance.now(),
    });
});
window.addEventListener("keyup", (e) => {
  const id = `key-${keys.indexOf(e.key.toLowerCase())}`;
  if (liveNotes.has(id))
    act({ type: "note-off", hand: id, at: performance.now() });
});
window.addEventListener("blur", () => {
  releaseLive();
  camera?.configure(settings);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    loops.stop();
    stopReplay();
    silence();
    if (traceStart !== null) finishTrace();
    camera?.configure(settings);
    updateTransport();
  }
});
window.addEventListener("beforeunload", () => {
  ++generation;
  camera?.stop();
  silence();
  capture.stop();
});

stage.bounds = settings.bounds;
const restored = readProject();
if (restored) loops.load(restored);
$<HTMLInputElement>("tempo").value = String(loops.bpm);
$("beat-ruler").replaceChildren(
  ...Array.from({ length: 8 }, (_, i) => {
    const span = document.createElement("span");
    span.textContent = String(i + 1);
    return span;
  }),
);
setInstrument("drums");
renderTracks();
setSessionUI();
updateTransport();
setInterval(scheduler, 25);
function render(time: number) {
  const backendLoading = camera?.backendStatus === "loading";
  if (backendLoading && !backendWasLoading) {
    releaseLive();
    camera?.configure(settings);
  }
  backendWasLoading = backendLoading;
  if (
    session === "camera" &&
    !replaying &&
    !stale &&
    time - lastFrameAt > clamp(state.inferenceMs * 2 + 150, 450, 1200)
  ) {
    releaseLive();
    state = { ...state, hands: [], actions: [] };
    camera?.configure(settings);
    stale = true;
  }
  stage.draw(time, audio.waveform());
  capture.frame();
  if (time - lastUI > 80) {
    updateRecognitionUI();
    updateTransport();
    lastUI = time;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
