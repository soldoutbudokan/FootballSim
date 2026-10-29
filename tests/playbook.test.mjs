import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMATIONS, PLAYS, RECEIVERS, formationFor, routeFor, hotRouteFor, readParts, readText } from '../dist/js/plays.js';
import { Simulation, STEP, WIDTH } from '../dist/js/sim.js';

test('every call has a complete, distinct route combination and a legal eleven-player alignment', () => {
  const ids = new Set(), diagrams = new Set();
  for (const call of PLAYS) {
    assert.ok(!ids.has(call.id), 'duplicate play ID ' + call.id);
    ids.add(call.id);
    assert.ok(!diagrams.has(JSON.stringify(call.routes)), 'duplicate route combination ' + call.id);
    diagrams.add(JSON.stringify(call.routes));
    const players = formationFor(call);
    assert.equal(players.length, 11, call.id);
    assert.equal(new Set(players.map(p => p.id)).size, 11, call.id);
    assert.equal(players.filter(p => p.role === 'ol').length, 5, call.id);
    // Five linemen plus two uncovered ends, with no receiver covered by an
    // additional on-line receiver outside him.
    const ends = players.filter(p => RECEIVERS.includes(p.id) && p.z === 0).sort((a,b) => a.x-b.x);
    assert.equal(ends.length, 2, call.id);
    assert.ok(ends[0].x < -3.2 && ends[1].x > 3.2, call.id);
    for (const p of players) {
      assert.ok(Math.abs(p.x) < WIDTH / 2 && p.z <= 0, call.id + ': ' + p.id);
      for (const q of players) if (p !== q) {
        assert.ok(Math.hypot(p.x-q.x, p.z-q.z) > .7, call.id + ': overlapping snap positions');
      }
    }
    for (const id of RECEIVERS) {
      assert.ok(call.routes[id]?.length, call.id + ': route for ' + id);
      for (const [x,z] of call.routes[id]) assert.ok(Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) < WIDTH/2, call.id);
    }
  }
});

test('coaching cues name receivers by their pass keys, never by letter', () => {
  const stick = PLAYS.find(p => p.id === 'stick');
  assert.equal(readText(stick), 'Read the flat defender on the trips side: 3 settles inside him while 2 widens to the flat. 4 clears the sideline.');
  for (const call of PLAYS) {
    const parts = readParts(call);
    assert.ok(parts.length, call.id + ': has a read');
    // Every token resolves to one of the five receivers; none is left as text.
    for (const token of call.read.matchAll(/\{(\w+)\}/g)) assert.ok(RECEIVERS.includes(token[1]), call.id + ': unknown receiver {' + token[1] + '}');
    for (const part of parts) {
      if (part.text !== undefined) assert.ok(part.text && !/[{}]/.test(part.text), call.id + ': stray token text');
      else assert.ok(Number.isInteger(part.receiver) && part.receiver >= 0 && part.receiver < RECEIVERS.length, call.id);
    }
    // The renderer's segments read back as the plain text.
    assert.equal(parts.map(p => p.text ?? String(p.receiver + 1)).join(''), readText(call), call.id);
    if (call.type === 'run') continue;
    const text = readText(call);
    assert.ok(parts.some(p => p.receiver !== undefined), call.id + ': a pass read names its receivers');
    assert.doesNotMatch(text, /\b[XYABR]\b/, call.id + ': bare receiver letter in ' + JSON.stringify(text));
  }
  assert.deepEqual(readParts({ read: 'Hit {Q} or {R}.' }), [{ text: 'Hit ' }, { text: '{Q}' }, { text: ' or ' }, { receiver: 4 }, { text: '.' }]);
});

test('each formation places and mirrors players and routes at both ends of the field', () => {
  for (const call of PLAYS) for (const spot of [11, 105]) for (const flip of [false, true]) {
    const s = new Simulation(41, { offense:call.id, coverage:'cover3', spot, flip });
    for (const spec of formationFor(call)) {
      const p = s.byId[spec.id];
      assert.equal(p.x, flip ? -spec.x : spec.x, call.id + ': ' + spec.id);
      assert.equal(p.z, spot + spec.z, call.id + ': ' + spec.id);
      assert.ok(p.z >= 0 && p.z <= 120, call.id);
    }
    for (const id of RECEIVERS) {
      assert.deepEqual(s.byId[id].route, routeFor(call,id,spot,flip));
      assert.ok(s.byId[id].route.every(p => p.z >= 0 && p.z <= 118), call.id);
    }
  }
});

test('hot routes start from the called formation and mirror with it', () => {
  for (const call of PLAYS.filter(p => p.type !== 'run')) for (const flip of [false,true]) {
    const s = new Simulation(9, { offense:call.id, coverage:'man', flip });
    const original = JSON.stringify(call.routes);
    for (const id of RECEIVERS) {
      const spec = formationFor(call).find(p => p.id === id);
      const streak = hotRouteFor(id,'streak',call);
      assert.equal(streak[0][0], spec.x, call.id + ': ' + id);
      assert.equal(s.setHotRoute(id,'streak'), true);
      assert.equal(s.byId[id].route[0].x, flip ? -spec.x : spec.x);
      const flat = hotRouteFor(id,'flat',call);
      assert.ok(spec.x < 0 ? flat[0][0] < spec.x : flat[0][0] > spec.x, call.id + ': flat goes outside');
    }
    assert.equal(JSON.stringify(call.routes), original, 'hot routes never mutate the playbook');
  }
});

test('all run concepts physically meet at the handoff from either side', () => {
  for (const call of PLAYS.filter(p => p.type === 'run')) for (const flip of [false,true]) {
    const s = new Simulation(42, { offense:call.id, coverage:'cover3', flip });
    s.snap();
    while (!s.handoff && s.time < 1.8 && s.phase !== 'dead') s.step(STEP);
    assert.equal(s.handoff, true, call.id + ': handoff completes');
    assert.equal(s.selected, 'R', call.id + ': control transfers to back');
    const qb = s.byId.QB, rb = s.byId.R;
    assert.ok(Math.hypot(qb.x-rb.x,qb.z-rb.z) <= 1.4,
      call.id + ': no remote handoff (' + Math.hypot(qb.x-rb.x,qb.z-rb.z).toFixed(2) + ' yd)');
  }
});

const THREE = await import('../dist/vendor/three.module.js').catch(() => null);
test('field route ribbons originate beneath the players in the selected formation', {
  skip: THREE ? false : 'vendored three.js not present (run npm run check)',
}, async () => {
  const { rebuildPlayArt } = await import('../dist/js/env/playart.js');
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect(){}, fillRect(){} }) }) };
  try {
    const group = new THREE.Group();
    for (const formationId of Object.keys(FORMATIONS)) for (const flip of [false,true]) {
      const call = PLAYS.find(p => p.formationId === formationId);
      rebuildPlayArt(group,call,35,flip);
      assert.equal(group.children.length,10);
      RECEIVERS.forEach((id,i) => {
        const start = formationFor(call).find(p => p.id === id);
        const positions = group.children[i*2].geometry.getAttribute('position');
        assert.ok(Math.abs((positions.getX(0)+positions.getX(1))/2 - (flip ? -start.x : start.x)) < 1e-5);
        assert.ok(Math.abs((positions.getZ(0)+positions.getZ(1))/2 + 35 + start.z) < 1e-5);
        for (const value of positions.array) assert.ok(Number.isFinite(value));
      });
    }
    for (const child of group.children) { child.geometry.dispose(); child.material.dispose(); }
  } finally { globalThis.document = previousDocument; }
});
