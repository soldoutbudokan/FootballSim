import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation,STEP,GRAVITY,flightVelocity,nearestOnSegment} from '../dist/js/sim.js';
import {PLAYS} from '../dist/js/plays.js';
function advance(s,seconds,input={}){for(let i=0;i<Math.round(seconds/STEP);i++)s.step(STEP,input);}
function practice(seed){return new Simulation(seed,{offense:'mesh',coverage:'cover3'});}
test('practice contains an 11-player offense and an 11-player CPU defense',()=>{const s=practice(1);assert.equal(s.players.length,22);assert.equal(s.players.filter(p=>p.team==='offense').length,11);assert.equal(new Set(s.players.map(p=>p.id)).size,22);assert.equal(s.carrier,'QB');});
test('ballistic solution reaches a receiver at the requested flight time',()=>{for(const t of [.5,1,2.5]){const from={x:1,y:1.85,z:30},to={x:22,y:1.6,z:61},v=flightVelocity(from,to,t);assert.ok(Math.abs(from.x+v.x*t-to.x)<1e-9);assert.ok(Math.abs(from.z+v.z*t-to.z)<1e-9);assert.ok(Math.abs(from.y+v.y*t-.5*GRAVITY*t*t-to.y)<1e-9);}});
test('swept ball collision detects a fast pass between simulation positions',()=>{const p=nearestOnSegment({x:0,z:0,y:1},{x:2,z:2,y:2},{x:1,z:1});assert.equal(p.t,.5);assert.equal(p.y,1.5);});
test('snap is idempotent and throws are unavailable before the snap',()=>{const s=practice(1);assert.equal(s.requestThrow('X'),false);assert.equal(s.snap(),true);assert.equal(s.snap(),false);assert.equal(s.stats.reps,1);});
test('crossing the line of scrimmage locks forward passing',()=>{const s=practice(1);s.snap();s.byId.QB.z=s.spot+1;s.step(STEP);assert.equal(s.crossedLine,true);assert.equal(s.requestThrow('X'),false);assert.equal(s.throwAway(),false);});
test('play action prevents release until the fake is finished',()=>{const s=practice(1);s.selectPlay('flood');s.snap();advance(s,.5);assert.equal(s.requestThrow('X'),false);advance(s,.7);assert.equal(s.requestThrow('X'),true);});
test('a pass completes through flight and transfers control to the receiver',()=>{const s=practice(42);s.snap();advance(s,1.8);assert.equal(s.requestThrow('X','touch'),true);let caught=false;for(let i=0;i<800&&s.phase!=='dead';i++){s.step(STEP,{z:s.phase==='run'?1:0});if(s.phase==='run'){caught=true;assert.equal(s.carrier,'X');}}assert.equal(caught,true);assert.equal(s.stats.attempts,1);assert.equal(s.stats.completions,1);assert.equal(s.phase,'dead');assert.ok(s.recording.length>20);});
for(const id of ['zone','stretch'])test(id+' hands off to the user-controlled running back',()=>{const s=practice(42);s.selectPlay(id);s.snap();advance(s,.8);assert.equal(s.handoff,true);assert.equal(s.carrier,'R');assert.equal(s.phase,'run');assert.equal(s.stats.attempts,0);assert.equal(s.requestThrow('X'),false);});
test('idle quarterback can be sacked by the pass rush',()=>{const s=practice(7);s.snap();advance(s,12);assert.equal(s.phase,'dead');assert.equal(s.result.kind,'sack');assert.equal(s.stats.sacks,1);});
test('a defender in the ball path intercepts; control never becomes defensive',()=>{const s=practice(4);s.snap();advance(s,.5);s.phase='air';s.carrier=null;s.threw=true;s.stats.attempts=1;const d=s.byId.FS;s.ball={x:d.x,y:1.4,z:d.z,vx:0,vy:0,vz:0};s.pass={receiver:'X',target:{x:d.x,z:d.z,y:1.4},elapsed:.5,duration:1};s.step(STEP);assert.equal(s.result.kind,'interception');assert.equal(s.stats.ints,1);assert.notEqual(s.selected,'FS');});
test('incomplete passes preserve field position and advance the down in drive mode',()=>{const s=practice(1);s.configure({mode:'drive'});s.snap();advance(s,.5);s.throwAway();s.next();assert.equal(s.spot,35);assert.equal(s.down,2);assert.equal(s.toGo,10);});
test('first downs reset the series and fourth-down failure starts another drive',()=>{const s=practice(1);s.configure({mode:'drive'});s.snap();s.finish('Tackled',14,'tackle');s.next();assert.equal(s.spot,49);assert.equal(s.down,1);assert.equal(s.toGo,10);for(let i=0;i<4;i++){s.snap();s.finish('Incomplete',0,'incomplete');s.next();}assert.equal(s.spot,35);assert.equal(s.down,1);});
test('repeat-spot practice retains the configured location after a gain',()=>{const s=practice(1);s.configure({spot:90,mode:'reps'});s.snap();s.finish('Tackled',8,'tackle');s.next();assert.equal(s.spot,90);assert.equal(s.down,1);});
test('touchdowns and out-of-bounds terminate a rep exactly once',()=>{const s=practice(1);s.snap();s.phase='run';s.carrier='R';s.byId.R.z=110.1;s.step(STEP);assert.equal(s.result.kind,'touchdown');assert.equal(s.stats.td,1);const yards=s.stats.yards;s.finish('Tackled',99,'tackle');assert.equal(s.stats.yards,yards);const out=practice(1);out.snap();out.byId.QB.x=27;out.step(STEP);assert.equal(out.result.kind,'out');});
test('seeded simulation is independent of how a fixed number of steps is grouped',()=>{const a=practice(123),b=practice(123);a.snap();b.snap();for(let i=0;i<120;i++){a.step(STEP);a.step(STEP);}for(let i=0;i<240;i++)b.step(STEP);assert.deepEqual(a.snapshot(),b.snapshot());});
test('all plays and defensive looks remain finite and terminate',()=>{for(const p of PLAYS)for(const coverage of ['cover2','cover3','man','blitz']){const s=practice(42);s.configure({coverage});s.selectPlay(p.id);s.snap();let thrown=false;for(let i=0;i<2900&&s.phase!=='dead';i++){if(s.time>1.8&&!thrown&&p.type!=='run'){s.requestThrow('X','touch');thrown=true;}s.step(STEP,{z:s.phase==='run'?1:0,sprint:s.phase==='run'});}assert.equal(s.phase,'dead',p.id+' '+coverage);for(const p of s.players)assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.z));}});
test('juke cooldown and stamina prevent unlimited moves',()=>{
  // A juke is a plant off momentum, so it needs the carrier moving (> 2 yd/s); the cooldown is the 0.45 s move itself.
  const s=practice(1);s.snap();assert.equal(s.juke(1),false);advance(s,1,{x:1,sprint:true});
  assert.equal(s.juke(1),true);assert.equal(s.juke(1),false);assert.ok(s.byId.QB.stamina<1);
});

