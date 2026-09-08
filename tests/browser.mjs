import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
await mkdir(".verification", { recursive: true });
const base =
  process.argv.find((a) => /^https?:/.test(a)) || "http://127.0.0.1:4180";
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1080 },
  acceptDownloads: true,
});
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGE ERROR", e.message);
});
await page.addInitScript(() => {
  const AC = window.AudioContext;
  window.AudioContext = class extends AC {
    constructor(...args) {
      super(...args);
      window.testAudioContext = this;
    }
  };
  const MR = window.MediaRecorder;
  window.MediaRecorder = class extends MR {
    constructor(...args) {
      super(...args);
      window.testRecorder = this;
      this.addEventListener("dataavailable", (e) =>
        console.log("CHUNK", e.data.size),
      );
    }
  };
  window.audioAudit = { starts: [], stops: [] };
  const start = OscillatorNode.prototype.start,
    stop = OscillatorNode.prototype.stop;
  OscillatorNode.prototype.start = function (at) {
    window.audioAudit.starts.push({ at, frequency: this.frequency.value });
    return start.call(this, at);
  };
  OscillatorNode.prototype.stop = function (at) {
    window.audioAudit.stops.push(at);
    return stop.call(this, at);
  };
});
try {
  await page.goto(base);
  await page.locator("#start-pointer").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#session-state").textContent === "KEYS / TOUCH",
  );
  await page.waitForTimeout(700);
  assert.equal(
    await page.evaluate(() => window.audioAudit.starts.length),
    0,
    "session must start silent",
  );
  for (let i = 0; i < 10; i++) await page.keyboard.press("a");
  assert.equal(await page.locator("#hit-count").textContent(), "10");
  assert.equal(
    await page.evaluate(() => window.audioAudit.starts.length),
    10,
    "one oscillator per kick",
  );
  await page.locator("#mode-melody").click();
  await page.keyboard.down("d");
  await page.waitForTimeout(200);
  assert.match(await page.locator("#recognized").textContent(), /holding/);
  await page.keyboard.up("d");
  assert.equal(await page.locator("#recognized").textContent(), "Released");
  await page.screenshot({
    path: ".verification/melody-live.png",
    fullPage: true,
  });
  await page.locator("#mode-drums").click();
  await page.locator("#tempo").fill("160");
  await page.locator("#tempo").dispatchEvent("change");
  await page.locator("#record-layer").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#transport-label")
        .textContent.startsWith("Recording"),
    null,
    { timeout: 10000 },
  );
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 2 ? "s" : "a");
    await page.waitForTimeout(200);
  }
  await page.waitForFunction(
    () => document.querySelectorAll(".track:not(.empty)").length === 1,
    null,
    { timeout: 10000 },
  );
  assert.equal(await page.locator(".note-block").count(), 8);
  console.log(
    "PASS silent start, ten kicks, held melody, eight-note recorded layer",
  );
  await page.locator("#play").click();
  await page.screenshot({
    path: ".verification/drum-loop.png",
    fullPage: true,
  });
  const wavDownload = page.waitForEvent("download");
  await page.locator("#export-wav").click();
  const wav = await wavDownload;
  await wav.saveAs(".verification/bodybeats-loop.wav");
  const bytes = await readFile(".verification/bodybeats-loop.wav");
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.ok(bytes.length > 100000);
  let loud = 0;
  for (let i = 44; i < bytes.length; i += 2)
    if (Math.abs(bytes.readInt16LE(i)) > 100) loud++;
  assert.ok(loud > 1000, "export contains audible samples");
  console.log(
    "PASS WAV export",
    bytes.length,
    "bytes,",
    loud,
    "non-silent samples",
  );
  const projectDownload = page.waitForEvent("download");
  await page.locator("#save-session").click();
  await (await projectDownload).saveAs(".verification/project.json");
  const saved = JSON.parse(
    await readFile(".verification/project.json", "utf8"),
  );
  assert.equal(saved.layers[0].notes.length, 8);
  await page.reload();
  assert.equal(await page.locator(".track:not(.empty)").count(), 1);
  assert.equal(await page.locator("#tempo").inputValue(), "160");
  console.log("PASS local project restore");
  await page.locator("#start-pointer").click();
  await page.locator("#mode-melody").click();
  const area = await page.locator("#melody-control").boundingBox();
  await page.mouse.move(area.x + 50, area.y + 100);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width - 50, area.y + 100, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.locator("#recognized").textContent(), "Released");
  await page.locator("#capture").click();
  console.log(
    "CAPTURE START",
    await page.locator("#capture").textContent(),
    await page.locator("#toast").textContent(),
  );
  await page.keyboard.press("a");
  await page.waitForTimeout(1200);
  console.log(
    "RECORDING DETAILS",
    await page.evaluate(() => ({
      state: window.testAudioContext.state,
      time: window.testAudioContext.currentTime,
      hidden: document.hidden,
      recorder: window.testRecorder.state,
      tracks: window.testRecorder.stream.getTracks().map((t) => ({
        kind: t.kind,
        state: t.readyState,
        muted: t.muted,
        settings: t.getSettings(),
      })),
    })),
  );
  const clipDownload = page.waitForEvent("download");
  await page.locator("#capture").click();
  console.log(
    "CAPTURE STOP",
    await page.locator("#capture").textContent(),
    await page.locator("#toast").textContent(),
  );
  await (await clipDownload).saveAs(".verification/performance.webm");
  assert.ok((await readFile(".verification/performance.webm")).length > 1000);
  console.log("PASS pointer melody and performance recording");
  await page.locator("#stop-session").click();
  assert.equal(
    await page.locator("#session-state").textContent(),
    "READY WHEN YOU ARE",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".verification/mobile-final.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "mobile must not overflow",
  );
  assert.deepEqual(errors, []);
  console.log("PASS mobile layout and no application errors");
} finally {
  await browser.close();
}
