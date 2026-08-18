import {
  FilesetResolver,
  HandLandmarker
} from "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const WASM_URL =
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/wasm";

const video = document.querySelector("#camera");
const startBtn = document.querySelector("#startBtn");
const demoBtn = document.querySelector("#demoBtn");
const statusEl = document.querySelector("#status");
const slashLayer = document.querySelector("#slashLayer");
const sensitivityEl = document.querySelector("#sensitivity");
const gestureModeEl = document.querySelector("#gestureMode");

const HORIZONTAL_ASSET = "./assets/horizontal.png";
const VERTICAL_ASSET = "./assets/vertical.png";

let handLandmarker = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let previousWrist = null;
let lastGestureTime = 0;
let gestureArmed = true;
let lastPointing = false;

const COOLDOWN_MS = 520;

function setStatus(text) {
  statusEl.textContent = text;
}

async function createHandLandmarker() {
  setStatus("Loading hand tracker…");

  const vision = await FilesetResolver.forVisionTasks(WASM_URL);

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL
    },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access is not available in this browser.");
  }

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  video.srcObject = stream;
  await video.play();

  running = true;
  startBtn.disabled = true;
  demoBtn.disabled = false;
  setStatus("Camera ready — point + move");

  requestAnimationFrame(detectLoop);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/*
  MediaPipe hand landmarks:
  0 wrist
  4 thumb tip
  5 index MCP
  6 index PIP
  8 index tip
  9 middle MCP
  10 middle PIP
  12 middle tip
  13 ring MCP
  14 ring PIP
  16 ring tip
  17 pinky MCP
  18 pinky PIP
  20 pinky tip
*/

function fingerExtended(hand, tip, pip, mcp) {
  const wrist = hand[0];
  const tipToWrist = distance(hand[tip], wrist);
  const pipToWrist = distance(hand[pip], wrist);
  const mcpToWrist = distance(hand[mcp], wrist);

  return tipToWrist > pipToWrist * 1.08 &&
         tipToWrist > mcpToWrist * 1.15;
}

function isPointing(hand) {
  const indexExtended = fingerExtended(hand, 8, 6, 5);
  const middleExtended = fingerExtended(hand, 12, 10, 9);
  const ringExtended = fingerExtended(hand, 16, 14, 13);
  const pinkyExtended = fingerExtended(hand, 20, 18, 17);

  return indexExtended && !middleExtended && !ringExtended && !pinkyExtended;
}

function getMovement(hand) {
  const wrist = hand[0];

  if (!previousWrist) {
    previousWrist = { x: wrist.x, y: wrist.y };
    return { dx: 0, dy: 0, amount: 0 };
  }

  const dx = wrist.x - previousWrist.x;
  const dy = wrist.y - previousWrist.y;

  previousWrist = { x: wrist.x, y: wrist.y };

  return {
    dx,
    dy,
    amount: Math.hypot(dx, dy)
  };
}

function getDirection(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  if (ax > ay * 1.45) {
    return "horizontal";
  }

  if (ay > ax * 1.45) {
    return "vertical";
  }

  // A diagonal is made by rotating the horizontal slash.
  return dx * dy < 0 ? "diagonal-up" : "diagonal-down";
}

function shouldTrigger(pointing, movement) {
  const now = performance.now();

  if (now - lastGestureTime < COOLDOWN_MS) {
    return false;
  }

  if (!pointing) {
    gestureArmed = true;
    return false;
  }

  if (!gestureArmed) {
    return false;
  }

  if (gestureModeEl.value === "point") {
    gestureArmed = false;
    return true;
  }

  const threshold = Number(sensitivityEl.value);

  if (movement.amount >= threshold) {
    gestureArmed = false;
    return true;
  }

  return false;
}

function spawnSlash(direction, dx = 0, dy = 0) {
  const img = document.createElement("img");
  img.className = "slash";

  if (direction === "vertical") {
    img.src = VERTICAL_ASSET;
  } else {
    img.src = HORIZONTAL_ASSET;
  }

  const angle =
    direction === "diagonal-up"
      ? -25
      : direction === "diagonal-down"
        ? 25
        : 0;

  const scale =
    direction === "vertical"
      ? 0.78
      : 1;

  const startScale = direction === "vertical"
    ? 0.72
    : 0.72;

  img.style.width = direction === "vertical"
    ? "min(58vh, 900px)"
    : "min(86vw, 1200px)";

  slashLayer.appendChild(img);

  const baseTransform =
    `translate(-50%, -50%) rotate(${angle}deg)`;

  const finalTransform =
    `translate(-50%, -50%) rotate(${angle}deg) scale(${scale})`;

  img.animate(
    [
      {
        opacity: 0,
        transform: `${baseTransform} scale(${startScale})`,
        filter: "contrast(1.05) blur(2px)"
      },
      {
        opacity: 1,
        transform: `${baseTransform} scale(1.02)`,
        filter: "contrast(1.2) blur(0)"
      },
      {
        opacity: 1,
        transform: finalTransform,
        filter: "contrast(1.12) blur(0)"
      },
      {
        opacity: 0,
        transform: `${baseTransform} scale(1.08)`,
        filter: "contrast(1.1) blur(1px)"
      }
    ],
    {
      duration: 360,
      easing: "cubic-bezier(.16,.8,.24,1)",
      fill: "forwards"
    }
  );

  setTimeout(() => img.remove(), 420);
  lastGestureTime = performance.now();
}

function triggerSlash(direction = "horizontal") {
  spawnSlash(direction);
}

function processResults(results) {
  if (!results?.landmarks?.length) {
    previousWrist = null;
    lastPointing = false;
    setStatus("No hand detected");
    return;
  }

  const hand = results.landmarks[0];
  const pointing = isPointing(hand);
  const movement = getMovement(hand);

  if (pointing) {
    setStatus("POINTING — move to slash");
  } else {
    setStatus("Hand detected — point your index finger");
  }

  if (shouldTrigger(pointing, movement)) {
    const direction = getDirection(movement.dx, movement.dy);
    triggerSlash(direction);
  }

  lastPointing = pointing;
}

function detectLoop() {
  if (!running || !handLandmarker) return;

  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;

    const results = handLandmarker.detectForVideo(
      video,
      performance.now()
    );

    processResults(results);
  }

  requestAnimationFrame(detectLoop);
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;

  try {
    await createHandLandmarker();
    await startCamera();
  } catch (error) {
    console.error(error);
    startBtn.disabled = false;
    setStatus(`Error: ${error.message}`);
  }
});

demoBtn.addEventListener("click", () => {
  const directions = ["horizontal", "vertical", "diagonal-up", "diagonal-down"];
  const direction =
    directions[Math.floor(Math.random() * directions.length)];

  triggerSlash(direction);
});