test('default practice draws offense and defense again for each new rep',()=>{
  const s=new Simulation(2026),offenses=new Set(),defenses=new Set();
  assert.equal(s.config.offense,'random');assert.equal(s.config.coverage,'random');assert.equal(s.config.mode,'reps');
  for(let i=0;i<80;i++){offenses.add(s.play.id);defenses.add(s.coverage);s.snap();s.finish('Incomplete',0,'incomplete');assert.equal(s.next(),true);}
  assert.equal(offenses.size,PLAYS.length);assert.equal(defenses.size,4);assert.equal(s.spot,35);assert.equal(s.down,1);
});
test('fixed calls repeat until random offense is restored',()=>{
  const s=new Simulation(13);s.configure({offense:'zone',coverage:'man'});
  for(let i=0;i<10;i++){assert.equal(s.play.id,'zone');assert.equal(s.coverage,'man');s.snap();s.finish('Tackled',3,'tackle');s.next();}
  assert.equal(s.selectPlay('random'),true);const offenses=new Set();
  for(let i=0;i<40;i++){offenses.add(s.play.id);assert.equal(s.coverage,'man');s.snap();s.finish('Tackled',3,'tackle');s.next();}
  assert.ok(offenses.size>1);assert.equal(s.config.offense,'random');
  s.selectPlay('corners');for(let i=0;i<5;i++){assert.equal(s.play.id,'corners');s.snap();s.finish('Incomplete',0,'incomplete');s.next();}
});
test('resetting, flipping and selecting plays preserve a drive series',()=>{
  const s=new Simulation(19);s.configure({mode:'drive'});s.snap();s.finish('Tackled',4,'tackle');s.next();
  const play=s.play.id,coverage=s.coverage;s.config.flip=true;s.reset();
  assert.equal(s.play.id,play);assert.equal(s.coverage,coverage);assert.equal(s.down,2);assert.equal(s.toGo,6);assert.equal(s.spot,39);
  for(const choice of ['mesh','random']){s.selectPlay(choice);assert.equal(s.down,2);assert.equal(s.toGo,6);assert.equal(s.spot,39);}
  s.snap();s.finish('Tackled',6,'tackle');s.next();assert.equal(s.down,1);assert.equal(s.toGo,10);assert.equal(s.spot,45);
  s.configure({mode:'reps'});s.snap();s.finish('Tackled',8,'tackle');s.next();assert.equal(s.spot,35);assert.equal(s.down,1);
});
test('hot routes change one receiver, execute after the snap and preserve the base play',()=>{
  const s=practice(42),base=JSON.stringify(PLAYS.find(p=>p.id==='mesh').routes),other=s.byId.Y.route.map(p=>({...p}));
  assert.equal(s.setHotRoute('X','out'),true);assert.deepEqual(s.byId.Y.route,other);assert.notDeepEqual(s.effectivePlay.routes.X,s.play.routes.X);
  s.snap();advance(s,1.8);assert.ok(s.byId.X.x<-21);assert.equal(s.setHotRoute('X','curl'),false);assert.equal(JSON.stringify(PLAYS.find(p=>p.id==='mesh').routes),base);
  s.finish('Incomplete',0,'incomplete');s.next();assert.deepEqual(s.hotRoutes,{});assert.deepEqual(s.effectivePlay.routes,s.play.routes);
});
test('hot routes mirror with the play and can be restored',()=>{
  const s=practice(2);s.setHotRoute('A','corner');const normal=s.byId.A.route.map(p=>({...p}));s.config.flip=true;s.reset();
  assert.deepEqual(s.byId.A.route,normal.map(p=>({x:-p.x,z:p.z})));assert.equal(s.setHotRoute('A','default'),true);assert.deepEqual(s.hotRoutes,{});
  assert.equal(s.setHotRoute('QB','streak'),false);assert.equal(s.setHotRoute('X','invalid'),false);s.selectPlay('zone');assert.equal(s.setHotRoute('X','streak'),false);
});
test('audibles preserve the drive and defense, clear hot routes, and apply only to this snap',()=>{
  const s=new Simulation(10,{offense:'mesh',coverage:'man',mode:'drive'});s.snap();s.finish('Tackled',3,'tackle');s.next();s.setHotRoute('A','flat');
  const defense=s.players.filter(p=>p.team==='defense').map(p=>[p.id,p.x,p.z]);
  assert.equal(s.audible('slants'),true);assert.equal(s.play.id,'slants');assert.equal(s.config.offense,'mesh');assert.equal(s.coverage,'man');assert.equal(s.down,2);assert.equal(s.toGo,7);assert.equal(s.spot,38);assert.deepEqual(s.hotRoutes,{});
  assert.deepEqual(s.players.filter(p=>p.team==='defense').map(p=>[p.id,p.x,p.z]),defense);
  s.snap();assert.equal(s.audible('zone'),false);s.finish('Incomplete',0,'incomplete');s.next();assert.equal(s.play.id,'mesh');assert.equal(s.down,3);assert.equal(s.toGo,7);
});
test('coverage calls use distinct safety shells, cushions and blitz positions',()=>{
  const make=coverage=>new Simulation(31,{offense:'mesh',coverage}),three=make('cover3'),two=make('cover2'),man=make('man'),blitz=make('blitz');
  assert.ok(Math.abs(three.byId.FS.x)<1);assert.ok(three.byId.SS.z-three.spot<10);assert.ok(Math.abs(two.byId.FS.x)>10);assert.ok(two.byId.SS.z-two.spot>16);
  assert.ok(three.byId.CB1.z-three.spot>7);assert.ok(two.byId.CB1.z-two.spot<5);assert.ok(man.byId.CB1.z-man.spot<3);
  assert.ok(blitz.byId.LB1.z-blitz.spot<2);assert.ok(blitz.byId.LB2.z-blitz.spot<2);assert.ok(blitz.players.filter(p=>p.team==='defense').every(p=>p.z-blitz.spot<6));
  man.snap();advance(man,.8);assert.ok(man.byId.FS.z-man.spot>18);assert.ok(man.byId.SS.z-man.spot>18);
});
test('the same defensive call varies its front between reps and stays set during adjustments',()=>{
  const s=new Simulation(91,{offense:'mesh',coverage:'cover3'}),fronts=new Set(),positions=new Set();
  for(let i=0;i<30;i++){fronts.add(s.defensiveFront);positions.add(s.byId.DE1.x);const x=s.byId.DE1.x;s.setHotRoute('X','curl');s.reset();assert.equal(s.byId.DE1.x,x);s.snap();s.finish('Incomplete',0,'incomplete');s.next();}
  assert.equal(fronts.size,4);assert.ok(positions.size>4);
});

