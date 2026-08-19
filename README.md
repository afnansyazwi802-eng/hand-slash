# Hand Slash — Fixed Dismantle VFX

This build fixes the broken interaction in the previous ZIP.

## Important fixes
- Uses the supplied `assets/dismantle-vfx.png` as the **only** Dismantle slash VFX.
- Removed the old `horizontal.png`, `vertical.png`, and other unused slash assets.
- Restored actual webcam hand tracking with MediaPipe Hands.
- The slash is spawned at the **visible index-finger position** when the swipe is detected.
- The slash image is drawn from its **center**, not from its tip/end.
- After spawning, the slash is completely fixed in world/screen position. It does **not** follow the finger.
- Swipe direction controls the slash rotation through the full 360°.
- One slash per swipe, with a short cooldown to prevent accidental double-spawns.
- The VFX is clamped so its center cannot be spawned outside the visible screen.
- `Test Slash` gives a reliable way to test the VFX without the camera.
- `Hide`/`SHOW` controls are restored.
- Energy is 300 max and costs 12 per slash.
- Fist gives a deliberately medium-speed recharge.
- Open palm performs RCT while held; RCT stops as soon as the open-palm gesture disappears.
- RCT consumes energy and heals HP.
- Two hands held near each other for about 0.85s activate Domain Expansion, which lasts 5 seconds.
- Domain slashes are also fixed after spawning.
- Camera processing is capped around 24 FPS and uses MediaPipe's lighter model (`modelComplexity: 0`) to keep an i5 laptop comfortable.

## GitHub Pages
Upload the contents of this folder to the repository root and make sure GitHub Pages publishes `main` → `/ (root)`.

The browser must be allowed to load the MediaPipe library from jsDelivr, so an internet connection is required for hand tracking.

## If the page still shows an old version
GitHub Pages/browser caching can keep an older JavaScript file. Do a hard refresh:
- Windows/Chrome: `Ctrl + Shift + R`
- If necessary, open the GitHub Pages URL in an Incognito window.
