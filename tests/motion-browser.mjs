import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
});
const fixture = await readFile("tests/fixtures/thumb_up.jpg");
const base =
  process.argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:4181";
const baseline = process.argv.includes("--baseline");
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1100 },
  });
  page.on("pageerror", (e) => console.log("ERROR", e.message));
  await page.addInitScript(() => {
    const WorkerClass = window.Worker;
    window.samples = [];
    window.Worker = class extends WorkerClass {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.type === "result") {
            window.latest = data.state;
            window.samples.push({
              hands: data.state.hands.length,
              flow: data.state.hands.filter((h) => h.source === "motion")
                .length,
              actions: data.state.actions.length,
              ms: data.state.inferenceMs,
            });
          }
        });
      }
    };
  });
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
      window.handY = 25;
      window.handBlur = 0;
      function draw() {
        ctx.filter = "none";
        ctx.fillStyle = "#aaa";
        ctx.fillRect(0, 0, 640, 480);
        ctx.filter = `blur(${window.handBlur}px)`;
        ctx.drawImage(
          image,
          220,
          window.handY,
          (image.width * 240) / image.height,
          240,
        );
        requestAnimationFrame(draw);
      }
      draw();
      navigator.mediaDevices.getUserMedia = async () =>
        canvas.captureStream(60);
    },
    `data:image/jpeg;base64,${fixture.toString("base64")}`,
  );
  await page.locator("#start-camera").click();
  await page.waitForFunction(() => window.latest?.hands.length, null, {
    timeout: 45000,
  });
  const results = [];
  for (const blur of [0, 3, 5]) {
    for (let repeat = 0; repeat < 3; repeat++) {
      await page.evaluate(() => {
        window.handBlur = 0;
        window.handY = 25;
      });
      await page.waitForFunction(
        () => window.latest.hands.some((h) => h.phase === "ready"),
        null,
        { timeout: 5000 },
      );
      const before = Number(await page.locator("#hit-count").textContent());
      await page.evaluate(async (blur) => {
        window.samples = [];
        const start = performance.now();
        await new Promise((resolve) => {
          function move(now) {
            const p = Math.min(1, (now - start) / 120);
            window.handY = 25 + p * 175;
            window.handBlur = p < 1 ? blur : 0;
            if (p < 1) requestAnimationFrame(move);
            else resolve();
          }
          requestAnimationFrame(move);
        });
      }, blur);
      await page.waitForTimeout(200);
      const samples = await page.evaluate(() => window.samples);
      results.push({
        blur,
        hits: Number(await page.locator("#hit-count").textContent()) - before,
        frames: samples.length,
        missing: samples.filter((s) => !s.hands).length,
        motion: samples.filter((s) => s.flow).length,
        maxMs: Math.round(Math.max(...samples.map((s) => s.ms))),
      });
    }
  }
  console.log(JSON.stringify(results));
  await writeFile(
    `.verification/motion-${baseline ? "baseline" : "updated"}.json`,
    JSON.stringify(results, null, 2),
  );
  if (!baseline)
    assert.ok(
      results.every((r) => r.hits === 1),
      "each fast strike must produce one hit, including the blurred cases",
    );
} finally {
  await browser.close();
}