// ---------------------------------------------------------------------------
// Movement model (plan 4.1-4.3 and acceptance 6.3).

// A back running free: the zone handoff is done and the defense is moved far away.
function openField(seed=1){
  const s=new Simulation(seed,{offense:'zone',coverage:'cover3'});
  s.snap();advance(s,.8,{z:1});
  for(const d of s.defense){d.x=d.x<0?-26:26;d.z=s.spot+45;d.vx=d.vz=0;}
  return s;
}
const speedOf=p=>Math.hypot(p.vx,p.vz);

test('a sprinting back needs over half a second to reverse and keeps moving forward over a yard first',()=>{
  const s=openField(),r=s.byId.R;advance(s,2,{z:1,sprint:true});
  assert.ok(r.vz>7.5,'at speed before the reversal');
  const z0=r.z,t0=s.time;let stopped=null,furthest=z0;
  for(let i=0;i<240&&stopped===null;i++){s.step(STEP,{z:-1,sprint:true});furthest=Math.max(furthest,r.z);if(r.vz<=0)stopped=s.time-t0;}
  assert.ok(stopped>.5,'took '+stopped+' s to stop');assert.ok(furthest-z0>1,'drifted '+(furthest-z0)+' yd forward');
  advance(s,1,{z:-1,sprint:true});assert.ok(r.vz<-3,'then runs the other way');
});

