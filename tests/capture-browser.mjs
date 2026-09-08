import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.addInitScript(() => {
    const Recorder = window.MediaRecorder;
    window.MediaRecorder = class extends Recorder {
      constructor(...args) {
        super(...args);
        window.captureAudit = { recorder: this, chunks: [], errors: [] };
        this.addEventListener("dataavailable", (event) =>
          window.captureAudit.chunks.push(event.data.size),
        );
        this.addEventListener("error", (event) =>
          window.captureAudit.errors.push(String(event.error)),
        );
      }
    };
  });
  await page.goto(process.argv[2] || "http://127.0.0.1:4181");
  await page.locator("#start-pointer").click();
  for (let i = 0; i < 4; i++) {
    await page.locator("#capture").click();
    if (i % 2) await page.keyboard.press("a");
    await page.waitForTimeout(1500);
    const downloaded = page
      .waitForEvent("download", { timeout: 4000 })
      .catch((error) => error);
    await page.locator("#capture").click();
    const clip = await downloaded;
    if (clip instanceof Error) {
      console.log(
        "CAPTURE FAILURE",
        await page.evaluate(() => ({
          toast: document.querySelector("#toast").textContent,
          hidden: document.hidden,
          state: window.captureAudit.recorder.state,
          chunks: window.captureAudit.chunks,
          errors: window.captureAudit.errors,
          tracks: window.captureAudit.recorder.stream.getTracks().map((t) => ({
            kind: t.kind,
            state: t.readyState,
            muted: t.muted,
            settings: t.getSettings(),
          })),
        })),
      );
      throw clip;
    }
    await clip.saveAs(`.verification/capture-${i}.webm`);
    const bytes = await readFile(`.verification/capture-${i}.webm`);
    assert.ok(bytes.length > 1000);
    const decoded = await page.evaluate(async (base64) => {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "video/webm" }),
      );
      const video = document.createElement("video");
      video.muted = true;
      video.src = url;
      let timer;
      try {
        return await Promise.race([
          new Promise((resolve, reject) => {
            video.onerror = () =>
              reject(new Error(`WebM decode failed: ${video.error?.message}`));
            const frame = (_now, metadata) => {
              if (metadata.mediaTime > 0.1)
                resolve({
                  width: video.videoWidth,
                  height: video.videoHeight,
                  time: metadata.mediaTime,
                });
              else video.requestVideoFrameCallback(frame);
            };
            video.requestVideoFrameCallback(frame);
            video.play().catch(reject);
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("WebM did not decode advancing video frames")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      }
    }, bytes.toString("base64"));
    assert.ok(decoded.width > 0 && decoded.height > 0 && decoded.time > 0.1);
    console.log(
      `PASS recording ${i + 1}: ${i % 2 ? "single note followed by rest" : "silent instrument"}; decoded advancing ${decoded.width}x${decoded.height} video`,
    );
  }
} finally {
  await browser.close();
}
