import {
  FilesetResolver,
  HandLandmarker
} from "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM_URL =
  "https://unpkg.com/@mediapipe/tasks-vision@0.10.35/wasm";

const video = document.querySelector("#camera");
const handCanvas = document.querySelector("#handOverlay");
const handCtx = handCanvas.getContext("2d");
const effectCanvas = document.querySelector("#effectCanvas");
const effectCtx = effectCanvas.getContext("2d");

const startBtn = document.querySelector("#start");
const testBtn = document.querySelector("#test");
const hideBtn = document.querySelector("#hide");
const panel = document.querySelector("#panel");
const statusEl = document.querySelector("#status");
const handsText = document.querySelector("#handsText");
const handCount = document.querySelector("#handCount");
const comboEl = document.querySelector("#combo");
const hpBar = document.querySelector("#hpBar");
const hpText = document.querySelector("#hpText");
const energyBar = document.querySelector("#energyBar");
const energyText = document.querySelector("#energyText");
const sensitivityEl = document.querySelector("#sensitivity");
const sensitivityValue = document.querySelector("#sensitivityValue");
const domainFx = document.querySelector("#domainFx");
const rctFx = document.querySelector("#rctFx");

const slashImage = new Image();
slashImage.decoding = "async";
slashImage.src = "./dismantle-vfx.png";

let detector = null;
let stream = null;
let running = false;
let lastVideoTime = -1;
let lastDetectTime = 0;

let hp = 70;
let energy = 300;
let combo = 0;
const MAX_HP = 100;
const MAX_ENERGY = 300;

let previousIndex = null;
let pointStart = null;
let fistSince = 0;
let openPalmSince = 0;
let twoHandSince = 0;

let rctActive = false;
let domainActive = false;
let domainEnds = 0;
let domainTimer = 0;

let slashThreshold = 75;
let lastSlashTime = 0;
const SLASH_COOLDOWN = 450;

const slashes = [];

const connections = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function updateHud() {
  combo = Math.max(0, combo);
  energy = Math.max(0, Math.min(MAX_ENERGY, energy));
  hp = Math.max(0, Math.min(MAX_HP, hp));

  if (comboEl) comboEl.textContent = combo;
  if (hpBar) hpBar.style.width = `${hp}%`;
  if (hpText) hpText.textContent = `${Math.round(hp)} / ${MAX_HP}`;
  if (energyBar) energyBar.style.width = `${energy / MAX_ENERGY * 100}%`;
  if (energyText) energyText.textContent = `${Math.round(energy)} / ${MAX_ENERGY}`;
}

function resizeCanvases() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  for (const canvas of [handCanvas, effectCanvas]) {
    canvas.width = Math.max(1, Math.round(innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(innerHeight * dpr));
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
  }
  handCtx.setTransform(dpr,0,0,dpr,0,0);
  effectCtx.setTransform(dpr,0,0,dpr,0,0);
}
resizeCanvases();
window.addEventListener("resize", resizeCanvases);

