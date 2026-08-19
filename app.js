const video = document.getElementById('camera');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d', {alpha:true});
const panel = document.getElementById('panel');
const showBtn = document.getElementById('show');
const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');
const comboEl = document.getElementById('combo');
const energyEl = document.getElementById('energy');
const energyText = document.getElementById('energyText');
const hpEl = document.getElementById('hp');
const hpText = document.getElementById('hpText');
const sensitivity = document.getElementById('sensitivity');
const flash = document.getElementById('flash');

const slashImage = new Image();
slashImage.src = 'assets/dismantle-vfx.png';

let W=innerWidth,H=innerHeight,dpr=1;
let energy=300, hp=100, combo=0;
let slashes=[], sparks=[];
let cameraStream=null, cameraRunner=null, cameraStarted=false;
let audioCtx=null;
let hands=null, processing=false, lastProcess=0;
let handState = new Map();
let lastSlashTime=0;
const MAX_ENERGY=300;
const SLASH_COST=12;

function resize(){
  W=innerWidth; H=innerHeight; dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(W*dpr); canvas.height=Math.round(H*dpr);
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener('resize',resize); resize();

function updateHud(){
  comboEl.textContent=combo;
  energyEl.style.width=(energy/MAX_ENERGY*100)+'%';
  energyText.textContent=Math.round(energy);
  hpEl.style.width=Math.max(0,hp)+'%';
  hpText.textContent=Math.round(hp);
}
updateHud();

function setMode(t){modeEl.textContent=t}

function beep(freq=170,dur=.11,volume=.035){
  try{
    audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    const o=audioCtx.createOscillator(),g=audioCtx.createGain();
    o.type='sawtooth'; o.frequency.setValueAtTime(freq,audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(45,freq*.42),audioCtx.currentTime+dur);
    g.gain.setValueAtTime(volume,audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+dur);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime+dur);
  }catch(e){}
}

function mapTip(lm){
  // MediaPipe x is mirrored relative to our displayed video. The video itself is mirrored,
  // so using (1-x) makes the effect land directly under the visible finger.
  return {x:(1-lm.x)*W, y:lm.y*H};
}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}

function spawnSlash(x,y,angle,fromGesture=true){
  if(energy<SLASH_COST){setMode('NO ENERGY'); beep(90,.08,.02); return false}
  energy-=SLASH_COST; combo++; updateHud(); beep(210,.10,.04);
  const scale=Math.min(W,H)/850;
  slashes.push({
    x:Math.max(20,Math.min(W-20,x)),
    y:Math.max(20,Math.min(H-20,y)),
    angle,
    born:performance.now(),
    life:430,
    scale:Math.max(.62,Math.min(1.25,scale)),
    seed:Math.random()
  });
  // tiny impact burst at the actual spawn point
  for(let i=0;i<5;i++){
    const a=Math.random()*Math.PI*2, s=25+Math.random()*55;
    sparks.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,born:performance.now(),life:180});
  }
  flash.style.opacity='.045';
  setTimeout(()=>flash.style.opacity='0',35);
  setMode(fromGesture?'DISMANTLE':'TEST SLASH');
  return true;
}

function drawSlash(s,now){
  const age=now-s.born;
  if(age>=s.life)return false;
  const enter=Math.min(1,age/55);
  const fade=Math.min(1,(s.life-age)/105);
  const alpha=Math.min(1,enter)*fade;
  // Keep the entire source image centered on the spawn point.
  // No translation after spawn: it never follows the hand.
  const iw=2048, ih=682;
  const width=Math.min(W*.74,1120)*s.scale*(.82+.18*enter);
  const height=width*(ih/iw);
  ctx.save();
  ctx.translate(s.x,s.y);
  ctx.rotate(s.angle);
  ctx.globalAlpha=alpha;
  ctx.globalCompositeOperation='screen';
  ctx.drawImage(slashImage,-width/2,-height/2,width,height);
  ctx.restore();
  return true;
}

