// Totals and text tables for the bench. Rates are shares of the plays they
// can happen on: completions, interceptions and yards per attempt of
// attempts (throws plus throw-aways), sacks and pressure of dropbacks,
// breakups and drops of balls thrown, the rest of all plays.

const EXPLOSIVE = 20;        // yd: an explosive play
const PRESSURE_BY = 2.5;     // s: pressure counted up to this time

export function summarize(reps) {
  const s = {
    n: 0, errors: 0, dropbacks: 0, runs: 0, attempts: 0, throws: 0, completions: 0, passYards: 0,
    yards: 0, sacks: 0, ints: 0, pbus: 0, drops: 0, pressured: 0, ttt: 0, open15: 0, open15n: 0, open25: 0, open25n: 0,
    explosive: 0, tds: 0, carries: 0, rushYards: 0, scrambles: 0, scrambleYards: 0, throwAways: 0, firstDowns: 0,
    yac: 0, airYards: 0, thirds: 0, thirdConversions: 0,
  };
  for (const r of reps) {
    if (r.error) { s.errors++; continue; }
    s.n++; s.yards += r.yards;
    if (r.firstDown) s.firstDowns++;
    if (r.yards >= EXPLOSIVE) s.explosive++;
    if (r.kind === 'touchdown') s.tds++;
    if (r.down === 3) { s.thirds++; if (r.firstDown) s.thirdConversions++; }
    if (r.type === 'run') { s.runs++; s.carries++; s.rushYards += r.yards; continue; }
    s.dropbacks++;
    if (r.pressureAt != null && r.pressureAt <= PRESSURE_BY) s.pressured++;
    if (r.kind === 'sack') s.sacks++;
    if (r.scramble) { s.scrambles++; s.scrambleYards += r.yards; }
    if (r.thrown || r.throwAway) s.attempts++;
    if (r.throwAway) s.throwAways++;
    if (r.thrown) {
      s.throws++; s.ttt += r.releaseAt;
      if (r.completed) { s.completions++; s.passYards += r.yards; s.yac += r.yac ?? 0; s.airYards += r.catchDepth ?? 0; }
      if (r.kind === 'interception') s.ints++;
      if (r.deflection) s.pbus++;
      if (r.drop) s.drops++;
    }
    if (r.open?.[0] != null) { s.open15 += r.open[0]; s.open15n++; }
    if (r.open?.[1] != null) { s.open25 += r.open[1]; s.open25n++; }
  }
  const per = (a, b, k = 100) => (b ? (a / b) * k : null);
  return {
    n: s.n, errors: s.errors, dropbacks: s.dropbacks, runs: s.runs, attempts: s.attempts, completions: s.completions,
    cmpPct: per(s.completions, s.attempts), ypa: per(s.passYards, s.attempts, 1), ypp: per(s.yards, s.n, 1),
    sackPct: per(s.sacks, s.dropbacks), intPct: per(s.ints, s.attempts), pbuPct: per(s.pbus, s.throws), dropPct: per(s.drops, s.throws),
    pressurePct: per(s.pressured, s.dropbacks), ttt: per(s.ttt, s.throws, 1),
    open15: per(s.open15, s.open15n, 1), open25: per(s.open25, s.open25n, 1),
    explosivePct: per(s.explosive, s.n), tdPct: per(s.tds, s.n), firstDownPct: per(s.firstDowns, s.n),
    ypc: per(s.rushYards, s.carries, 1), scramblePct: per(s.scrambles, s.dropbacks), throwAwayPct: per(s.throwAways, s.dropbacks),
    yac: per(s.yac, s.completions, 1), adot: per(s.airYards, s.completions, 1),
    thirdPct: per(s.thirdConversions, s.thirds), sacks: s.sacks, ints: s.ints, tds: s.tds,
  };
}

export function summarizeDrives(drives) {
  const n = drives.length, count = k => drives.filter(d => d.end === k).length;
  const sum = k => drives.reduce((a, d) => a + d[k], 0);
  return {
    drives: n, plays: n ? sum('plays') / n : null, yards: n ? sum('yards') / n : null, firstDowns: n ? sum('firstDowns') / n : null,
    tdPct: n ? (count('touchdown') / n) * 100 : null, intPct: n ? (count('interception') / n) * 100 : null,
    downsPct: n ? (count('downs') / n) * 100 : null, points: n ? (7 * count('touchdown') - 2 * count('safety')) / n : null,
  };
}

