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
const handOverlay = document.querySelector("#handOverlay");
const overlayCtx = handOverlay.getContext("2d", { alpha: true });
const sensitivityEl = document.querySelector("#sensitivity");
const gestureModeEl = document.querySelector("#gestureMode");
const comboEl = document.querySelector("#combo");
const energyBar = document.querySelector("#energyBar i");

const HORIZONTAL_ASSET = "./assets/horizontal.png";
const VERTICAL_ASSET = "./assets/vertical.png";

let handLandmarker = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let previousPoint = null;
let previousPointTime = 0;
let lastGestureTime = 0;
let gestureArmed = true;
let smoothedPoint = null;
let lastDetectionTime = 0;
let combo = 0;
let comboTimer = 0;
let energy = 100;
let lastFrameTime = 0;

const COOLDOWN_MS = 430;
const DETECTION_INTERVAL_MS = 55; // ~18 FPS: much lighter than processing every camera frame.
const COMBO_WINDOW_MS = 1800;
const MAX_PARTICLES = 18;

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
    minHandDetectionConfidence: 0.58,
    minHandPresenceConfidence: 0.58,
    minTrackingConfidence: 0.58
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access is not available in this browser.");
  }

  // 640x480 is deliberately used to keep CPU/GPU load low.
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 640, max: 960 },
      height: { ideal: 480, max: 720 },
      frameRate: { ideal: 24, max: 30 }
    },
    audio: false
  });

  video.srcObject = stream;
  await video.play();

  running = true;
  startBtn.disabled = true;
  demoBtn.disabled = false;
  setStatus("Camera ready — point + move");

  resizeOverlay();
  requestAnimationFrame(detectLoop);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

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

function getDirection(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  if (ax > ay * 1.45) return "horizontal";
  if (ay > ax * 1.45) return "vertical";
  return dx * dy < 0 ? "diagonal-up" : "diagonal-down";
}

function updateCombo() {
  const now = performance.now();

  if (now - comboTimer > COMBO_WINDOW_MS) {
    combo = 0;
  }

  combo += 1;
  comboTimer = now;
  comboEl.textContent = combo;

  // Small energy reward, capped at 100.
  energy = Math.min(100, energy + 8);
  updateEnergy();
}

function updateEnergy() {
  energyBar.style.transform = `scaleX(${energy / 100})`;
}

function drainEnergy(amount) {
  energy = Math.max(0, energy - amount);
  updateEnergy();
}

function shouldTrigger(pointing, movement) {
  const now = performance.now();

  if (now - lastGestureTime < COOLDOWN_MS) return false;

  if (!pointing) {
    gestureArmed = true;
    return false;
  }

  if (!gestureArmed) return false;

  if (gestureModeEl.value === "point") {
    gestureArmed = false;
    return true;
  }

  const threshold = Number(sensitivityEl.value);

  // Require a real swipe rather than tiny camera jitter.
  if (movement.amount >= threshold && movement.speed >= 0.0015) {
    gestureArmed = false;
    return true;
  }

  return false;
}

function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

  handOverlay.width = Math.max(1, Math.round(rect.width * dpr));
  handOverlay.height = Math.max(1, Math.round(rect.height * dpr));
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function videoPointToScreen(landmark) {
  const rect = video.getBoundingClientRect();
  const videoW = video.videoWidth || 640;
  const videoH = video.videoHeight || 480;

  const scale = Math.max(rect.width / videoW, rect.height / videoH);
  const shownW = videoW * scale;
  const shownH = videoH * scale;
  const cropX = (shownW - rect.width) / 2;
  const cropY = (shownH - rect.height) / 2;

  return {
    x: (1 - landmark.x) * shownW - cropX,
    y: landmark.y * shownH - cropY
  };
}

function smoothPoint(point, amount = 0.48) {
  if (!smoothedPoint) {
    smoothedPoint = { ...point };
    return smoothedPoint;
  }

  smoothedPoint.x += (point.x - smoothedPoint.x) * amount;
  smoothedPoint.y += (point.y - smoothedPoint.y) * amount;

  return smoothedPoint;
}

function drawHandTracking(hand) {
  const rect = video.getBoundingClientRect();
  overlayCtx.clearRect(0, 0, rect.width, rect.height);

  const points = hand.map(videoPointToScreen);

  const connections = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],
    [0,17]
  ];

  overlayCtx.lineWidth = 1.5;
  overlayCtx.strokeStyle = "rgba(255,255,255,0.45)";
  overlayCtx.beginPath();

  for (const [a, b] of connections) {
    overlayCtx.moveTo(points[a].x, points[a].y);
    overlayCtx.lineTo(points[b].x, points[b].y);
  }

  overlayCtx.stroke();

  // Draw only the important landmarks to reduce canvas work.
  const important = [0, 5, 6, 7, 8, 9, 13, 17];

  overlayCtx.fillStyle = "rgba(255,255,255,0.9)";
  for (const i of important) {
    const p = points[i];
    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, i === 8 ? 5 : 3, 0, Math.PI * 2);
    overlayCtx.fill();
  }

  const tip = smoothPoint(points[8]);

  overlayCtx.beginPath();
  overlayCtx.arc(tip.x, tip.y, 12, 0, Math.PI * 2);
  overlayCtx.strokeStyle = "rgba(255,255,255,0.95)";
  overlayCtx.lineWidth = 2.5;
  overlayCtx.stroke();

  return tip;
}