test('a sharp change of direction at speed plants with a cut action and event, and costs speed',()=>{
  const s=openField(),r=s.byId.R;advance(s,2,{z:1,sprint:true});s.drainEvents();
  const before=speedOf(r);let slowest=before,cut=false;
  for(let i=0;i<60;i++){s.step(STEP,{x:1,sprint:true});slowest=Math.min(slowest,speedOf(r));if(r.action==='cut')cut=true;}
  assert.ok(s.drainEvents().includes('cut'));assert.ok(cut);assert.ok(slowest<before*.7,'slowed to '+slowest);
  advance(s,.8,{x:1,sprint:true});assert.ok(r.vx>6,'explodes out of the cut');assert.ok(Math.abs(r.vz)<1);
});

test('three jukes within 1.5 s all succeed without a stun, momentum-consistent and paid for in speed',()=>{
  const s=openField(),r=s.byId.R;advance(s,1.5,{z:1,sprint:true});
  const results=[],start=s.time;let biggestJump=0,last={x:r.vx,z:r.vz};
  for(let k=0;k<3;k++){
    results.push(s.juke(k%2?-1:1));assert.equal(r.action,'juke');assert.equal(r.actionTime,.45);
    for(let i=0;i<54;i++){s.step(STEP,{z:1,sprint:true});biggestJump=Math.max(biggestJump,Math.hypot(r.vx-last.x,r.vz-last.z));last={x:r.vx,z:r.vz};}
  }
  assert.deepEqual(results,[true,true,true]);assert.ok(s.time-start<=1.5);
  assert.ok(biggestJump<.4,'velocity changed by '+biggestJump+' in one step');assert.ok(r.stamina<1);
  assert.ok(s.players.every(p=>!('stun' in p)));
});

test('a juke moves the carrier sideways by half his speed plus 2.5 yd/s and drops forward speed',()=>{
  const s=openField(),r=s.byId.R;advance(s,1.5,{z:1,sprint:true});
  const v=speedOf(r);assert.equal(s.juke(1),true);advance(s,.25,{z:1,sprint:true});
  assert.ok(Math.abs(r.vx-(.5*v+2.5))<.6,'lateral '+r.vx);assert.ok(Math.abs(r.vz-.65*v)<.6,'forward '+r.vz);
  assert.ok(s.snapshot().players.find(p=>p.id==='R').lean>.5,'leans into the juke');
});

test('a tired carrier can still juke',()=>{
  const s=openField(),r=s.byId.R;advance(s,1,{z:1,sprint:true});r.stamina=0;
  assert.equal(s.juke(-1),true);assert.equal(r.stamina,0);
});