// Completion by the quarterback's own openness score at the decision: a
// check that the score means something.
export function calibration(reps) {
  const edges = [-Infinity, 1, 2, 3, 4, Infinity], rows = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const in_ = reps.filter(r => !r.error && r.thrown && r.openThrow != null && r.openThrow >= edges[i] && r.openThrow < edges[i + 1]);
    const label = i === 0 ? `<${edges[1]}` : i === edges.length - 2 ? `${edges[i]}+` : `${edges[i]}-${edges[i + 1]}`;
    const cmp = in_.filter(r => r.completed).length, int = in_.filter(r => r.kind === 'interception').length;
    rows.push({ label, n: in_.length, cmpPct: in_.length ? (cmp / in_.length) * 100 : null, intPct: in_.length ? (int / in_.length) * 100 : null });
  }
  return rows;
}

const f1 = v => (v == null ? '-' : v.toFixed(1)), f2 = v => (v == null ? '-' : v.toFixed(2)), int = v => (v == null ? '-' : String(v));
export const COLUMNS = [
  { head: 'n', get: s => int(s.n), w: 5 },
  { head: 'cmp%', get: s => f1(s.cmpPct), w: 6 },
  { head: 'y/a', get: s => f1(s.ypa), w: 5 },
  { head: 'y/p', get: s => f1(s.ypp), w: 5 },
  { head: 'sack%', get: s => f1(s.sackPct), w: 6 },
  { head: 'int%', get: s => f1(s.intPct), w: 5 },
  { head: 'pbu%', get: s => f1(s.pbuPct), w: 5 },
  { head: 'drop%', get: s => f1(s.dropPct), w: 6 },
  { head: 'pr2.5%', get: s => f1(s.pressurePct), w: 7 },
  { head: 'ttt', get: s => f2(s.ttt), w: 5 },
  { head: 'open2.5', get: s => f2(s.open25), w: 8 },
  { head: '20+%', get: s => f1(s.explosivePct), w: 5 },
  { head: 'td%', get: s => f1(s.tdPct), w: 5 },
  { head: 'ypc', get: s => f1(s.ypc), w: 5 },
  { head: 'scr%', get: s => f1(s.scramblePct), w: 5 },
];
const DRIVE_COLUMNS = [
  { head: 'drives', get: d => int(d.drives), w: 7 },
  { head: 'plays/dr', get: d => f1(d.plays), w: 9 },
  { head: 'yds/dr', get: d => f1(d.yards), w: 7 },
  { head: '1st/dr', get: d => f2(d.firstDowns), w: 7 },
  { head: 'pts/dr', get: d => f2(d.points), w: 7 },
  { head: 'td%', get: d => f1(d.tdPct), w: 6 },
  { head: 'int%', get: d => f1(d.intPct), w: 6 },
  { head: 'downs%', get: d => f1(d.downsPct), w: 7 },
  { head: '3rd%', get: d => f1(d.third), w: 6 },
];

export function table(title, rows, label = 'coverage', columns = COLUMNS) {
  const width = Math.max(label.length, ...rows.map(r => r.name.length)) + 1;
  const line = (name, cells) => name.padEnd(width) + cells.map((c, i) => c.padStart(columns[i].w + 1)).join('');
  const out = [title, line(label, columns.map(c => c.head))];
  for (const r of rows) {
    if (r.rule) out.push('-'.repeat(width + columns.reduce((a, c) => a + c.w + 1, 0)));
    out.push(line(r.name, columns.map(c => c.get(r.stats))));
  }
  return out.join('\n');
}

export const driveTable = (title, rows, label) => table(title, rows, label, DRIVE_COLUMNS);

export function summaryLine(name, s) {
  const p = (v, d = 1) => (v == null ? '-' : v.toFixed(d));
  return `${name}: ${s.n} plays · cmp ${p(s.cmpPct)}% · ${p(s.ypa)} y/a · ${p(s.ypp)} y/p · sack ${p(s.sackPct)}% · int ${p(s.intPct)}% · pbu ${p(s.pbuPct)}% · pressure by 2.5 s ${p(s.pressurePct)}% · ttt ${p(s.ttt, 2)} s · open@2.5 ${p(s.open25, 2)} · 20+ ${p(s.explosivePct)}% · td ${p(s.tdPct)}% · ypc ${p(s.ypc)}`;
}
