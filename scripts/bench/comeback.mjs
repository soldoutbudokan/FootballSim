// Fourth-quarter comebacks played by the bench's scripted quarterback and a
// simple clock manager, so the situations and the clock rules are measured,
// not felt. Every game is seeded (its seed makes the situation too).
//
//   node scripts/bench/comeback.mjs                      # 100 games a level
//   node scripts/bench/comeback.mjs --games 300 --difficulty allpro --seed 7
//   BENCH_SIM=/tmp/base/dist/js node scripts/bench/comeback.mjs
//
// The manager is not a good one: it never throws to the sideline on purpose
// and decides in no time at all. It
//   - calls the coordinator's pick for every down;
//   - takes a timeout after any play that leaves the clock running, while it
//     has one and either under TIMEOUT s are left or a kick from there is
//     better than RANGE;
//   - kicks, when three points are enough, once the kick is better than
//     SURE, on fourth down if it is better than LONG, or with under LAST s
//     left (with the clock running only if the unit can still get on);
//   - spikes the ball in range (better than LONG) with the clock running,
//     under SPIKE s left and downs to spare;
//   - goes without a huddle otherwise;
//   - after a touchdown kicks when the kick wins, and goes for two when it
//     would only tie.
import { playOut } from './rep.mjs';
import { core, dir, STEP } from './game.mjs';

const { Simulation } = core;
const { CLOCK, fieldGoalOdds, kickDistance } = await import(new URL('sim/comeback.js', dir));
const TIMEOUT = 50, RANGE = 0.6, SURE = 0.8, LONG = 0.3, LAST = 9, SPIKE = 22, MOST = 40;

const args = process.argv.slice(2), option = (name, fallback) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : fallback; };
if (args.includes('--help')) { console.log('--games N (100)  --seed S (1)  --difficulty rookie|pro|allpro|all (all)'); process.exit(0); }
const games = Number(option('games', 100)), seed0 = Number(option('seed', 1)), level = option('difficulty', 'all');
const levels = level === 'all' ? ['rookie', 'pro', 'allpro'] : [level];

function wait(sim, done, limit = 60) { for (let t = 0; !done() && t < limit; t += STEP) sim.step(STEP); }

function play(seed, difficulty) {
  const sim = new Simulation(seed, { mode: 'comeback', difficulty });
  sim.saveFrame = () => {}; sim.recording = [];
  const g = sim.game, scenario = { ...g.scenario };
  for (let n = 0; n < MOST && !g.over; n++) {
    if (sim.phase === 'presnap' && !sim.kick) {
      sim.setPlay('random');
      wait(sim, () => sim.ready || g.over);
      if (g.over) break;
      playOut(sim, { aggression: 0.5 }, seed * 100 + n);
    }
    wait(sim, () => sim.deadTime > 0.5 || g.over, 5);
    if (g.over) break;
    if (g.stage === 'pat') {
      if (g.us >= g.them) sim.tryKick(); else sim.tryTwo();
      if (sim.kick) wait(sim, () => !!g.over);
      continue;
    }
    const at = g.next || sim, fourth = at.down === 4, odds = g.us + 3 >= g.them ? fieldGoalOdds(kickDistance(at.spot)) : 0;
    if (g.running && g.timeouts > 0 && (g.clock < TIMEOUT || odds > RANGE)) sim.timeout();
    const unit = !g.running || g.clock > CLOCK.unit + 1;
    if (odds > 0 && unit && (odds >= SURE || (fourth && odds > LONG) || g.clock < LAST)) { sim.fieldGoal(); wait(sim, () => !!g.over); continue; }
    if (g.running && odds > LONG && g.clock < SPIKE && !fourth && sim.spikeBall()) { wait(sim, () => (sim.phase === 'dead' && sim.result?.spike) || g.over); continue; }
    sim.next();
  }
  return { scenario, over: g.over };
}

const pct = (n, of) => (of ? (100 * n / of).toFixed(0).padStart(3) + ' %' : '   –');
const mean = a => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '–');
console.log(`FootballSim comeback bench · ${games} games a level · seed ${seed0}`);
console.log('level     won   overtime  lost   | kick is enough  needs a touchdown | lost to: pick  downs  clock  kick  try | plays  clock left');
for (const difficulty of levels) {
  const count = { win: 0, tie: 0, loss: 0 }, lost = {}, kind = { kick: [0, 0], td: [0, 0] }, plays = [], left = [];
  let played = 0;
  for (let i = 0; i < games; i++) {
    const r = play(seed0 + i, difficulty);
    if (!r.over) continue;
    played++; count[r.over.result]++;
    const k = kind[r.scenario.deficit <= 3 ? 'kick' : 'td'];
    k[1]++;
    if (r.over.result === 'loss') { const why = r.over.reason.replace(/\d+ /, ''); lost[why] = (lost[why] || 0) + 1; }
    else { k[0]++; plays.push(r.over.plays); left.push(r.over.clock); }
  }
  const l = name => String(lost[name] || 0).padStart(4);
  console.log(`${difficulty.padEnd(8)} ${pct(count.win, played)}   ${pct(count.tie, played)}   ${pct(count.loss, played)}  |      ${pct(kind.kick[0], kind.kick[1])}             ${pct(kind.td[0], kind.td[1])}       |         ${l('Intercepted')}  ${l('Turned over on downs')}  ${l('Time expired')}  ${l('Missed from yards')}  ${l('Two-point try failed')} |  ${mean(plays).padStart(4)}    ${mean(left).padStart(5)} s`);
}
console.log('"kick is enough" and "needs a touchdown": the share of those situations not lost. Plays and clock left: of the games not lost.');
