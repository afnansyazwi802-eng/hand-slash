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
const domainBtn = document.querySelector("#domainBtn");
const domainLayer = document.querySelector("#domainLayer");
const statusEl = document.querySelector("#status");
const slashLayer = document.querySelector("#slashLayer");
const gestureFx = document.querySelector("#gestureFx");
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
let domainHoldStart = 0;
let lastDomainTime = 0;
let lastFistRecharge = 0;
let domainActive = false;

const COOLDOWN_MS = 500;
const DETECTION_INTERVAL_MS = 50; // ~20 FPS hand inference: still light, but more responsive
const COMBO_WINDOW_MS = 1800;
const MAX_PARTICLES = 18;
const DOMAIN_COST = 40;
const DOMAIN_HOLD_MS = 700;
const DOMAIN_COOLDOWN_MS = 6500;
const FIST_RECHARGE_INTERVAL_MS = 120;
const FIST_RECHARGE_AMOUNT = 8;

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
  domainBtn.disabled = false;
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

function isFist(hand) {
  const indexBent = angle(hand[5], hand[6], hand[8]) < 135;
  const middleBent = angle(hand[9], hand[10], hand[12]) < 135;
  const ringBent = angle(hand[13], hand[14], hand[16]) < 135;
  const pinkyBent = angle(hand[17], hand[18], hand[20]) < 135;

  // Thumb folded inward: thumb tip should be closer to the palm center.
  const palmCenter = hand[9];
  const thumbFolded = distance(hand[4], palmCenter) < distance(hand[2], palmCenter) * 1.15;

  return indexBent && middleBent && ringBent && pinkyBent && thumbFolded;
}

function isOpenPalm(hand) {
  const indexStraight = angle(hand[5], hand[6], hand[8]) > 150;
  const middleStraight = angle(hand[9], hand[10], hand[12]) > 150;
  const ringStraight = angle(hand[13], hand[14], hand[16]) > 150;
  const pinkyStraight = angle(hand[17], hand[18], hand[20]) > 150;

  return indexStraight && middleStraight && ringStraight && pinkyStraight;
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

function drawMotionStreak(from, to) {
  if (!from || !to || !gestureFx) return;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  // Ignore tiny tracking jitter.
  if (length < 5) return;

  const rect = video.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, from.x));
  const y = Math.max(0, Math.min(rect.height, from.y));

  const streak = document.createElement("span");
  streak.className = "motion-streak";
  streak.style.left = `${x}px`;
  streak.style.top = `${y}px`;
  streak.style.width = `${Math.min(length * 1.8, 150)}px`;
  streak.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;

  gestureFx.appendChild(streak);
  setTimeout(() => streak.remove(), 240);
}

