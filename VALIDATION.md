# Validation

The initial release passes 47 deterministic tests and the TypeScript and Vite production build. Tests cover frame scheduling, CPU/GPU selection, drum crossings and rearming, pinch/release behavior, playing-area geometry, calibration, tracking loss, loops, and import validation.

Browser checks cover keyboard and pointer instruments, loop recording, project restoration, WAV/WebM export, mobile layout, camera lifecycle failures, and trace replay. A public-image fixture exercises the actual MediaPipe worker and produces nine expected strikes in the fast-motion test.

These synthetic checks do not establish human tracking accuracy. A live two-hand session measured about 19–20 tracking updates per second and 36–65 ms capture-to-result latency. The 60 FPS ceiling is not a performance guarantee. The CPU comparison and a separate lighter-model experiment did not show a consistent improvement.

An intermittent empty WebM recording occurred during parallel browser tests. Subsequent isolated runs passed, including four consecutive recordings with decoded, advancing video frames. The initial failure remains unexplained.

Run `npm run check` for the automated suite. To run browser checks, start `npm run preview` in another terminal, install Chromium with `npx playwright install chromium`, then run:

```sh
node tests/browser.mjs http://127.0.0.1:4181
node tests/lifecycle.mjs http://127.0.0.1:4181
node tests/camera-browser.mjs http://127.0.0.1:4181
node tests/motion-browser.mjs http://127.0.0.1:4181
node tests/capture-browser.mjs http://127.0.0.1:4181
```

Browser tests save local artifacts under `.verification/`, which is excluded from Git. The camera fixture is the public MediaPipe image at https://storage.googleapis.com/mediapipe-assets/thumb_up.jpg. No personal camera recordings are included in this repository.