test('a receiver slows below 70 % of top speed into a 90° break and recovers afterwards',()=>{
  const s=practice(3);s.setHotRoute('Y','out');s.snap();const y=s.byId.Y,breakAt=y.route[0];
  let stem=0,atBreak=Infinity,after=0;
  for(let i=0;i<480;i++){
    s.step(STEP);const v=speedOf(y),d=Math.hypot(y.x-breakAt.x,y.z-breakAt.z);
    if(y.routeIndex===0&&d>3)stem=Math.max(stem,v);
    if(d<1.2)atBreak=Math.min(atBreak,v);
    if(y.routeIndex===1&&d>3)after=Math.max(after,v);
  }
  assert.ok(stem>.8*y.top,'full speed on the stem: '+stem);
  assert.ok(atBreak<.7*y.top,'speed at the break '+atBreak);
  assert.ok(after>atBreak+2.5,'recovers to '+after);
});

test('a pro defender reacts to where the carrier was 0.28 s ago and leads him toward an intercept',()=>{
  const s=openField(),r=s.byId.R,d=s.byId.SS,history=[];
  advance(s,.6,{z:1,sprint:true});d.x=r.x+6;d.z=r.z+14;d.vx=d.vz=0;d.turned=true;
  for(let i=0;i<60;i++){s.step(STEP,{z:1,sprint:true});history.push({t:s.time,z:r.z});}
  const lag=s.time-d.seen.t;assert.ok(Math.abs(lag-.28)<STEP*1.5,'lag '+lag);
  const then=history.find(h=>Math.abs(h.t-d.seen.t)<1e-6);assert.ok(then&&Math.abs(then.z-d.seen.z)<1e-6);
  assert.ok(r.z-d.seen.z>1.5,'the carrier has moved on since');assert.ok(d.aim.z>d.seen.z,'aims ahead of what he saw');
  for(const [level,latency] of [['rookie',.4],['allpro',.18]])assert.equal(new Simulation(1,{difficulty:level}).byId.FS.latency,latency);
});

test('a well-timed cutback makes a closing defender overrun; a straight runner is tackled',()=>{
  const run=cutAt=>{
    const s=openField(11),r=s.byId.R;advance(s,1.4,{z:1,sprint:true});
    const d=s.byId.SS;d.x=r.x+7;d.z=r.z+11;d.vx=-3;d.vz=-6;d.turned=true;
    let cut=false,closest=Infinity;
    for(let i=0;i<260&&s.phase!=='dead';i++){
      const gap=Math.hypot(d.x-r.x,d.z-r.z);if(gap<cutAt)cut=true;closest=Math.min(closest,gap);
      s.step(STEP,cut?{x:1,z:.25,sprint:true}:{z:1,sprint:true});
    }
    return {s,closest};
  };
  const straight=run(-1);assert.ok(['tackle','dead'].includes(straight.s.phase)&&straight.closest<.95);
  const cutback=run(5);assert.ok(cutback.closest>.95,'stayed out of reach: '+cutback.closest);assert.equal(cutback.s.phase,'run');
});

test('a tackle drags 0-3 yards after contact and the rep ends within 1.2 s of contact',()=>{
  for(const approach of ['head-on','from behind','from the side']){
    const s=openField(2),r=s.byId.R,d=s.byId.LB2;advance(s,1.2,{z:1,sprint:true});
    s.random=()=>0;d.turned=true;
    if(approach==='head-on'){d.x=r.x;d.z=r.z+8;d.vx=0;d.vz=-5;}
    else if(approach==='from behind'){d.x=r.x+.3;d.z=r.z-2.5;d.vx=0;d.vz=9.4;d.top=d.speed=10;}
    else {d.x=r.x+6;d.z=r.z+5;d.vx=-6;d.vz=0;}
    let contact=null;
    for(let i=0;i<600&&s.phase!=='dead';i++){
      s.step(STEP,{z:1,sprint:true});
      if(!contact&&s.phase==='tackle'){contact={t:s.time,z:r.z};assert.equal(r.action,'wrapped');assert.equal(d.action,'tackle');assert.ok(s.drainEvents().includes('tackle'));}
    }
    assert.ok(contact,approach+' made contact');assert.equal(s.result.kind,'tackle');
    const yac=r.z-contact.z;assert.ok(yac>=0&&yac<=3,approach+' yards after contact '+yac);
    assert.ok(s.result.time-contact.t<=1.2,approach+' ended '+(s.result.time-contact.t)+' s after contact');
    assert.equal(r.action,'down');assert.ok(Math.abs(s.result.yards-Math.round(r.z-s.spot))<=1);
  }
});

