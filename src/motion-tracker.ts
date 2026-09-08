import type { HandSample } from "./types.ts";

export type GrayFrame = { width: number; height: number; pixels: Uint8Array };
type Anchor = {
  hand: HandSample;
  frame: GrayFrame;
  at: number;
  cx: number;
  cy: number;
  radius: number;
  values: number[];
  energy: number;
};
const GRID = 9;
function patch(frame: GrayFrame, cx: number, cy: number, radius: number) {
  const values: number[] = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++) {
      const px = Math.round(cx + ((x / (GRID - 1)) * 2 - 1) * radius);
      const py = Math.round(cy + ((y / (GRID - 1)) * 2 - 1) * radius);
      if (px < 0 || py < 0 || px >= frame.width || py >= frame.height)
        return null;
      values.push(frame.pixels[py * frame.width + px]);
    }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let energy = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] -= mean;
    energy += values[i] ** 2;
  }
  return { values, energy };
}

/** Bounded image matching, anchored only by actual model detections. No velocity extrapolation. */
export class MotionTracker {
  private anchors = new Map<string, Anchor>();
  clear() {
    this.anchors.clear();
  }
  observe(hands: HandSample[], frame: GrayFrame, at: number) {
    for (const hand of hands) {
      const cx = (1 - hand.x) * frame.width,
        cy = hand.y * frame.height;
      const radius = Math.max(6, Math.min(22, hand.scale * frame.width * 0.95));
      const template = patch(frame, cx, cy, radius);
      // Flat areas cannot reliably identify an object.
      if (!template || template.energy < GRID * GRID * 25) {
        this.anchors.delete(hand.id);
        continue;
      }
      this.anchors.set(hand.id, {
        hand,
        frame,
        at,
        cx,
        cy,
        radius,
        ...template,
      });
    }
  }
  recover(frame: GrayFrame, at: number, detected: HandSample[]) {
    const recovered: HandSample[] = [];
    for (const [id, anchor] of this.anchors) {
      if (
        at - anchor.at > 220 ||
        at <= anchor.at ||
        frame.width !== anchor.frame.width ||
        frame.height !== anchor.frame.height
      ) {
        if (at - anchor.at > 220) this.anchors.delete(id);
        continue;
      }
      if (detected.some((h) => h.id === id)) continue;
      const candidates: { dx: number; dy: number; score: number }[] = [];
      const range = Math.min(48, Math.ceil(8 + (at - anchor.at) * 0.32));
      function score(dx: number, dy: number) {
        const target = patch(
          frame,
          anchor.cx + dx,
          anchor.cy + dy,
          anchor.radius,
        );
        if (!target || target.energy < GRID * GRID * 25) return -1;
        let dot = 0;
        for (let i = 0; i < target.values.length; i++)
          dot += anchor.values[i] * target.values[i];
        return dot / Math.sqrt(anchor.energy * target.energy);
      }
      for (let dy = -range; dy <= range; dy += 3)
        for (let dx = -range; dx <= range; dx += 3)
          candidates.push({ dx, dy, score: score(dx, dy) });
      candidates.sort((a, b) => b.score - a.score);
      let best = candidates[0];
      if (!best || best.score < 0.65) continue;
      const coarse = best;
      for (let dy = coarse.dy - 2; dy <= coarse.dy + 2; dy++)
        for (let dx = coarse.dx - 2; dx <= coarse.dx + 2; dx++) {
          const value = score(dx, dy);
          if (value > best.score) best = { dx, dy, score: value };
        }
      // Reject ambiguous matches and matches that stick to a stationary background.
      const competitor = candidates.find(
        (c) => Math.hypot(c.dx - best.dx, c.dy - best.dy) > anchor.radius,
      );
      if (
        best.score < 0.82 ||
        (competitor && best.score - competitor.score < 0.06) ||
        Math.hypot(best.dx, best.dy) < 1.5
      )
        continue;
      const dx = -best.dx / frame.width,
        dy = best.dy / frame.height;
      const x = anchor.hand.x + dx,
        y = anchor.hand.y + dy;
      if (
        x < 0.02 ||
        x > 0.98 ||
        y < 0.02 ||
        y > 0.98 ||
        [...detected, ...recovered].some(
          (h) => Math.hypot(h.x - x, h.y - y) < 0.12,
        )
      )
        continue;
      recovered.push({
        ...anchor.hand,
        source: "motion",
        x,
        y,
        pose: "None",
        score: best.score,
        pinchRatio: 1,
        points: anchor.hand.points.map((p) => ({
          ...p,
          x: p.x + dx,
          y: p.y + dy,
        })),
      });
    }
    return recovered;
  }
}
