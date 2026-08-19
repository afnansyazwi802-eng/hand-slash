import {
  FilesetResolver,
  HandLandmarker
} from "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM_URL =
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/wasm";

const video = document.querySelector("#camera");
const overlay = document.querySelector("#handOverlay");
const overlayCtx = overlay?.getContext("2d");
const slashLayer = document.querySelector("#slashLayer");
const domainFx = document.querySelector("#domainFx");
const rctFx = document.querySelector("#rctFx");
const startBtn = document.querySelector("#start");
const testSlashBtn = document.querySelector("#test");
const hideBtn = document.querySelector("#hide");
const statusEl = document.querySelector("#status");
const comboEl = document.querySelector("#combo");
const hpBar = document.querySelector("#hpBar");
const hpText = document.querySelector("#hpText");
const energyBar = document.querySelector("#energyBar");
const energyText = document.querySelector("#energyText");
const handsText = document.querySelector("#handsText");
const sensitivity = document.querySelector("#sensitivity");
const sensitivityValue = document.querySelector("#sensitivityValue");

const slashImage = new Image();
slashImage.src = "./dismantle-vfx.png";

let detector = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let lastDetectTime = 0;

let hp = 70;
const MAX_HP = 100;
let energy = 300;
const MAX_ENERGY = 300;

let combo = 0;
let comboExpires = 0;

let previousIndex = null;
let previousTime = 0;
let pointStart = null;
let gestureArmed = true;

let rctActive = false;
let rctStart = 0;
let domainActive = false;
let domainStart = 0;
let domainTimer = 0;
let openPalmStart = 0;
let twoHandStart = 0;
let fistLast = 0;

let lastSlashTime = 0;
const SLASH_COOLDOWN = 450;
let slashThreshold = 75;

const slashStates = [];

const connections = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];

function status(text) {
  if (statusEl) statusEl.textContent = text;
}

function updateHud() {
  if (comboEl) comboEl.textContent = combo;
  if (hpBar) hpBar.style.width = `${hp / MAX_HP * 100}%`;
  if (hpText) hpText.textContent = `${Math.round(hp)} / ${MAX_HP}`;
  if (energyBar) energyBar.style.width = `${energy / MAX_ENERGY * 100}%`;
  if (energyText) energyText.textContent = `${Math.round(energy)} / ${MAX_ENERGY}`;
}

