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
const gestureFx = document.querySelector("#gestureFx");
const handOverlay = document.querySelector("#handOverlay");
const overlayCtx = handOverlay.getContext("2d");
const sensitivityEl = document.querySelector("#sensitivity");
const gestureModeEl = document.querySelector("#gestureMode");
const comboEl = document.querySelector("#combo");
const energyBar = document.querySelector("#energyBar");
const energyText = document.querySelector("#energyText");
const hpBar = document.querySelector("#hpBar");
const hpText = document.querySelector("#hpText");
const hudPanel = document.querySelector(".hud");
const hudToggle = document.querySelector("#hudToggle");


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
const MAX_ENERGY = 300;
let energy = MAX_ENERGY;
let hp = 70;
const MAX_HP = 100;
let domainActive = false;
let rctActive = false;
let rctEndsAt = 0;
let domainEndsAt = 0;
let domainInterval = null;

const COOLDOWN_MS = 500;
const DETECTION_INTERVAL_MS = 50; // ~20 FPS hand inference: still light, but more responsive
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
    numHands: 2,
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
function isFingerExtended(hand, mcp, pip, dip, tip) {
  // Extended fingers have a fingertip farther from the wrist than the PIP joint.
  const wrist = hand[0];
  const pipDist = distance(wrist, hand[pip]);
  const tipDist = distance(wrist, hand[tip]);
  return tipDist > pipDist * 1.10 && angle(hand[mcp], hand[pip], hand[tip]) > 135;
}

function isFingerBent(hand, mcp, pip, dip, tip) {
  const wrist = hand[0];
  const pipDist = distance(wrist, hand[pip]);
  const tipDist = distance(wrist, hand[tip]);
  return tipDist < pipDist * 1.18;
}

function isPointing(hand) {
  const index = isFingerExtended(hand, 5, 6, 7, 8);
  const middle = isFingerBent(hand, 9, 10, 11, 12);
  const ring = isFingerBent(hand, 13, 14, 15, 16);
  const pinky = isFingerBent(hand, 17, 18, 19, 20);

  return index && middle && ring && pinky;
}

function isFist(hand) {
  // Fist = all four long fingers folded toward the palm.
  const middle = isFingerBent(hand, 9, 10, 11, 12);
  const ring = isFingerBent(hand, 13, 14, 15, 16);
  const pinky = isFingerBent(hand, 17, 18, 19, 20);

  // Index gets a little more tolerance because it is often partially visible.
  const index = isFingerBent(hand, 5, 6, 7, 8);

  return index && middle && ring && pinky;
}

function isOpenPalm(hand) {
  const index = isFingerExtended(hand, 5, 6, 7, 8);
  const middle = isFingerExtended(hand, 9, 10, 11, 12);
  const ring = isFingerExtended(hand, 13, 14, 15, 16);
  const pinky = isFingerExtended(hand, 17, 18, 19, 20);

  return index && middle && ring && pinky;
}

