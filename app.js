const video=document.getElementById('camera');
const canvas=document.getElementById('overlay');
const ctx=canvas.getContext('2d');
const panel=document.getElementById('panel');
const statusEl=document.getElementById('status');
const comboEl=document.getElementById('combo');
const energyEl=document.getElementById('energy');
const sensitivity=document.getElementById('sensitivity');

const slashImage=new Image();
slashImage.src='dismantle-vfx.png';

let W=innerWidth,H=innerHeight,dpr=1;
let combo=0, energy=300;
let tracking=false, lastPoint=null, gestureStart=null;
let slashes=[];
let audioCtx=null;

function resize(){
  W=innerWidth; H=innerHeight; dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener('resize',resize); resize();

function updateHud(){
  comboEl.textContent=combo;
  energyEl.style.width=(energy/300*100)+'%';
}
updateHud();

function beep(){
  try{
    audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
    const o=audioCtx.createOscillator(), g=audioCtx.createGain();
    o.type='sawtooth'; o.frequency.setValueAtTime(180,audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(70,audioCtx.currentTime+.09);
    g.gain.setValueAtTime(.045,audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.12);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime+.12);
  }catch{}
}

/*
  ONE VFX ONLY.
  The uploaded image is the sole slash asset.
  No old arrow, diagonal, vertical, random-sheet, or multi-slash assets remain.
*/
function spawnSlash(x,y,angle){
  if(energy<12)return;
  energy=Math.max(0,energy-12);
  combo++;
  updateHud();
  beep();

  slashes.push({
    x,y,angle,
    born:performance.now(),
    life:470,
    scale:Math.min(W,H)/1250
  });
}

function drawSlash(s,now){
  const age=now-s.born;
  if(age>=s.life)return false;

  const enter=Math.min(age/65,1);
  const fade=Math.min((s.life-age)/120,1);
  const alpha=enter*fade;

  // The image is drawn from its CENTER.
  // This is what keeps the slash centered instead of putting its tip on the finger.
  const aspect=2048/700;
  const width=Math.min(W*.72,1100)*(.72+.28*enter)*s.scale/.75;
  const height=width/aspect;

  ctx.save();
  ctx.translate(s.x,s.y);
  ctx.rotate(s.angle);
  ctx.globalAlpha=alpha;
  ctx.globalCompositeOperation='screen';

  // slight "zap" growth, no travelling/flying motion
  ctx.drawImage(slashImage,-width/2,-height/2,width,height);

  ctx.restore();
  return true;
}

function frame(now){
  ctx.clearRect(0,0,W,H);
  slashes=slashes.filter(s=>drawSlash(s,now));

  if(tracking && lastPoint){
    ctx.save();
    ctx.strokeStyle='rgba(255,255,255,.45)';
    ctx.fillStyle='#fff';
    ctx.beginPath();ctx.arc(lastPoint.x,lastPoint.y,4,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function screenPoint(e){
  const r=canvas.getBoundingClientRect();
  return {x:e.clientX-r.left,y:e.clientY-r.top};
}

canvas.addEventListener('pointerdown',e=>{
  tracking=true;
  gestureStart=lastPoint=screenPoint(e);
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointermove',e=>{
  if(tracking)lastPoint=screenPoint(e);
});
canvas.addEventListener('pointerup',e=>{
  if(!tracking)return;
  const end=screenPoint(e);
  const dx=end.x-gestureStart.x,dy=end.y-gestureStart.y;
  const distance=Math.hypot(dx,dy);
  if(distance>12){
    spawnSlash(end.x,end.y,Math.atan2(dy,dx));
  }
  tracking=false; lastPoint=null;
});

document.getElementById('test').onclick=()=>{
  spawnSlash(W/2,H/2,Math.random()*Math.PI*2);
};

document.getElementById('hide').onclick=()=>{
  panel.hidden=!panel.hidden;
};

document.getElementById('start').onclick=async()=>{
  try{
    const stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:'user',width:{ideal:1280},height:{ideal:720}},
      audio:false
    });
    video.srcObject=stream;
    statusEl.textContent='Camera running — swipe to Dismantle';
  }catch(err){
    statusEl.textContent='Camera permission was not granted.';
  }
};

// Fist-style medium recharge helper retained without making the laptop work hard.
setInterval(()=>{
  if(!tracking && energy<300){
    energy=Math.min(300,energy+3);
    updateHud();
  }
},1000);
