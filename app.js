const video=document.getElementById('camera');
const canvas=document.getElementById('overlay');
const ctx=canvas.getContext('2d');
const panel=document.getElementById('panel');
const statusEl=document.getElementById('status');
const comboEl=document.getElementById('combo');
const energyEl=document.getElementById('energy');
const hpEl=document.getElementById('hp');
const handCountEl=document.getElementById('handCount');

const slashImage=new Image();
slashImage.src='dismantle-vfx.png';

let W=innerWidth,H=innerHeight,dpr=1;
let combo=0,energy=300,hp=100;
let slashes=[];
let lastHands=[];
let previousIndex=null,previousPalm=null,pointStarted=null;
let lastSlashTime=0,fistSince=0,openSince=0,domainSince=0;
let rctActive=false,domainActive=false;
let cameraRunning=false,processing=false,handsReady=false;
let audioCtx=null;
let domainEnd=0,nextDomainSlash=0;

function resize(){
  W=innerWidth; H=innerHeight; dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener('resize',resize); resize();

function updateHud(){
  comboEl.textContent=combo;
  energyEl.style.width=`${Math.max(0,Math.min(300,energy))/3}%`;
  hpEl.style.width=`${Math.max(0,Math.min(100,hp))}%`;
  handCountEl.textContent=lastHands.length;
}
updateHud();

function beep(freq=180,d=.12){
  try{
    audioCtx ||= new (window.AudioContext||window.webkitAudioContext)();
    const o=audioCtx.createOscillator(),g=audioCtx.createGain();
    o.type='sawtooth'; o.frequency.value=freq;
    g.gain.setValueAtTime(.035,audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+d);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime+d);
  }catch{}
}

function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function screenPoint(lm){
  const vw=video.videoWidth||1280,vh=video.videoHeight||720;
  const scale=Math.max(W/vw,H/vh),dw=vw*scale,dh=vh*scale;
  const ox=(W-dw)/2,oy=(H-dh)/2;
  return {x:ox+(1-lm.x)*dw,y:oy+lm.y*dh};
}

// Finger extension is based on tip-vs-PIP distance from the wrist.
// This is much more stable for open-palm / fist detection than the old test.
function fingerExtended(lm,tip,pip){
  return dist(lm[tip],lm[0]) > dist(lm[pip],lm[0])*1.16 &&
         dist(lm[tip],lm[pip]) > dist(lm[pip],lm[tip===8?5:tip===12?9:tip===16?13:17])*0.55;
}
function handState(lm){
  const index=fingerExtended(lm,8,6);
  const middle=fingerExtended(lm,12,10);
  const ring=fingerExtended(lm,16,14);
  const pinky=fingerExtended(lm,20,18);
  const long=[index,middle,ring,pinky];
  const count=long.filter(Boolean).length;
  return {
    index,middle,ring,pinky,count,
    point:index && count===1,
    open:count>=3,
    fist:count<=1
  };
}

function palmCenter(lm){
  const ids=[0,5,9,13,17];
  let x=0,y=0;
  for(const i of ids){const p=screenPoint(lm[i]);x+=p.x;y+=p.y}
  return {x:x/ids.length,y:y/ids.length};
}

function clampSlashPosition(x,y,width,height,angle){
  // Keep the visual center safely inside the viewport even after rotation.
  const r=Math.hypot(width,height)/2;
  return {x:Math.max(r,Math.min(W-r,x)),y:Math.max(r,Math.min(H-r,y))};
}

function addSlash(x,y,a,opts={}){
  const now=performance.now();
  const cost=opts.domain?0:12;
  if(!opts.domain && (energy<cost || now-lastSlashTime<240)) return false;
  if(!opts.domain){energy-=cost;combo++;lastSlashTime=now;updateHud()}
  const aspect=(slashImage.naturalWidth||2048)/(slashImage.naturalHeight||700);
  const width=opts.domain ? Math.min(W*.36,600) : Math.min(W*.44,760);
  const height=width/aspect;
  const pos=clampSlashPosition(x,y,width,height,a);
  slashes.push({x:pos.x,y:pos.y,a,born:now,life:opts.domain?360:440,width,height,domain:!!opts.domain});
  if(!opts.domain) beep(190,.1); else beep(130+Math.random()*70,.055);
  return true;
}

