#!/usr/bin/env node
// The scripted-quarterback bench: plays many reps of the real simulation with
// a scripted quarterback and ball carrier (scripts/bench/qb.mjs and
// carrier.mjs) and reports what happened by difficulty and coverage, so the
// defense and the pass rush can be tuned with numbers instead of feel.
// Every rep is seeded from --seed and its index, so a run replays exactly,
// however many worker threads share it. No dependencies.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { mix } from './bench/util.mjs';
import { summarize, summarizeDrives, calibration, table, driveTable, summaryLine } from './bench/report.mjs';

const HELP = `Scripted-quarterback bench for FootballSim.

Usage:
  node scripts/bench.mjs [options]
  node scripts/bench.mjs --watch <seed> <play> [coverage] [--difficulty pro] [--aggression 0.5] [--flip]

Options:
  --reps N            reps per cell (difficulty x coverage x aggression); in drive
                      mode, drives per cell. Default 100.
  --seed S            base seed. Rep i uses the same seed in every cell. Default 1.
  --difficulty D      rookie | pro | allpro | all, or a comma list. Default all.
  --coverage C        a COVERAGES key from dist/js/plays.js (cover3, cover2, man,
                      blitz, ...), random, all (every key but random), or a comma
                      list. Default all.
  --plays P           all | pass (with play action) | run | a comma list of play
                      ids. Reps cycle through the plays in order. Default all.
  --formation F       only plays from these formations (comma list of ids).
  --aggression A      0..1, the openness the quarterback accepts (0 cautious, 1
                      aggressive), or cautious (0.2), balanced (0.5),
                      aggressive (0.8), both (0.2 and 0.8), or a comma list.
                      Default 0.5.
  --mode M            reps (each rep from --spot, the default) or drive (move the
                      chains from --spot until a score, a turnover or downs).
  --spot Y            line of scrimmage, z in yards (35 = own 25). Default 35.
  --by K              rows: coverage (default), family (the coverage actually
                      called, useful with random), personnel (the defensive
                      package), shell, front, play, formation.
  --flip              flip every play (default: alternate flipped and normal).
  --jobs N            worker threads. Default: one per CPU but one, at most 8.
  --sim DIR           drive the game in DIR (a copy of dist/js) instead of
                      dist/js, e.g. an older commit for an A/B comparison:
                      git archive HEAD dist/js | tar -x -C /tmp/base
                      node scripts/bench.mjs --sim /tmp/base/dist/js
  --json FILE         write every rep and every table as JSON.
  --quiet             print only the summary line per difficulty.
  --watch S P [C]     play one rep (seed S, play P, coverage C, default random)
                      and print a trace every 0.25 s: the quarterback, the
                      nearest rusher, each receiver's separation / openness,
                      and the scripted quarterback's decision.
  --help              this text.

Columns: cmp% and int% per attempt (throws and throw-aways), y/a passing yards
per attempt, y/p yards per play, sack% and pr2.5% (a defender within 1.5 yd of
the quarterback by 2.5 s) per dropback, pbu% and drop% per ball thrown, ttt mean
time to throw (s), open2.5 receivers more than 2.5 yd from every defender at
2.5 s, 20+% explosive plays, td% touchdowns, ypc yards per designed run, scr%
scrambles per dropback.`;

const NAMES = { rookie: 'Rookie', pro: 'Pro', allpro: 'All-pro' };
const PROFILES = { cautious: [0.2], balanced: [0.5], aggressive: [0.8], both: [0.2, 0.8] };
const QUIET_EVENTS = new Set(['cut', 'snap']);

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

// The simulation is edited while the bench runs: a module that does not load
// is reported plainly instead of as a stack trace.
async function load(path) {
  try { return await import(path); }
  catch (error) { fail(`Could not load the game (${process.env.BENCH_SIM || 'dist/js'}): ${error.message}\nIf another change is mid-edit, try again in a minute.`, 2); }
}

