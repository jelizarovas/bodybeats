import type { HandView } from "./types.ts";

// Draw current observations only; a missing detection is not an active hand.
export class TrackingView {
  private recent = new Map<string, { hand: HandView; seenAt: number }>();
  update(hands: HandView[], now: number) {
    this.recent.clear();
    for (const hand of hands) this.recent.set(hand.id, { hand, seenAt: now });
  }
  frames(now: number) {
    const frames: { hand: HandView }[] = [];
    for (const [id, entry] of this.recent) {
      const age = now - entry.seenAt;
      if (age > 250) {
        this.recent.delete(id);
        continue;
      }
      frames.push({ hand: entry.hand });
    }
    return frames;
  }
  clear() {
    this.recent.clear();
  }
}
