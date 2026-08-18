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
const overlayCtx = handOverlay.getContext("2d");
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
let previousTip = null;
let previousTipTime = 0;
let previousDirection = null;
let smoothedTip = null;
let lastDetectionTime = 0;
let lastSlashTime = 0;
let combo = 0;
let comboTimer = 0;
let energy = 100;

const COOLDOWN_MS = 500;
const DETECTION_INTERVAL_MS = 60; // ~16 FPS hand inference
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
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55
  });
}

async function startCamera() {
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
  setStatus("Camera ready — show one hand");

  resizeOverlay();
  requestAnimationFrame(detectLoop);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angle(a, b, c) {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;

  const dot = abx * cbx + aby * cby;
  const mag = Math.hypot(abx, aby) * Math.hypot(cbx, cby);

  if (!mag) return 180;
  return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
}

/*
  More reliable pointing test:
  - index finger is mostly straight
  - middle/ring/pinky are bent
  This avoids the old wrist-distance test getting "stuck".
*/
function isPointing(hand) {
  const indexStraight =
    angle(hand[5], hand[6], hand[8]) > 155;

  const middleBent =
    angle(hand[9], hand[10], hand[12]) < 145;

  const ringBent =
    angle(hand[13], hand[14], hand[16]) < 145;

  const pinkyBent =
    angle(hand[17], hand[18], hand[20]) < 145;

  return indexStraight && middleBent && ringBent && pinkyBent;
}

function getDirection(dx, dy) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  if (ax > ay * 1.35) return "horizontal";
  if (ay > ax * 1.35) return "vertical";

  return dy < 0 ? "diagonal-up" : "diagonal-down";
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

  // Camera is mirrored with CSS, so mirror X here too.
  return {
    x: (1 - landmark.x) * shownW - cropX,
    y: landmark.y * shownH - cropY
  };
}

function smoothPoint(point) {
  if (!smoothedTip) {
    smoothedTip = { ...point };
    return smoothedTip;
  }

  // Enough smoothing to reduce jitter without making the slash lag.
  smoothedTip.x += (point.x - smoothedTip.x) * 0.55;
  smoothedTip.y += (point.y - smoothedTip.y) * 0.55;

  return smoothedTip;
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

  overlayCtx.strokeStyle = "rgba(255,255,255,0.42)";
  overlayCtx.lineWidth = 1.5;
  overlayCtx.beginPath();

  for (const [a, b] of connections) {
    overlayCtx.moveTo(points[a].x, points[a].y);
    overlayCtx.lineTo(points[b].x, points[b].y);
  }

  overlayCtx.stroke();

  // Fingertip + wrist + finger bases only: low rendering cost.
  for (const i of [0, 5, 8, 9, 13, 17]) {
    const p = points[i];

    overlayCtx.beginPath();
    overlayCtx.arc(p.x, p.y, i === 8 ? 5 : 3, 0, Math.PI * 2);
    overlayCtx.fillStyle = "#fff";
    overlayCtx.fill();
  }

  const tip = smoothPoint(points[8]);

  overlayCtx.beginPath();
  overlayCtx.arc(tip.x, tip.y, 13, 0, Math.PI * 2);
  overlayCtx.strokeStyle = "rgba(255,255,255,0.95)";
  overlayCtx.lineWidth = 2.5;
  overlayCtx.stroke();

  return tip;
}

function clearTracking() {
  const rect = video.getBoundingClientRect();
  overlayCtx.clearRect(0, 0, rect.width, rect.height);
  smoothedTip = null;
  previousTip = null;
  previousTipTime = 0;
}

function screenToPercent(point) {
  const rect = video.getBoundingClientRect();

  return {
    x: Math.max(0, Math.min(100, point.x / rect.width * 100)),
    y: Math.max(0, Math.min(100, point.y / rect.height * 100))
  };
}

function updateEnergy() {
  if (energyBar) {
    energyBar.style.transform = `scaleX(${energy / 100})`;
  }
}

function addCombo() {
  const now = performance.now();

  if (now - comboTimer > COMBO_WINDOW_MS) {
    combo = 0;
  }

  combo += 1;
  comboTimer = now;

  if (comboEl) comboEl.textContent = combo;

  energy = Math.min(100, energy + 5);
  updateEnergy();
}

function spawnParticles(point) {
  if (!point) return;

  const existing = slashLayer.querySelectorAll(".particle").length;
  if (existing >= MAX_PARTICLES) return;

  const pos = screenToPercent(point);

  for (let i = 0; i < 5; i++) {
    const p = document.createElement("span");
    p.className = "particle";
    p.style.left = `${pos.x}%`;
    p.style.top = `${pos.y}%`;
    p.style.setProperty("--dx", `${(Math.random() - 0.5) * 90}px`);
    p.style.setProperty("--dy", `${(Math.random() - 0.5) * 90}px`);

    slashLayer.appendChild(p);
    setTimeout(() => p.remove(), 380);
  }
}

