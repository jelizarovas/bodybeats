import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
await mkdir(".verification", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1150 },
  });
  page.on("pageerror", console.error);
  await page.goto("http://127.0.0.1:4180");
  await page.waitForTimeout(700);
  await page.screenshot({
    path: ".verification/studio-proposal.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".verification/studio-mobile.png",
    fullPage: true,
  });
} finally {
  await browser.close();
}