function draw(now){
  ctx.clearRect(0,0,W,H);
  slashes=slashes.filter(s=>drawSlash(s,now));
  sparks=sparks.filter(p=>{
    const age=now-p.born;
    if(age>=p.life)return false;
    const t=age/p.life;
    p.x+=p.vx*.016; p.y+=p.vy*.016;
    ctx.globalAlpha=(1-t)*.65;
    ctx.fillStyle='#fff';
    ctx.fillRect(p.x,p.y,2,2);
    return true;
  });
  ctx.globalAlpha=1;
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

function classify(hand, index){
  // Simple low-cost gesture classifier. It is intentionally tolerant because webcam angles vary.
  const wrist=hand[0], idx=hand[8], idxP=hand[6], mid=hand[12], ring=hand[16], pinky=hand[20];
  const d=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const palm=d(wrist,hand[9])+0.001;
  const tips=[8,12,16,20], pips=[6,10,14,18];
  let extended=0;
  for(let i=0;i<4;i++) if(d(hand[tips[i]],wrist)>d(hand[pips[i]],wrist)*1.12) extended++;
  const indexExtended=d(idx,wrist)>d(idxP,wrist)*1.10;
  const open=extended>=3;
  const fist=extended<=1;
  return {index:idx, indexExtended, open, fist, two:false};
}

function onHands(results){
  const list=results.multiHandLandmarks||[];
  const now=performance.now();

  // Domain: two visible hands held together-ish for ~0.8s, then 5 seconds of random fixed slashes.
  if(list.length>=2){
    setMode('DOMAIN READY');
  }

  list.forEach((hand, i)=>{
    const g=classify(hand,i);
    const p=mapTip(g.index);
    let s=handState.get(i);
    if(!s){s={points:[],last:p,lastTime:now,swipeCooldown:0,openSince:0,lastRCT:0};handState.set(i,s)}
    const dt=Math.max(1,now-s.lastTime);
    const vx=(p.x-s.last.x)/dt*1000, vy=(p.y-s.last.y)/dt*1000;
    s.points.push({x:p.x,y:p.y,t:now});
    if(s.points.length>8)s.points.shift();

    // RCT: open palm. While held, heal and spend energy. Stops immediately when palm disappears.
    if(g.open){
      if(!s.openSince)s.openSince=now;
      if(now-s.openSince>180 && now-s.lastRCT>90){
        if(energy>=2 && hp<100){
          energy-=2; hp=Math.min(100,hp+1.8); updateHud();
          spawnRCT(p.x,p.y);
          s.lastRCT=now;
        } else if(hp>=100) setMode('RCT FULL');
      }
    }else s.openSince=0;

    // Fist recharge: medium speed, only while fist is actually detected.
    if(g.fist && !g.open){
      energy=Math.min(MAX_ENERGY,energy+0.9);
      updateHud();
      setMode('ENERGY RECHARGE');
    }

    // Point + move: trigger once per quick directional swipe. Spawn at the FINGER POSITION
    // at the moment the swipe completes, with the slash CENTER there. It then stays fixed.
    if(g.indexExtended && !g.open){
      const speed=Math.hypot(vx,vy)*Number(sensitivity.value);
      if(speed>380 && now-s.swipeCooldown>300 && now-lastSlashTime>120){
        let angle=Math.atan2(vy,vx);
        // The image is horizontal; its long axis follows the swipe direction.
        if(spawnSlash(p.x,p.y,angle,true)){
          s.swipeCooldown=now; lastSlashTime=now;
        }
      }
    }

    s.last=p; s.lastTime=now;
  });
  // Drop missing hands so RCT cannot continue after the gesture disappears.
  if(list.length===0){
    handState.clear();
    if(slashes.length===0)setMode(cameraStarted?'READY':'CAMERA OFF');
  }
}

function spawnRCT(x,y){
  sparks.push({x,y,vx:0,vy:-8,born:performance.now(),life:220,rct:true});
}

function domainExpansion(){
  if(energy<80){setMode('DOMAIN: NOT ENOUGH ENERGY');return}
  energy-=80; combo=0; updateHud(); setMode('DOMAIN EXPANSION'); beep(70,.25,.06);
  const start=performance.now(), duration=5000;
  const timer=setInterval(()=>{
    if(performance.now()-start>=duration){clearInterval(timer);setMode('READY');return}
    const x=W*.15+Math.random()*W*.7, y=H*.18+Math.random()*H*.64;
    const a=Math.random()*Math.PI*2;
    spawnSlash(Math.max(10,x),Math.max(10,y),a,false);
  },260);
}

let domainTimer=0;
function detectDomain(results){
  if((results.multiHandLandmarks||[]).length>=2){
    const handsList=results.multiHandLandmarks;
    const a=handsList[0][0],b=handsList[1][0];
    const ax=(1-a.x)*W, ay=a.y*H, bx=(1-b.x)*W, by=b.y*H;
    if(Math.hypot(ax-bx,ay-by)<Math.min(W,H)*.30){
      if(!domainTimer)domainTimer=performance.now();
      if(performance.now()-domainTimer>850){domainTimer=0;domainExpansion()}
    }else domainTimer=0;
  }else domainTimer=0;
}

// Override callback so both systems run once per processed frame.
function handleResults(results){onHands(results);detectDomain(results)}

async function startCamera(){
  if(cameraStarted)return;
  try{
    statusEl.textContent='Requesting camera…';
    cameraStream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user',width:{ideal:960},height:{ideal:540},frameRate:{ideal:24,max:30}},
      audio:false
    });
    video.srcObject=cameraStream;
    await video.play();

    hands=new Hands({locateFile:file=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
    hands.setOptions({
      maxNumHands:2,
      modelComplexity:0, // lighter for i5-1145G7
      minDetectionConfidence:.58,
      minTrackingConfidence:.55
    });
    hands.onResults(handleResults);

    cameraStarted=true;
    statusEl.textContent='Camera running — point + swipe';
    setMode('READY');

    // Controlled processing rate: avoids hammering the laptop.
    const loop=async(ts)=>{
      if(!cameraStarted)return;
      requestAnimationFrame(loop);
      if(processing || !video.videoWidth || ts-lastProcess<42)return;
      lastProcess=ts; processing=true;
      try{await hands.send({image:video})}catch(e){console.warn(e)}
      processing=false;
    };
    requestAnimationFrame(loop);
  }catch(err){
    console.error(err);
    statusEl.textContent='Camera failed: '+(err.message||'permission blocked');
    setMode('CAMERA ERROR');
  }
}

document.getElementById('start').onclick=startCamera;
document.getElementById('test').onclick=()=>{
  spawnSlash(W/2,H/2,0,false);
};
document.getElementById('clear').onclick=()=>{
  slashes.length=0;sparks.length=0;setMode('READY');
};
document.getElementById('hide').onclick=()=>{
  panel.classList.add('hidden');showBtn.classList.remove('hidden');
};
showBtn.onclick=()=>{
  panel.classList.remove('hidden');showBtn.classList.add('hidden');
};

// Clicking the canvas is intentionally not used: camera hand tracking is the control input.
document.addEventListener('visibilitychange',()=>{
  if(document.hidden && cameraStream){
    cameraStream.getTracks().forEach(t=>t.enabled=false);
  }else if(cameraStream){
    cameraStream.getTracks().forEach(t=>t.enabled=true);
  }
});