function clearHandTracking() {
  const rect = video.getBoundingClientRect();
  overlayCtx.clearRect(0, 0, rect.width, rect.height);
  smoothedPoint = null;
  previousPoint = null;
}

function screenToPercent(point) {
  const rect = video.getBoundingClientRect();

  return {
    x: (point.x / rect.width) * 100,
    y: (point.y / rect.height) * 100
  };
}

function spawnParticles(point) {
  if (!point || slashLayer.childElementCount > MAX_PARTICLES) return;

  const pos = screenToPercent(point);

  for (let i = 0; i < 6; i++) {
    const p = document.createElement("span");
    p.className = "particle";
    p.style.left = `${pos.x}%`;
    p.style.top = `${pos.y}%`;
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 90}px`);
    p.style.setProperty("--dy", `${(Math.random() - 0.5) * 90}px`);
    slashLayer.appendChild(p);

    setTimeout(() => p.remove(), 360);
  }
}

function spawnSlash(direction, spawnPoint = null) {
  if (slashLayer.querySelectorAll(".slash").length >= 3) return;

  const img = document.createElement("img");
  img.className = "slash";

  img.src =
    direction === "vertical"
      ? VERTICAL_ASSET
      : HORIZONTAL_ASSET;

  const angle =
    direction === "diagonal-up"
      ? -25
      : direction === "diagonal-down"
        ? 25
        : 0;

  const scale = direction === "vertical" ? 0.78 : 1;

  img.style.width =
    direction === "vertical"
      ? "min(58vh, 900px)"
      : "min(86vw, 1200px)";

  if (spawnPoint) {
    const pos = screenToPercent(spawnPoint);
    img.style.left = `${pos.x}%`;
    img.style.top = `${pos.y}%`;
  }

  slashLayer.appendChild(img);

  const baseTransform =
    `translate(-50%, -50%) rotate(${angle}deg)`;

  const finalTransform =
    `translate(-50%, -50%) rotate(${angle}deg) scale(${scale})`;

  img.animate(
    [
      {
        opacity: 0,
        transform: `${baseTransform} scale(.72)`,
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
      duration: 330,
      easing: "cubic-bezier(.16,.8,.24,1)",
      fill: "forwards"
    }
  );

  setTimeout(() => img.remove(), 390);
  lastGestureTime = performance.now();
}

function triggerSlash(direction = "horizontal", spawnPoint = null) {
  if (energy < 8) return;

  drainEnergy(8);
  updateCombo();
  spawnParticles(spawnPoint);
  spawnSlash(direction, spawnPoint);
}

function processResults(results) {
  if (!results?.landmarks?.length) {
    clearHandTracking();
    setStatus("No hand detected");
    return;
  }

  const hand = results.landmarks[0];
  const indexScreenPoint = drawHandTracking(hand);
  const pointing = isPointing(hand);

  const now = performance.now();
  let movement = { dx: 0, dy: 0, amount: 0, speed: 0 };

  if (previousPoint) {
    const dt = Math.max(16, now - previousPointTime);
    const dx = indexScreenPoint.x - previousPoint.x;
    const dy = indexScreenPoint.y - previousPoint.y;

    movement = {
      dx,
      dy,
      amount: Math.hypot(dx, dy) / Math.max(video.clientWidth, video.clientHeight),
      speed: Math.hypot(dx, dy) / dt
    };
  }

  previousPoint = { ...indexScreenPoint };
  previousPointTime = now;

  if (pointing) {
    setStatus("POINTING — swipe your finger");
  } else {
    setStatus("Hand detected — point your index finger");
  }

  if (shouldTrigger(pointing, movement)) {
    const direction = getDirection(movement.dx, movement.dy);
    triggerSlash(direction, indexScreenPoint);
  }
}

function detectLoop(now) {
  if (!running || !handLandmarker) return;

  // Hard cap processing to about 18 detections/second.
  if (
    video.readyState >= 2 &&
    video.currentTime !== lastVideoTime &&
    now - lastDetectionTime >= DETECTION_INTERVAL_MS
  ) {
    lastVideoTime = video.currentTime;
    lastDetectionTime = now;

    const results = handLandmarker.detectForVideo(video, now);
    processResults(results);
  }

  requestAnimationFrame(detectLoop);
}

window.addEventListener("resize", resizeOverlay);

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
  const directions = [
    "horizontal",
    "vertical",
    "diagonal-up",
    "diagonal-down"
  ];

  triggerSlash(
    directions[Math.floor(Math.random() * directions.length)],
    {
      x: video.clientWidth * 0.5,
      y: video.clientHeight * 0.5
    }
  );
});

updateEnergy();
