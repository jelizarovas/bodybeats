import { SCALE, clamp, LOOP_BEATS } from "./types.ts";
import type { Layer, LoopNote, Project } from "./types.ts";
type Voice = {
  oscillator: OscillatorNode;
  overtone: OscillatorNode;
  gain: GainNode;
  filter: BiquadFilterNode;
  stopped: boolean;
  stop(at: number): void;
};
const frequency = (index: number) => 440 * 2 ** ((SCALE[index] - 69) / 12);

function melody(
  context: BaseAudioContext,
  output: AudioNode,
  note: number,
  brightness: number,
  at: number,
): Voice {
  const oscillator = context.createOscillator(),
    overtone = context.createOscillator(),
    gain = context.createGain(),
    filter = context.createBiquadFilter();
  oscillator.type = "triangle";
  overtone.type = "sine";
  oscillator.frequency.setValueAtTime(frequency(note), at);
  overtone.frequency.setValueAtTime(frequency(note) * 2, at);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(650 + brightness * 6000, at);
  filter.Q.value = 0.7;
  const harmonic = context.createGain();
  harmonic.gain.value = 0.15;
  oscillator.connect(filter);
  overtone.connect(harmonic).connect(filter);
  filter.connect(gain).connect(output);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.2, at + 0.015);
  oscillator.start(at);
  overtone.start(at);
  const voice: Voice = {
    oscillator,
    overtone,
    gain,
    filter,
    stopped: false,
    stop(end) {
      if (this.stopped) return;
      this.stopped = true;
      gain.gain.cancelAndHoldAtTime(end);
      gain.gain.linearRampToValueAtTime(0, end + 0.06);
      oscillator.stop(end + 0.07);
      overtone.stop(end + 0.07);
    },
  };
  oscillator.onended = () => {
    oscillator.disconnect();
    overtone.disconnect();
    harmonic.disconnect();
    filter.disconnect();
    gain.disconnect();
  };
  return voice;
}
function drum(
  context: BaseAudioContext,
  output: AudioNode,
  pad: number,
  velocity: number,
  at: number,
) {
  const gain = context.createGain();
  gain.connect(output);
  const level = clamp(velocity, 0.1, 1);
  if (pad === 0 || pad === 3) {
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(pad === 0 ? 145 : 240, at);
    osc.frequency.exponentialRampToValueAtTime(pad === 0 ? 43 : 85, at + 0.12);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level * 0.85, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      at + (pad === 0 ? 0.48 : 0.32),
    );
    osc.connect(gain);
    osc.start(at);
    osc.stop(at + 0.55);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } else {
    const length = pad === 1 ? 0.22 : 0.08,
      buffer = context.createBuffer(
        1,
        Math.ceil(context.sampleRate * length),
        context.sampleRate,
      ),
      data = buffer.getChannelData(0);
    let seed = 19371;
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    const noise = context.createBufferSource(),
      filter = context.createBiquadFilter();
    noise.buffer = buffer;
    filter.type = "highpass";
    filter.frequency.value = pad === 1 ? 1200 : 6800;
    noise.connect(filter).connect(gain);
    gain.gain.setValueAtTime(level * (pad === 1 ? 0.5 : 0.3), at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    noise.start(at);
    noise.onended = () => {
      noise.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }
}
export class AudioEngine {
  context: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private captureDestination: MediaStreamAudioDestinationNode | null = null;
  private voices = new Map<string, Voice>();
  private layerBuses = new Map<string, GainNode>();
  private initializing: Promise<void> | null = null;
  private volume = 0.7;
  async start() {
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }
  private async initialize() {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -8;
      compressor.knee.value = 6;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.15;
      this.master.connect(compressor).connect(this.context.destination);
      this.captureDestination = this.context.createMediaStreamDestination();
      compressor.connect(this.captureDestination);
      // Keep the recording clock advancing through rests between notes.
      const recordingClock = this.context.createConstantSource();
      recordingClock.offset.value = 0;
      recordingClock.connect(this.captureDestination);
      recordingClock.start();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      compressor.connect(this.analyser);
      this.newBus();
    }
    await this.context.resume();
  }
  private newBus() {
    if (this.context && this.master) {
      this.bus = this.context.createGain();
      this.bus.connect(this.master);
    }
  }
  get now() {
    return this.context?.currentTime ?? 0;
  }
  get stream() {
    return this.captureDestination?.stream ?? null;
  }
  get latency() {
    return this.context ? this.context.baseLatency * 1000 : 0;
  }
  setVolume(value: number) {
    this.volume = clamp(value);
    this.master?.gain.setTargetAtTime(this.volume, this.now, 0.02);
  }
  hit(pad: number, velocity = 0.65, at = this.now) {
    if (this.context && this.bus)
      drum(this.context, this.bus, pad, velocity, Math.max(at, this.now));
  }
  noteOn(id: string, note: number, brightness = 0.5) {
    if (!this.context || !this.bus) return;
    this.noteOff(id);
    this.voices.set(
      id,
      melody(this.context, this.bus, note, brightness, this.now),
    );
  }
  noteChange(id: string, note: number, brightness: number) {
    const voice = this.voices.get(id);
    if (!voice) return;
    voice.oscillator.frequency.setTargetAtTime(
      frequency(note),
      this.now,
      0.018,
    );
    voice.overtone.frequency.setTargetAtTime(
      frequency(note) * 2,
      this.now,
      0.018,
    );
    voice.filter.frequency.setTargetAtTime(
      650 + brightness * 6000,
      this.now,
      0.03,
    );
  }
  noteOff(id: string) {
    this.voices.get(id)?.stop(this.now);
    this.voices.delete(id);
  }
  releaseLive() {
    for (const id of [...this.voices.keys()]) this.noteOff(id);
  }
  scheduled(
    note: LoopNote,
    at: number,
    secondsPerBeat: number,
    layerId: string,
  ) {
    if (!this.context || !this.bus) return;
    let output = this.layerBuses.get(layerId);
    if (!output) {
      output = this.context.createGain();
      output.connect(this.bus);
      this.layerBuses.set(layerId, output);
    }
    if (note.instrument === "drums")
      drum(this.context, output, note.pitch, note.velocity, at);
    else {
      const voice = melody(
        this.context,
        output,
        note.pitch,
        note.brightness,
        at,
      );
      voice.stop(at + note.duration * secondsPerBeat);
    }
  }
  muteLayer(id: string, muted: boolean) {
    this.layerBuses
      .get(id)
      ?.gain.setTargetAtTime(muted ? 0 : 1, this.now, 0.015);
  }
  click(at: number, accent = false) {
    if (!this.context || !this.bus) return;
    const osc = this.context.createOscillator(),
      gain = this.context.createGain();
    osc.frequency.value = accent ? 1100 : 750;
    gain.gain.setValueAtTime(0.055, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    osc.connect(gain).connect(this.bus);
    osc.start(at);
    osc.stop(at + 0.04);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }
  /** Fade the old output bus, including already-scheduled loop voices. */
  panic() {
    this.releaseLive();
    if (this.bus) {
      const old = this.bus;
      old.gain.cancelScheduledValues(this.now);
      old.gain.setTargetAtTime(0, this.now, 0.01);
      setTimeout(() => old.disconnect(), 150);
    }
    this.layerBuses.clear();
    this.newBus();
  }
  waveform() {
    if (!this.analyser) return new Float32Array(128);
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    return data;
  }
  async exportWav(project: Project): Promise<Blob> {
    const secondsPerBeat = 60 / project.bpm,
      duration = LOOP_BEATS * secondsPerBeat + 0.6,
      sampleRate = 44100,
      offline = new OfflineAudioContext(
        2,
        Math.ceil(duration * sampleRate),
        sampleRate,
      );
    const gain = offline.createGain();
    gain.gain.value = this.volume;
    const limiter = offline.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.ratio.value = 8;
    gain.connect(limiter).connect(offline.destination);
    for (const layer of project.layers.filter((l: Layer) => !l.muted))
      for (const note of layer.notes) {
        const at = note.beat * secondsPerBeat;
        if (note.instrument === "drums")
          drum(offline, gain, note.pitch, note.velocity, at);
        else
          melody(offline, gain, note.pitch, note.brightness, at).stop(
            at + note.duration * secondsPerBeat,
          );
      }
    return encodeWav(await offline.startRendering());
  }
}
function encodeWav(buffer: AudioBuffer) {
  const channels = buffer.numberOfChannels,
    length = buffer.length * channels * 2,
    bytes = new ArrayBuffer(44 + length),
    view = new DataView(bytes);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length, true);
  const data = Array.from({ length: channels }, (_, i) =>
    buffer.getChannelData(i),
  );
  let offset = 44;
  for (let i = 0; i < buffer.length; i++)
    for (let c = 0; c < channels; c++) {
      const value = clamp(data[c][i], -1, 1);
      view.setInt16(
        offset,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      );
      offset += 2;
    }
  return new Blob([bytes], { type: "audio/wav" });
}
