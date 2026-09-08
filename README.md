# BodyBeats Studio 3

A local browser instrument with air drums, pinch-controlled melody, and an eight-beat loop station. Every sound comes from a deliberate action or a recorded layer. Starting a session is silent.

## Run

Requires Node.js 22.12 or later. Run `npm install`, then `npm run dev` and open the localhost address printed by Vite. `npm run check` runs the deterministic tests and production build. `npm run preview` serves the build at http://127.0.0.1:4181.

Camera access requires localhost or HTTPS. The first camera startup downloads the pinned MediaPipe runtime and gesture model from jsDelivr and Google storage. Camera images are processed locally in a worker; this app does not upload them. Keyboard and touch modes do not need the model. Browser cache availability determines whether a later camera startup can work offline.

## Play

Starting the camera shows the mirrored feed at full brightness with the pads and tracking overlay on top. Desktop controls float over the feed. The image keeps its camera proportions. Hide camera is optional.

On phones, camera mode removes the page heading so the instrument and transport fit near the top of the first screen. The display canvas uses one CSS pixel per rendered pixel, draws at up to 30 FPS, and avoids live-video blur. Camera recognition keeps its separate worker input and can process up to 60 frames per second when the device and model are fast enough.

- **Air drums:** Put the whole hand in frame. Lift above a pad until it says ready, then strike down through the dotted line. Lift again to rearm. A/S/D/F or tapping the pads plays kick/snare/hi-hat/tom.
- **Melody:** Pinch thumb and index to start a note. Move sideways to change pitch and upward to brighten it. Release the pinch to stop. Alternatively hold A/S/D/F/G/H/J, or hold and drag the stage.
- **Playing area:** With the camera running, choose Set my playing area. Hold at the upper-left and lower-right limits of your comfortable reach. Either hand, left, or right can be selected.
- **Loops:** Record a layer after the count-in, then play for eight beats. Up to four drum or melody layers can repeat together. Mute/remove layers or undo the last one. Pause before changing tempo.
- **Save:** Projects save in this browser on this origin. Save project downloads a portable JSON file; Open project restores it. Export audio renders unmuted layers to WAV. Record performance saves the stage and instrument audio as WebM, up to 60 seconds. The microphone is never requested.
- **Recognition lab:** Explicitly record up to 15 seconds of hand landmarks, then replay or export the trace. Traces contain positions and recognition samples, not camera images. A performance video includes the camera image only when Show camera is enabled.

End session stops the camera and releases notes. Losing a hand releases held notes. Hiding the tab pauses loops and releases sound. Camera errors leave keyboard/touch available.

Missing hands no longer leave fading skeletons. Continuous low-FPS observations preserve gesture state for up to 600 ms. A drum stroke can survive a missing observation for up to 120 ms only when a nearby matching real hand confirms the crossing. Actual upward movement rearms immediately, without a stationary dwell. Crossing position and time are interpolated between observations. Held notes release on tracking loss; stalled frames and window blur also reset the worker gesture state.

A short image-patch fallback can follow measured palm movement for up to 220 ms from the last model detection. It can complete an armed drum strike, but cannot rearm or start a pinch. Ambiguous, stationary, expired, and overlapping matches are rejected. The playing lanes are inset from the camera edges. Calibration transforms the same geometry for drawing and recognition while keeping the full camera image visible.

Tracking is capped at 60 updates per second (16.7 ms between capture starts), with one frame in flight and no frame queue. On completion, the newest available camera frame is processed immediately when the rate cap permits. Camera capture requests up to 60 FPS; the actual device may deliver less. Recognition lab separates model, pixel readback, motion recovery, total worker, and capture-to-result times. Camera exposure and physical audio output delay are not included in capture-to-result timing.

The GPU is tried first. After warmup, repeated hand frames over the 16.7 ms budget trigger one bounded CPU comparison using cached model bytes and matching fresh frames. CPU is selected only if it preserves detected hands and consistently saves at least 20% and 4 ms. Loading briefly pauses tracking and releases notes; stale frames cannot generate delayed hits. A faster backend does not guarantee 60 FPS.

## Architecture

- `camera.ts` owns permission, stream, worker lifecycle, timeouts, and one frame in flight. Frames are transferred as ImageBitmaps and closed after inference.
- `vision.worker.ts` runs MediaPipe and temporal gesture recognition off the UI thread. It selects GPU or CPU from measured performance. A worker gives the browser independent scheduling; the app does not pin a physical CPU core.
- `recognition.ts` turns tracked hands into explicit hit/note-on/note-change/note-off actions with rearming, velocity thresholds, pinch hysteresis, and tracking-loss release.
- `audio.ts` synthesizes voices with Web Audio. `loops.ts` schedules against the audio clock, with lookahead and deduplication across loop boundaries. Each layer has its own output gain.
- `stage.ts` renders the instrument, landmarks, state, and audio waveform. `capture.ts` records a separate, fixed-size canvas and the audio output.
- `storage.ts` validates project/trace imports and stores calibration and projects locally.

The app uses TypeScript and Vite, with no UI framework or server. It recognizes hand actions; full-body dance classification and trained custom gesture models are not included.

## Verification

See [VALIDATION.md](VALIDATION.md). Browser verification uses Playwright. Run `npx playwright install chromium` before running the browser scripts. The deterministic tests run with Node alone after dependency installation.

The camera fixture is the public MediaPipe test image from https://storage.googleapis.com/mediapipe-assets/thumb_up.jpg. Moving a photo through the real model validates the pipeline, but does not establish recognition quality for every person's hands, lighting, camera, or hardware. Live human calibration and play remain the next acceptance check.

## GitHub Pages

The site is published at https://jelizarovas.github.io/bodybeats/. The `Test and deploy BodyBeats` workflow runs tests and builds the application on pushes to `main`, then deploys `dist` to GitHub Pages. Pull requests run the checks without deploying. Relative asset paths support the repository subdirectory, including the vision worker.

The hosted site uses a different browser origin from localhost. To transfer an existing loop, use Save project in the local app, then Open project on the hosted site. Camera access requires permission for the new HTTPS address. Camera frames continue to be processed on the device.
