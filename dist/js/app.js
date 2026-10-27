import { Simulation, STEP, WIDTH } from './sim.js';
import { PLAYS, FORMATION, RECEIVERS, ROUTE_COLORS, COVERAGES, HOT_ROUTES } from './plays.js';
import { FieldScene } from './scene.js';
import { AdaptiveGraphics } from './graphics.js';
import { FieldAudio } from './audio.js';
const $=id=>document.getElementById(id),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const storage={read(){try{return JSON.parse(localStorage.getItem('footballsim.preferences.v1'))||{};}catch{return {};}},write(value){try{localStorage.setItem('footballsim.preferences.v1',JSON.stringify(value));}catch{}}};
const prefs={graphics:'auto',lighting:'day',camera:'broadcast',passStyle:'timing',...storage.read()};
const sim=new Simulation(),audio=new FieldAudio();
let view,graphics,inMenu=true,paused=false,showArt=true,replay=null,charge=null,started=false,frameId=0;
const keys=new Set(),touch={x:0,z:0,sprint:false},padMove={x:0,z:0,sprint:false};let padButtons=[],toastTimer,activeDialog=null;
const isTouch=matchMedia('(pointer: coarse)').matches;if(isTouch)document.body.classList.add('touch-active');
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2600);}
function savePrefs(){storage.write(prefs);}
function clearInput(){keys.clear();touch.x=touch.z=padMove.x=padMove.z=0;touch.sprint=padMove.sprint=false;charge=null;$('charge').hidden=true;document.querySelectorAll('.target-button').forEach(b=>b.classList.remove('active'));}
function movement(){
  const arrows=!charge;let x=(keys.has('KeyD')?1:0)-(keys.has('KeyA')?1:0)+(arrows&&keys.has('ArrowRight')?1:0)-(arrows&&keys.has('ArrowLeft')?1:0)+touch.x+padMove.x;
  let z=(keys.has('KeyW')?1:0)-(keys.has('KeyS')?1:0)+(arrows&&keys.has('ArrowUp')?1:0)-(arrows&&keys.has('ArrowDown')?1:0)+touch.z+padMove.z;
  const length=Math.hypot(x,z);if(length>1){x/=length;z/=length;}return {x,z,sprint:keys.has('ShiftLeft')||keys.has('ShiftRight')||touch.sprint||padMove.sprint};
}
function openDialog(id){if(activeDialog)return;clearInput();paused=true;activeDialog=$(id);activeDialog.showModal();audio.suspend();if(id==='pause')renderStats();}
function closeDialog(){if(!activeDialog)return;const d=activeDialog;activeDialog=null;d.close();paused=false;clearInput();last=performance.now();accumulator=0;graphics?.reset();audio.resume();}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',closeDialog));
document.querySelectorAll('dialog').forEach(d=>{d.addEventListener('cancel',e=>{e.preventDefault();closeDialog();});d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});});
function syncPlay(){view?.setPlay(sim.effectivePlay,sim.spot,sim.config.flip,sim.config.mode==='drive'?sim.toGo:null);$('offense').value=sim.config.offense;$('random-play').setAttribute('aria-pressed',String(sim.config.offense==='random'));$('play-name').textContent=sim.play.name;$('formation').textContent=sim.play.formation+(sim.config.offense==='random'?' · RANDOM':'')+(sim.audibled?' · AUDIBLE':'');$('read-tip').textContent=Object.keys(sim.hotRoutes).length?'Hot routes set. Check the updated play art before the snap.':sim.play.read;renderPlaybook();clearInput();renderHUD();}
function start(){if(!view)return;inMenu=false;started=true;$('welcome').hidden=true;$('hud').hidden=false;$('scoreboard').hidden=false;$('pause-button').hidden=false;$('touch-controls').hidden=!isTouch;view.firstFrame=true;graphics.reset();last=performance.now();syncPlay();}
function snap(){if(inMenu){start();return;}if(paused||replay)return;if(sim.phase==='presnap'){sim.snap();clearInput();}else if(sim.phase==='dead'){sim.next();syncPlay();}renderHUD();}
function beginCharge(index){if(inMenu||paused||replay||sim.phase!=='live'||sim.carrier!=='QB'||sim.crossedLine||sim.play.type==='run')return;if(sim.play.type==='pa'&&sim.time<1.1){toast('Let the play-action fake develop.');return;}charge={id:RECEIVERS[index],index,started:performance.now()};$('charge').hidden=false;document.querySelectorAll('.target-button').forEach((b,i)=>b.classList.toggle('active',i===index));}
function releaseCharge(index){if(!charge||charge.index!==index)return;const duration=(performance.now()-charge.started)/1000,style=prefs.passStyle==='timing'?(duration<.17?'lob':duration<.43?'touch':'bullet'):prefs.passStyle;
  const lead={x:(keys.has('ArrowRight')?1:0)-(keys.has('ArrowLeft')?1:0),z:(keys.has('ArrowUp')?1:0)-(keys.has('ArrowDown')?1:0)};
  if(!sim.requestThrow(charge.id,style,lead))toast(sim.crossedLine?'You crossed the line — run the ball.':'Set for the snap before throwing.');
  charge=null;$('charge').hidden=true;document.querySelectorAll('.target-button').forEach(b=>b.classList.remove('active'));
}
function cycleCamera(){const cameras=['broadcast','wide','qb'];prefs.camera=cameras[(cameras.indexOf(prefs.camera)+1)%3];view.cameraMode=prefs.camera;$('camera').value=prefs.camera;savePrefs();toast({broadcast:'Broadcast camera',wide:'All-22 wide camera',qb:'Quarterback camera'}[prefs.camera]);}
function openPlaybook(){if(replay)closeReplay();if(!inMenu&&!['presnap','dead'].includes(sim.phase)){toast('Call the next play after this rep.');return;}openDialog('playbook');}
function togglePause(){if(inMenu)return;if(activeDialog)closeDialog();else openDialog('pause');}
async function toggleFullscreen(){
  try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else toast('Fullscreen is not supported in this browser.');}
  catch{toast('Fullscreen is unavailable here. Open the game directly in your browser.');}
}
$('fullscreen').onclick=toggleFullscreen;
document.addEventListener('fullscreenchange',()=>{const active=!!document.fullscreenElement;$('fullscreen').setAttribute('aria-pressed',String(active));$('fullscreen').setAttribute('aria-label',(active?'Exit':'Enter')+' fullscreen (F)');view?.resize();});
let hotReceiver=0;
function canAdjust(){if(inMenu||replay||sim.phase!=='presnap'){toast('Make adjustments before the snap.');return false;}return true;}
function openHotRoutes(){if(!canAdjust())return;if(sim.play.type==='run'){toast('Hot routes need a passing play. Press Z to call an audible.');return;}renderHotRoutes();openDialog('hot-routes');}
function openAudibles(){if(!canAdjust())return;renderAudibles();openDialog('audibles');}
function applyHotRoute(kind){if(sim.setHotRoute(RECEIVERS[hotReceiver],kind)){syncPlay();renderHotRoutes();}}
function chooseAudible(id){if(sim.audible(id)){syncPlay();closeDialog();toast('Audible: '+sim.play.name);}}
function renderHotRoutes(){
  const id=RECEIVERS[hotReceiver],current=sim.hotRoutes[id];$('hot-route-current').textContent='RECEIVER '+(hotReceiver+1)+' · '+(HOT_ROUTES.find(r=>r.id===current)?.label||'Original route');
  $('hot-route-receivers').replaceChildren();RECEIVERS.forEach((id,i)=>{const b=document.createElement('button');b.className='receiver-choice';b.textContent=String(i+1);b.style.setProperty('--target-color',ROUTE_COLORS[i]);b.setAttribute('aria-label','Receiver '+(i+1));b.setAttribute('aria-pressed',String(i===hotReceiver));b.onclick=()=>{hotReceiver=i;renderHotRoutes();};$('hot-route-receivers').append(b);});
  $('hot-route-grid').replaceChildren();HOT_ROUTES.forEach(route=>{const b=document.createElement('button');b.className='adjustment-card';b.innerHTML='<span>'+route.label+'</span><kbd>'+route.key+'</kbd>';b.setAttribute('aria-label',route.label+' route');b.setAttribute('aria-pressed',String(current===route.id));b.onclick=()=>applyHotRoute(route.id);$('hot-route-grid').append(b);});
}
function renderAudibles(){
  $('audible-grid').replaceChildren();PLAYS.forEach((play,i)=>{const b=document.createElement('button');b.className='adjustment-card';b.innerHTML='<div><span>'+play.name+'</span><small>'+play.tag+'</small></div><kbd>'+(i+1)+'</kbd>';b.setAttribute('aria-label','Audible '+(i+1)+': '+play.name);b.setAttribute('aria-pressed',String(play.id===sim.play.id));b.onclick=()=>chooseAudible(play.id);$('audible-grid').append(b);});
}
function renderStats(){const s=sim.stats;$('session-stats').innerHTML=`<div><strong>${s.completions}/${s.attempts}</strong><span>COMP / ATT</span></div><div><strong>${s.yards}</strong><span>TOTAL YARDS</span></div><div><strong>${s.td}</strong><span>TOUCHDOWNS</span></div><div><strong>${s.reps}</strong><span>REPS</span></div><div><strong>${s.ints}</strong><span>INTS</span></div><div><strong>${s.sacks}</strong><span>SACKS</span></div>`;}
function openReplay(){if(sim.phase!=='dead'||sim.recording.length<2)return;clearInput();replay={time:0,playing:true,frames:sim.recording.slice(),duration:sim.recording.at(-1).time};$('replay-controls').hidden=false;$('result').hidden=true;$('replay-play').textContent='Ⅱ';view.firstFrame=true;audio.suspend();}
function closeReplay(){replay=null;$('replay-controls').hidden=true;view.firstFrame=true;audio.resume();renderHUD();}
let playFilter='all';
function diagram(play){const map=([x,z])=>[100+x*3.1,99-z*2.1];let svg='<svg viewBox="0 0 200 115" role="img" aria-label="Route diagram"><path d="M5 34H195M5 66H195M5 99H195" stroke="#d1e3d4" stroke-opacity=".12" fill="none"/><path d="M100 4V110" stroke="#d1e3d4" stroke-opacity=".08" stroke-dasharray="2 4"/>';
  RECEIVERS.forEach((id,i)=>{const p=FORMATION.find(p=>p.id===id),points=[[p.x,p.z],...play.routes[id]].map(([x,z])=>map([sim.config.flip?-x:x,z]));svg+=`<polyline points="${points.map(p=>p.join(',')).join(' ')}" stroke="${ROUTE_COLORS[i]}" fill="none" stroke-width="1.6" stroke-linejoin="round" opacity=".9"/><circle cx="${points[0][0]}" cy="${points[0][1]}" r="2.8" fill="${ROUTE_COLORS[i]}"/>`;});
  for(let i=-2;i<=2;i++)svg+=`<rect x="${98+i*5}" y="98" width="3" height="3" fill="#cbdad3"/>`;svg+='<circle cx="100" cy="109" r="3" fill="#f3f5e9"/></svg>';return svg;}