function getDirection(dx, dy) {
  const degrees = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  return {
    label: `slash-${Math.round(degrees)}deg`,
    angle: degrees
  };
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

function updateHP() {
  if (hpBar) {
    hpBar.style.transform = `scaleX(${hp / MAX_HP})`;
  }
  if (hpText) {
    hpText.textContent = `${Math.round(hp)} / ${MAX_HP}`;
  }
}

function takeDamage(amount = 20) {
  hp = Math.max(0, hp - amount);
  updateHP();

  const ui = document.querySelector(".hud") || document.body;
  const flash = document.createElement("div");
  flash.className = "damage-flash";
  ui.appendChild(flash);
  setTimeout(() => flash.remove(), 220);

  setStatus(`💥 DAMAGE — HP ${Math.round(hp)}%`);
}

function updateEnergy() {
  if (energyBar) {
    energyBar.style.transform = `scaleX(${energy / MAX_ENERGY})`;
  }
  if (energyText) {
    energyText.textContent = `${Math.round(energy)} / ${MAX_ENERGY}`;
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

  energy = Math.min(MAX_ENERGY, energy + 5);
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


function getPalmCenter(hand) {
  const indices = [0, 5, 9, 13, 17];
  let x = 0;
  let y = 0;
  for (const i of indices) {
    const p = videoPointToScreen(hand[i]);
    x += p.x;
    y += p.y;
  }
  return { x: x / indices.length, y: y / indices.length };
}

function updateRCTPosition(point) {
  const layer = document.querySelector("#rctFx");
  if (!layer || !point) return;

  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const x = Math.max(8, Math.min(92, point.x / rect.width * 100));
  const y = Math.max(10, Math.min(90, point.y / rect.height * 100));

  layer.style.setProperty("--rct-x", `${x}%`);
  layer.style.setProperty("--rct-y", `${y}%`);
}

function stopRCT(reason = "RCT stopped") {
  if (!rctActive) return;

  rctActive = false;
  window.__rctLastTime = 0;

  const layer = document.querySelector("#rctFx");
  if (!layer) return;

  layer.classList.add("rct-out");

  setTimeout(() => {
    layer.innerHTML = "";
    layer.classList.remove("rct-out");
  }, 360);

  setStatus(reason);
}

function activateRCT(anchorPoint) {
  if (domainActive || rctActive || energy < 40) {
    if (energy < 40) setStatus("Not enough energy for RCT");
    return;
  }

  rctActive = true;
  rctEndsAt = performance.now() + 4000;

  const layer = document.querySelector("#rctFx");
  if (!layer) {
    rctActive = false;
    return;
  }

  layer.innerHTML = "";
  updateRCTPosition(anchorPoint);

  const anchor = document.createElement("div");
  anchor.className = "rct-anchor";

  const aura = document.createElement("div");
  aura.className = "rct-aura";

  const orb = document.createElement("div");
  orb.className = "rct-orb";

  const symbol = document.createElement("div");
  symbol.className = "rct-symbol";

  const title = document.createElement("div");
  title.className = "rct-title";
  title.textContent = "RCT";

  anchor.appendChild(aura);
  anchor.appendChild(symbol);
  anchor.appendChild(orb);
  anchor.appendChild(title);

  // Expanding healing waves.
  for (let i = 0; i < 3; i++) {
    const wave = document.createElement("div");
    wave.className = "rct-heal-wave";
    wave.style.animationDelay = `${i * 0.48}s`;
    anchor.appendChild(wave);
  }

  // Lightweight white energy particles spiral toward the healing core.
  for (let i = 0; i < 28; i++) {
    const particle = document.createElement("span");
    particle.className = "rct-particle";
    particle.style.setProperty("--angle", `${Math.random() * 360}deg`);
    particle.style.setProperty("--distance", `${180 + Math.random() * 300}px`);
    particle.style.setProperty("--delay", `${Math.random() * 1.1}s`);
    anchor.appendChild(particle);
  }

  layer.appendChild(anchor);

  setStatus(`RCT — REVERSED ENERGY • HP ${Math.round(hp)} • EN ${Math.round(energy)}`);

  // RCT restores energy quickly, but fist remains the fastest recharge.
  const start = performance.now();

  const tick = () => {
    if (!rctActive) return;

    const now = performance.now();
    const dt = Math.min(100, now - (window.__rctLastTime || now));
    window.__rctLastTime = now;

    // RCT heals HP by consuming cursed energy.
    hp = Math.min(MAX_HP, hp + dt * 0.022);
    energy = Math.max(0, energy - dt * 0.018);
    updateHP();
    updateEnergy();

    if (energy <= 0) {
      rctActive = false;
      window.__rctLastTime = 0;
      layer.classList.add("rct-out");
      setTimeout(() => {
        layer.innerHTML = "";
        layer.classList.remove("rct-out");
        setStatus("RCT stopped — energy empty");
      }, 380);
      return;
    }

    if (now >= rctEndsAt) {
      rctActive = false;
      window.__rctLastTime = 0;
      layer.classList.add("rct-out");

      setTimeout(() => {
        layer.innerHTML = "";
        layer.classList.remove("rct-out");
        setStatus("RCT ended — show your hand");
      }, 380);
      return;
    }

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

function randomDomainSlash() {
  if (!domainActive) return;

  const rect = video.getBoundingClientRect();
  const point = {
    x: 70 + Math.random() * Math.max(1, rect.width - 140),
    y: 70 + Math.random() * Math.max(1, rect.height - 140)
  };

  const angle = Math.random() * 360;
  const direction = { label: `slash-${Math.round(angle)}deg`, angle };

  // During the domain, slashes can appear at ANY angle.
  spawnParticles(point);
  spawnImpact(point, direction);
  spawnSlash(direction, point, false);
}

function activateDomain() {
  if (domainActive || energy < 90) return;

  energy -= 90;
  updateEnergy();

  domainActive = true;
  domainEndsAt = performance.now() + 5000;

  const layer = document.querySelector("#domainFx");
  if (!layer) {
    domainActive = false;
    energy = Math.min(MAX_ENERGY, energy + 90);
    updateEnergy();
    return;
  }

  layer.innerHTML = "";

  const overlay = document.createElement("div");
  overlay.className = "domain-overlay";

  const title = document.createElement("div");
  title.className = "domain-title";
  title.textContent = "DOMAIN EXPANSION";

  const ring = document.createElement("div");
  ring.className = "domain-ring";

  const core = document.createElement("div");
  core.className = "domain-core";
  ring.appendChild(core);

  layer.appendChild(overlay);
  layer.appendChild(ring);
  layer.appendChild(title);

  // Low-cost visual shards.
  for (let i = 0; i < 8; i++) {
    const shard = document.createElement("span");
    shard.className = "domain-shard";
    shard.style.setProperty("--angle", `${i * 45}deg`);
    layer.appendChild(shard);
  }

  setStatus("DOMAIN EXPANSION — RANDOM SLASHES");

  // One slash immediately, then roughly 4 per second.
  randomDomainSlash();
  domainInterval = setInterval(() => {
    if (performance.now() < domainEndsAt) randomDomainSlash();
  }, 240);

  setTimeout(() => {
    domainActive = false;

    if (domainInterval) {
      clearInterval(domainInterval);
      domainInterval = null;
    }

    layer.classList.add("domain-exit");

    setTimeout(() => {
      layer.innerHTML = "";
      layer.classList.remove("domain-exit");
      setStatus("Domain ended — show your hand");
    }, 380);
  }, 5000);
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

function spawnSlash(direction, point, demo = false, vector = null) {
  const existing = slashLayer.querySelectorAll(".dismantle-projectile").length;
  if (existing >= (domainActive ? 5 : 2) && !demo) return;

  const videoRect = video.getBoundingClientRect();
  const layerRect = slashLayer.getBoundingClientRect();
  const launch = point || {
    x: videoRect.width * 0.5,
    y: videoRect.height * 0.5
  };

  // The finger movement is the launch impulse. Keep the full 0–360° angle.
  let angle = Number.isFinite(direction?.angle) ? direction.angle : 0;
  if (vector && !demo) {
    angle = (Math.atan2(vector.y, vector.x) * 180 / Math.PI + 360) % 360;
  }

  // The artwork's blade points roughly -30° in its source image.
  // Rotating by +30° makes its tip-to-tip axis line up with the movement angle.
  const ART_AXIS_DEG = -30;
  const rotation = angle - ART_AXIS_DEG;

  const diagonal = Math.hypot(videoRect.width, videoRect.height);
  const slashWidth = Math.max(420, Math.min(760, diagonal * 0.58));
  const slashHeight = slashWidth * (869 / 1515);

  // Convert the fingertip from the camera rectangle into the slash layer.
  const startX = launch.x + videoRect.left - layerRect.left;
  const startY = launch.y + videoRect.top - layerRect.top;

  // The slash flies forward instead of being pinned to the screen edge.
  // It travels far enough to read as a ranged cut, but not so far that it
  // instantly disappears on ordinary swipes.
  const travel = demo
    ? diagonal * 0.42
    : Math.min(diagonal * 0.78, Math.max(diagonal * 0.48, 430 + Math.hypot(vector?.x || 0, vector?.y || 0) * 1.8));

  const projectile = document.createElement("div");
  projectile.className = "dismantle-projectile";
  projectile.style.left = `${startX}px`;
  projectile.style.top = `${startY}px`;
  projectile.style.width = `${slashWidth}px`;
  projectile.style.height = `${slashHeight}px`;
  projectile.style.setProperty("--slash-rotation", `${rotation}deg`);

  const slash = document.createElement("img");
  slash.src = `./dismantle-vfx.png?v=21`;
  slash.alt = "";
  slash.draggable = false;
  slash.className = "dismantle-projectile-art";
  slash.width = Math.round(slashWidth);
  slash.height = Math.round(slashHeight);

  projectile.appendChild(slash);
  slashLayer.appendChild(projectile);

  const rad = angle * Math.PI / 180;
  const vx = Math.cos(rad);
  const vy = Math.sin(rad);

  // A short, sharp acceleration phase gives the "slide → ZAP" feeling.
  const duration = demo ? 500 : 285;
  const start = performance.now();
  let rafId = 0;

  function animateProjectile(now) {
    const elapsed = now - start;
    const t = Math.min(1, elapsed / duration);

    // Ease-out after a very fast launch: quick first 25%, then clean travel.
    const travelT = t < 0.22
      ? (t / 0.22) ** 1.65 * 0.28
      : 0.28 + ((t - 0.22) / 0.78) ** 0.82 * 0.72;

    const x = vx * travel * travelT;
    const y = vy * travel * travelT;

    // Extend the blade during the first few frames, then hold its shape.
    const grow = Math.min(1, t / 0.12);
    const scaleX = 0.035 + grow * 0.965;

    let opacity = 1;
    if (t < 0.035) opacity = t / 0.035;
    else if (t > 0.88) opacity = 1 - (t - 0.88) / 0.12;

    projectile.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${rotation}deg) scaleX(${scaleX})`;
    projectile.style.opacity = opacity.toFixed(3);

    if (t < 1) {
      rafId = requestAnimationFrame(animateProjectile);
    } else {
      cancelAnimationFrame(rafId);
      projectile.remove();
    }
  }

  rafId = requestAnimationFrame(animateProjectile);

  // A tiny trail follows the launch direction; it is intentionally restrained.
  const fragmentCount = demo ? 4 : 2;
  for (let i = 0; i < fragmentCount; i++) {
    const fragment = document.createElement("span");
    fragment.className = "slash-fragment slash-fragment-v19";
    fragment.style.left = `${startX}px`;
    fragment.style.top = `${startY}px`;
    fragment.style.setProperty("--fragment-angle", `${angle + (Math.random() - .5) * 7}deg`);
    fragment.style.setProperty("--fragment-distance", `${35 + Math.random() * 80}px`);
    fragment.style.setProperty("--fragment-delay", `${i * 18}ms`);
    slashLayer.appendChild(fragment);
    setTimeout(() => fragment.remove(), 280);
  }
}

function triggerSlash(direction, point, demo = false, vector = null) {
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
  spawnSlash(direction, impactPoint, demo, vector);
  lastSlashTime = performance.now();
}

function processResults(results) {
  const hands = results?.landmarks || [];

  if (!hands.length) {
    stopRCT("RCT stopped — open palm lost");
    clearTracking();
    setStatus("No hand detected");
    window.__openPalmStart = 0;
    window.__twoPalmStart = 0;
    window.__fistLastTime = 0;
    return;
  }

  // Draw the first hand as the main tracking hand.
  const hand = hands[0];
  const tip = drawHandTracking(hand);

  const pointing = isPointing(hand);
  const fist = isFist(hand);
  const openPalm = isOpenPalm(hand);
  const twoOpenPalms =
    hands.length >= 2 &&
    isOpenPalm(hands[0]) &&
    isOpenPalm(hands[1]);

  const now = performance.now();

  // DOMAIN: BOTH HANDS OPEN + held for ~1.2 seconds.
  if (!domainActive && !rctActive && twoOpenPalms) {
    if (!window.__twoPalmStart) {
      window.__twoPalmStart = now;
    }

    const held = now - window.__twoPalmStart;
    setStatus(`🖐️🖐️ DOMAIN ${Math.min(100, Math.round(held / 1200 * 100))}%`);

    if (held >= 1200) {
      activateDomain();
      window.__twoPalmStart = 0;
      return;
    }
  } else if (!twoOpenPalms) {
    window.__twoPalmStart = 0;
  }

  if (domainActive) {
    setStatus("DOMAIN EXPANSION — RANDOM SLASHES");
    return;
  }

  // RCT: ONE open palm held for ~0.8 seconds.
  // Two palms are reserved for Domain Expansion.
  if (!rctActive && openPalm && !twoOpenPalms && !pointing && !fist) {
    if (!window.__openPalmStart) {
      window.__openPalmStart = now;
    }

    const held = now - window.__openPalmStart;

    setStatus(`🖐️ RCT ${Math.min(100, Math.round(held / 800 * 100))}%`);

    if (held >= 800) {
      activateRCT(getPalmCenter(hand));
      window.__openPalmStart = 0;
      return;
    }
  } else if (!openPalm || twoOpenPalms) {
    window.__openPalmStart = 0;
  }

  if (rctActive) {
    // RCT only exists while the activating one-hand open-palm gesture remains.
    // The moment the palm closes, points, or a second hand appears, stop it.
    if (!openPalm || twoOpenPalms || pointing || fist) {
      stopRCT("RCT stopped — open palm gesture lost");
      window.__openPalmStart = 0;
      return;
    }

    updateRCTPosition(getPalmCenter(hand));
    setStatus(`RCT — REVERSED ENERGY • HP ${Math.round(hp)} • EN ${Math.round(energy)}`);
    return;
  }

  // FIST: fastest recharge.
  if (fist) {
    window.__fistLastTime ||= now;

    const dt = Math.min(100, now - window.__fistLastTime);
    window.__fistLastTime = now;

    energy = Math.min(MAX_ENERGY, energy + dt * 0.024);
    updateEnergy();

    setStatus(
      energy >= MAX_ENERGY - 0.1
        ? "✊ ENERGY FULL"
        : `✊ RECHARGING ${Math.round(energy)} / ${MAX_ENERGY}`
    );

    previousTip = { ...tip };
    previousTipTime = now;
    return;
  }

  window.__fistLastTime = 0;

  if (!previousTip) {
    previousTip = { ...tip };
    previousTipTime = now;
    setStatus(pointing ? "POINTING — move to slash" : "Hand detected — point, fist, or palm");
    return;
  }

  const dt = Math.max(16, now - previousTipTime);
  const fromTip = { ...previousTip };

  const dx = tip.x - previousTip.x;
  const dy = tip.y - previousTip.y;

  previousTip = { ...tip };
  previousTipTime = now;

  const movementPx = Math.hypot(dx, dy);
  const diagonal = Math.max(video.clientWidth, video.clientHeight);
  const movementRatio = movementPx / Math.max(1, diagonal);
  const speed = movementPx / dt;

  if (pointing && movementPx >= 5) {
    drawMotionStreak(fromTip, tip);
  }

  if (!pointing) {
    setStatus("Hand detected — point, fist, or palm");
    return;
  }

  setStatus("POINTING — swipe now");

  if (gestureModeEl.value === "point") {
    if (now - lastSlashTime > 700) {
      triggerSlash({ label: "slash-0deg", angle: 0 }, tip);
    }
    return;
  }

  const sensitivity = Number(sensitivityEl.value);

  if (
    movementRatio >= sensitivity &&
    speed >= 0.25 &&
    now - lastSlashTime > COOLDOWN_MS
  ) {
    const direction = getDirection(dx, dy);
    const directionKey = Math.round(direction.angle);

    if (movementRatio >= sensitivity * 1.02 || directionKey !== previousDirection) {
      previousDirection = directionKey;
      triggerSlash(direction, tip, false, { x: dx, y: dy });
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
  const rect = video.getBoundingClientRect();
  const angle = Math.random() * 360;

  setStatus("TEST SLASH!");

  triggerSlash(
    { label: `slash-${Math.round(angle)}deg`, angle },
    {
      x: rect.width * 0.5,
      y: rect.height * 0.5
    },
    true
  );
});

window.addEventListener("resize", resizeOverlay);
updateEnergy();
updateHP();


if (hudToggle && hudPanel) {
  hudToggle.addEventListener("click", () => {
    const hidden = hudPanel.classList.toggle("is-hidden");
    hudToggle.textContent = hidden ? "SHOW" : "HIDE";
    hudToggle.setAttribute("aria-expanded", String(!hidden));
    hudToggle.setAttribute("aria-label", hidden ? "Show controls" : "Hide controls");
  });
}

const damageBtn = document.querySelector("#damageBtn");
if (damageBtn) {
  damageBtn.addEventListener("click", () => takeDamage(25));
}