function spawnSlash(x,y,a){addSlash(x,y,a)}

function triggerDomain(){
  if(domainActive || energy<45) return;
  domainActive=true; domainEnd=performance.now()+5000; nextDomainSlash=0;
  energy-=45; updateHud(); beep(70,.4);
  statusEl.textContent='DOMAIN EXPANSION — random Dismantle slashes for 5 seconds';
}

function domainTick(now){
  if(!domainActive) return;
  if(now>=domainEnd){domainActive=false;statusEl.textContent='2-hand tracking ON — Point/Move: Slash • Fist: Recharge • Open Palm: RCT • 2 Hands: Domain';return}
  if(now>=nextDomainSlash){
    const margin=Math.min(W,H)*.20;
    const x=margin+Math.random()*(W-margin*2);
    const y=margin+Math.random()*(H-margin*2);
    const a=Math.random()*Math.PI*2;
    addSlash(x,y,a,{domain:true});
    nextDomainSlash=now+120+Math.random()*180;
  }
}

function drawHand(lm,now){
  // Full-hand landmark/skeleton visualization, not just a single fingertip dot.
  const chains=[[0,1,2,3,4],[0,5,6,7,8],[0,9,10,11,12],[0,13,14,15,16],[0,17,18,19,20],[5,9,13,17]];
  ctx.save();
  ctx.lineWidth=2;
  ctx.strokeStyle='rgba(255,255,255,.72)';
  ctx.fillStyle='rgba(255,255,255,.9)';
  for(const chain of chains){
    ctx.beginPath();
    chain.forEach((id,i)=>{const p=screenPoint(lm[id]);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)});
    ctx.stroke();
  }
  for(let i=0;i<lm.length;i++){
    const p=screenPoint(lm[i]);
    ctx.beginPath();ctx.arc(p.x,p.y,i===8?5:3,0,Math.PI*2);ctx.fill();
  }
  ctx.restore();
}

function drawSlash(s,now){
  const age=now-s.born;if(age>=s.life)return false;
  const enter=Math.min(1,age/42);
  const hold=Math.min(1,Math.max(0,(age-70)/180));
  const fade=Math.min(1,(s.life-age)/90);
  const scale=.92+.08*enter;
  ctx.save();
  ctx.translate(s.x,s.y);ctx.rotate(s.a);
  ctx.globalAlpha=enter*fade;
  ctx.globalCompositeOperation='screen';
  ctx.drawImage(slashImage,-s.width*scale/2,-s.height*scale/2,s.width*scale,s.height*scale);
  ctx.restore();
  return true;
}