function renderPlaybook(){const grid=$('play-grid');grid.replaceChildren();PLAYS.filter(p=>playFilter==='all'||(playFilter==='run'?p.type==='run':p.type!=='run')).forEach(play=>{const b=document.createElement('button');b.className='play-card'+(play.id===sim.play.id?' selected':'');b.setAttribute('aria-label',play.name+' — '+play.tag);b.innerHTML=`<span class="play-tag">${play.tag}</span>${play.id===sim.play.id?'<span class="selected-dot">●</span>':''}<h3>${play.name}</h3>${diagram(play)}<small>${play.formation}</small>`;b.onclick=()=>{if(sim.phase==='dead')sim.next();sim.selectPlay(play.id);syncPlay();closeDialog();if(inMenu)start();};grid.append(b);});}
PLAYS.forEach(play=>{const option=document.createElement('option');option.value=play.id;option.textContent=play.name;$('offense').append(option);});
RECEIVERS.forEach((id,i)=>{
  const key=String(i+1),b=document.createElement('button');b.className='target-button';b.style.setProperty('--target-color',ROUTE_COLORS[i]);b.setAttribute('aria-label','Pass to receiver '+key);b.setAttribute('aria-keyshortcuts',key);b.innerHTML=`<strong>${key}</strong>`;
  b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);beginCharge(i);});b.addEventListener('pointerup',()=>releaseCharge(i));b.addEventListener('pointercancel',clearInput);$('targets').append(b);
  const label=document.createElement('div');label.className='receiver-marker';label.style.setProperty('--target-color',ROUTE_COLORS[i]);label.textContent=key;label.id='marker-'+id;$('receiver-labels').append(label);
});
function fieldPosition(z){const yard=Math.round(z-10);return yard<50?'OWN '+yard:yard===50?'MIDFIELD':'OPP '+(100-yard);}
function renderHUD(){
  const dead=sim.phase==='dead',pre=sim.phase==='presnap',live=!pre&&!dead,passing=sim.phase==='live'&&sim.play.type!=='run'&&!sim.crossedLine;
  document.body.classList.toggle('playing',live);document.body.classList.toggle('drive-mode',sim.config.mode==='drive');
  $('phase-badge').innerHTML='<span class="live-dot"></span>'+(replay?'INSTANT REPLAY':{presnap:'PRE-SNAP',live:sim.play.type==='run'?'HANDOFF':'IN THE POCKET',air:'BALL IN FLIGHT',run:'BALL CARRIER',dead:'REP COMPLETE'}[sim.phase]);
  $('coverage-label').textContent='DEFENSE · '+(sim.config.coverage==='random'&&pre?'DISGUISED':COVERAGES[sim.coverage].label.toUpperCase());
  $('down-distance').hidden=sim.config.mode!=='drive';$('practice-label').textContent=sim.config.mode==='drive'?'MOVE THE CHAINS':'PRACTICE';
  $('down-distance').textContent=['','1ST','2ND','3RD','4TH'][sim.down]+' & '+(sim.spot+sim.toGo>=110?'GOAL':sim.toGo);
  $('drive-status').hidden=sim.config.mode!=='drive';$('drive-down').textContent=$('down-distance').textContent;$('drive-detail').textContent=(sim.spot+sim.toGo>=110?'GOAL TO GO':sim.toGo+' YARDS TO FIRST DOWN')+' · BALL AT '+fieldPosition(sim.spot);
  $('presnap-adjustments').hidden=!pre||!!replay;$('hot-routes-open').disabled=sim.play.type==='run';$('hot-routes-open').title=sim.play.type==='run'?'Call a passing play to set hot routes':'Hot routes · H';
  $('field-position').textContent=fieldPosition(sim.spot);$('rep-number').textContent=String(sim.stats.reps+(pre?1:0)).padStart(2,'0');
  $('snap').hidden=!pre;$('throw-away').hidden=!passing;$('play-hint').hidden=!pre||!!replay;
  $('targets').hidden=(!pre&&!passing)||sim.play.type==='run'||!!replay;
  $('result').hidden=!dead||!!replay;$('touch-controls').hidden=!isTouch||!live||!!replay;
  const p=sim.byId[sim.carrier||sim.selected];$('player-role').textContent=p.role.toUpperCase()+' '+p.number;$('stamina-fill').style.width=p.stamina*100+'%';
  $('player-state').textContent=pre?'READY':sim.crossedLine?'RUN ONLY':sim.phase==='air'?'PASS AWAY':p.stamina<.25?'FATIGUED':Math.hypot(p.vx,p.vz)>1?'ON THE MOVE':'FEET SET';
  if(dead&&sim.result){const r=sim.result;$('result-tag').textContent=r.kind==='touchdown'?'TOUCHDOWN':r.kind==='interception'?'TURNOVER':r.firstDown&&sim.config.mode==='drive'?'FIRST DOWN':'REP COMPLETE';$('result-title').textContent=r.label;$('result-detail').textContent=(r.yards>0?'+':'')+r.yards+' YDS  ·  '+r.time.toFixed(1)+' SEC  ·  '+sim.stats.completions+'/'+sim.stats.attempts+' PASSING';}
}
function drawMinimap(state){const c=$('minimap').getContext('2d'),w=180,h=180,start=Math.max(0,Math.min(75,state.spot-12));c.clearRect(0,0,w,h);c.fillStyle='#102d30';c.fillRect(0,0,w,h);c.strokeStyle='#d9e9d329';c.lineWidth=1;for(let z=0;z<=120;z+=5){const y=h-(z-start)*3.4;c.beginPath();c.moveTo(8,y);c.lineTo(w-8,y);c.stroke();}if(sim.config.mode==='drive'){c.strokeStyle='#e1bf6688';const fd=h-(state.spot+sim.toGo-start)*3.4;c.beginPath();c.moveTo(8,fd);c.lineTo(172,fd);c.stroke();}for(const p of state.players){const y=h-(p.z-start)*3.4,x=w/2+p.x*3;c.fillStyle=p.id===state.carrier?'#c6fc88':sim.byId[p.id].team==='offense'?'#58bdd8':'#e4e6df';c.beginPath();c.arc(x,y,p.id===state.carrier?3.5:2.4,0,Math.PI*2);c.fill();}c.fillStyle='#f4b864';c.beginPath();c.arc(w/2+state.ball.x*3,h-(state.ball.z-start)*3.4,2,0,Math.PI*2);c.fill();}
function positionMarkers(state){const visible=!inMenu&&!replay&&['presnap','live'].includes(state.phase)&&sim.play.type!=='run'&&!sim.crossedLine;RECEIVERS.forEach(id=>{const el=$('marker-'+id),p=state.players.find(p=>p.id===id),s=view.project(p.x,3.2,p.z);el.hidden=!visible||!s.visible;el.style.left=s.x+'px';el.style.top=s.y+'px';});}
$('start').onclick=start;$('snap').onclick=snap;$('next').onclick=snap;$('throw-away').onclick=()=>sim.throwAway();
$('settings-open').onclick=()=>openDialog('settings');$('help-open').onclick=()=>openDialog('help');$('playbook-open').onclick=openPlaybook;$('result-playbook').onclick=openPlaybook;
$('random-play').onclick=()=>{if(sim.phase==='dead')sim.next();sim.selectPlay('random');syncPlay();closeDialog();if(inMenu)start();};
$('hot-routes-open').onclick=openHotRoutes;$('audible-open').onclick=openAudibles;$('hot-route-reset').onclick=()=>applyHotRoute('default');
$('pause-button').onclick=togglePause;$('resume').onclick=closeDialog;$('restart').onclick=()=>{sim.reset();syncPlay();closeDialog();};
$('art-button').onclick=()=>{showArt=!showArt;$('art-button').setAttribute('aria-pressed',String(showArt));};
$('replay-open').onclick=openReplay;$('replay-close').onclick=closeReplay;$('replay-play').onclick=()=>{if(!replay)return;if(replay.time>=replay.duration)replay.time=0;replay.playing=!replay.playing;$('replay-play').textContent=replay.playing?'Ⅱ':'▶';};
$('replay-scrub').oninput=()=>{if(replay){replay.time=Number($('replay-scrub').value)/1000*replay.duration;replay.playing=false;$('replay-play').textContent='▶';}};
$('sound').onclick=async()=>{await audio.setEnabled(!audio.enabled);$('sound').setAttribute('aria-pressed',String(audio.enabled));$('sound').setAttribute('aria-label',audio.enabled?'Mute sound':'Enable sound');$('sound').querySelector('.mute-dot').hidden=audio.enabled;if(paused)audio.suspend();};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{playFilter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(el=>el.classList.toggle('active',el===b));renderPlaybook();});
$('flip-play').onchange=()=>{if(sim.phase==='dead')sim.next();sim.config.flip=$('flip-play').checked;sim.reset();syncPlay();};
for(const [id,key] of [['graphics','graphics'],['lighting','lighting'],['camera','camera'],['pass-style','passStyle']]){$(id).value=prefs[key];$(id).onchange=()=>{prefs[key]=$(id).value;savePrefs();if(key==='graphics')graphics?.select(prefs.graphics);if(key==='lighting')view?.setLighting(prefs.lighting);if(key==='camera'&&view)view.cameraMode=prefs.camera;};}
$('apply-settings').onclick=()=>{if(replay)closeReplay();sim.reset();sim.configure({offense:$('offense').value,coverage:$('coverage').value,difficulty:$('difficulty').value,mode:$('practice-mode').value,spot:Number($('spot').value)});syncPlay();closeDialog();toast('Practice conditions updated.');};
window.addEventListener('keydown',e=>{
  if(['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
  if(e.code==='KeyF'){e.preventDefault();if(!e.repeat)toggleFullscreen();return;}
  if(activeDialog){
    if(e.code==='Escape'){e.preventDefault();closeDialog();return;}if(e.repeat)return;
    if(activeDialog.id==='hot-routes'){
      if(/^Digit[1-5]$/.test(e.code)){e.preventDefault();hotReceiver=Number(e.code.slice(-1))-1;renderHotRoutes();}
      else if(e.code==='Digit0'){e.preventDefault();applyHotRoute('default');}
      else {const route=HOT_ROUTES.find(r=>e.code==='Key'+r.key);if(route){e.preventDefault();applyHotRoute(route.id);}}
    }else if(activeDialog.id==='audibles'&&/^Digit[1-8]$/.test(e.code)){e.preventDefault();chooseAudible(PLAYS[Number(e.code.slice(-1))-1].id);}return;
  }
  const used=['Space','Enter','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','KeyB','KeyC','KeyH','KeyZ','KeyP','Escape','KeyX','KeyR','Digit1','Digit2','Digit3','Digit4','Digit5','ShiftLeft','ShiftRight'];
  if(used.includes(e.code))e.preventDefault();if(e.repeat)return;keys.add(e.code);
  if(e.code==='Space'||e.code==='Enter')snap();else if(e.code==='Escape'||e.code==='KeyP')togglePause();else if(e.code==='KeyH')openHotRoutes();else if(e.code==='KeyZ')openAudibles();else if(e.code==='KeyB')openPlaybook();else if(e.code==='KeyC')cycleCamera();else if(e.code==='Tab'){$('art-button').click();}else if(e.code==='KeyR')openReplay();else if(e.code==='KeyX')sim.throwAway();else if(e.code==='KeyQ')sim.juke(-1);else if(e.code==='KeyE')sim.juke(1);else if(/^Digit[1-5]$/.test(e.code))beginCharge(Number(e.code.slice(-1))-1);
});
window.addEventListener('keyup',e=>{if(/^Digit[1-5]$/.test(e.code))releaseCharge(Number(e.code.slice(-1))-1);keys.delete(e.code);});
window.addEventListener('blur',()=>{clearInput();if(started&&!paused&&!inMenu)openDialog('pause');});
const joystick=$('joystick'),thumb=joystick.querySelector('i');let joyPointer=null;
function updateJoy(e){const r=joystick.getBoundingClientRect(),x=e.clientX-r.left-r.width/2,z=-(e.clientY-r.top-r.height/2),d=Math.max(36,Math.hypot(x,z));touch.x=x/d;touch.z=z/d;thumb.style.transform=`translate(${touch.x*32}px,${-touch.z*32}px)`;}
joystick.onpointerdown=e=>{e.preventDefault();joyPointer=e.pointerId;joystick.setPointerCapture(e.pointerId);updateJoy(e);};joystick.onpointermove=e=>{if(e.pointerId===joyPointer)updateJoy(e);};joystick.onpointerup=joystick.onpointercancel=()=>{joyPointer=null;touch.x=touch.z=0;thumb.style.transform='';};
$('touch-sprint').onpointerdown=e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);touch.sprint=true;};$('touch-sprint').onpointerup=$('touch-sprint').onpointercancel=()=>touch.sprint=false;$('touch-juke-left').onclick=()=>sim.juke(-1);$('touch-juke-right').onclick=()=>sim.juke(1);
function pollGamepad(){const pad=navigator.getGamepads?.().find(p=>p&&p.mapping==='standard');if(!pad){padMove.x=padMove.z=0;padMove.sprint=false;padButtons=[];return;}$('input-device').textContent='CONTROLLER CONNECTED';const deadzone=v=>Math.abs(v)<.18?0:(Math.abs(v)-.18)/.82*Math.sign(v);padMove.x=deadzone(pad.axes[0]);padMove.z=-deadzone(pad.axes[1]);padMove.sprint=pad.buttons[7]?.pressed;const passButtons=[0,2,3,1,5];
  pad.buttons.forEach((b,i)=>{const was=padButtons[i]||false;if(b.pressed&&!was){if(i===9)togglePause();else if(!paused){if(i===0&&(inMenu||sim.phase==='presnap'||sim.phase==='dead'))snap();else if(passButtons.includes(i))beginCharge(passButtons.indexOf(i));else if(i===8)cycleCamera();else if(i===14)sim.juke(-1);else if(i===15)sim.juke(1);}}if(!b.pressed&&was&&passButtons.includes(i))releaseCharge(passButtons.indexOf(i));});padButtons=pad.buttons.map(b=>b.pressed);
}
window.addEventListener('resize',()=>view?.resize());
let last=performance.now(),lastRender=last,nextRender=0,accumulator=0,uiElapsed=0,fpsElapsed=0,fpsFrames=0;
function frame(now){frameId=requestAnimationFrame(frame);if(document.hidden||!view)return;const raw=Math.max(0,(now-last)/1000);last=now;pollGamepad();if(paused)return;const dt=Math.min(raw,.1);
  if(!inMenu&&!replay){accumulator+=dt;while(accumulator>=STEP){sim.step(STEP,movement());accumulator-=STEP;}for(const event of sim.drainEvents())audio.event(event);}
  if(replay&&replay.playing){replay.time=Math.min(replay.duration,replay.time+dt*.5);if(replay.time>=replay.duration){replay.playing=false;$('replay-play').textContent='▶';}}
  if(now+.5<nextRender)return;const interval=inMenu?50:1000/60;nextRender=now-nextRender>interval?now+interval:nextRender+interval;
  const renderDelta=Math.min(.15,(now-lastRender)/1000);lastRender=now;
  let state=sim.snapshot();if(replay){state=replay.frames[Math.min(replay.frames.length-1,Math.floor(replay.time/.05))];$('replay-scrub').value=String(replay.time/replay.duration*1000);}
  view.render(state,renderDelta,{menu:inMenu,showArt,replay:!!replay});graphics.sample(renderDelta*1000,!inMenu&&!replay,['presnap','dead'].includes(sim.phase));
  positionMarkers(state);if(charge){const duration=(now-charge.started)/1000;$('charge-fill').style.width=Math.min(100,duration/.6*100)+'%';$('charge-label').textContent='TO '+(charge.index+1)+' · '+(prefs.passStyle==='timing'?(duration<.17?'LOB':duration<.43?'TOUCH':'BULLET'):prefs.passStyle.toUpperCase());}
  uiElapsed+=renderDelta;fpsElapsed+=renderDelta;fpsFrames++;if(uiElapsed>.1){renderHUD();drawMinimap(state);uiElapsed=0;}if(fpsElapsed>1){$('fps').textContent=Math.round(fpsFrames/fpsElapsed)+' FPS';fpsElapsed=0;fpsFrames=0;}
}
document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frameId);clearInput();audio.suspend();if(started&&!paused)openDialog('pause');}else{last=performance.now();lastRender=last;nextRender=0;accumulator=0;graphics?.reset();frameId=requestAnimationFrame(frame);}});
try {
  view=new FieldScene($('field'),sim.players);view.setLighting(prefs.lighting);view.cameraMode=prefs.camera;
  graphics=new AdaptiveGraphics((profile,scale)=>{view.setQuality(profile,scale);$('quality-label').textContent=(prefs.graphics==='auto'?'AUTO · ':'')+profile.label.toUpperCase()+(scale<1?' · '+Math.round(scale*100)+'%':'');},prefs.graphics);
  syncPlay();$('load-status').textContent='FIELD READY · NO INSTALL REQUIRED';$('input-device').textContent=isTouch?'TOUCH CONTROLS':'KEYBOARD + MOUSE';frameId=requestAnimationFrame(frame);
  if(new URLSearchParams(location.search).has('debug'))window.footballsim={sim,view,graphics,start,snap,get paused(){return paused;},get replay(){return replay;}};
} catch(error){console.error(error);$('start').disabled=true;$('load-status').textContent='WEBGL 2 REQUIRED';$('error').hidden=false;$('error-message').textContent='FootballSim needs WebGL 2. Enable hardware acceleration in your browser, then reload. '+(error.message||'');}
