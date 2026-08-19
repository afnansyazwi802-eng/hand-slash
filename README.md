# Hand Slash v31 — 2-Hand Tracking + RCT + Domain VFX

This version fixes the gesture feedback and skill logic.

- MediaPipe Hands detects up to 2 hands.
- Full hand landmarks/skeleton are drawn on the camera overlay.
- Pointing index + movement fires one fixed Dismantle slash.
- Fist recharges Energy at a medium speed.
- Open palm activates RCT at the palm, consumes Energy, and restores HP. RCT stops immediately when the palm closes/disappears.
- Two visible hands for about 0.5 seconds activates Domain Expansion.
- Domain runs for 5 seconds and continuously spawns random Dismantle slashes at random positions/directions.
- The current `dismantle-vfx.png` is the only slash VFX.
- Tracking uses MediaPipe modelComplexity 0 and a 960x540 ideal camera stream for lighter laptop usage.

GitHub Pages must be served over HTTPS and the browser must have camera permission.