function videoToScreen(p) {
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 960;
  const vh = video.videoHeight || 540;

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

function drawHands(hands) {
  handCtx.clearRect(0,0,innerWidth,innerHeight);

  for (const hand of hands) {
    const pts = hand.map(videoToScreen);

    handCtx.strokeStyle = "rgba(255,255,255,.48)";
    handCtx.lineWidth = 1.6;
    handCtx.beginPath();
    for (const [a,b] of connections) {
      handCtx.moveTo(pts[a].x,pts[a].y);
      handCtx.lineTo(pts[b].x,pts[b].y);
    }
    handCtx.stroke();

    handCtx.fillStyle = "rgba(255,255,255,.9)";
    for (let i=0;i<pts.length;i++) {
      handCtx.beginPath();
      handCtx.arc(pts[i].x,pts[i].y,i===8?5:3,0,Math.PI*2);
      handCtx.fill();
    }
  }
}

function distance(a,b) {
  return Math.hypot(a.x-b.x,a.y-b.y);
}

function angle(a,b,c) {
  const abx=a.x-b.x, aby=a.y-b.y;
  const cbx=c.x-b.x, cby=c.y-b.y;
  const den=Math.hypot(abx,aby)*Math.hypot(cbx,cby);
  if(!den) return 180;
  return Math.acos(Math.max(-1,Math.min(1,(abx*cbx+aby*cby)/den)))*180/Math.PI;
}

function fingerExtended(h,mcp,pip,dip,tip) {
  return distance(h[tip],h[0]) > distance(h[pip],h[0]) * 1.08 &&
         angle(h[mcp],h[pip],h[tip]) > 135;
}

function fingerBent(h,mcp,pip,dip,tip) {
  return distance(h[tip],h[0]) < distance(h[pip],h[0]) * 1.22;
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
  Dismantle fix:
  this is a SNAPSHOT effect. x/y/angle are captured once and never changed.
  It renders on a dedicated canvas so HTML/CSS/DOM positioning cannot move it.
*/
function spawnSlash(x,y,angle,{domain=false}={}) {
  if (!slashImage.complete || !slashImage.naturalWidth) {
    setStatus("Loading Dismantle VFX…");
    return false;
  }

  const now = performance.now();

  if (!domain) {
    if (now-lastSlashTime < SLASH_COOLDOWN) return false;
    if (energy < 12) {
      setStatus("Not enough Energy");
      return false;
    }
    energy -= 12;
    combo += 1;
    lastSlashTime = now;
    updateHud();
  }

  if (slashes.filter(s=>!s.dead).length >= (domain ? 6 : 1)) return false;

  slashes.push({
    x,
    y,
    angle,
    born: now,
    life: domain ? 380 : 520,
    baseWidth: Math.min(innerWidth * 0.64, 960),
    dead: false
  });

  return true;
}

function renderSlashes(now) {
  effectCtx.clearRect(0,0,innerWidth,innerHeight);

  for (const s of slashes) {
    const age = now-s.born;

    if (age >= s.life) {
      s.dead = true;
      continue;
    }

    const inAlpha = Math.min(age/55,1);
    const outAlpha = Math.min((s.life-age)/90,1);
    const alpha = inAlpha*outAlpha;

    const scale = 0.72 + 0.28*Math.min(age/95,1);
    const width = s.baseWidth * scale;
    const aspect = slashImage.naturalWidth / slashImage.naturalHeight;
    const height = width / aspect;

    effectCtx.save();
    effectCtx.translate(s.x,s.y);
    effectCtx.rotate(s.angle);
    effectCtx.globalAlpha = alpha;
    effectCtx.globalCompositeOperation = "screen";

    // CENTER ANCHOR: the actual center of the image stays exactly at x/y.
    effectCtx.drawImage(
      slashImage,
      -width/2,
      -height/2,
      width,
      height
    );

    effectCtx.restore();
  }

  for(let i=slashes.length-1;i>=0;i--){
    if(slashes[i].dead) slashes.splice(i,1);
  }
}

function startDomain() {
  if (domainActive || rctActive || energy < 90) return;

  energy -= 90;
  updateHud();

  domainActive = true;
  domainEnds = performance.now()+5000;
  if (domainFx) domainFx.classList.add("active");

  clearInterval(domainTimer);
  domainTimer = setInterval(()=>{
    if (!domainActive) return;

    const margin=Math.min(innerWidth,innerHeight)*0.18;
    const x=margin+Math.random()*(innerWidth-margin*2);
    const y=margin+Math.random()*(innerHeight-margin*2);
    const angle=Math.random()*Math.PI*2;
    spawnSlash(x,y,angle,{domain:true});
  },320);

  setStatus("DOMAIN EXPANSION");
}

function stopDomain() {
  if (!domainActive) return;
  domainActive=false;
  clearInterval(domainTimer);
  domainTimer=0;
  if(domainFx) domainFx.classList.remove("active");
  setStatus("Domain ended");
}

function startRCT(anchor) {
  if (rctActive || domainActive || energy < 40) return;

  rctActive=true;
  if(rctFx){
    rctFx.classList.add("active");
    rctFx.style.left=`${anchor.x}px`;
    rctFx.style.top=`${anchor.y}px`;
  }
  setStatus("RCT — REVERSED ENERGY");
}

function stopRCT() {
  if (!rctActive) return;
  rctActive=false;
  if(rctFx) rctFx.classList.remove("active");
}

function updateRCT(anchor,now) {
  if(!rctActive || !anchor) return;

  const dt=Math.min(70,now-(window.__rctTime||now));
  window.__rctTime=now;

  energy=Math.max(0,energy-dt*0.035);
  hp=Math.min(100,hp+dt*0.024);
  updateHud();

  if(rctFx){
    rctFx.style.left=`${anchor.x}px`;
    rctFx.style.top=`${anchor.y}px`;
  }

  if(energy<=0) stopRCT();
}

function processHands(result) {
  const hands=result?.landmarks||[];
  if(handCount) handCount.textContent=hands.length;
  if(handsText) handsText.textContent=`HANDS ${hands.length}`;

  drawHands(hands);

  const now=performance.now();

  if(!hands.length){
    previousIndex=null;
    pointStart=null;
    fistSince=0;
    openPalmSince=0;
    twoHandSince=0;
    stopRCT();
    if(!domainActive) setStatus("No hand detected");
    return;
  }

  // 2 HANDS ALWAYS WIN OVER RCT.
  if(hands.length>=2){
    stopRCT();
    fistSince=0;
    openPalmSince=0;
    previousIndex=null;
    pointStart=null;

    if(!twoHandSince) twoHandSince=now;
    const held=now-twoHandSince;

    if(!domainActive){
      setStatus(`👐 DOMAIN ${Math.min(100,Math.round(held/550*100))}%`);
      if(held>=550){
        startDomain();
        twoHandSince=0;
      }
    }
    return;
  }

  twoHandSince=0;

  if(domainActive){
    // Keep Domain self-contained. One hand cannot accidentally switch to RCT.
    return;
  }

  const h=hands[0];
  const index=videoToScreen(h[8]);
  const palm=videoToScreen(h[9]);
  const pointing=isPointing(h);
  const fist=isFist(h);
  const palmOpen=isOpenPalm(h);

  if(fist){
    stopRCT();
    openPalmSince=0;
    pointStart=null;
    previousIndex={...index};

    if(!fistSince) fistSince=now;
    const dt=Math.min(90,now-fistSince);
    fistSince=now;

    energy=Math.min(MAX_ENERGY,energy+dt*0.045);
    updateHud();
    setStatus(`✊ RECHARGING ${Math.round(energy)} / ${MAX_ENERGY}`);
    return;
  }

  fistSince=0;

  if(palmOpen && !pointing){
    pointStart=null;
    previousIndex={...index};

    if(!openPalmSince) openPalmSince=now;
    if(!rctActive && now-openPalmSince>=450) startRCT(palm);

    if(rctActive) updateRCT(palm,now);
    else setStatus(`🖐️ RCT ${Math.min(100,Math.round((now-openPalmSince)/450*100))}%`);

    return;
  }

  openPalmSince=0;
  if(rctActive) stopRCT();

  if(pointing){
    if(!pointStart) pointStart={...index};
    const dx=index.x-pointStart.x;
    const dy=index.y-pointStart.y;
    const travel=Math.hypot(dx,dy);

    setStatus("☝️ POINT — SWIPE TO DISMANTLE");

    if(travel>=slashThreshold && now-lastSlashTime>=SLASH_COOLDOWN){
      // IMPORTANT: spawn uses the CURRENT fingertip once, then locks it.
      const fired=spawnSlash(index.x,index.y,Math.atan2(dy,dx));
      if(fired) pointStart={...index};
    }

    previousIndex={...index};
    return;
  }

  previousIndex=null;
  pointStart=null;
  setStatus("Hand detected");
}

async function setupDetector() {
  setStatus("Loading hand tracker…");

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

async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia){
    throw new Error("Camera API is not available.");
  }

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
  testBtn.disabled=false;
  setStatus("Camera ready — show one or two hands");
  resizeCanvases();
  requestAnimationFrame(loop);
}

function loop(now){
  if(!running || !detector) return;

  if(video.readyState>=2 &&
     video.currentTime!==lastVideoTime &&
     now-lastDetectTime>=60){

    lastVideoTime=video.currentTime;
    lastDetectTime=now;

    try{
      const result=detector.detectForVideo(video,now);
      processHands(result);
    }catch(err){
      console.error(err);
      setStatus(`Hand tracking error: ${err.message}`);
    }
  }

  if(domainActive && now>=domainEnds){
    stopDomain();
  }

  renderSlashes(now);

  if(combo>0 && comboExpires && now>comboExpires){
    combo=0;
    comboExpires=0;
    updateHud();
  }

  requestAnimationFrame(loop);
}

sensitivityEl?.addEventListener("input",()=>{
  slashThreshold=Number(sensitivityEl.value);
  if(sensitivityValue) sensitivityValue.textContent=`${slashThreshold}px`;
});

startBtn?.addEventListener("click",async()=>{
  startBtn.disabled=true;
  try{
    await setupDetector();
    await startCamera();
  }catch(err){
    console.error(err);
    startBtn.disabled=false;
    setStatus(`Error: ${err.message}`);
  }
});

testBtn?.addEventListener("click",()=>{
  spawnSlash(innerWidth/2,innerHeight/2,0,{});
  setStatus("TEST DISMANTLE");
});

hideBtn?.addEventListener("click",()=>{
  panel?.classList.toggle("hidden");
});

updateHud();
