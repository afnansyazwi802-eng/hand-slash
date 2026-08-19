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