function resizeOverlay() {
  if (!overlay || !overlayCtx) return;
  const rect = video.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  overlay.width = Math.max(1, Math.round(rect.width * dpr));
  overlay.height = Math.max(1, Math.round(rect.height * dpr));
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function videoToScreen(p) {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;
  const scale = Math.max(rect.width / vw, rect.height / vh);
  const shownW = vw * scale;
  const shownH = vh * scale;
  const cropX = (shownW - rect.width) / 2;
  const cropY = (shownH - rect.height) / 2;
  return {
    x: (1 - p.x) * shownW - cropX,
    y: p.y * shownH - cropY
  };
}

function drawHands(allHands) {
  if (!overlayCtx) return;
  const rect = video.getBoundingClientRect();
  overlayCtx.clearRect(0, 0, rect.width, rect.height);

  for (const hand of allHands) {
    const pts = hand.map(videoToScreen);

    overlayCtx.strokeStyle = "rgba(255,255,255,.46)";
    overlayCtx.lineWidth = 1.5;
    overlayCtx.beginPath();
    for (const [a,b] of connections) {
      overlayCtx.moveTo(pts[a].x, pts[a].y);
      overlayCtx.lineTo(pts[b].x, pts[b].y);
    }
    overlayCtx.stroke();

    overlayCtx.fillStyle = "rgba(255,255,255,.9)";
    for (let i=0;i<pts.length;i++) {
      const r = i === 8 ? 5 : 3;
      overlayCtx.beginPath();
      overlayCtx.arc(pts[i].x, pts[i].y, r, 0, Math.PI*2);
      overlayCtx.fill();
    }

    const palm = pts[9];
    overlayCtx.beginPath();
    overlayCtx.arc(palm.x, palm.y, 9, 0, Math.PI*2);
    overlayCtx.strokeStyle = "rgba(255,255,255,.75)";
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();
  }
}

function angle(a,b,c) {
  const abx=a.x-b.x, aby=a.y-b.y;
  const cbx=c.x-b.x, cby=c.y-b.y;
  const mag=Math.hypot(abx,aby)*Math.hypot(cbx,cby);
  if (!mag) return 180;
  const dot=(abx*cbx+aby*cby)/mag;
  return Math.acos(Math.max(-1,Math.min(1,dot))) * 180/Math.PI;
}

function fingerExtended(h, mcp,pip,dip,tip) {
  const wrist=h[0];
  const pipD=Math.hypot(h[pip].x-wrist.x,h[pip].y-wrist.y);
  const tipD=Math.hypot(h[tip].x-wrist.x,h[tip].y-wrist.y);
  return tipD > pipD * 1.08 && angle(h[mcp],h[pip],h[tip]) > 135;
}

function fingerBent(h, mcp,pip,dip,tip) {
  const wrist=h[0];
  const pipD=Math.hypot(h[pip].x-wrist.x,h[pip].y-wrist.y);
  const tipD=Math.hypot(h[tip].x-wrist.x,h[tip].y-wrist.y);
  return tipD < pipD * 1.22;
}

function isPointing(h) {
  return fingerExtended(h,5,6,7,8) &&
         fingerBent(h,9,10,11,12) &&
         fingerBent(h,13,14,15,16) &&
         fingerBent(h,17,18,19,20);
}

function isFist(h) {
  return fingerBent(h,5,6,7,8) &&
         fingerBent(h,9,10,11,12) &&
         fingerBent(h,13,14,15,16) &&
         fingerBent(h,17,18,19,20);
}

function isOpenPalm(h) {
  return fingerExtended(h,5,6,7,8) &&
         fingerExtended(h,9,10,11,12) &&
         fingerExtended(h,13,14,15,16) &&
         fingerExtended(h,17,18,19,20);
}

/*
  This is the key fix:
  the slash takes a SNAPSHOT of the finger position at activation.
  Nothing updates its x/y afterward.
*/
function spawnSlash(x,y,angle, fromDomain=false) {
  if (slashStates.length >= (fromDomain ? 5 : 1)) return;
  if (!fromDomain && performance.now()-lastSlashTime < SLASH_COOLDOWN) return;

  if (!fromDomain) {
    if (energy < 12) {
      status("Not enough Energy");
      return;
    }
    energy -= 12;
    combo += 1;
    comboExpires = performance.now() + 1800;
    lastSlashTime = performance.now();
    updateHud();
  }

  const s = {
    x, y, angle,
    born: performance.now(),
    life: 500,
    width: Math.min(innerWidth * 0.66, 960)
  };

  slashStates.push(s);
}

function drawSlashes(now) {
  if (!slashImage.complete || !slashImage.naturalWidth) return;

  for (let i=slashStates.length-1;i>=0;i--) {
    const s=slashStates[i];
    const age=now-s.born;
    if (age>=s.life) {
      slashStates.splice(i,1);
      continue;
    }

    const inT=Math.min(age/75,1);
    const outT=Math.min((s.life-age)/120,1);
    const alpha=inT*outT;
    const width=s.width * (0.72 + 0.28*Math.min(age/110,1));
    const aspect=slashImage.naturalWidth/slashImage.naturalHeight;
    const height=width/aspect;

    ctxSave();
  }

  function ctxSave() {
    // no-op: actual draw is performed below after layer compositing is
    // centralized, preserving the fixed spawn coordinates.
  }
}

function renderSlashes(now) {
  if (!slashLayer) return;

  // Clear previous image nodes that belong to completed effects.
  for (const child of [...slashLayer.children]) {
    if (child.dataset.dismantle === "true" && !child.isConnected) continue;
  }

  // Render each slash as an absolute image. Its position is fixed at spawn.
  const activeIds = new Set();
  slashStates.forEach((s, idx) => {
    const id = `dismantle-${idx}-${s.born}`;
    activeIds.add(id);
    let img = slashLayer.querySelector(`[data-slash-id="${CSS.escape(id)}"]`);
    if (!img) {
      img = document.createElement("img");
      img.className = "dismantle-instance";
      img.dataset.slashId = id;
      img.src = slashImage.src;
      slashLayer.appendChild(img);
    }

    const age = now - s.born;
    const inT = Math.min(age/75,1);
    const outT = Math.min((s.life-age)/120,1);
    const alpha = inT*outT;
    const width = s.width * (0.72 + 0.28*Math.min(age/110,1));
    const posX = s.x;
    const posY = s.y;

    // Rotation/position are NEVER changed after the slash is spawned.
    img.style.left = `${posX}px`;
    img.style.top = `${posY}px`;
    img.style.width = `${width}px`;
    img.style.opacity = `${alpha}`;
    img.style.transform = `translate(-50%, -50%) rotate(${s.angle}rad)`;
  });

  for (const img of [...slashLayer.querySelectorAll("[data-slash-id]")]) {
    if (!activeIds.has(img.dataset.slashId)) img.remove();
  }
}

function randomDomainSlash() {
  if (!domainActive) return;
  const margin = Math.min(innerWidth,innerHeight)*0.14;
  const x = margin + Math.random()*(innerWidth-margin*2);
  const y = margin + Math.random()*(innerHeight-margin*2);
  const a = Math.random()*Math.PI*2;
  spawnSlash(x,y,a,true);
}

function setDomain(active) {
  domainActive = active;
  if (domainFx) {
    domainFx.classList.toggle("active", active);
  }
}

function startDomain() {
  if (domainActive || rctActive) return;
  if (energy < 90) {
    status("Not enough Energy for Domain");
    return;
  }

  energy -= 90;
  updateHud();

  domainActive = true;
  domainStart = performance.now();
  setDomain(true);
  status("DOMAIN EXPANSION");

  clearInterval(domainTimer);
  randomDomainSlash();
  domainTimer = setInterval(() => {
    if (!domainActive) return;
    randomDomainSlash();
  }, 360);
}

function stopDomain() {
  if (!domainActive) return;
  domainActive = false;
  clearInterval(domainTimer);
  domainTimer = 0;
  setDomain(false);
}

function startRCT(anchor) {
  if (rctActive || domainActive) return;
  if (energy < 40) {
    status("Not enough Energy for RCT");
    return;
  }

  rctActive = true;
  rctStart = performance.now();
  openPalmStart = performance.now();

  if (rctFx) {
    rctFx.classList.add("active");
    rctFx.style.left = `${anchor.x}px`;
    rctFx.style.top = `${anchor.y}px`;
  }
  status("RCT — REVERSED ENERGY");
}

function stopRCT() {
  if (!rctActive) return;
  rctActive = false;
  if (rctFx) rctFx.classList.remove("active");
}

function updateRCT(now, anchor) {
  if (!rctActive) return;
  if (!anchor) {
    stopRCT();
    return;
  }

  const dt = Math.min(80, now - (window.__rctLast || now));
  window.__rctLast = now;

  energy = Math.max(0, energy - dt * 0.035);
  hp = Math.min(MAX_HP, hp + dt * 0.024);
  updateHud();

  if (rctFx) {
    // RCT follows the palm ONLY while RCT is active.
    rctFx.style.left = `${anchor.x}px`;
    rctFx.style.top = `${anchor.y}px`;
  }

  if (energy <= 0 || now-rctStart >= 4000) {
    stopRCT();
    window.__rctLast = 0;
  }
}

function processResults(results) {
  const hands = results?.landmarks || [];
  if (handsText) handsText.textContent = `HANDS ${hands.length}`;

  if (!hands.length) {
    drawHands([]);
    previousIndex = null;
    pointStart = null;
    openPalmStart = 0;
    twoHandStart = 0;
    fistLast = 0;
    stopRCT();
    if (!domainActive) status("No hand detected");
    return;
  }

  drawHands(hands);

  const now = performance.now();
  const twoHands = hands.length >= 2;
  const first = hands[0];
  const idx = videoToScreen(first[8]);
  const palm = videoToScreen(first[9]);

  // TWO HANDS ALWAYS HAVE PRIORITY.
  if (twoHands) {
    stopRCT();
    openPalmStart = 0;
    fistLast = 0;
    previousIndex = null;
    pointStart = null;

    if (!twoHandStart) twoHandStart = now;
    const held = now-twoHandStart;

    if (!domainActive) {
      status(`👐 DOMAIN ${Math.min(100,Math.round(held/550*100))}%`);
      if (held >= 550) {
        startDomain();
        twoHandStart = 0;
      }
    } else {
      status("DOMAIN EXPANSION");
    }
    return;
  }

  // One hand from here onward.
  twoHandStart = 0;

  if (domainActive) {
    stopDomain();
  }

  const fist = isFist(first);
  const palmOpen = isOpenPalm(first);
  const pointing = isPointing(first);

  // FIST: medium recharge, time based.
  if (fist) {
    stopRCT();
    openPalmStart = 0;
    pointStart = null;
    previousIndex = {...idx};

    if (!fistLast) fistLast=now;
    const dt=Math.min(100,now-fistLast);
    fistLast=now;
    energy=Math.min(MAX_ENERGY,energy+dt*0.045);
    updateHud();
    status(`✊ RECHARGING ${Math.round(energy)}`);
    return;
  }
  fistLast=0;

  // RCT: one open palm, must be held for 450ms.
  if (palmOpen && !pointing) {
    previousIndex = {...idx};
    pointStart = null;

    if (!openPalmStart) openPalmStart = now;
    const held=now-openPalmStart;

    if (!rctActive) {
      status(`🖐️ RCT ${Math.min(100,Math.round(held/450*100))}%`);
      if (held >= 450) startRCT(palm);
    } else {
      status("RCT — REVERSED ENERGY");
    }

    updateRCT(now,palm);
    return;
  }
  openPalmStart=0;

  if (rctActive) stopRCT();

  // Dismantle: start from the current fingertip and require deliberate travel.
  if (pointing) {
    if (!previousIndex) previousIndex={...idx};
    if (!pointStart) pointStart={...idx};

    const dx=idx.x-pointStart.x;
    const dy=idx.y-pointStart.y;
    const travel=Math.hypot(dx,dy);

    status("☝️ POINT — SWIPE TO DISMANTLE");

    if (travel >= slashThreshold && gestureArmed && now-lastSlashTime >= SLASH_COOLDOWN) {
      spawnSlash(idx.x,idx.y,Math.atan2(dy,dx),false);
      pointStart={...idx};
      gestureArmed=false;
    }

    // Re-arm when the finger changes direction or a new motion segment starts.
    const localMove=Math.hypot(idx.x-(previousIndex?.x||idx.x),idx.y-(previousIndex?.y||idx.y));
    if (localMove > 12) gestureArmed=true;

    previousIndex={...idx};
    previousTime=now;
    return;
  }

  previousIndex=null;
  pointStart=null;
  gestureArmed=true;
  status("Hand detected");
}

async function createDetector() {
  const vision=await FilesetResolver.forVisionTasks(WASM_URL);
  detector=await HandLandmarker.createFromOptions(vision,{
    baseOptions:{modelAssetPath:MODEL_URL},
    runningMode:"VIDEO",
    numHands:2,
    minHandDetectionConfidence:0.52,
    minHandPresenceConfidence:0.52,
    minTrackingConfidence:0.52
  });
}

async function startCamera() {
  stream=await navigator.mediaDevices.getUserMedia({
    video:{
      facingMode:"user",
      width:{ideal:960,max:1280},
      height:{ideal:540,max:720},
      frameRate:{ideal:24,max:30}
    },
    audio:false
  });

  video.srcObject=stream;
  await video.play();
  running=true;
  startBtn.disabled=true;
  if(testSlashBtn) testSlashBtn.disabled=false;
  status("Camera ready — show your hand");
  resizeOverlay();
  requestAnimationFrame(loop);
}

function loop(now) {
  if (!running || !detector) return;

  if (now-lastDetectTime >= 60 &&
      video.readyState >= 2 &&
      video.currentTime !== lastVideoTime) {
    lastDetectTime=now;
    lastVideoTime=video.currentTime;

    try {
      const results=detector.detectForVideo(video,now);
      processResults(results);
    } catch(err) {
      console.error(err);
      status("Hand tracking error — open Console");
    }
  }

  // Domain lasts exactly 5 seconds and has no effect from one-hand gestures.
  if (domainActive && now-domainStart >= 5000) {
    stopDomain();
    status("Domain ended");
  }

  if (combo > 0 && now>comboExpires) {
    combo=0;
    updateHud();
  }

  renderSlashes(now);
  requestAnimationFrame(loop);
}

if (sensitivity) {
  const sync=()=>{
    slashThreshold=Number(sensitivity.value);
    if(sensitivityValue) sensitivityValue.textContent=`${slashThreshold}px`;
  };
  sensitivity.addEventListener("input",sync);
  sync();
}

startBtn?.addEventListener("click",async()=>{
  try {
    await createDetector();
    await startCamera();
  } catch(err) {
    console.error(err);
    status(`Error: ${err.message}`);
    startBtn.disabled=false;
  }
});

testSlashBtn?.addEventListener("click",()=>{
  spawnSlash(innerWidth/2,innerHeight/2,0,false);
  status("TEST DISMANTLE");
});

hideBtn?.addEventListener("click",()=>{
  const panel=document.querySelector(".panel");
  if(panel) panel.classList.toggle("hidden");
});

updateHud();