function spawnSlash(direction, point) {
  const existing = slashLayer.querySelectorAll(".slash").length;
  if (existing >= 3) return;

  const img = document.createElement("img");
  img.className = "slash";

  img.src =
    direction === "vertical"
      ? VERTICAL_ASSET
      : HORIZONTAL_ASSET;

  img.alt = "";

  if (point) {
    const pos = screenToPercent(point);
    img.style.left = `${pos.x}%`;
    img.style.top = `${pos.y}%`;
  }

  const angle =
    direction === "diagonal-up"
      ? -25
      : direction === "diagonal-down"
        ? 25
        : 0;

  img.style.width =
    direction === "vertical"
      ? "min(58vh, 850px)"
      : "min(86vw, 1150px)";

  slashLayer.appendChild(img);

  const base = `translate(-50%, -50%) rotate(${angle}deg)`;

  // Explicitly animate from invisible to visible to invisible.
  const animation = img.animate(
    [
      {
        opacity: 0,
        transform: `${base} scale(.72)`,
        filter: "contrast(1.15) blur(2px)"
      },
      {
        opacity: 1,
        transform: `${base} scale(1)`,
        filter: "contrast(1.2) blur(0)"
      },
      {
        opacity: 1,
        transform: `${base} scale(1.04)`,
        filter: "contrast(1.15) blur(0)"
      },
      {
        opacity: 0,
        transform: `${base} scale(1.10)`,
        filter: "contrast(1.1) blur(1px)"
      }
    ],
    {
      duration: 360,
      easing: "cubic-bezier(.16,.8,.24,1)",
      fill: "forwards"
    }
  );

  animation.finished
    .catch(() => {})
    .finally(() => img.remove());
}

function triggerSlash(direction, point) {
  if (energy < 8) {
    setStatus("Energy low — wait a moment");
    return;
  }

  energy -= 8;
  updateEnergy();
  addCombo();

  spawnParticles(point);
  spawnSlash(direction, point);

  lastSlashTime = performance.now();
}

function processResults(results) {
  if (!results?.landmarks?.length) {
    clearTracking();
    setStatus("No hand detected");
    return;
  }

  const hand = results.landmarks[0];
  const tip = drawHandTracking(hand);
  const pointing = isPointing(hand);

  const now = performance.now();

  if (!previousTip) {
    previousTip = { ...tip };
    previousTipTime = now;
    setStatus(pointing ? "POINTING — move to slash" : "Hand detected — point");
    return;
  }

  const dt = Math.max(16, now - previousTipTime);
  const dx = tip.x - previousTip.x;
  const dy = tip.y - previousTip.y;

  previousTip = { ...tip };
  previousTipTime = now;

  const movementPx = Math.hypot(dx, dy);
  const diagonal = Math.max(video.clientWidth, video.clientHeight);
  const movementRatio = movementPx / Math.max(1, diagonal);
  const speed = movementPx / dt;

  if (!pointing) {
    setStatus("Hand detected — point your index finger");
    return;
  }

  setStatus("POINTING — swipe now");

  if (gestureModeEl.value === "point") {
    if (now - lastSlashTime > COOLDOWN_MS) {
      triggerSlash("horizontal", tip);
    }
    return;
  }

  const sensitivity = Number(sensitivityEl.value);

  // Threshold is based on the visible screen, not normalized landmark
  // coordinates, so it behaves consistently on different screen sizes.
  if (
    movementRatio >= sensitivity &&
    speed >= 0.35 &&
    now - lastSlashTime > COOLDOWN_MS
  ) {
    const direction = getDirection(dx, dy);

    // Prevent the same direction from firing repeatedly because of tiny
    // tracking oscillations.
    if (movementRatio >= sensitivity * 1.25 || direction !== previousDirection) {
      previousDirection = direction;
      triggerSlash(direction, tip);
    }
  }
}

function detectLoop(now) {
  if (!running || !handLandmarker) return;

  if (
    video.readyState >= 2 &&
    video.currentTime !== lastVideoTime &&
    now - lastDetectionTime >= DETECTION_INTERVAL_MS
  ) {
    lastVideoTime = video.currentTime;
    lastDetectionTime = now;

    try {
      const results = handLandmarker.detectForVideo(video, now);
      processResults(results);
    } catch (error) {
      console.error("Hand detection error:", error);
      setStatus("Hand tracking error — see Console");
    }
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
  const directions = [
    "horizontal",
    "vertical",
    "diagonal-up",
    "diagonal-down"
  ];

  const rect = video.getBoundingClientRect();

  triggerSlash(
    directions[Math.floor(Math.random() * directions.length)],
    {
      x: rect.width * 0.5,
      y: rect.height * 0.5
    }
  );
});

window.addEventListener("resize", resizeOverlay);
updateEnergy();
