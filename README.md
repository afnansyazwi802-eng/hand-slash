# Hand Slash v32 — Domain Priority Fix

## Gesture priority
- **2 hands:** Domain Expansion has priority and disables RCT/Dismantle while active.
- **Open palm (one hand):** RCT. Consumes Energy and restores HP.
- **Fist:** Medium-speed Energy recovery.
- **Point + move (one hand):** Dismantle.

## Domain
Two hands held for about 0.5 seconds activate Domain Expansion. It lasts 5 seconds and generates random fixed Dismantle slashes. RCT cannot activate at the same time.

## Files
- `app.js`
- `index.html`
- `style.css`
- `dismantle-vfx.png`
- `energy-recovery.webp`
- `favicon.svg`


### v34 changes
- Lower default Dismantle sensitivity (62px travel threshold).
- 420ms slash cooldown to reduce accidental repeated slashes.
- Added an adjustable Slash Sensitivity slider.
- Made Domain Expansion aura/title more visible while keeping the effect lightweight.


## v35 fixes
- Full two-hand MediaPipe tracking is retained.
- Dismantle takes a fixed snapshot of the fingertip position and direction, so the slash stays where it spawned.
- Higher default swipe threshold (75px) and 450ms cooldown reduce accidental slashes.
- Domain has priority over RCT, lasts 5 seconds, and has a visible dark aura/title overlay.
- RCT follows the palm only while active and stops when the open-palm gesture disappears.


## v36 startup fix
- `app.js` is an ES module and is now loaded with `type="module"` so Start Camera works again.
- Fixed HP/Energy element IDs to match the JavaScript.


## v37 slash render fix
The Dismantle VFX is now rendered on a dedicated canvas. The spawn coordinates and angle are snapshotted once, so the slash remains exactly where it is created and cannot drift with the hand or HTML layout.


## v38 slash unstuck
- Dismantle now has a hard 440ms lifetime.
- Render loop clears the effect canvas every frame.
- Dead slash states are force-removed every frame.
- Rendering no longer depends on a successful hand-detection frame.
- Fixed a `comboExpires is not defined` crash that killed the whole render loop after the first Dismantle slash. `comboExpires` is now declared and set on every landed slash, so combo correctly decays after a 2s timeout instead of throwing.

## v39 recharge energy VFX
- Added a red cursed-energy flame overlay (`energy-recovery.webp`, animated, real alpha) that plays anchored to the palm while Fist/recharge is active.
- Source GIF's baked-in checkerboard background was converted to true alpha transparency (alpha derived from per-pixel brightness) and hue-shifted from cyan to red.
- The effect fades in/out with the fist gesture and is force-hidden by `stopRCT()` in every state (Domain start, hands lost, energy depleted) so it can never get stuck on screen.
