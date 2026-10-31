// One rep (or one drive) with the scripted quarterback and ball carrier,
// and what the bench measures about it. Only public parts of the
// simulation are read: positions and velocities, phase, carrier, pass,
// result, events and the coverage called.
import { core, plays, STEP } from './game.mjs';
import { Quarterback } from './qb.mjs';
import { Runner } from './carrier.mjs';
import { generator, mix, nearest } from './util.mjs';

const { Simulation } = core, { RECEIVERS } = plays;
const LIMIT = 30;                 // s; the simulation itself ends a rep at 22 s
const OPEN_SEP = 2.5;             // yd: a receiver this far from every defender is open
const PRESSURE_GAP = 1.5;         // yd: a defender this close to the quarterback is pressure
const CHECKS = [1.5, 2.5];        // s after the snap: count the open receivers
const DRIVE_PLAYS = 40;           // a drive stops after this many snaps
const IDLE = Object.freeze({ x: 0, z: 0, sprint: false });
const round = v => (v == null || !Number.isFinite(v) ? v ?? null : Math.round(v * 100) / 100);

// A bench task: { mode, difficulty, coverage, aggression, index, seed, play,
// flip, spot, plays (drive mode) }. Errors come back as records, so one
// broken rep does not end the run.
export function runTask(task) {
  try { return task.mode === 'drive' ? runDrive(task) : runRep(task); }
  catch (error) { return { ...key(task), error: String(error?.stack || error) }; }
}

function key(task) {
  return { index: task.index, difficulty: task.difficulty, request: task.coverage, aggression: task.aggression, seed: task.seed };
}

// No replay frames: the bench never shows a replay.
function lighten(sim) {
  sim.saveFrame = () => {};
  sim.recording = [];
}

export function runRep(task, hook) {
  const sim = new Simulation(task.seed, { offense: task.play, coverage: task.coverage, difficulty: task.difficulty, mode: 'reps', flip: !!task.flip, spot: task.spot ?? 35 });
  lighten(sim);
  return playOut(sim, task, mix(task.seed, 0x51), hook);
}

// A drive from the configured spot until a touchdown, an interception, a
// safety or a turnover on downs, the call drawn from the play list each down.
export function runDrive(task) {
  const pick = generator(mix(task.seed, 0xD1));
  const choose = () => task.plays[Math.floor(pick() * task.plays.length)];
  const sim = new Simulation(task.seed, { offense: choose(), coverage: task.coverage, difficulty: task.difficulty, mode: 'drive', flip: pick() < 0.5, spot: task.spot ?? 35 });
  lighten(sim);
  const reps = [];
  let end = 'limit', firstDowns = 0, yards = 0;
  for (let n = 0; n < DRIVE_PLAYS; n++) {
    const rec = playOut(sim, task, mix(task.seed, 0x51, n));
    rec.drive = task.index; rec.snap = n;
    reps.push(rec);
    const r = sim.result;
    if (!r) { end = 'unfinished'; break; }
    yards += r.yards;
    if (['touchdown', 'interception', 'safety'].includes(r.kind)) { end = r.kind; break; }
    if (r.firstDown) firstDowns++;
    else if (sim.down >= 4) { end = 'downs'; break; }
    sim.config.offense = choose(); sim.config.flip = pick() < 0.5;
    sim.next();
    if (sim.play?.id !== sim.config.offense) sim.selectPlay(sim.config.offense);
  }
  return { drive: { ...key(task), plays: reps.length, end, firstDowns, yards, start: task.spot ?? 35 }, reps };
}

