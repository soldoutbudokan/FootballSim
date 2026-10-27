import test from 'node:test';
import assert from 'node:assert/strict';
import {AdaptiveGraphics,PROFILES,pixelRatio} from '../dist/js/graphics.js';
import {Simulation} from '../dist/js/sim.js';
// The camera tests need the vendored renderer, which is not committed
// (`npm run check` downloads it). On a fresh checkout they are skipped.
const THREE = await import('../dist/vendor/three.module.js').catch(() => null);
const cameraModule = THREE ? await import('../dist/js/env/camera.js') : null;
const {CameraDirector, normalizeCameraMode, landingPoint} = cameraModule || {};
const cameraTest = (name, fn) => test(name, {skip: THREE ? false : 'vendored three.js not present (run npm run check)'}, fn);
test('high DPI displays respect physical pixel budgets',()=>{for(const p of PROFILES){const r=pixelRatio(3840,2160,3,p);assert.ok(3840*2160*r*r<=p.pixels+1);assert.ok(r<=p.dpr);}});
test('sustained overload lowers auto quality; one stall does not',()=>{const a=new AdaptiveGraphics(()=>{});for(let i=0;i<180;i++)a.sample(16.67);a.sample(190);assert.equal(a.level,1);for(let i=0;i<210;i++)a.sample(40);assert.equal(a.level,0);});
test('quality changes wait until a rep boundary',()=>{const a=new AdaptiveGraphics(()=>{});for(let i=0;i<200;i++)a.sample(40,true,false);assert.equal(a.level,1);a.sample(40,true,true);assert.equal(a.level,0);});
test('sustained headroom can raise auto quality',()=>{const a=new AdaptiveGraphics(()=>{});for(let i=0;i<1000;i++)a.sample(16.67);assert.equal(a.level,2);});
test('manual quality cannot be changed by frame rate samples',()=>{const a=new AdaptiveGraphics(()=>{},'ultra');for(let i=0;i<400;i++)a.sample(100);assert.equal(a.profile.id,'ultra');});
test('paused/menu samples do not downgrade the device',()=>{const a=new AdaptiveGraphics(()=>{});for(let i=0;i<300;i++)a.sample(100,false);assert.equal(a.level,1);});
test('invalid saved graphics choices return to auto',()=>{const a=new AdaptiveGraphics(()=>{},'broken');assert.equal(a.mode,'auto');assert.equal(a.profile.id,'balanced');});

test('profiles describe environment props and keep the performance tier light', () => {
  for (const p of PROFILES) {
    for (const key of ['id', 'label', 'pixels', 'dpr', 'shadow', 'props', 'grass', 'detail']) assert.ok(key in p, `${p.id} has ${key}`);
    assert.ok(!('crowd' in p), 'the practice facility has no crowd');
  }
  const performance = PROFILES[0];
  assert.equal(performance.id, 'performance');
  assert.equal(performance.shadow, 0, 'no shadow maps');
  assert.equal(performance.grass, 0, 'no grass tufts');
  assert.equal(performance.props, 0);
  assert.equal(performance.detail, false);
  for (let i = 1; i < PROFILES.length; i++) {
    assert.ok(PROFILES[i].props >= PROFILES[i - 1].props);
    assert.ok(PROFILES[i].grass >= PROFILES[i - 1].grass);
    assert.ok(PROFILES[i].shadow >= PROFILES[i - 1].shadow);
  }
});

// --- camera direction ------------------------------------------------------

function director(mode) {
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.25, 2600);
  const d = new CameraDirector(camera);
  d.mode = normalizeCameraMode(mode);
  return { d, camera };
}
const run = (d, state, seconds, options = {}) => { for (let t = 0; t < seconds; t += 1 / 60) d.update(state, 1 / 60, { aspect: 16 / 9, ...options }); };

cameraTest('camera modes are game, broadcast and all22; old saved values fall back to game', () => {
  assert.equal(normalizeCameraMode('broadcast'), 'broadcast');
  assert.equal(normalizeCameraMode('all22'), 'all22');
  for (const old of ['wide', 'qb', undefined, 'nonsense']) assert.equal(normalizeCameraMode(old), 'game');
});

cameraTest('pre-snap game camera frames every receiver from behind the offense', () => {
  const sim = new Simulation(7, { offense: 'mesh', coverage: 'cover3' });
  const { d, camera } = director('game');
  run(d, sim.snapshot(), 1);
  assert.ok(-camera.position.z < sim.spot - 10, 'camera is behind the line of scrimmage');
  assert.ok(camera.position.y < 12, 'camera stays low');
  camera.updateMatrixWorld();
  for (const p of sim.players.filter(p => ['X', 'B'].includes(p.id))) {
    const v = new THREE.Vector3(p.x, 1, -p.z).project(camera);
    assert.ok(Math.abs(v.x) < 1, `${p.id} is on screen`);
  }
});

cameraTest('live game camera follows the controlled player low and close with damping', () => {
  const sim = new Simulation(7, { offense: 'mesh', coverage: 'cover3' });
  const { d, camera } = director('game');
  run(d, sim.snapshot(), 0.5);
  sim.snap();
  for (let i = 0; i < 60; i++) sim.step(1 / 120, { x: 0, z: 0, sprint: false });
  assert.equal(sim.phase, 'live');
  const before = camera.position.clone();
  d.update(sim.snapshot(), 1 / 60, { aspect: 16 / 9 });
  assert.ok(camera.position.distanceTo(before) < 2, 'one frame moves the camera only a little');
  run(d, sim.snapshot(), 3);
  const qb = sim.byId.QB;
  assert.ok(Math.abs(camera.position.y - 5.5) < 0.6, 'about 5.5 yd above');
  assert.ok(Math.abs((qb.z - -camera.position.z) - 10.5) < 1.5, 'about 10.5 yd behind');
  assert.equal(camera.fov, 42);
});

cameraTest('broadcast camera stays in the sideline press box with a 12-30 degree lens', () => {
  const sim = new Simulation(7, { offense: 'mesh', coverage: 'cover3' });
  const { d, camera } = director('broadcast');
  run(d, sim.snapshot(), 2);
  assert.ok(Math.abs(camera.position.x + 60) < 1);
  assert.ok(Math.abs(camera.position.y - 22) < 1);
  assert.ok(camera.fov >= 12 && camera.fov <= 30);
});

cameraTest('all-22 camera is high in the end zone behind the offense', () => {
  const sim = new Simulation(7, { offense: 'mesh', coverage: 'cover3' });
  const { d, camera } = director('all22');
  run(d, sim.snapshot(), 2);
  assert.ok(Math.abs(camera.position.y - 32) < 1);
  assert.ok(Math.abs((sim.spot - -camera.position.z) - 38) < 1.5);
  assert.equal(camera.fov, 38);
});

cameraTest('a thrown ball lands where its velocity says it will', () => {
  const p = landingPoint({ x: 0, y: 1.3, z: 30, vx: 2, vy: 5.365, vz: 10 });
  assert.ok(Math.abs(p.z - 40) < 0.05 && Math.abs(p.x - 2) < 0.05);
});
