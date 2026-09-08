import { COLORS, DRUM_LINE, NOTE_NAMES, PAD_NAMES, clamp } from "./types.ts";
import { TrackingView } from "./tracking-view.ts";
import { laneRect, playToCamera, PLAY_LEFT, PLAY_RIGHT } from "./play-area.ts";
import type {
  HandView,
  Instrument,
  Recognition,
  Action,
  Bounds,
} from "./types.ts";
const LINKS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
export class Stage {
  instrument: Instrument = "drums";
  active = false;
  showCamera = false;
  bounds: Bounds = { left: 0, top: 0, right: 1, bottom: 1 };
  hands: HandView[] = [];
  private canvas: HTMLCanvasElement;
  private video: HTMLVideoElement;
  private ctx: CanvasRenderingContext2D;
  private hits = Array(4).fill(-Infinity) as number[];
  private held = new Map<string, number>();
  private tracking = new TrackingView();
  private width = 0;
  private height = 0;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    this.canvas = canvas;
    this.video = video;
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }
  private resize() {
    // A high-DPI camera canvas is expensive on phones and does not improve
    // recognition, which reads the video independently in the worker.
    const compact = matchMedia("(max-width: 800px), (pointer: coarse)").matches;
    const d = Math.min(devicePixelRatio, compact ? 1 : 2);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = this.width * d;
    this.canvas.height = this.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  update(state: Recognition) {
    this.hands = state.hands;
    this.tracking.update(state.hands, performance.now());
  }
  action(action: Action) {
    if (action.type === "hit") this.hits[action.pad] = performance.now();
    else if (action.type === "note-off") this.held.delete(action.hand);
    else this.held.set(action.hand, action.note);
  }
  clear() {
    this.hands = [];
    this.tracking.clear();
    this.held.clear();
    this.hits.fill(-Infinity);
  }
  draw(time: number, wave: Float32Array) {
    const ctx = this.ctx,
      w = this.width,
      h = this.height;
    if (!w || !h) return;
    const cameraVisible = this.showCamera && this.video.readyState >= 2;
    if (cameraVisible) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(this.video, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.fillStyle = "#1c2218";
      ctx.fillRect(0, 0, w, h);
      const g = ctx.createRadialGradient(
        w * 0.73,
        h * 0.35,
        0,
        w * 0.7,
        h * 0.4,
        w * 0.6,
      );
      g.addColorStop(0, this.instrument === "drums" ? "#354426" : "#332c43");
      g.addColorStop(1, "#1c2218");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.strokeStyle = "#8ea46e15";
    for (let r = 50; !cameraVisible && r < Math.max(w, h); r += 48) {
      ctx.beginPath();
      ctx.ellipse(
        w * 0.81,
        h * 0.31,
        r,
        r * 0.6,
        this.reduced ? -0.5 : -0.5 + Math.sin(time / 12000) * 0.04,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    if (this.instrument === "drums") this.drawDrums(time);
    else this.drawMelody(time);
    if (this.active) {
      ctx.strokeStyle = "#d8fc7140";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < wave.length; i++) {
        const x = w * 0.3 + (i / (wave.length - 1)) * w * 0.4,
          y = h * 0.17 + wave[i] * 40;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
      if (!cameraVisible && !this.hands.length && !this.held.size) {
        ctx.fillStyle = "#99a889";
        ctx.textAlign = "center";
        ctx.font = `${w < 500 ? 11 : 14}px Segoe UI`;
        ctx.fillText(
          this.instrument === "drums"
            ? "Lift. Strike. Make it yours."
            : "Hold a note. Find a melody.",
          w / 2,
          h * 0.3,
        );
        ctx.font = "9px monospace";
        ctx.fillStyle = "#7b8c6a";
        ctx.fillText(
          this.instrument === "drums"
            ? "DOWN THROUGH THE LINE TO PLAY"
            : "PINCH TO PLAY / OPEN TO RELEASE",
          w / 2,
          h * 0.3 + 22,
        );
        ctx.textAlign = "left";
      }
    }
    for (const frame of this.tracking.frames(time)) {
      ctx.save();
      this.drawHand(frame.hand);
      ctx.restore();
    }
    if (this.active) {
      ctx.font = "10px monospace";
      ctx.fillStyle = "#b5c59e";
      ctx.fillText("BODYBEATS", w * 0.055, h * 0.94);
    }
  }
  private drawDrums(time: number) {
    const ctx = this.ctx,
      w = this.width,
      h = this.height,
      start = playToCamera({ x: PLAY_LEFT, y: DRUM_LINE }, this.bounds),
      end = playToCamera({ x: PLAY_RIGHT, y: DRUM_LINE }, this.bounds);
    ctx.setLineDash([3, 7]);
    ctx.strokeStyle = "#a4ba6c70";
    ctx.beginPath();
    ctx.moveTo(w * start.x, h * start.y);
    ctx.lineTo(w * end.x, h * end.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (this.active) {
      ctx.font = "8px monospace";
      ctx.fillStyle = "#99ad7f";
      ctx.fillText("HIT LINE", w * start.x, h * start.y - 10);
    }
    for (let i = 0; i < 4; i++) {
      const lane = laneRect(i, 4),
        top = playToCamera({ x: lane.left, y: 0.64 }, this.bounds),
        bottom = playToCamera({ x: lane.right, y: 0.875 }, this.bounds),
        gap = w * (bottom.x - top.x) * 0.045,
        x = w * top.x + gap,
        pw = w * (bottom.x - top.x) - gap * 2,
        y = h * top.y,
        ph = h * (bottom.y - top.y),
        pulse = clamp(1 - (time - this.hits[i]) / 400);
      ctx.fillStyle =
        pulse > 0.1
          ? COLORS[i] + "80"
          : this.showCamera
            ? "#10181085"
            : COLORS[i] + "15";
      ctx.strokeStyle = COLORS[i] + (pulse > 0.1 ? "ee" : "66");
      ctx.lineWidth = pulse > 0.1 ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(x, y, pw, ph, 10);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = COLORS[i];
      ctx.font = `500 ${w < 500 ? 12 : 14}px Segoe UI`;
      ctx.fillText(PAD_NAMES[i], x + Math.min(17, pw * 0.15), y + ph - 22);
      ctx.font = `${w < 500 ? 6 : 8}px monospace`;
      ctx.fillStyle = COLORS[i] + "99";
      ctx.fillText(
        w < 500
          ? `0${i + 1}`
          : ["01 / LOW END", "02 / SNAP", "03 / SHIMMER", "04 / BODY"][i],
        x + Math.min(17, pw * 0.15),
        y + 22,
      );
      ctx.strokeStyle = COLORS[i] + (pulse > 0.1 ? "cc" : "55");
      ctx.beginPath();
      ctx.ellipse(
        x + pw * 0.65,
        y + ph * 0.45,
        pw * (0.19 + (this.reduced ? 0 : pulse * 0.12)),
        ph * (0.19 + (this.reduced ? 0 : pulse * 0.1)),
        -0.2,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
  }
  private drawMelody(time: number) {
    const ctx = this.ctx,
      w = this.width,
      h = this.height;
    for (let i = 0; i < 7; i++) {
      const lane = laneRect(i, 7),
        top = playToCamera({ x: lane.left, y: 0.43 }, this.bounds),
        bottom = playToCamera({ x: lane.right, y: 0.83 }, this.bounds),
        gap = w * (bottom.x - top.x) * 0.035,
        x = w * top.x + gap,
        kw = w * (bottom.x - top.x) - gap * 2,
        y = h * top.y,
        kh = h * (bottom.y - top.y),
        held = [...this.held.values()].includes(i);
      ctx.fillStyle = held
        ? "#b7a1e580"
        : this.showCamera
          ? "#17101d85"
          : "#b7a1e510";
      ctx.strokeStyle = held ? "#cfb5ff" : "#b7a1e541";
      ctx.beginPath();
      ctx.roundRect(x, y, kw, kh, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = held ? "#eadfff" : "#ac98c4";
      ctx.font = `${w < 500 ? 16 : 23}px Segoe UI`;
      ctx.textAlign = "center";
      ctx.fillText(NOTE_NAMES[i], x + kw / 2, y + kh - 25);
      ctx.font = "8px monospace";
      ctx.fillText(["A", "S", "D", "F", "G", "H", "J"][i], x + kw / 2, y + 21);
      if (held) {
        ctx.strokeStyle = "#dac7ff";
        ctx.beginPath();
        for (let j = 0; j < kw - 14; j++) {
          const yy =
            y +
            kh * 0.5 +
            Math.sin(j * 0.13 + (this.reduced ? 0 : time / 130)) * 10;
          j ? ctx.lineTo(x + 7 + j, yy) : ctx.moveTo(x + 7 + j, yy);
        }
        ctx.stroke();
      }
    }
    ctx.textAlign = "left";
  }
  private drawHand(hand: HandView) {
    const ctx = this.ctx,
      w = this.width,
      h = this.height,
      color =
        hand.phase === "hit"
          ? "#fff4d2"
          : hand.phase === "holding"
            ? "#d5b8ff"
            : hand.phase === "ready"
              ? "#d8fc71"
              : "#bcc8b2";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.shadowColor = "#000";
    ctx.shadowBlur = w < 800 ? 0 : 4;
    ctx.beginPath();
    for (const [a, b] of hand.source === "motion" ? [] : LINKS) {
      if (!hand.points[a] || !hand.points[b]) continue;
      const start = playToCamera(hand.points[a], this.bounds),
        end = playToCamera(hand.points[b], this.bounds);
      ctx.moveTo(start.x * w, start.y * h);
      ctx.lineTo(end.x * w, end.y * h);
    }
    ctx.stroke();
    const position = playToCamera(hand, this.bounds),
      x = position.x * w,
      y = position.y * h;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color + "77";
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.stroke();
    const text =
      hand.source === "motion"
        ? hand.phase === "hit"
          ? "HIT"
          : "MOTION"
        : hand.phase === "holding"
          ? NOTE_NAMES[hand.note]
          : hand.phase.toUpperCase();
    ctx.font = "10px monospace";
    const size = ctx.measureText(text).width;
    const labelX = clamp(x + 22, 5, w - size - 15),
      labelY = clamp(y - 18, 50, h - 55);
    ctx.fillStyle = "#131b10dc";
    ctx.beginPath();
    ctx.roundRect(labelX - 6, labelY - 13, size + 12, 21, 4);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, labelX, labelY);
  }
}