test('a missed tackle makes the tackler stumble at 30 % speed and costs the carrier 20 %',()=>{
  const s=openField(2),r=s.byId.R,d=s.byId.LB2;advance(s,1.2,{z:1,sprint:true});
  s.random=()=>.999;d.turned=true;d.x=r.x+.2;d.z=r.z+3;d.vx=0;d.vz=-4;
  let before=null;
  for(let i=0;i<120&&d.action!=='stumble';i++){before=speedOf(r);s.step(STEP,{z:1,sprint:true});}
  assert.equal(d.action,'stumble');assert.equal(s.phase,'run');assert.ok(s.drainEvents().includes('broken-tackle'));
  assert.ok(speedOf(r)<before*.85,'carrier slowed from '+before+' to '+speedOf(r));
  assert.ok(Math.abs(d.actionTime-.7)<.02);
  advance(s,.3,{z:1,sprint:true});assert.ok(speedOf(d)<.31*d.top+.1,'stumbling defender is slow');
  assert.equal(s.phase,'run','one attempt per contact');
});

test('a sacked quarterback is wrapped behind the line and the sack is counted once',()=>{
  const s=practice(7);s.snap();advance(s,12);assert.equal(s.result.kind,'sack');assert.equal(s.stats.sacks,1);
  assert.equal(s.byId.QB.action,'down');assert.ok(s.result.yards<=0);
});

test('a dropped pass ends the rep incomplete with a drop event and the ball falls loose',()=>{
  const s=practice(42);s.snap();advance(s,1.8);assert.equal(s.requestThrow('X','touch'),true);
  s.random=()=>0;let events=[];
  for(let i=0;i<400&&s.phase!=='dead';i++){s.step(STEP);events.push(...s.drainEvents());}
  assert.equal(s.result.kind,'incomplete');assert.equal(s.result.label,'Dropped');assert.ok(events.includes('drop'));
  assert.equal(s.completed,false);assert.equal(s.stats.completions,0);assert.equal(s.carrier,null);
  for(let i=0;i<240;i++)s.step(STEP);
  assert.ok(Math.abs(s.ball.y-.1)<1e-9);assert.deepEqual([s.ball.vx,s.ball.vy,s.ball.vz],[0,0,0]);
});

test('throw timing matches the scene contract and the ball carries its flight velocity',()=>{
  const s=practice(42);s.snap();advance(s,1.8);const t=s.time;assert.equal(s.requestThrow('X','bullet'),true);
  assert.equal(s.byId.QB.action,'throw');assert.equal(s.byId.QB.actionTime,.4);
  let released=null;
  for(let i=0;i<60&&released===null;i++){s.step(STEP);if(s.phase==='air')released=s.time-t;}
  assert.ok(Math.abs(released-.23)<STEP*1.5,'released after '+released);
  assert.ok(Math.abs(s.byId.QB.actionTime-(.4-released))<STEP*1.5,'the throw action is not restarted at release');
  const b=s.snapshot().ball;assert.ok(Math.hypot(b.vx,b.vz)>20);
  for(let i=0;i<400&&s.phase==='air';i++)s.step(STEP);
  if(s.phase==='run'){const held=s.snapshot().ball;assert.deepEqual([held.vx,held.vy,held.vz],[0,0,0]);assert.equal(s.byId[s.carrier].action,'catch');}
});

test('the snapshot carries speed, lean, backpedal and the tackle phase fields of the scene contract',()=>{
  const s=openField(),r=s.byId.R;advance(s,1,{z:1,sprint:true});s.juke(1);advance(s,.1,{z:1,sprint:true});
  const snap=s.snapshot();assert.ok(['presnap','live','air','run','tackle','dead'].includes(snap.phase));
  for(const key of ['x','y','z','vx','vy','vz'])assert.ok(Number.isFinite(snap.ball[key]),key);
  assert.deepEqual([snap.ball.vx,snap.ball.vy,snap.ball.vz],[0,0,0],'carried ball has no velocity');
  for(const p of snap.players){
    for(const key of ['x','z','vx','vz','facing','speed','lean','actionTime','phase','stamina'])assert.ok(Number.isFinite(p[key]),p.id+' '+key);
    assert.ok(Math.abs(p.speed-Math.hypot(p.vx,p.vz))<1e-9);assert.ok(p.lean>=-1&&p.lean<=1);assert.equal(typeof p.backpedal,'boolean');
    assert.ok(p.engaged===null||typeof p.engaged==='string');
  }
  assert.equal(snap.players.find(p=>p.id==='R').action,'juke');
  const pre=practice(1).snapshot();assert.ok(pre.players.every(p=>p.action==='ready'&&p.speed===0));
  assert.ok(pre.ball.y<.2&&pre.ball.z===35,'the ball lies on the turf at the line before the snap');
});