// Snap, play the rep out with the scripted players and record it. `hook`
// (watch mode) is called after every step with the events of that step.
export function playOut(sim, task, qbSeed, hook) {
  const rec = {
    ...key(task), play: sim.play.id, type: sim.play.type, flip: !!sim.config?.flip,
    family: sim.coverage ?? null, shell: sim.call?.shell ?? null, front: sim.defensiveFront ?? sim.call?.front ?? null, disguised: sim.call?.disguised ?? null,
    down: sim.down ?? null, toGo: sim.toGo ?? null, spot: sim.spot,
    pressureAt: null, open: [null, null], releaseAt: null, target: null, style: null,
    sepRelease: null, sepArrival: null, airYards: null, catchDepth: null,
    deflection: false, drop: false, scramble: false, jukes: 0, brokenTackles: 0,
  };
  const qb = new Quarterback(sim, { aggression: task.aggression ?? 0.5, seed: qbSeed });
  const runner = new Runner();
  sim.snap();
  drain(sim);
  const steps = Math.ceil(LIMIT / STEP);
  for (let i = 0; i < steps && sim.phase !== 'dead'; i++) {
    sim.step(STEP, control(sim, qb, runner));
    const events = drain(sim);
    observe(sim, rec, events);
    if (hook) hook(sim, qb, runner, rec, events);
  }
  const r = sim.result || { kind: 'unfinished', label: 'Unfinished', yards: 0, completed: false, firstDown: false };
  Object.assign(rec, {
    kind: r.kind, label: r.label, yards: r.yards, completed: !!r.completed, firstDown: !!r.firstDown, time: round(sim.time),
    thrown: rec.releaseAt != null, throwAway: qb.threwAway || r.label === 'Thrown away',
    decidedAt: round(qb.decision?.decidedAt), why: qb.decision?.why ?? null, openThrow: round(qb.decision?.open),
    predSep: round(qb.decision?.arriveSep), lane: round(qb.decision?.lane),
    lead: qb.decision ? `${qb.decision.lead.x},${qb.decision.lead.z}` : null,
    reaction: round(qb.reaction), escapes: qb.escapes, jukes: runner.jukes,
    yac: r.completed && rec.catchDepth != null ? round(r.yards - rec.catchDepth) : null,
    open: rec.open.map(v => (v === -1 ? null : v)),
  });
  return rec;
}

function control(sim, qb, runner) {
  if (sim.phase === 'live' && sim.carrier === 'QB' && !sim.crossedLine) return qb.pocket(sim);
  if ((sim.phase === 'live' || sim.phase === 'run') && sim.carrier) return runner.control(sim);
  return IDLE;
}

function drain(sim) {
  if (typeof sim.drainEvents === 'function') return sim.drainEvents();
  return Array.isArray(sim.events) ? sim.events.splice(0) : [];
}

function observe(sim, rec, events) {
  const t = sim.time, spot = rec.spot;
  for (const e of events) {
    if (e === 'deflection') rec.deflection = true;
    else if (e === 'drop') rec.drop = true;
    else if (e === 'broken-tackle') rec.brokenTackles++;
    else if (e === 'catch' && sim.carrier && sim.byId[sim.carrier]) rec.catchDepth = round(sim.byId[sim.carrier].z - spot);
  }
  const qb = sim.byId.QB;
  if (rec.pressureAt == null && sim.phase === 'live' && sim.carrier === 'QB' && !sim.crossedLine && nearest(sim.defense, qb).gap < PRESSURE_GAP) rec.pressureAt = round(t);
  for (let k = 0; k < CHECKS.length; k++) {
    if (rec.open[k] !== null || t < CHECKS[k] - 1e-9) continue;
    const passing = rec.type !== 'run' && (sim.phase === 'live' || sim.phase === 'air') && !sim.crossedLine;
    rec.open[k] = passing ? RECEIVERS.filter(id => sim.byId[id] && nearest(sim.defense, sim.byId[id]).gap > OPEN_SEP).length : -1;
  }
  if (sim.pass && rec.releaseAt == null) {
    rec.releaseAt = round(t); rec.target = sim.pass.receiver; rec.style = sim.pass.style ?? null;
    const p = sim.byId[rec.target];
    if (p) rec.sepRelease = round(nearest(sim.defense, p).gap);
    if (sim.pass.target) rec.airYards = round(sim.pass.target.z - spot);
  }
  if (rec.releaseAt != null && rec.sepArrival == null && (sim.phase !== 'air' || (sim.pass && sim.pass.elapsed >= sim.pass.duration))) {
    const p = sim.byId[rec.target];
    if (p) rec.sepArrival = round(nearest(sim.defense, p).gap);
  }
  if (rec.type !== 'run' && sim.carrier === 'QB' && sim.crossedLine) rec.scramble = true;
}
