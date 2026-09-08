import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const base =
  process.argv.find((a) => /^https?:/.test(a)) || "http://127.0.0.1:4180";
const fixture = await readFile("tests/fixtures/thumb_up.jpg");
await mkdir(".verification", { recursive: true });
const browser = await chromium.launch({
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.log("PAGE ERROR", e.message);
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300));
});
await page.addInitScript(() => {
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (e) => {
        if (e.data.type === "result") window.latestRecognition = e.data.state;
        if (e.data.type === "error") console.error("WORKER", e.data.message);
      });
    }
  };
});
try {
  await page.goto(base);
  await page.evaluate(
    async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext("2d");
      const scale = 240 / image.height;
      window.photoY = 25;
      window.photoVisible = true;
      function draw() {
        ctx.fillStyle = "#ddd";
        ctx.fillRect(0, 0, 640, 480);
        if (window.photoVisible)
          ctx.drawImage(image, 220, window.photoY, image.width * scale, 240);
      }
      draw();
      window.drawTimer = setInterval(draw, 33);
      navigator.mediaDevices.getUserMedia = async () => {
        window.fakeStream = canvas.captureStream(30);
        return window.fakeStream;
      };
    },
    `data:image/jpeg;base64,${fixture.toString("base64")}`,
  );
  await page.locator("#start-camera").click();
  await page.waitForFunction(
    () =>
      window.latestRecognition?.hands?.length ||
      document.querySelector("#tracking-health").textContent ===
        "CAMERA UNAVAILABLE",
    null,
    { timeout: 45000 },
  );
  assert.equal(
    await page.locator("#session-state").textContent(),
    "CAMERA SESSION",
    await page.locator("#toast").textContent(),
  );
  console.log(
    "REAL HAND",
    await page.evaluate(() =>
      window.latestRecognition.hands.map((h) => ({
        pose: h.pose,
        x: h.x,
        y: h.y,
        phase: h.phase,
      })),
    ),
  );
  assert.equal(
    await page.evaluate(() => window.latestRecognition.hands[0].pose),
    "Thumb_Up",
  );
  assert.equal(
    await page.locator("#hit-count").textContent(),
    "00",
    "static hand must not generate music",
  );
  assert.equal(
    await page.locator("#camera-view").getAttribute("aria-pressed"),
    "true",
    "camera must be visible by default",
  );
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const pixel = canvas
      .getContext("2d")
      .getImageData(
        Math.floor(canvas.width * 0.9),
        Math.floor(canvas.height * 0.35),
        1,
        1,
      ).data;
    const stage = document.querySelector("#stage").getBoundingClientRect();
    const toolbar = document
      .querySelector(".instrument-toolbar")
      .getBoundingClientRect();
    const transport = document
      .querySelector(".transport")
      .getBoundingClientRect();
    return {
      brightness: pixel[0],
      aspect: stage.width / stage.height,
      toolbarOverCamera:
        toolbar.top >= stage.top - 1 && toolbar.bottom < stage.bottom,
      transportOverCamera:
        transport.bottom <= stage.bottom + 1 && transport.top > stage.top,
    };
  });
  assert.ok(geometry.brightness > 180, "camera image must remain bright");
  assert.ok(
    Math.abs(geometry.aspect - 4 / 3) < 0.01,
    "camera must not be stretched",
  );
  assert.ok(geometry.toolbarOverCamera && geometry.transportOverCamera);
  console.log(
    "PASS full-brightness camera visible by default, aspect correct, controls overlay camera",
  );
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      window.photoY += (0.35 - window.latestRecognition.samples[0].y) * 480;
    });
    await page.waitForFunction(
      () => window.latestRecognition.hands.some((h) => h.phase === "ready"),
      null,
      { timeout: 10000 },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const initial = window.photoY,
            start = performance.now();
          function step(t) {
            const p = Math.min(1, (t - start) / 240);
            window.photoY = initial + p * 175;
            if (p < 1) requestAnimationFrame(step);
            else resolve();
          }
          requestAnimationFrame(step);
        }),
    );
    await page.waitForTimeout(300);
  }
  assert.equal(await page.locator("#hit-count").textContent(), "03");
  console.log(
    "PASS real model, static pose silence, three photo-motion drum hits",
  );
  await page.screenshot({
    path: ".verification/camera-overlay.png",
    fullPage: true,
  });
  await page.locator("#diagnostics-toggle").click();
  await page.locator("#record-trace").click();
  await page.waitForTimeout(400);
  await page.locator("#record-trace").click();
  assert.equal(await page.locator("#replay-trace").isEnabled(), true);
  console.log("PASS opt-in trace recording");
  await page.evaluate(() => {
    window.photoVisible = false;
  });
  await page.waitForFunction(() => window.latestRecognition.hands.length === 0);
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator("#recognized").textContent(),
    "No hand visible",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".verification/camera-overlay-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator("#stop-session").click();
  assert.equal(
    await page.evaluate(() =>
      window.fakeStream.getTracks().every((t) => t.readyState === "ended"),
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log("PASS no-hand feedback and camera cleanup");
} catch (error) {
  console.log(
    "CAMERA FAILURE",
    await page.evaluate(() => ({
      status: document.querySelector("#session-state").textContent,
      health: document.querySelector("#tracking-health").textContent,
      toast: document.querySelector("#toast").textContent,
      state: window.latestRecognition,
      video: {
        time: document.querySelector("video").currentTime,
        ready: document.querySelector("video").readyState,
      },
    })),
  );
  await page.screenshot({
    path: ".verification/camera-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