test('coverage backs backpedal facing the quarterback, then flip when a receiver threatens them',()=>{
  const s=new Simulation(5,{offense:'verts',coverage:'cover3'}),cb=s.byId.CB1,qb=s.byId.QB;s.snap();
  let backpedalled=false,facedQB=true,flippedAt=null;
  for(let i=0;i<360;i++){
    s.step(STEP);
    if(cb.backpedal){backpedalled=true;const toQB=Math.atan2(qb.x-cb.x,qb.z-cb.z);facedQB=facedQB&&Math.abs(Math.atan2(Math.sin(cb.facing-toQB),Math.cos(cb.facing-toQB)))<.35;}
    if(cb.turned&&flippedAt===null)flippedAt=s.time;
  }
  assert.ok(backpedalled&&facedQB);assert.ok(flippedAt>1&&flippedAt<2.8,'flipped at '+flippedAt);
  assert.ok(Math.abs(cb.facing)<.6,'runs downfield after the flip');assert.ok(cb.z>s.byId.X.z,'stays on top of the go route');
});

test('the quarterback faces downfield in the pocket and engaged blockers face each other',()=>{
  const s=practice(7),qb=s.byId.QB;s.snap();advance(s,.5);
  assert.ok(qb.backpedal,'drops back facing downfield');assert.ok(Math.abs(qb.facing)<1e-6);
  advance(s,.7);const blocker=s.line.find(o=>o.engaged);assert.ok(blocker,'a lineman is engaged');
  const d=s.byId[blocker.engaged];assert.equal(d.engaged,blocker.id);assert.equal(blocker.action,'block');
  const toward=Math.atan2(d.x-blocker.x,d.z-blocker.z),gap=Math.atan2(Math.sin(blocker.facing-toward),Math.cos(blocker.facing-toward));
  assert.ok(Math.abs(gap)<.3,'blocker squared up');
  assert.ok(s.requestThrow('A','touch'));advance(s,.1);assert.ok(Math.abs(Math.atan2(s.byId.A.x-qb.x,s.byId.A.z-qb.z)-qb.facing)<.6,'turns to his target to throw');
});

test('handoffs meet the back at the mesh and both run plays still reach the carrier within 0.8 s',()=>{
  for(const id of ['zone','stretch'])for(const flip of [false,true]){
    const s=practice(5);s.config.flip=flip;s.selectPlay(id);s.snap();let gap=null;
    for(let i=0;i<96&&!s.handoff;i++){s.step(STEP);if(s.handoff)gap=Math.hypot(s.byId.QB.x-s.byId.R.x,s.byId.QB.z-s.byId.R.z);}
    assert.ok(s.handoff,id);assert.ok(gap<1.3,id+(flip?' flipped':'')+' exchange gap '+gap);assert.equal(s.byId.R.action,'carry');
  }
});

test('a safety needs the carrier downed in his own end zone; lining up there is legal',()=>{
  const s=new Simulation(3,{offense:'mesh',coverage:'cover3',spot:11});s.snap();advance(s,.7);
  assert.equal(s.phase,'live','quarterback in the end zone after the drop');assert.ok(s.byId.QB.z<=10);
  const t=new Simulation(3,{offense:'mesh',coverage:'cover3',spot:11});t.snap();advance(t,.5);
  t.byId.QB.x=27;t.step(STEP);assert.equal(t.result.kind,'safety');
});

test('an interceptor keeps the ball after the whistle',()=>{
  const s=practice(4);s.snap();advance(s,.5);s.phase='air';s.carrier=null;s.threw=true;const d=s.byId.FS;
  s.ball={x:d.x,y:1.4,z:d.z,vx:0,vy:0,vz:0};s.pass={receiver:'X',target:{x:d.x,z:d.z,y:1.4},elapsed:.5,duration:1};s.step(STEP);
  assert.equal(s.result.kind,'interception');advance(s,1);assert.ok(s.ball.y>1&&Math.hypot(s.ball.x-d.x,s.ball.z-d.z)<.5);
});

test('after the whistle players pull up, blocks release and the tackled carrier stays down',()=>{
  const s=practice(7);s.snap();advance(s,12);assert.equal(s.result.kind,'sack');
  const tackler=s.byId[s.tackler];advance(s,1.5);
  assert.equal(s.byId.QB.action,'down');assert.equal(tackler.action,'tackle');
  assert.ok(s.players.every(p=>p.engaged===null));assert.ok(s.players.every(p=>Math.hypot(p.vx,p.vz)<.05),'everyone has stopped');
  assert.ok(s.players.every(p=>!['cut','juke','throw','catch','block','stumble'].includes(p.action)));
});

