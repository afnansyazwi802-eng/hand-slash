# Hand Slash

A browser-based hand gesture experiment using MediaPipe Hand Landmarker and a webcam.

Point with your index finger and move your hand quickly to trigger a slash.

## Features

- Webcam hand tracking
- Custom index-pointing gesture detection
- Horizontal slash
- Vertical slash
- Diagonal slash using the horizontal asset rotated with CSS
- Fade-in / hold / fade-out animation
- Gesture cooldown to prevent repeated triggers
- Adjustable movement sensitivity
- Test Slash button
- Works as a static GitHub Pages site

## Run locally

Because browsers normally require a secure context for webcam access, use a local web server instead of opening `index.html` directly.

With Python:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

Allow camera access.

## GitHub Pages

Push the repository to GitHub, then enable GitHub Pages using GitHub Actions.

The included workflow is:

```text
.github/workflows/deploy.yml
```

After deployment, the project can be opened from its GitHub Pages URL.

## Gesture

Default gesture:

1. Extend your index finger.
2. Keep middle, ring, and pinky fingers folded.
3. Move the hand.

The movement direction determines the slash:

- Mostly left/right → horizontal
- Mostly up/down → vertical
- Mixed movement → diagonal

## Controls

### Point + Move

The default mode. The slash fires when a pointing gesture is detected together with enough hand movement.

### Point Only

The slash fires once when the pointing gesture is detected.

### Sensitivity

Lower values make movement easier to trigger.

Higher values require a faster/larger movement.

## Important

The camera stays in the browser. This project does not upload camera frames to a server.

The MediaPipe runtime is loaded from jsDelivr using @mediapipe/tasks-vision 0.10.35, and the hand model is loaded from Google's MediaPipe model hosting.

## Customize the effect

Replace:

```text
assets/horizontal.png
assets/vertical.png
```

with your own transparent PNG effects.

The animation itself is controlled in `spawnSlash()` inside `app.js`.

## License

Code in this repository is provided as an example project. Replace this section with the license you want for your repository.


## Hand tracking overlay

The camera view now draws the detected hand landmarks and a smoothed ring around the index fingertip.
The ring helps you see exactly what MediaPipe is tracking. The slash is spawned at the tracked fingertip instead of always appearing in the center.


## Performance profile

The browser version is intentionally tuned for laptops:
- 640x480 preferred camera input
- maximum camera frame rate of 30 FPS
- hand inference capped at about 18 FPS
- one detected hand
- lightweight hand overlay
- maximum 18 simultaneous particles
- maximum 3 simultaneous slash images

This keeps the effect responsive without continuously pushing the CPU/GPU at full load.


## v3 gesture fix

This version fixes two bugs:
1. The combo HUD elements now exist, so triggering a slash cannot crash on a missing DOM element.
2. Pointing detection uses finger-joint angles instead of wrist-distance heuristics, making it much less likely to get stuck.

Swipe detection uses the smoothed index fingertip position and screen-space movement. The effect still uses a lightweight 640x480 camera and roughly 16 FPS hand inference.


## v5 feel / impact update

- Live fingertip movement leaves a short fading motion streak.
- Slash animation lasts longer so it is easier to perceive.
- Slash activation has an impact ring, brief flash, small shards, and a tiny screen response.
- Hand inference is raised from ~16 FPS to ~20 FPS for better responsiveness while keeping the one-hand / 640x480 lightweight profile.


## v8 Domain Expansion

Open-palm hold activates a 5-second Domain Expansion. While active, the page automatically creates randomized horizontal, vertical, and diagonal Dismantle slashes around the camera view. The domain uses lightweight CSS/DOM effects and keeps the normal slash/particle caps.


Domain activation is now a deliberate ~1.2 second open-palm hold, keeping it between the requested 1–2 second range.


## v10 gesture reliability fix

- Fist recognition now uses tolerant finger-folding checks.
- Fist recharge is time-based, so it does not depend on camera/inference FPS.
- Open-palm Domain activation is held for ~1.2 seconds and remains active for 5 seconds.
- Domain random slash effects have a higher temporary slash cap.
- Gesture status text clearly reports fist recharge and domain activation progress.


## v11 gesture layout

- ✊ One fist: fastest energy recharge.
- 🖐️ One open palm held ~0.8s: RCT, a 4-second energy restoration state.
- 🖐️🖐️ Two open palms held ~1.2s: Domain Expansion.
- ☝️ Point + swipe: Dismantle.
MediaPipe now tracks up to two hands so Domain Expansion can use the two-hand gesture.


## v12 HP + RCT

- Added a 100-point HP bar beside Energy.
- RCT restores HP over its 4-second duration, plus a smaller amount of Energy.
- Added a `Test Damage` button so RCT can be tested immediately.
- HP and Energy are capped at 100.