function parse(argv) {
  const o = { sim: null, reps: 100, seed: 1, difficulty: 'all', coverage: 'all', plays: 'all', formation: null, aggression: '0.5', mode: 'reps', spot: 35, by: 'coverage', flip: false, jobs: null, json: null, quiet: false, watch: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i], value;
    if (arg === '-h') arg = '--help';
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg} (see --help)`);
    const eq = arg.indexOf('=');
    if (eq > 0) { value = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    const name = arg.slice(2);
    const take = () => {
      if (value !== undefined) return value;
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`--${name} needs a value`);
      return argv[++i];
    };
    if (name === 'help') o.help = true;
    else if (name === 'quiet') o.quiet = true;
    else if (name === 'flip') o.flip = true;
    else if (name === 'watch') {
      o.watch = [take()];
      while (o.watch.length < 3 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.watch.push(argv[++i]);
    } else if (name in o) o[name] = take();
    else fail(`Unknown option --${name} (see --help)`);
  }
  return o;
}

function list(text) {
  return String(text).split(',').map(s => s.trim()).filter(Boolean);
}

function aggressions(text) {
  const out = [];
  for (const item of list(text)) {
    if (PROFILES[item]) out.push(...PROFILES[item]);
    else if (Number.isFinite(Number(item)) && Number(item) >= 0 && Number(item) <= 1) out.push(Number(item));
    else fail(`--aggression takes 0..1 or ${Object.keys(PROFILES).join(', ')}, not ${item}`);
  }
  return [...new Set(out)];
}

function choosePlays(o, PLAYS) {
  let plays;
  if (o.plays === 'all') plays = PLAYS;
  else if (o.plays === 'pass') plays = PLAYS.filter(p => p.type !== 'run');
  else if (o.plays === 'run') plays = PLAYS.filter(p => p.type === 'run');
  else {
    plays = list(o.plays).map(id => PLAYS.find(p => p.id === id) || fail(`Unknown play ${id}. Plays: ${PLAYS.map(p => p.id).join(', ')}`));
  }
  if (o.formation) {
    const formations = list(o.formation);
    plays = plays.filter(p => formations.includes(p.formationId));
  }
  if (!plays.length) fail('No plays match --plays and --formation.');
  return plays;
}

function chooseCoverages(o, COVERAGES) {
  const keys = Object.keys(COVERAGES);
  if (o.coverage === 'all') return keys.filter(k => k !== 'random');
  const out = list(o.coverage);
  for (const c of out) if (!keys.includes(c)) fail(`Unknown coverage ${c}. Coverages: ${keys.join(', ')}, all`);
  return out;
}

function chooseLevels(o, levels) {
  if (o.difficulty === 'all') return levels;
  const out = list(o.difficulty);
  for (const d of out) if (!levels.includes(d)) fail(`Unknown difficulty ${d}. Levels: ${levels.join(', ')}, all`);
  return out;
}

// Runs the tasks inline (one job) or spread over worker threads, task k to
// worker k mod jobs; results come back in task order.
async function runAll(tasks, jobs, progress) {
  if (jobs <= 1) {
    const { runTask } = await load('./bench/rep.mjs');
    return tasks.map(task => { const r = runTask(task); progress(1); return r; });
  }
  const shares = Array.from({ length: jobs }, () => []);
  tasks.forEach((task, k) => shares[k % jobs].push(task));
  const results = new Array(tasks.length);
  await Promise.all(shares.map(share => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bench/worker.mjs', import.meta.url), { workerData: { tasks: share } });
    worker.on('message', m => {
      if (m.progress) progress(m.progress);
      if (m.results) for (const { order, result } of m.results) results[order] = result;
    });
    worker.on('error', reject);
    worker.on('exit', code => (code ? reject(new Error(`a bench worker exited with code ${code}`)) : resolve()));
  })));
  return results;
}

function groupKey(by, rep, formationOf) {
  if (by === 'coverage') return rep.request;
  if (by === 'family') return rep.family ?? '?';
  if (by === 'personnel') return rep.personnel ?? '(none)';
  if (by === 'shell') return rep.shell ?? '(none)';
  if (by === 'front') return rep.front ?? '(none)';
  if (by === 'play') return rep.play;
  if (by === 'formation') return formationOf(rep.play);
  return '?';
}

async function bench(o) {
  const { plays: { PLAYS, COVERAGES }, dir } = await load('./bench/game.mjs');
  const defense = await import(new URL('sim/defense.js', dir)).catch(() => null);
  const levels = defense?.DIFFICULTY ? Object.keys(defense.DIFFICULTY) : ['rookie', 'pro', 'allpro'];
  const reps = Number(o.reps), seed = Number(o.seed), spot = Number(o.spot);
  if (!Number.isInteger(reps) || reps < 1) fail('--reps takes a whole number above zero');
  if (!Number.isFinite(seed)) fail('--seed takes a number');
  if (!['reps', 'drive'].includes(o.mode)) fail('--mode is reps or drive');
  if (!['coverage', 'family', 'personnel', 'shell', 'front', 'play', 'formation'].includes(o.by)) fail('--by is coverage, family, personnel, shell, front, play or formation');
  if (!Number.isFinite(spot) || spot < 11 || spot > 105) fail('--spot takes a z between 11 and 105');
  const plays = choosePlays(o, PLAYS), coverages = chooseCoverages(o, COVERAGES), difficulties = chooseLevels(o, levels), profiles = aggressions(o.aggression);
  const tasks = [];
  for (const aggression of profiles) for (const difficulty of difficulties) for (const coverage of coverages) for (let i = 0; i < reps; i++) {
    const play = plays[i % plays.length];
    tasks.push({
      order: tasks.length, mode: o.mode, difficulty, coverage, aggression, index: i, seed: mix(seed, i), spot,
      play: play.id, flip: o.flip || Math.floor(i / plays.length) % 2 === 1, plays: o.mode === 'drive' ? plays.map(p => p.id) : undefined,
    });
  }
  // One worker per spare core; each warms up its own copy of the game, so a
  // small run uses fewer (about 40 tasks a worker at least).
  const jobs = Math.max(1, Number(o.jobs) || Math.min(8, availableParallelism() - 1, Math.ceil(tasks.length / 40)));
  const started = performance.now(), tty = process.stderr.isTTY && !o.quiet;
  let done = 0;
  const progress = k => {
    done += k;
    if (tty) process.stderr.write(`\r  ${done}/${tasks.length} ${o.mode === 'drive' ? 'drives' : 'reps'}  ${((performance.now() - started) / 1000).toFixed(1)} s `);
  };
  let results;
  try { results = await runAll(tasks, jobs, progress); }
  catch (error) { fail(`\nThe bench stopped: ${error.message}\nIf the simulation is mid-edit, try again in a minute.`, 2); }
  if (tty) process.stderr.write('\r' + ' '.repeat(60) + '\r');
  const seconds = (performance.now() - started) / 1000;

  // Flatten drives into their reps; keep the drives for the drive table.
  const all = [], drives = [];
  for (const r of results) {
    if (r?.drive) { drives.push(r.drive); all.push(...r.reps); }
    else all.push(r);
  }
  const errors = all.filter(r => r.error);
  const formationOf = id => PLAYS.find(p => p.id === id)?.formationId ?? '?';
  const label = level => NAMES[level] || level;
  const out = [], json = { meta: { args: o, plays: plays.map(p => p.id), coverages, difficulties, aggression: profiles, reps, seed, spot, mode: o.mode, jobs, seconds, node: process.version }, cells: [], summary: [], drives: [], calibration: null, reps: all };
  out.push(`FootballSim bench · ${o.mode} mode · ${reps} ${o.mode === 'drive' ? 'drives' : 'reps'} per cell · seed ${seed} · plays ${o.plays === 'all' || o.plays === 'pass' || o.plays === 'run' ? o.plays : 'custom'} (${plays.length}) · aggression ${profiles.join(', ')} · spot ${spot}${o.sim ? ` · game ${o.sim}` : ''}`);
  const summary = [];
  for (const aggression of profiles) for (const difficulty of difficulties) {
    const cell = all.filter(r => r.aggression === aggression && r.difficulty === difficulty);
    const keys = o.by === 'coverage' ? coverages : [...new Set(cell.map(r => groupKey(o.by, r, formationOf)))].sort();
    const rows = keys.map(k => ({ name: k, stats: summarize(cell.filter(r => groupKey(o.by, r, formationOf) === k)) }));
    const total = summarize(cell);
    rows.push({ name: 'all', stats: total, rule: true });
    const title = `\n${label(difficulty)} · aggression ${aggression.toFixed(2)}`;
    out.push(table(title, rows, o.by));
    for (const r of rows) json.cells.push({ aggression, difficulty, by: o.by, group: r.name, stats: r.stats });
    summary.push({ aggression, difficulty, stats: total });
    if (o.mode === 'drive') {
      const dcell = drives.filter(d => d.aggression === aggression && d.difficulty === difficulty);
      const drows = coverages.map(c => ({ name: c, stats: { ...summarizeDrives(dcell.filter(d => d.request === c)), third: summarize(cell.filter(r => r.request === c)).thirdPct } }));
      drows.push({ name: 'all', stats: { ...summarizeDrives(dcell), third: total.thirdPct }, rule: true });
      out.push(driveTable(`\nDrives · ${label(difficulty)} · aggression ${aggression.toFixed(2)}`, drows, 'coverage'));
      for (const r of drows) json.drives.push({ aggression, difficulty, coverage: r.name, stats: r.stats });
    }
  }
  json.summary = summary;
  json.calibration = calibration(all);
  const lines = summary.map(s => summaryLine(`${label(s.difficulty)}${profiles.length > 1 ? ` (aggression ${s.aggression})` : ''}`, s.stats));
  if (o.quiet) console.log(lines.join('\n'));
  else {
    out.push('\nSummary', ...lines.map(l => '  ' + l));
    out.push('\nOpenness at the decision vs result (the quarterback\'s own score, yards): ' +
      json.calibration.map(c => `${c.label} n=${c.n} cmp ${c.cmpPct == null ? '-' : c.cmpPct.toFixed(0)}% int ${c.intPct == null ? '-' : c.intPct.toFixed(1)}%`).join(' | '));
    out.push(`${all.length - errors.length} plays in ${seconds.toFixed(1)} s on ${jobs} job${jobs > 1 ? 's' : ''}.`);
    console.log(out.join('\n'));
  }
  if (errors.length) {
    process.stderr.write(`\n${errors.length} rep${errors.length > 1 ? 's' : ''} threw. First error (seed ${errors[0].seed}):\n${errors[0].error}\n`);
  }
  if (o.json) {
    writeFileSync(o.json, JSON.stringify(json));
    if (!o.quiet) console.log(`Wrote ${o.json}.`);
  }
  if (errors.length && errors.length === all.length) process.exit(1);
}

// One rep, traced: every 0.25 s the quarterback, the nearest defender to
// him, each receiver as separation / openness (the scripted quarterback's
// score; '*' his target, 'b' a back staying in to block), and the decision.
async function watch(o) {
  const [seedText, playId, coverage = 'random'] = o.watch;
  const { plays: { PLAYS, COVERAGES, RECEIVERS } } = await load('./bench/game.mjs');
  const { runRep } = await load('./bench/rep.mjs');
  const seed = Number(seedText);
  if (!Number.isFinite(seed)) fail('--watch takes a seed, a play id and a coverage');
  const play = PLAYS.find(p => p.id === playId) || fail(`Unknown play ${playId}. Plays: ${PLAYS.map(p => p.id).join(', ')}`);
  if (!COVERAGES[coverage]) fail(`Unknown coverage ${coverage}. Coverages: ${Object.keys(COVERAGES).join(', ')}`);
  const difficulty = o.difficulty === 'all' ? 'pro' : list(o.difficulty)[0];
  const aggression = aggressions(o.aggression)[0];
  const task = { mode: 'reps', difficulty, coverage, aggression, index: 0, seed, play: play.id, flip: o.flip, spot: Number(o.spot) };
  const f = (v, d = 1, w = 5) => (v == null || !Number.isFinite(v) ? '-' : (v >= 0 ? '+' : '') + v.toFixed(d)).padStart(w);
  let next = 0.25, header = false;
  const hook = (sim, qb, runner, rec, events) => {
    const t = sim.time.toFixed(2).padStart(5);
    if (!header) {
      header = true;
      console.log(`${play.name} (${play.id}${o.flip ? ', flipped' : ''}) vs ${COVERAGES[coverage].label}: called ${sim.coverage}${rec.front ? `, ${rec.front} front` : ''}${rec.shell ? `, ${rec.shell} shell` : ''} · ${NAMES[difficulty] || difficulty} · aggression ${aggression} · seed ${seed}`);
      console.log(`Reads ${qb.order.join(' ')} · checkdown ${qb.checkdown}${qb.clears.length ? ` · clears ${qb.clears.join(' ')}` : ''} · reaction ${qb.reaction.toFixed(2)} s · line z ${sim.spot}`);
      console.log(`    t phase  QB x/z       rush     ${RECEIVERS.map(id => id.padEnd(10)).join('')}decision`);
    }
    for (const e of events) {
      if (QUIET_EVENTS.has(e)) continue;
      let detail = '';
      if (e === 'throw' && sim.pass) detail = ` to ${sim.pass.receiver}, ${sim.pass.style}, ${(sim.pass.target.z - sim.spot).toFixed(1)} yd downfield, ${sim.pass.duration.toFixed(2)} s in the air`;
      else if (e === 'catch' && sim.carrier) detail = ` by ${sim.carrier} at ${(sim.byId[sim.carrier].z - sim.spot).toFixed(1)} yd`;
      else if (e === 'tackle') detail = ` by ${sim.tackler ?? '?'}`;
      else if (e === 'juke') detail = ` (${runner.note})`;
      console.log(`${t} * ${e}${detail}`);
    }
    if (sim.time + 1e-9 < next || sim.phase === 'dead') return;
    next += 0.25;
    const q = sim.byId.QB, c = sim.carrier && sim.byId[sim.carrier];
    let rush = '', nearest = Infinity;
    for (const d of sim.defense) { const g = Math.hypot(d.x - q.x, d.z - q.z); if (g < nearest) { nearest = g; rush = d.id; } }
    const target = qb.decision?.id || qb.pending?.id;
    const cells = RECEIVERS.map(id => {
      const p = sim.byId[id];
      let sep = Infinity;
      for (const d of sim.defense) sep = Math.min(sep, Math.hypot(d.x - p.x, d.z - p.z));
      const look = qb.looks[id], mark = id === target ? '*' : look && !look.available ? 'b' : ' ';
      return `${sep.toFixed(1)}/${look ? look.open.toFixed(1) : '-'}${mark}`.padEnd(10);
    }).join('');
    const doing = sim.carrier === 'QB' && !sim.crossedLine ? qb.note : sim.phase === 'air' ? `ball in the air to ${sim.pass?.receiver}` : c ? `${c.id} at ${f(c.x, 1, 0)}/${f(c.z - sim.spot, 1, 0)}: ${runner.note}` : '';
    console.log(`${t} ${sim.phase.padEnd(6)} ${f(q.x)} ${f(q.z - sim.spot)}  ${nearest.toFixed(1).padStart(4)} ${rush.padEnd(4)} ${cells}${doing}`);
  };
  const rec = runRep(task, hook);
  if (rec.error) fail(rec.error, 2);
  console.log(`Result: ${rec.label} (${rec.kind}), ${rec.yards} yd, ${rec.time} s.` +
    (rec.thrown ? ` Threw to ${rec.target} at ${rec.releaseAt} s (${rec.why}, openness ${rec.openThrow}); separation ${rec.sepRelease} yd at the release, ${rec.sepArrival} at the arrival.` : '') +
    (rec.pressureAt != null ? ` First pressure ${rec.pressureAt} s.` : ' No pressure.'));
}

const options = parse(process.argv.slice(2));
if (options.sim) process.env.BENCH_SIM = options.sim;
if (options.help) console.log(HELP);
else if (options.watch) await watch(options);
else await bench(options);