test('a pursuer who cannot close the last yard dives at the carrier',()=>{
  for(const roll of [0,.999]){
    const s=openField(2),r=s.byId.R,d=s.byId.FS;advance(s,1.6,{z:1,sprint:true});
    s.random=()=>roll;d.turned=true;d.x=r.x;d.z=r.z-1.5;d.vx=r.vx;d.vz=r.vz;d.top=r.top;
    let events=[];
    for(let i=0;i<60&&!events.some(e=>e==='tackle'||e==='broken-tackle');i++){s.step(STEP,{z:1,sprint:true});events.push(...s.drainEvents());}
    if(roll===0){assert.ok(events.includes('tackle'),'dive tackle');assert.equal(s.phase,'tackle');assert.equal(d.action,'tackle');}
    else {assert.ok(events.includes('broken-tackle'),'missed dive');assert.equal(d.action,'stumble');}
  }
});

test('a blocked defender comes off his block when the ball carrier runs at him',()=>{
  const s=practice(5);s.selectPlay('zone');s.snap();advance(s,1);
  const d=s.defense.find(q=>q.engaged&&q.role==='dl'),r=s.byId.R;assert.ok(d,'a lineman is blocked');
  r.x=d.x;r.z=d.z-1.4;r.vx=0;r.vz=1;
  for(let i=0;i<48;i++)s.step(STEP);
  assert.equal(d.engaged,null,'shed the block');
});

test('trailing pursuers shade to their own side of the carrier while they are still far away', () => {
  const s = openField(1), r = s.byId.R;
  advance(s, 0.8, { z: 1, sprint: true });
  const left = s.byId.LB1, right = s.byId.LB3;
  // Both trail the runner by 9 yd, one lined up on each side.
  for (const [d, dx] of [[left, -0.5], [right, 0.5]]) { d.x = r.x + dx; d.z = r.z - 9; d.vx = 0; d.vz = 6; d.turned = true; }
  advance(s, 0.1, { z: 1, sprint: true });
  assert.ok(left.leverage < -0.9 && right.leverage > 0.9, 'each takes his own side');
  assert.ok(left.aim.x < left.seen.x - 0.6, 'left pursuer aims left of the runner: ' + (left.aim.x - left.seen.x));
  assert.ok(right.aim.x > right.seen.x + 0.6, 'right pursuer aims right of the runner: ' + (right.aim.x - right.seen.x));
});

test('after a tackle the other defenders pull up beside the pile instead of lining up behind it', () => {
  let reps = 0;
  for (let seed = 1; seed <= 40; seed++) for (const play of ['zone', 'stretch']) {
    const s = new Simulation(seed, { offense: play, coverage: 'random' });
    s.snap();
    // Who was still coming when the carrier was wrapped up (not blocked, not
    // already at arm's length).
    let coming = null;
    for (let i = 0; i < 3600 && s.phase !== 'dead'; i++) {
      s.step(STEP, { z: s.phase === 'run' ? 1 : 0, sprint: true });
      if (!coming && s.phase === 'tackle') {
        const c = s.byId[s.carrier];
        coming = new Set(s.defense.filter(d => !d.engaged && d.id !== s.tackler && Math.hypot(d.x - c.x, d.z - c.z) > 2.5).map(d => d.id));
      }
    }
    if (s.result.kind !== 'tackle') continue;
    reps++;
    advance(s, 2);
    const c = s.byId[s.carrier];
    const others = s.defense.filter(d => d.action !== 'tackle' && Math.hypot(d.x - c.x, d.z - c.z) < 7);
    for (const d of others) if (coming.has(d.id)) assert.ok(Math.hypot(d.x - c.x, d.z - c.z) > 1.2, `${play}/${seed}: ${d.id} pulled up short of the pile`);
    // Around the pile none of them stands in a file directly behind another,
    // in line with the carrier.
    const pile = others.filter(d => coming.has(d.id) && Math.hypot(d.x - c.x, d.z - c.z) < 4.5);
    for (const a of pile) for (const b of pile) {
      if (a === b) continue;
      const file = Math.abs(a.x - b.x) < 0.9 && Math.abs(a.z - b.z) > 0.6 && Math.abs(a.x - c.x) < 1.2 && Math.abs(b.x - c.x) < 1.2;
      assert.ok(!file, `${play}/${seed}: ${a.id} and ${b.id} in single file behind the carrier`);
    }
    assert.ok(s.players.every(p => Math.hypot(p.vx, p.vz) < 0.05), `${play}/${seed}: everyone has stopped`);
  }
  assert.ok(reps > 50, 'enough tackled reps: ' + reps);
});
