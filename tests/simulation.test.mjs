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
