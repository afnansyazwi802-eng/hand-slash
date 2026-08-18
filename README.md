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

The MediaPipe model and runtime are loaded from Google's MediaPipe model hosting and jsDelivr.

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