function render(now){
  ctx.clearRect(0,0,W,H);
  domainTick(now);
  slashes=slashes.filter(s=>drawSlash(s,now));
  if(domainActive){
    const left=Math.max(0,domainEnd-now);
    ctx.fillStyle='rgba(255,255,255,.025)';ctx.fillRect(0,0,W,H);
    ctx.strokeStyle='rgba(255,255,255,.38)';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(W/2,H/2,Math.min(W,H)*.38,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,.8)';ctx.font='700 14px system-ui';ctx.textAlign='center';
    ctx.fillText(`DOMAIN ${Math.ceil(left/1000)}s`,W/2,Math.min(H*.9,70));
  }
  if(rctActive&&previousPalm){
    const p=previousPalm;
    const pulse=1+Math.sin(now/80)*.12;
    const g=ctx.createRadialGradient(p.x,p.y,5,p.x,p.y,90*pulse);
    g.addColorStop(0,'rgba(255,255,255,.95)');
    g.addColorStop(.3,'rgba(230,245,255,.38)');
    g.addColorStop(.65,'rgba(255,255,255,.12)');
    g.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(p.x,p.y,90*pulse,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.72)';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(p.x,p.y,42+Math.sin(now/90)*6,0,Math.PI*2);ctx.stroke();
    ctx.beginPath();ctx.arc(p.x,p.y,62+Math.sin(now/120)*7,0,Math.PI*2);ctx.stroke();
  }
  if(previousIndex&&!rctActive){ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(previousIndex.x,previousIndex.y,4,0,Math.PI*2);ctx.fill()}
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

function onResults(res){
  const now=performance.now();
  lastHands=res.multiHandLandmarks||[];
  updateHud();
  if(!lastHands.length){
    previousIndex=null;previousPalm=null;pointStarted=null;
    fistSince=openSince=domainSince=0;rctActive=false;return;
  }

  if(lastHands.length>=2){
    if(!domainSince)domainSince=now;
    if(now-domainSince>500)triggerDomain();
  }else domainSince=0;

  // Prefer the first detected hand for single-hand skills.
  const lm=lastHands[0];
  const s=handState(lm);
  const idx=screenPoint(lm[8]);
  const palm=palmCenter(lm);
  previousIndex=idx;previousPalm=palm;

  // Dismantle: only a clear index-pointing pose. The slash is spawned at
  // the current point and then remains fixed in that position.
  if(s.point && !domainActive){
    fistSince=openSince=0;
    if(!pointStarted)pointStarted={...idx};
    const dx=idx.x-pointStarted.x,dy=idx.y-pointStarted.y;
    if(Math.hypot(dx,dy)>25 && now-lastSlashTime>240){
      spawnSlash(idx.x,idx.y,Math.atan2(dy,dx));
      pointStarted={...idx};
    }
  }else pointStarted=null;

  // Fist: medium recharge speed, not instant.
  if(s.fist && !s.open){
    openSince=0;
    if(!fistSince)fistSince=now;
    if(now-fistSince>260 && energy<300){energy=Math.min(300,energy+1.15);updateHud()}
  }else fistSince=0;

  // Open palm: RCT follows the palm, consumes energy, restores HP.
  if(s.open){
    fistSince=0;
    if(!openSince)openSince=now;
    if(now-openSince>220){
      rctActive=energy>0;
      if(rctActive){energy=Math.max(0,energy-.75);hp=Math.min(100,hp+.45);updateHud()}
    }
  }else{
    openSince=0;rctActive=false;
  }
}

async function setupHands(){
  if(!window.Hands){statusEl.textContent='Hand tracker did not load. Refresh the page.';return}
  const hands=new Hands({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`});
  hands.setOptions({maxNumHands:2,modelComplexity:0,minDetectionConfidence:.6,minTrackingConfidence:.55,selfieMode:false});
  hands.onResults(onResults);handsReady=true;
  async function loop(){
    if(cameraRunning&&video.readyState>=2&&!processing){
      processing=true;
      try{await hands.send({image:video})}catch(e){console.warn(e)}
      processing=false;
    }
    requestAnimationFrame(loop);
  }
  loop();
}

async function startCamera(){
  try{
    if(!handsReady)await setupHands();
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:960,max:1280},height:{ideal:540,max:720}},audio:false});
    video.srcObject=stream;await video.play();cameraRunning=true;
    statusEl.textContent='2-hand tracking ON — Point/Move: Slash • Fist: Recharge • Open Palm: RCT • 2 Hands: Domain';
  }catch(e){console.error(e);statusEl.textContent='Camera or hand tracking failed. Allow camera permission and refresh.'}
}

document.getElementById('start').onclick=startCamera;
document.getElementById('test').onclick=()=>addSlash(W/2,H/2,Math.random()*Math.PI*2);
document.getElementById('hide').onclick=()=>panel.hidden=!panel.hidden;
document.getElementById('show').onclick=()=>panel.hidden=false;
addEventListener('keydown',e=>{if(e.key.toLowerCase()==='h')panel.hidden=!panel.hidden});
