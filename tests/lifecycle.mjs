import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({
  headless: true,
});
const base = process.argv[2] || "http://127.0.0.1:4181";
try {
  for (const scenario of [
    "late-permission",
    "denied",
    "model-error",
    "frame-stall",
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((scenario) => {
      window.workerStopped = false;
      window.Worker = class extends EventTarget {
        postMessage(data) {
          if (data.type === "init")
            setTimeout(
              () =>
                this.dispatchEvent(
                  new MessageEvent("message", {
                    data:
                      scenario === "model-error"
                        ? { type: "error", message: "Test model unavailable" }
                        : { type: "ready", delegate: "TEST" },
                  }),
                ),
              30,
            );
          if (data.type === "frame") data.bitmap.close();
        }
        terminate() {
          window.workerStopped = true;
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        if (scenario === "denied")
          throw new DOMException("Permission denied", "NotAllowedError");
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext("2d");
        setInterval(() => {
          ctx.fillStyle = "#aaa";
          ctx.fillRect(0, 0, 640, 480);
        }, 33);
        window.testStream = canvas.captureStream(30);
        if (scenario === "late-permission")
          await new Promise((resolve) => (window.resolvePermission = resolve));
        return window.testStream;
      };
    }, scenario);
    await page.goto(base);
    await page.locator("#start-camera").click();
    if (scenario === "late-permission") {
      await page.waitForFunction(() => !!window.resolvePermission);
      await page.locator("#stop-session").click();
      await page.evaluate(() => window.resolvePermission());
    }
    await page.waitForFunction(
      () =>
        document.querySelector("#session-state").textContent ===
        "READY WHEN YOU ARE",
      null,
      { timeout: 10000 },
    );
    await page.waitForFunction(
      () =>
        window.workerStopped &&
        (!window.testStream ||
          window.testStream.getTracks().every((t) => t.readyState === "ended")),
    );
    await page.locator("#start-pointer").click();
    await page.keyboard.press("a");
    assert.equal(await page.locator("#hit-count").textContent(), "01");
    assert.deepEqual(errors, []);
    console.log(`PASS ${scenario}: resources stopped, keyboard recovery works`);
    await page.close();
  }
  const page = await browser.newPage();
  await page.goto(base);
  const sample = (y) => ({
    id: "hand-0",
    handedness: "Left",
    x: 0.2,
    y,
    scale: 0.15,
    pinchRatio: 1,
    pose: "Open_Palm",
    score: 0.9,
    points: [],
  });
  const trace = {
    version: 1,
    settings: {
      instrument: "drums",
      bounds: { left: 0, top: 0, right: 1, bottom: 1 },
      preferredHand: "any",
    },
    frames: [0, 50, 100, 150, 200, 250, 300].map((timestamp, i) => ({
      timestamp,
      hands: [sample([0.35, 0.35, 0.35, 0.5, 0.7, 0.75, 0.75][i])],
    })),
  };
  await page.locator("#import-trace").setInputFiles({
    name: "one-hit.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(trace)),
  });
  await page.locator("#replay-trace").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#trace-status")
      .textContent.startsWith("Replay complete"),
  );
  assert.match(
    await page.locator("#trace-status").textContent(),
    /1 musical actions/,
  );
  assert.equal(await page.locator("#hit-count").textContent(), "01");
  console.log("PASS imported gesture trace replay: exactly one drum hit");
} finally {
  await browser.close();
}
