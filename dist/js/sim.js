import { FORMATION, PLAYS, RECEIVERS, routeFor, COVERAGES } from './plays.js';
export const STEP=1/120, WIDTH=53.333333, GOAL=110, GRAVITY=10.73;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
export function seededRandom(seed=12345) {let a=seed>>>0;return()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
export function flightVelocity(from,to,time) {return {x:(to.x-from.x)/time,y:(to.y-from.y+.5*GRAVITY*time*time)/time,z:(to.z-from.z)/time};}
export function nearestOnSegment(a,b,p){const dx=b.x-a.x,dz=b.z-a.z,den=dx*dx+dz*dz;const t=den?clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/den,0,1):0;return {x:a.x+dx*t,z:a.z+dz*t,y:a.y+(b.y-a.y)*t,t};}
function player(spec,team,spot,flip=false) {return {...spec,team,x:flip?-spec.x:spec.x,z:spot+spec.z,y:0,vx:0,vz:0,facing:team==='offense'?0:Math.PI,route:[],routeIndex:0,stamina:1,action:'ready',actionTime:0,stun:0,engaged:null,shed:0,phase:0};}
const DEFENSE=[
  {id:'DE1',number:91,role:'dl',x:-4.8,z:1.2,speed:6.7}, {id:'DT1',number:95,role:'dl',x:-1.5,z:1.2,speed:5.9},
  {id:'DT2',number:97,role:'dl',x:1.6,z:1.2,speed:5.9}, {id:'DE2',number:99,role:'dl',x:4.8,z:1.2,speed:6.7},
  {id:'LB1',number:54,role:'lb',x:-7,z:5,speed:7.7}, {id:'LB2',number:52,role:'lb',x:0,z:6,speed:7.6}, {id:'LB3',number:56,role:'lb',x:7,z:5,speed:7.7},
  {id:'CB1',number:23,role:'cb',x:-21,z:6,speed:8.7}, {id:'CB2',number:24,role:'cb',x:21,z:6,speed:8.7},
  {id:'FS',number:31,role:'s',x:-9,z:17,speed:8.5}, {id:'SS',number:32,role:'s',x:9,z:17,speed:8.5},
];
export class Simulation {
  constructor(seed=Date.now()) {
    this.random=seededRandom(seed);this.config={spot:35,coverage:'cover3',difficulty:'pro',mode:'reps',flip:false};
    this.stats={reps:0,attempts:0,completions:0,yards:0,passing:0,rushing:0,td:0,ints:0,sacks:0};
    this.down=1;this.toGo=10;this.spot=35;this.play=PLAYS[0];this.events=[];this.reset();
  }
  configure(options) {if(this.phase!=='presnap'&&this.phase!=='dead')return false;Object.assign(this.config,options);this.config.spot=clamp(Number(this.config.spot)||35,11,105);this.spot=this.config.spot;this.down=1;this.toGo=Math.min(10,GOAL-this.spot);this.reset();return true;}
  selectPlay(id){if(!['presnap','dead'].includes(this.phase))return false;this.play=PLAYS.find(p=>p.id===id)||this.play;this.reset();return true;}
  reset() {
    this.phase='presnap';this.time=0;this.deadTime=0;this.pass=null;this.throwIntent=null;this.result=null;this.handoff=false;this.crossedLine=false;this.tackler=null;
    this.selected='QB';this.carrier='QB';this.jukeCooldown=0;this.recording=[];this.recordClock=0;this.completed=false;this.threw=false;this.events=[];
    const cover=this.config.coverage; this.coverage=cover==='random'?['cover3','cover2','man','blitz'][Math.floor(this.random()*4)]:cover;
    this.players=FORMATION.map(p=>player(p,'offense',this.spot,this.config.flip));
    this.players.push(...DEFENSE.map(p=>player(p,'defense',this.spot)));
    this.players.forEach(p=>{p.shed=2.5+this.random()*2.8;p.route=routeFor(this.play,p.id,this.spot,this.config.flip);});
    this.byId=Object.fromEntries(this.players.map(p=>[p.id,p]));
    this.ball={x:0,y:.45,z:this.spot,vx:0,vy:0,vz:0};this.lastBall={...this.ball};this.saveFrame();
  }
  snap() {if(this.phase!=='presnap')return false;this.phase='live';this.events.push('snap');this.stats.reps++;return true;}
  requestThrow(id,style='bullet',lead={x:0,z:0}) {
    if(this.phase!=='live'||this.carrier!=='QB'||this.crossedLine||this.threw||this.throwIntent||this.play.type==='run'||!RECEIVERS.includes(id)||this.time<.28)return false;
    if(this.play.type==='pa'&&this.time<1.1)return false;
    this.throwIntent={id,style:['bullet','touch','lob'].includes(style)?style:'bullet',lead:{x:clamp(lead.x||0,-1,1),z:clamp(lead.z||0,-1,1)},at:this.time+.23};
    this.byId.QB.action='throw';this.byId.QB.actionTime=.4;return true;
  }
  throwAway(){if(this.phase!=='live'||this.carrier!=='QB'||this.crossedLine||this.threw||this.time<.3)return false;this.stats.attempts++;this.threw=true;this.finish('Thrown away',0,'incomplete');return true;}
  predict(p,t){let x=p.x,z=p.z,index=p.routeIndex,budget=p.speed*t;for(let i=index;i<p.route.length;i++){const q=p.route[i],d=Math.hypot(q.x-x,q.z-z);if(d>budget){x+=(q.x-x)*budget/d;z+=(q.z-z)*budget/d;break;}budget-=d;x=q.x;z=q.z;}return {x,z};}
  release() {
    const intent=this.throwIntent,p=this.byId[intent.id],qb=this.byId.QB;
    const speed={bullet:28,touch:22,lob:16}[intent.style];let duration=clamp(dist(qb,p)/speed,.42,2.8),target;
    for(let i=0;i<3;i++){target=this.predict(p,duration);duration=clamp(dist(qb,target)/speed,.42,2.8);}
    const nearest=Math.min(...this.players.filter(d=>d.team==='defense').map(d=>dist(d,qb)));
    const pressure=clamp((3.3-nearest)/2.7,0,1),moving=Math.hypot(qb.vx,qb.vz)/7;
    const spread=.18+moving*1.6+pressure*2.8;
    target.x+=intent.lead.x*2.5+(this.random()-.5)*spread;target.z+=intent.lead.z*2.5+(this.random()-.5)*spread;
    target.x=clamp(target.x,-29,29);target.z=clamp(target.z,0,119);
    const from={x:qb.x+.25,y:1.85,z:qb.z+.35},to={...target,y:1.6},v=flightVelocity(from,to,duration);
    this.ball={...from,vx:v.x,vy:v.y,vz:v.z};this.pass={target:to,receiver:p.id,duration,elapsed:0,style:intent.style,pressure};
    this.threw=true;this.stats.attempts++;this.phase='air';this.carrier=null;this.throwIntent=null;this.events.push('throw');
    qb.action='throw';qb.actionTime=.4;
  }
  juke(direction=1){if(!['live','run'].includes(this.phase)||this.jukeCooldown>0)return false;const p=this.byId[this.carrier];if(!p||p.stamina<.2)return false;this.jukeCooldown=1.5;p.action='juke';p.actionTime=.4;p.vx+=direction*4.5;p.stamina-=.18;for(const d of this.players.filter(p=>p.team==='defense'))if(dist(d,p)<2.6)d.stun=.45;this.events.push('juke');return true;}
  move(p,target,dt,speedFactor=1) {
    if(p.stun>0){p.stun=Math.max(0,p.stun-dt);speedFactor*=.15;}
    const dx=target.x-p.x,dz=target.z-p.z,d=Math.hypot(dx,dz),speed=Math.min(p.speed*speedFactor,d/Math.max(dt,.001));
    const desiredX=d>.04?dx/d*speed:0,desiredZ=d>.04?dz/d*speed:0,accel=p.role==='ol'||p.role==='dl'?14:20;
    const dvx=desiredX-p.vx,dvz=desiredZ-p.vz,delta=Math.hypot(dvx,dvz),limit=accel*dt;
    p.vx+=delta>limit?dvx/delta*limit:dvx;p.vz+=delta>limit?dvz/delta*limit:dvz;
    p.x+=p.vx*dt;p.z+=p.vz*dt;p.phase+=Math.hypot(p.vx,p.vz)*dt;
    if(Math.hypot(p.vx,p.vz)>.4)p.facing=Math.atan2(p.vx,p.vz);
    p.x=clamp(p.x,-29,29);p.z=clamp(p.z,0,120);
  }
  step(dt,input={}) {
    if(this.phase==='presnap')return;
    this.jukeCooldown=Math.max(0,this.jukeCooldown-dt);
    if(this.phase==='dead'){this.deadTime+=dt;this.players.forEach(p=>{p.vx*=.92;p.vz*=.92;});return;}
    this.time+=dt;
    this.players.forEach(p=>{p.actionTime=Math.max(0,p.actionTime-dt);if(!p.actionTime)p.action='run';p.engaged=null;});
    const controlled=this.byId[this.carrier||this.selected];
    if(this.carrier&&controlled&&!(this.play.type==='run'&&!this.handoff)) {
      let x=input.x||0,z=input.z||0;const len=Math.hypot(x,z);if(len>1){x/=len;z/=len;}
      const sprint=!!input.sprint&&controlled.stamina>.08;
      controlled.stamina=clamp(controlled.stamina+(sprint&&len>.1?-.19:.12)*dt,0,1);
      this.move(controlled,{x:controlled.x+x*8,z:controlled.z+z*8},dt,sprint?1.14:.83);
      if(controlled.id==='QB'&&this.time<.6&&!len)this.move(controlled,{x:controlled.x,z:this.spot-6},dt,.5);
    }
    if(this.carrier==='QB'&&this.byId.QB.z>this.spot+.3)this.crossedLine=true;
    // Zone blocking and protection share a physical engagement model.
    const claimed=new Set(),rushCount=COVERAGES[this.coverage].rushers;
    for(const o of this.players.filter(p=>p.team==='offense'&&p.role==='ol')) {
      const defenders=this.players.filter(d=>d.team==='defense'&&!claimed.has(d.id)).sort((a,b)=>dist(o,a)-dist(o,b));
      const d=defenders[0]; if(!d)continue;claimed.add(d.id);
      const run=this.play.type==='run';const desired={x:d.x+(run?(this.config.flip?-1:1)*.2:0),z:run?d.z-.7:Math.min(this.spot-.7,d.z-.8)};
      this.move(o,desired,dt,run?.85:.5);
      if(dist(o,d)<1.55&&this.time<d.shed+(run?.9:0)) {o.engaged=d.id;d.engaged=o.id;o.action='block';o.actionTime=.1;d.action='block';d.actionTime=.1;d.vx*=.8;d.vz*=.8;}
    }
    for(const id of RECEIVERS) {
      const p=this.byId[id];if(this.carrier===id)continue;
      let target=p.route[p.routeIndex]||{x:p.x,z:p.z};
      if(dist(p,target)<.55&&p.routeIndex<p.route.length-1)target=p.route[++p.routeIndex];
      if(this.phase==='air'&&this.pass.receiver===id&&this.pass.elapsed>.12)target=this.pass.target;
      if(this.play.type==='run'&&id!=='R') {
        const defender=this.players.filter(d=>d.team==='defense'&&d.z>p.z-1).sort((a,b)=>dist(a,p)-dist(b,p))[0];
        if(defender&&dist(p,defender)<3.5){target=defender;if(dist(p,defender)<1.2){defender.engaged=p.id;p.action='block';p.actionTime=.1;}}
      }
      this.move(p,target,dt,this.time<.22?0:1);
    }
    if(this.play.type==='run'&&!this.handoff) {
      const qb=this.byId.QB,rb=this.byId.R;
      this.move(qb,{x:this.config.flip?1:-1,z:this.spot-4.3},dt,.5);
      if(this.time>.68){this.handoff=true;this.carrier='R';this.selected='R';this.phase='run';rb.action='carry';rb.actionTime=.3;this.events.push('handoff');}
    }
    const diff={rookie:.85,pro:.97,allpro:1.06}[this.config.difficulty]||.97;
    const defenders=this.players.filter(p=>p.team==='defense');
    defenders.forEach((d,i)=>{
      if(d.engaged){const o=this.byId[d.engaged];this.move(d,{x:o.x,z:o.z+.8},dt,.16);return;}
      let target={x:d.x,z:d.z},factor=diff;
      const pursuit=this.phase==='run'||this.crossedLine||(this.play.type==='run'&&this.time>.8);
      if(pursuit){const c=this.byId[this.carrier||'R'];target={x:c.x+c.vx*.24,z:c.z+c.vz*.24};}
      else if(i<rushCount){const qb=this.byId.QB;target={x:qb.x+(i===0?-1:i===3?1:0)*Math.max(0,1-this.time*.35),z:qb.z};factor*=.84;}
      else {
        const ids=['Y','R','A','X','B','Y','A'];const receiver=this.byId[ids[i-4]];
        if(this.coverage==='man'||this.coverage==='blitz'){target={x:receiver.x+receiver.vx*.13,z:receiver.z+1.2+receiver.vz*.13};}
        else {
          let zx=d.x,depth=8;
          if(this.coverage==='cover3') {
            const zones=[[-11,7],[0,9],[11,7],[-19,23],[19,23],[0,26],[7,12]];[zx,depth]=zones[i-4];
          } else {const zones=[[-8,11],[0,12],[8,11],[-23,5],[23,5],[-12,25],[12,25]];[zx,depth]=zones[i-4];}
          target={x:zx,z:Math.min(115,this.spot+depth)};
          const near=RECEIVERS.map(id=>this.byId[id]).filter(p=>Math.abs(p.x-zx)<(depth>20?12:8)&&p.z>this.spot+(depth>20?9:-2)).sort((a,b)=>dist(a,target)-dist(b,target))[0];
          if(near){target={x:zx*.28+near.x*.72,z:depth>20?Math.max(this.spot+depth,near.z+2):clamp(near.z+1,this.spot+2,this.spot+16)};}
        }
        if(this.phase==='air'&&this.pass.elapsed>({rookie:.58,pro:.32,allpro:.18}[this.config.difficulty])) {
          if(dist(d,this.pass.target)<15)target=this.pass.target;
        }
      }
      this.move(d,target,dt,this.time<.28?0:factor);
    });
    // Soft body separation prevents interpenetration without teleporting a player.
    for(let i=0;i<this.players.length;i++)for(let j=i+1;j<this.players.length;j++) {
      const a=this.players[i],b=this.players[j];if(a.id===this.carrier||b.id===this.carrier)continue;
      const dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz),r=(a.role==='ol'||b.role==='ol')?.72:.56;
      if(d<r&&d>.001){const push=(r-d)*.18;a.x-=dx/d*push;a.z-=dz/d*push;b.x+=dx/d*push;b.z+=dz/d*push;}
    }
    if(this.throwIntent&&this.time>=this.throwIntent.at)this.release();
    if(this.phase==='air') {
      this.lastBall={...this.ball};const b=this.ball;b.x+=b.vx*dt;b.z+=b.vz*dt;b.y+=b.vy*dt-.5*GRAVITY*dt*dt;b.vy-=GRAVITY*dt;this.pass.elapsed+=dt;
      const candidates=[];
      if(this.pass.elapsed>.18)for(const p of this.players){
        if(p.role==='ol'||p.id==='QB'||(p.team==='defense'&&p.role==='dl'&&b.y>2))continue;
        const near=nearestOnSegment(this.lastBall,b,p),gap=Math.hypot(near.x-p.x,near.z-p.z);
        if(gap<.84&&near.y>.55&&near.y<2.55&&Math.abs(p.x)<WIDTH/2&&p.z<120)candidates.push({p,gap});
      }
      candidates.sort((a,b)=>a.gap-b.gap);
      if(candidates.length) {
        const p=candidates[0].p;p.action='catch';p.actionTime=.45;
        if(p.team==='defense'){this.stats.ints++;this.events.push('interception');this.finish('Intercepted',0,'interception');}
        else {this.completed=true;this.stats.completions++;this.carrier=p.id;this.selected=p.id;this.phase='run';this.catchAt=this.time;this.events.push('catch');}
      } else if(b.y<=.15||Math.abs(b.x)>WIDTH/2+.7||b.z>120||b.z<0){this.finish('Incomplete',0,'incomplete');}
    }
    if(this.carrier&&this.phase!=='dead') {
      const c=this.byId[this.carrier];
      this.ball.x=c.x+.27;this.ball.y=1.25;this.ball.z=c.z+.22;
      if(c.z>=GOAL){this.stats.td++;this.finish('Touchdown',Math.max(0,GOAL-this.spot),'touchdown');}
      else if(c.z<=10){this.finish('Safety',c.z-this.spot,'safety');}
      else if(Math.abs(c.x)>WIDTH/2-.18){this.finish('Out of bounds',c.z-this.spot,'out');}
      else if(this.time>.85&&(!this.completed||this.time-this.catchAt>.18)) {
        const tackler=defenders.find(d=>!d.engaged&&d.stun<=0&&dist(c,d)<.88);
        if(tackler){this.tackler=tackler.id;tackler.action='tackle';tackler.actionTime=1;c.action='down';c.actionTime=1;const sack=this.carrier==='QB'&&!this.threw&&!this.crossedLine&&this.play.type!=='run';if(sack)this.stats.sacks++;this.finish(sack?'Sacked':'Tackled',c.z-this.spot,sack?'sack':'tackle');}
      }
    }
    if(this.time>22&&this.phase!=='dead')this.finish('Rep complete',this.carrier?this.byId[this.carrier].z-this.spot:0,'timeout');
    this.recordClock+=dt;if(this.recordClock>=.05){this.recordClock-=.05;this.saveFrame();}
  }
  finish(label,yards,kind) {
    if(this.phase==='dead')return;
    const gain=Math.round(yards);this.phase='dead';this.deadTime=0;this.throwIntent=null;
    this.result={label,yards:gain,kind,time:this.time,completed:this.completed,firstDown:gain>=this.toGo};
    this.stats.yards+=gain;if(this.completed)this.stats.passing+=gain;else if(!this.threw&&kind!=='sack')this.stats.rushing+=gain;
    this.events.push(kind==='touchdown'?'touchdown':'whistle');this.saveFrame();
  }
  next() {
    if(this.phase!=='dead')return false;
    if(this.config.mode==='drive') {
      const r=this.result;
      if(['touchdown','interception','safety'].includes(r.kind)||(this.down===4&&!r.firstDown)) {this.spot=this.config.spot;this.down=1;this.toGo=Math.min(10,GOAL-this.spot);}
      else {this.spot=clamp(this.spot+r.yards,11,109);if(r.firstDown){this.down=1;this.toGo=Math.min(10,GOAL-this.spot);}else {this.down++;this.toGo=Math.min(GOAL-this.spot,this.toGo-r.yards);}}
    }
    this.reset();return true;
  }
  snapshot(){return {phase:this.phase,time:this.time,deadTime:this.deadTime,carrier:this.carrier,selected:this.selected,spot:this.spot,ball:{...this.ball},players:this.players.map(p=>({id:p.id,x:p.x,z:p.z,vx:p.vx,vz:p.vz,facing:p.facing,action:p.action,actionTime:p.actionTime,phase:p.phase,stamina:p.stamina,engaged:p.engaged})),result:this.result};}
  saveFrame(){this.recording.push(this.snapshot());if(this.recording.length>460)this.recording.shift();}
  drainEvents(){return this.events.splice(0);}
}