function spawnImpact(point, direction) {
  if (!gestureFx || !point) return;

  const pos = screenToPercent(point);

  const ring = document.createElement("span");
  ring.className = "impact-ring";
  ring.style.left = `${pos.x}%`;
  ring.style.top = `${pos.y}%`;
  gestureFx.appendChild(ring);
  setTimeout(() => ring.remove(), 520);

  const flash = document.createElement("span");
  flash.className = "impact-flash";
  gestureFx.appendChild(flash);
  setTimeout(() => flash.remove(), 180);

  // A few restrained shards give the slash a physical "hit".
  for (let i = 0; i < 5; i++) {
    const shard = document.createElement("span");
    shard.className = "impact-shard";
    shard.style.left = `${pos.x}%`;
    shard.style.top = `${pos.y}%`;

    let a = Math.random() * 360;
    if (direction === "horizontal") a += 0;
    if (direction === "vertical") a += 90;

    shard.style.setProperty("--angle", `${a}deg`);
    shard.style.setProperty("--distance", `${35 + Math.random() * 55}px`);
    gestureFx.appendChild(shard);
    setTimeout(() => shard.remove(), 560);
  }

  // Very short screen response, not a constant animation.
  document.body.classList.remove("impact-shake");
  void document.body.offsetWidth;
  document.body.classList.add("impact-shake");
  setTimeout(() => document.body.classList.remove("impact-shake"), 160);
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

function spawnSlash(direction, point, demo = false) {
  const existing = slashLayer.querySelectorAll(".slash, .slash-fallback").length;
  if (existing >= 3 && !demo) return;

  const pos = point
    ? screenToPercent(point)
    : { x: 50, y: 50 };

  const angle =
    direction === "diagonal-up"
      ? -25
      : direction === "diagonal-down"
        ? 25
        : 0;

  const src =
    direction === "vertical"
      ? VERTICAL_ASSET
      : HORIZONTAL_ASSET;

  const img = document.createElement("img");
  img.className = "slash";
  img.alt = "";
  img.src = src;

  img.style.left = `${pos.x}%`;
  img.style.top = `${pos.y}%`;
  img.style.width =
    direction === "vertical"
      ? "min(58vh, 850px)"
      : "min(86vw, 1150px)";

  const base = `translate(-50%, -50%) rotate(${angle}deg)`;

  let finished = false;

  const remove = () => {
    if (finished) return;
    finished = true;
    img.remove();
  };

  img.onerror = () => {
    console.warn("Slash image failed to load:", src);

    // Never leave the user with a blank effect.
    img.remove();

    const fallback = document.createElement("div");
    fallback.className = "slash-fallback";

    fallback.style.left = `${pos.x}%`;
    fallback.style.top = `${pos.y}%`;

    if (direction === "vertical") {
      fallback.style.width = "8px";
      fallback.style.height = "min(65vh, 850px)";
    } else {
      fallback.style.width = "min(72vw, 900px)";
      fallback.style.height = "8px";
    }

    fallback.style.transform =
      `translate(-50%, -50%) rotate(${angle}deg) scale(.7)`;

    slashLayer.appendChild(fallback);

    const animation = fallback.animate(
      [
        { opacity: 0, transform: `translate(-50%, -50%) rotate(${angle}deg) scale(.7)` },
        { opacity: 1, transform: `translate(-50%, -50%) rotate(${angle}deg) scale(1)` },
        { opacity: 0, transform: `translate(-50%, -50%) rotate(${angle}deg) scale(1.08)` }
      ],
      {
        duration: demo ? 1000 : 620,
        easing: "ease-out",
        fill: "forwards"
      }
    );

    animation.finished.catch(() => {}).finally(() => fallback.remove());
  };

  slashLayer.appendChild(img);

  /*
    IMPORTANT:
    Wait until the PNG is loaded before starting the fade animation.
    This prevents the animation from finishing while the browser is
    still downloading the image.
  */
  const animateImage = () => {
    if (finished) return;

    img.animate(
      [
        {
          opacity: 0,
          transform: `${base} scale(.70)`,
          filter: "contrast(1.1) blur(3px)"
        },
        {
          opacity: 1,
          transform: `${base} scale(1)`,
          filter: "contrast(1.3) blur(0)"
        },
        {
          opacity: 1,
          transform: `${base} scale(1.04)`,
          filter: "contrast(1.2) blur(0)"
        },
        {
          opacity: 0,
          transform: `${base} scale(1.10)`,
          filter: "contrast(1.1) blur(1px)"
        }
      ],
      {
        duration: demo ? 1000 : 620,
        easing: "cubic-bezier(.16,.8,.24,1)",
        fill: "forwards"
      }
    ).finished
      .catch(() => {})
      .finally(remove);
  };

  if (img.complete && img.naturalWidth > 0) {
    animateImage();
  } else {
    img.onload = animateImage;
  }
}

function triggerSlash(direction, point, demo = false) {
  // Test Slash must always work, regardless of energy.
  if (!demo) {
    if (energy < 8) {
      setStatus("Energy low — wait a moment");
      return;
    }

    energy -= 8;
    updateEnergy();
    addCombo();
  }

  const impactPoint = point || {
    x: video.clientWidth / 2,
    y: video.clientHeight / 2
  };

  spawnParticles(impactPoint);
  spawnImpact(impactPoint, direction);
  spawnSlash(direction, impactPoint, demo);
  lastSlashTime = performance.now();
}


function rechargeWithFist(now) {
  if (now - lastFistRecharge < FIST_RECHARGE_INTERVAL_MS) return;

  lastFistRecharge = now;
  const before = energy;
  energy = Math.min(100, energy + FIST_RECHARGE_AMOUNT);

  if (energy !== before) {
    updateEnergy();
    setStatus(`FIST — ENERGY +${energy - before}`);
  } else {
    setStatus("FIST — ENERGY FULL");
  }
}

function spawnDomainExpansion() {
  if (!domainLayer || domainActive) return;
  if (energy < DOMAIN_COST) {
    setStatus("Not enough energy for Domain Expansion");
    return;
  }

  energy -= DOMAIN_COST;
  updateEnergy();
  domainActive = true;
  lastDomainTime = performance.now();
  setStatus("DOMAIN EXPANSION");

  const overlay = document.createElement("div");
  overlay.className = "domain-overlay";
  domainLayer.appendChild(overlay);

  const ring = document.createElement("div");
  ring.className = "domain-ring";
  domainLayer.appendChild(ring);

  const mark = document.createElement("div");
  mark.className = "domain-mark";
  domainLayer.appendChild(mark);

  const title = document.createElement("div");
  title.className = "domain-title";
  title.textContent = "DOMAIN EXPANSION";
  domainLayer.appendChild(title);

  for (let i = 0; i < 10; i++) {
    const shard = document.createElement("span");
    shard.className = "domain-shard";
    shard.style.setProperty("--angle", `${i * 36 + Math.random() * 12}deg`);
    shard.style.setProperty("--distance", `${90 + Math.random() * 180}px`);
    domainLayer.appendChild(shard);
    setTimeout(() => shard.remove(), 900);
  }

  // Keep the effect short and lightweight: roughly 1.2 seconds total.
  setTimeout(() => {
    overlay.remove();
    ring.remove();
    mark.remove();
    title.remove();
    domainActive = false;
    setStatus("DOMAIN COMPLETE — show your hand");
  }, 1250);
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
  const fist = isFist(hand);
  const openPalm = isOpenPalm(hand);

  const now = performance.now();

  // Fist is the fastest energy-recharge state.
  if (fist) {
    rechargeWithFist(now);
    previousTip = { ...tip };
    previousTipTime = now;
    return;
  }

  // Hold an open palm to charge and release Domain Expansion.
  if (openPalm && !pointing) {
    if (!domainHoldStart) domainHoldStart = now;

    const held = now - domainHoldStart;
    if (held >= DOMAIN_HOLD_MS && now - lastDomainTime > DOMAIN_COOLDOWN_MS) {
      spawnDomainExpansion();
      domainHoldStart = 0;
    } else {
      const remaining = Math.max(0, DOMAIN_HOLD_MS - held);
      setStatus(`OPEN PALM — DOMAIN ${Math.ceil(remaining / 100) / 10}s`);
    }

    previousTip = { ...tip };
    previousTipTime = now;
    return;
  }

  domainHoldStart = 0;

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

  // This is the "live" part: every detected hand movement leaves a tiny
  // fading trace, so the user can feel that the system is following them.
  if (pointing && movementPx >= 5) {
    drawMotionStreak(previousTip, tip);
  }

  if (!pointing) {
    setStatus("Hand detected — point your index finger");
    return;
  }

  setStatus("POINTING — swipe now");

  if (gestureModeEl.value === "point") {
    if (now - lastSlashTime > 700) {
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

domainBtn.addEventListener("click", () => {
  spawnDomainExpansion();
});

demoBtn.addEventListener("click", () => {
  const directions = [
    "horizontal",
    "vertical",
    "diagonal-up",
    "diagonal-down"
  ];

  const rect = video.getBoundingClientRect();

  setStatus("TEST SLASH!");

  triggerSlash(
    directions[Math.floor(Math.random() * directions.length)],
    {
      x: rect.width * 0.5,
      y: rect.height * 0.5
    },
    true
  );
});

window.addEventListener("resize", resizeOverlay);
updateEnergy();
