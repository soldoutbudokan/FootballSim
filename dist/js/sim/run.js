// The run game: run blocking, where every block is a matchup with its own
// life (double teams that climb, the puller's kick-out, defenders who win,
// hold, get driven or knocked down), and the defense's run fits (every gap
// owned, flow, the backside staying home for the cutback, the safety in the
// alley). Mixed into Simulation like the other sim modules. Positions are on
// the field: a flipped play mirrors `side`.
import { clamp, dist, scaled, seekWant, speedCap, STUMBLE_SPEED, GET_OFF, LEVERAGE } from './common.js';

// One per-rep draw per player (Simulation.reset: `form`, uniform 0-1) gives
// every number below that varies from rep to rep, through unrelated digits of
// it, so the run game takes no extra draws from the seeded stream.
const digit = (u, k) => (u * k) % 1;
const POWER_DIGIT = 1, NEED_DIGIT = 7919, PANCAKE_DIGIT = 6007, BUST_DIGIT = 4271, KIND_DIGIT = 3571, HOME_DIGIT = 2887, FILL_DIGIT = 1597, LINE_DIGIT = 9973;

// Run blocks. A block's margin m (in doublings of power, + for the offense)
// is log2 of the blockers' power over the defender's, plus the scheme. A
// man's power is his mass^`mass` (sim.js BODY: a lineman on a linebacker
// starts about 0.75 up, on a defensive lineman about even) times 2^(±`form`)
// for how well he plays this rep, and the whole line has its day: ±`line`
// on every block of the rep. The blockers know the snap count and where the
// play goes: `count` on every block. A second blocker on the same man (a
// double team) adds `double` of his power. An `angle` block (a down block, the puller's
// kick-out or lead with a run-up) hits him from the side; a `reach` (a zone
// lineman taking a man shaded to his play side) starts behind. A defender
// reads those three (DIFFICULTY `blockRead`, ± on m): against a down block he
// squeezes, against a reach he fights outside, against a puller he takes him
// on with his inside shoulder. A straight base block has no read to make.
//
// Life: without the ball near, a block holds about `hold` × 2^(`holdK` m) s
// (`min` to `max`): he comes off when his pressure, rising as (t / hold)^
// `power`, passes a threshold drawn for the block (exponential, from his
// form). The ball carrier pulls him off it: within `range` yd (all of it at
// `close`) he adds `ball` per second times `near`, plus `coming` for a
// carrier running straight at him (4 yd/s or more) and `open` for a blocker
// who is not between them (square from cos `squareFrom` up), divided by
// 2^(`holdK` m). So the man the back runs at sheds first, a man whose
// blocker has lost the angle comes off at once, and a sealed man the back
// runs past stays sealed; a back who runs into him (within `grab` yd) is his.
// Receivers blocking (a stalk block on a corner or a safety) hold `stalk` as
// long.
//
// While locked: with m over `drive` the blocker drives him back at
// `driveSpeed` yd/s per unit over it (at most `driveMost`); under −`drive`
// he walks the blocker back into the backfield at `penSpeed` per unit (at
// most `penMost`); in between he leans toward the ball at `lean`. A blocker
// who loses by more than `beaten` stumbles for `beatenTime` s as his man
// sheds; on `pancake` of blocks with m over `pancakeFrom` the defender is put
// on the ground (`pancakeAt` s into the block, stumbling for `down` s).
// Locks form within `lock` yd and part beyond `part`; a blocker does not take
// the man he lost again for `relock` s, and takes a new man only within
// `pick` yd.
const RUN_BLOCK = {
  mass: 2.5, form: 1.0, count: 0.55, line: 0.6, double: 0.85, angle: 0.35, reach: -0.35,
  hold: 2.3, holdK: 0.8, min: 0.35, max: 8, power: 2.5,
  ball: 1.2, range: 2.4, close: 0.9, grab: 0.75, near: 0.4, coming: 3, open: 2, squareFrom: 0.3, stalk: 0.6,
  drive: 0.5, driveSpeed: 1.3, driveMost: 1.8, driveMax: 2.5, penSpeed: 1.4, penMost: 2.0, lean: 0.3,
  beaten: 0.5, beatenTime: 0.45, pancake: 0.25, pancakeFrom: 1.3, pancakeAt: [0.5, 1.2], down: 0.9,
  lock: 1.55, part: 2.2, relock: 1, pick: 3,
};
// The run plan. First-level defenders are those lined up within `depth` yd
// of the line and `wide` yd of the ball; the box adds linebackers and
// safeties within `boxDeep` yd. Zone (inside and outside): each lineman takes
// the man over him or in his play-side gap (`zone`: rel yd to the play side,
// low, high and the best spot), play side first; a lineman with nobody there
// doubles the man of the neighbour on his play side (else his back side) and
// climbs to the nearest linebacker from there once that linebacker moves (he
// has read the run, `key` s ago, and runs at `flow` yd/s or more), comes
// within `near` yd of the double team or `depth2` yd of the line, `most` s
// into the block, once the block on the down man is over, or `late` s past
// that if the double team never forms. Gap (power, counter): each lineman on
// the play side of the puller blocks down on the man over him or inside
// (`down`), the back side hinges like a zone lineman to cover the gap the
// puller left; the puller kicks out the first man he finds in the hole, or
// leads up on a linebacker, within `hole` yd of it.
const RUN_PLAN = { depth: 2.5, wide: 9, boxDeep: 8.5, zone: [-0.7, 1.8, 0.4], down: [-2.2, 0.7, -0.6], near: 2.6, depth2: 1.2, most: 0.8, late: 0.5, key: 0.1, flow: 2, hole: 5 };

// Run fits. Gaps on each side, from where the line lined up and moved with
// it as a whole (so the gaps flow with a zone play): A beside the centre, B
// between guard and tackle, C outside the tackle (`c` yd, or between him and
// an attached tight end), D outside that (`d` yd past the C gap). Defensive
// linemen own the gap they line up in; linebackers and box safeties take the
// nearest gap left; a deep safety fills a gap still open on `fill` of reps
// (DIFFICULTY) and reads the run with the linebackers, and one who does not
// stays deep `deep` s longer. A man who has read the run pursues the runner
// on his gap's side of him (inside-out, LEVERAGE; within `even` yd of his gap
// he keeps the side he lined up on), so the gaps stay owned as the play
// moves. A back-side man (his gap more than `back` yd from the runner, on the
// far side from where he is going) stays home on `home` of reps (DIFFICULTY),
// `home` yd on the cutback side of the runner; the others chase the play,
// aiming `chase` yd past the runner, and leave the cutback. A bust
// (DIFFICULTY `bust`) is one of: jumping the next gap toward the play (`jump`
// of busts: he plays the runner from the play side and his own gap is open),
// over-running the play, aiming `over` yd past the runner (`overShare`), or
// peeking into the backfield, reading the run `late` s late (the rest).
const FIT = {
  c: 1.1, d: 2.2, open: 3, behind: 1, even: 0.5, back: 2, home: 2, chase: 1.5, jump: 0.4, overShare: 0.35, over: 2.5, late: 0.35, deep: 0.25,
};

export const running = {
  // This rep's run state, made fresh for every new set of players.
  runState() {
    let st = this.runGame;
    if (!st || st.players !== this.players) {
      const centre = this.byId.C || this.line[0];
      st = this.runGame = {
        players: this.players, plan: false, blocks: new Map(), fits: null, side: Math.sign(this.play.lane || 1) * this.playSide(),
        line: RUN_BLOCK.line * (2 * digit(centre?.form ?? 0.5, LINE_DIGIT) - 1),
      };
    }
    return st;
  },

  // ---------------------------------------------------------------------------
  // Run blocking (RUN_BLOCK, RUN_PLAN), once a step on a run play.
  runBlocking(dt) {
    const st = this.runState(), c = this.guardPoint();
    if (!st.plan) { this.planRunBlocks(st); st.plan = true; }
    // Blocks hold or end; pairs that drifted apart part.
    for (const [id, b] of [...st.blocks]) {
      const d = this.byId[id];
      b.blockers = b.blockers.filter(oid => dist(this.byId[oid], d) <= RUN_BLOCK.part && this.byId[oid].action !== 'stumble');
      if (!b.blockers.length || d.action === 'tackle') { st.blocks.delete(id); continue; }
      this.blockLife(st, b, d, dt);
    }
    for (const o of this.line) {
      if (o.id === this.play.pullingGuard && this.pullBlock(o)) continue;
      if (o.id === this.play.pullingGuard && !o.pullPicked) { o.pullPicked = true; this.pullTarget(o, st); }
      const d = this.runMan(o, st);
      o.sprinting = false;
      if (!d) { o.want = seekWant(o, { x: o.x, z: Math.max(o.z, this.spot + 0.5) }, speedCap(o, 0.5)); continue; }
      if (!this.blockOf(st, o) && dist(o, d) < RUN_BLOCK.lock) this.runLock(st, o, d);
      o.want = this.runBlockWant(st, o, d, c);
    }
    for (const b of st.blocks.values()) for (const oid of b.blockers) this.engage(this.byId[oid], this.byId[b.d]);
  },

  // The plan at the first live step: who blocks whom, the double teams and
  // where they climb (RUN_PLAN). From the alignment only, no draws.
  planRunBlocks(st) {
    const s = st.side, x0 = this.pocketX(), gap = this.play.blocking === 'power' || this.play.blocking === 'counter';
    const puller = this.play.pullingGuard;
    const line = this.line.filter(o => o.id !== puller).sort((a, b) => s * (b.start.x - a.start.x));
    const first = this.defense.filter(d => d.start.z - this.spot < RUN_PLAN.depth && Math.abs(d.start.x - x0) < RUN_PLAN.wide);
    const second = this.defense.filter(d => !first.includes(d) && (d.role === 'lb' || d.role === 's') && d.start.z - this.spot < RUN_PLAN.boxDeep && Math.abs(d.start.x - x0) < RUN_PLAN.wide);
    const taken = new Set();
    const px = puller ? this.byId[puller].start.x : null;
    for (const o of line) {
      o.runMan = null; o.runKind = 'base'; o.combo = null; o.climbTo = null;
      // Down (gap scheme, play side of the puller) or zone and hinge.
      const down = gap && s * (o.start.x - px) > 0, [lo, hi, best] = down ? RUN_PLAN.down : RUN_PLAN.zone;
      let pick = null, cost = Infinity;
      for (const d of first) {
        const rel = s * (d.start.x - o.start.x);
        if (taken.has(d.id) || rel < lo || rel > hi || Math.abs(rel - best) >= cost) continue;
        pick = d; cost = Math.abs(rel - best);
      }
      if (!pick) continue;
      taken.add(pick.id); o.runMan = pick.id;
      const rel = s * (pick.start.x - o.start.x);
      o.runKind = down && rel < -0.4 ? 'angle' : !gap && rel > 0.6 ? 'reach' : 'base';
    }
    const climbs = new Set();
    const nearestSecond = (x, z) => {
      let pick = null, far = Infinity;
      for (const d of second) if (!climbs.has(d.id) && Math.hypot(d.start.x - x, d.start.z - z) < far) { far = Math.hypot(d.start.x - x, d.start.z - z); pick = d; }
      if (pick) climbs.add(pick.id);
      return pick;
    };
    line.forEach((o, i) => {
      if (o.runMan) return;
      const mate = [line[i - 1], line[i + 1]].find(n => n && n.runMan && !line.some(q => q.combo === n.runMan));
      const lb = nearestSecond(o.start.x + s * 1.5, this.spot + 4.5);
      if (mate) { o.combo = mate.runMan; o.runMan = mate.runMan; o.climbTo = lb ? lb.id : null; }
      else o.runMan = lb ? lb.id : null;
    });
  },

  // The puller has come round: he kicks out the first man he finds in the
  // hole (the end man on the line), or leads up on a linebacker.
  pullTarget(o, st) {
    const hole = { x: this.pocketX() + st.side * Math.abs(this.play.lane || 4), z: this.spot + 0.5 };
    let pick = null, cost = Infinity;
    for (const d of this.defense) {
      const b = st.blocks.get(d.id);
      if ((b && b.blockers.length) || d.action === 'stumble' || d.z > this.spot + 6 || dist(d, hole) > RUN_PLAN.hole) continue;
      const c = dist(d, o) - (d.start.z - this.spot < RUN_PLAN.depth ? 1.5 : 0);
      if (c < cost) { cost = c; pick = d; }
    }
    o.runMan = pick ? pick.id : null; o.runKind = pick ? 'angle' : 'base'; o.combo = null; o.climbTo = null;
  },

  // A blocker's man this step: his planned man; a double team's second man
  // climbs to his linebacker when the time comes; once his block is over
  // (shed, knocked down, or a man he cannot reach) the nearest man in front
  // of him nobody has.
  runMan(o, st) {
    let d = o.runMan ? this.byId[o.runMan] : null;
    if (o.combo && o.climbTo && d) {
      const lb = this.byId[o.climbTo], b = st.blocks.get(d.id);
      const since = b && b.blockers.includes(o.id) ? this.time - b.at : 0;
      const ended = !b && (d.runBlocks || 0) > 0, late = this.time > GET_OFF.ol + RUN_PLAN.most + RUN_PLAN.late;
      const moving = this.time > (lb.readRun ?? 0) + RUN_PLAN.key && Math.hypot(lb.vx, lb.vz) > RUN_PLAN.flow;
      if (ended || late || (b && (moving || dist(lb, d) < RUN_PLAN.near || lb.z < this.spot + RUN_PLAN.depth2 || since > RUN_PLAN.most))) {
        if (b) b.blockers = b.blockers.filter(id => id !== o.id);
        o.runMan = o.climbTo; o.combo = null; o.climbTo = null; o.runKind = 'base';
        d = this.byId[o.runMan];
      }
    }
    // Nobody blocks a man behind the runner (that would be a block in the back).
    const c = this.handoff ? this.byId[this.carrier] : null;
    if (d && !this.lostMan(o, d) && d.action !== 'tackle' && dist(o, d) < 8 && !(c && d.z < c.z - 1)) return d;
    let pick = null, far = RUN_BLOCK.pick;
    for (const q of this.defense) {
      const b = st.blocks.get(q.id);
      if ((b && b.blockers.length) || this.lostMan(o, q) || q.action === 'tackle' || q.z < o.z - 1 || (c && q.z < c.z - 1) || dist(o, q) >= far) continue;
      far = dist(o, q); pick = q;
    }
    o.runMan = pick ? pick.id : null; o.runKind = 'base';
    return pick;
  },

  lostMan(o, d) { return (o.lostAt?.[d.id] ?? -9) > this.time - RUN_BLOCK.relock; },
  blockOf(st, o) { for (const b of st.blocks.values()) if (b.blockers.includes(o.id)) return b; return null; },

  // Blocker and defender lock up (or a second blocker joins: a double team).
  // The defender's threshold is drawn now from his form (a new digit for
  // each block he is in this rep), and so is whether this one can end with
  // him on the ground.
  runLock(st, o, d) {
    if (d.action === 'stumble' || d.action === 'tackle' || this.lostMan(o, d)) return false;
    let b = st.blocks.get(d.id);
    if (b) { if (!b.blockers.includes(o.id)) b.blockers.push(o.id); return true; }
    const k = (d.runBlocks = (d.runBlocks || 0) + 1);
    const u = digit(d.form, NEED_DIGIT * k), p = digit(o.form, PANCAKE_DIGIT * k);
    b = {
      d: d.id, blockers: [o.id], at: this.time, from: { x: d.x, z: d.z }, have: 0, need: -Math.log(1 - u),
      pancakeAt: p < RUN_BLOCK.pancake ? this.time + RUN_BLOCK.pancakeAt[0] + (RUN_BLOCK.pancakeAt[1] - RUN_BLOCK.pancakeAt[0]) * (p / RUN_BLOCK.pancake) : Infinity,
    };
    st.blocks.set(d.id, b);
    return true;
  },

  // A man's power in a run block (RUN_BLOCK `mass`, `form`).
  blockPower(p) { return p.mass ** RUN_BLOCK.mass * 2 ** (RUN_BLOCK.form * (2 * digit(p.form ?? 0.5, POWER_DIGIT) - 1)); },

  // The block's margin (+ for the offense): power, the double team, the
  // scheme and the defender's read of it, and the line's day.
  blockMargin(st, b) {
    const d = this.byId[b.d];
    let power = 0, scheme = 0, read = false;
    b.blockers.forEach((id, i) => {
      const o = this.byId[id];
      power += this.blockPower(o) * (i ? RUN_BLOCK.double : 1);
      const kind = o.runMan === b.d ? o.runKind : 'base';
      if (kind === 'angle') { scheme = Math.max(scheme, RUN_BLOCK.angle); read = true; }
      if (kind === 'reach') { scheme = Math.min(scheme, RUN_BLOCK.reach); read = true; }
    });
    return Math.log2(power / this.blockPower(d)) + RUN_BLOCK.count + scheme - (read ? this.skill.blockRead ?? 0 : 0) + (this.line.some(o => b.blockers.includes(o.id)) ? st.line : 0);
  },

  // One step of a block's life (see RUN_BLOCK): pressure toward the shed,
  // faster when the carrier comes at him and his blocker is not between them.
  blockLife(st, b, d, dt) {
    const m = this.blockMargin(st, b), t = this.time - b.at, R = RUN_BLOCK;
    const stalk = b.blockers.every(id => this.byId[id].role !== 'ol') ? R.stalk : 1;
    const hold = clamp(R.hold * stalk * 2 ** (R.holdK * m), R.min, R.max);
    let rate = R.power / hold * (t / hold) ** (R.power - 1);
    const c = this.byId[this.carrier];
    if (c && this.handoff) {
      const gap = dist(d, c), near = clamp((R.range - gap) / (R.range - R.close), 0, 1);
      if (gap < R.grab) b.have = b.need;
      if (near > 0) {
        const toD = scaled(d.x - c.x, d.z - c.z, 1), coming = clamp((c.vx * toD.x + c.vz * toD.z) / 4, 0, 1);
        let square = 0;
        for (const id of b.blockers) {
          const o = this.byId[id], toO = scaled(o.x - d.x, o.z - d.z, 1), toC = scaled(c.x - d.x, c.z - d.z, 1);
          square = Math.max(square, clamp((toO.x * toC.x + toO.z * toC.z - R.squareFrom) / (1 - R.squareFrom), 0, 1));
        }
        rate += R.ball * near * (R.near + R.coming * coming + R.open * (1 - square)) / 2 ** (R.holdK * m);
      }
    }
    b.have += rate * dt;
    if (this.time >= b.pancakeAt && m > R.pancakeFrom) {
      this.endBlock(st, b, d);
      d.action = 'stumble'; d.actionTime = R.down; d.vx *= STUMBLE_SPEED; d.vz *= STUMBLE_SPEED; d.juke = null;
      this.events.push('pancake');
      return;
    }
    if (b.have < b.need) return;
    if (m < -R.beaten) for (const id of b.blockers) {
      const o = this.byId[id];
      o.action = 'stumble'; o.actionTime = R.beatenTime; o.vx *= STUMBLE_SPEED; o.vz *= STUMBLE_SPEED;
    }
    this.endBlock(st, b, d);
    d.shedAt = this.time;
    this.events.push('shed');
  },

  endBlock(st, b, d) {
    for (const id of b.blockers) { const o = this.byId[id]; (o.lostAt ||= {})[d.id] = this.time; }
    st.blocks.delete(d.id);
  },

  // A run blocker's step: to his man's play side (a zone step, a reach on a
  // stretch), the puller to the inside of the man he kicks out; locked, stay
  // square between him and the ball (in on him when driving him back; a
  // double team's second man works hip to hip on his other side).
  runBlockWant(st, o, d, c) {
    const b = st.blocks.get(d.id), s = st.side;
    if (b && b.blockers.includes(o.id)) {
      const m = this.blockMargin(st, b), away = scaled(c.x - d.x, c.z - d.z, m > RUN_BLOCK.drive ? 0.6 : 0.95);
      const second = b.blockers.indexOf(o.id) > 0 ? 0.55 * (o.x > d.x ? 1 : -1) : 0;
      return seekWant(o, { x: d.x + away.x + second, z: d.z + away.z }, speedCap(o, 0.85));
    }
    const stretch = this.play.blocking === 'stretch', kick = o.id === this.play.pullingGuard && o.runKind === 'angle';
    const target = kick ? { x: d.x - s * 0.6, z: d.z - 0.5 } : { x: d.x + s * (stretch ? 0.85 : 0.2), z: d.z - (stretch ? 0.4 : 0.7) };
    return seekWant(o, target, speedCap(o, 0.85));
  },

  // A receiver's stalk block on a run (blockDownfield): it lives like any run
  // block. False once his man is gone (shed, or one he lost).
  stalkBlock(o, d) {
    const st = this.runState();
    if (this.lostMan(o, d)) return false;
    return this.runLock(st, o, d);
  },

  // A defender in a run block (drivePast): driven back, walking his blocker
  // into the backfield, or leaning toward the ball (RUN_BLOCK).
  runDrive(d) {
    const st = this.runState(), b = st.blocks.get(d.id), c = this.guardPoint();
    if (!b) return scaled(c.x - d.x, c.z - d.z, RUN_BLOCK.lean);
    const m = this.blockMargin(st, b), R = RUN_BLOCK;
    if (m > R.drive && dist(d, b.from) < R.driveMax) {
      let x = 0, z = 0;
      for (const id of b.blockers) { const o = this.byId[id]; x += d.x - o.x; z += d.z - o.z; }
      return scaled(x, z, Math.min(R.driveMost, R.driveSpeed * (m - R.drive)));
    }
    if (m < -R.drive) return scaled(c.x - d.x, c.z - d.z, Math.min(R.penMost, R.penSpeed * (-R.drive - m)));
    return scaled(c.x - d.x, c.z - d.z, R.lean);
  },

  // ---------------------------------------------------------------------------
  // Run fits (FIT). A gap's x: from where the line lined up, moved with the
  // line as a whole (its mean step sideways), so the gaps flow with a zone
  // play but do not follow one lineman chasing his man.
  gapX(id) {
    const s = id[0] === '-' ? -1 : 1, letter = id[1], x0 = this.pocketX();
    const side = this.line.filter(o => s * (o.start.x - x0) > 0.5 || o.id === 'C').sort((a, b) => s * (a.start.x - b.start.x));
    const C = side[0]?.start.x ?? x0, G = side[1]?.start.x ?? C, T = side[2]?.start.x ?? G;
    const movers = this.line.filter(o => o.id !== this.play.pullingGuard);
    const flow = movers.reduce((a, o) => a + o.x - o.start.x, 0) / Math.max(1, movers.length);
    if (letter === 'A') return (C + G) / 2 + flow;
    if (letter === 'B') return (G + T) / 2 + flow;
    const te = this.offense.find(p => (p.role === 'te' || p.role === 'wr') && s * (p.start.x - T) > 0.5 && s * (p.start.x - T) < 3.5 && p.start.z > this.spot - 2);
    const cx = te ? (T + te.start.x) / 2 : T + s * FIT.c;
    return (letter === 'C' ? cx : (te ? te.start.x : cx) + s * FIT.d) + flow;
  },

  // Who fits which gap (at the first read, from the alignment; no draws).
  // Linemen own the gap they line up in, linebackers and box safeties take
  // the nearest one left, and a deep safety fills one still open on the
  // difficulty's `fill` share of reps.
  planFits() {
    const x0 = this.pocketX(), gaps = [];
    for (const s of [-1, 1]) for (const l of 'ABCD') gaps.push({ id: (s < 0 ? '-' : '+') + l, x: this.gapX((s < 0 ? '-' : '+') + l) });
    const open = new Set(gaps.map(g => g.id)), fits = new Map();
    const take = (d, pool) => {
      let pick = null, far = Infinity;
      for (const g of gaps) if (open.has(g.id) && (!pool || pool(g)) && Math.abs(g.x - d.start.x) < far) { far = Math.abs(g.x - d.start.x); pick = g; }
      if (pick) { open.delete(pick.id); fits.set(d.id, { gap: pick.id }); }
      return pick;
    };
    const box = d => d.start.z - this.spot < RUN_PLAN.boxDeep && Math.abs(d.start.x - x0) < RUN_PLAN.wide;
    for (const d of this.defense.filter(d => d.role === 'dl')) take(d);
    const second = this.defense.filter(d => (d.role === 'lb' || d.role === 's') && box(d)).sort((a, b) => a.start.z - b.start.z || a.number - b.number);
    for (const d of second) take(d);
    const deep = this.defense.filter(d => d.role === 's' && !fits.has(d.id)).sort((a, b) => a.start.z - b.start.z || a.number - b.number);
    for (const d of deep) {
      if (open.size && digit(d.form, FILL_DIGIT) < (this.skill.fill ?? 0.5) && take(d)) d.readRun = Math.min(d.readRun, this.skill.runRead ?? d.readRun);
      else d.readRun += FIT.deep;
    }
    return fits;
  },

  fitOf(d) {
    const st = this.runState();
    if (!st.fits) st.fits = this.planFits();
    return st.fits.get(d.id) || null;
  },

  // A defender who has read the run fits it: he pursues the runner on his
  // gap's side of him (inside-out from his gap, LEVERAGE), so every gap stays
  // owned as the play moves. A back-side man who stays home keeps `home` yd
  // on the cutback side; one who does not chases the play. A man with no gap
  // (a corner, a deep safety), a man `behind` yd behind the runner, and
  // everyone once the runner is `open` yd through the line, pursues from the
  // side he lined up on. A bust jumps the next gap toward the play or
  // over-runs it (FIT).
  runFit(d) {
    const target = this.handoff ? this.carrier || 'R' : 'R', cap = speedCap(d), fit = this.fitOf(d);
    const seen = this.perceive(target, d.latency), x0 = this.pocketX();
    if (!fit || seen.z > this.spot + FIT.open || d.z < seen.z - FIT.behind) return this.pursue(d, target, cap, 0, d.leverage);
    const going = Math.abs(seen.vx) > 1.5 ? Math.sign(seen.vx) : Math.sign(seen.x - x0) || 1;
    if (d.runBust === 'over') return this.pursue(d, target, cap, going * FIT.over, 0);
    const gx = this.gapX(fit.gap), off = gx - seen.x, mag = Math.abs(d.leverage || LEVERAGE.min);
    // A man who jumped the next gap toward the play is on the wrong side of
    // the runner: his own gap is open.
    if (d.runBust === 'jump') return this.pursue(d, target, cap, 0, going * mag);
    const side = Math.abs(off) > FIT.even ? Math.sign(off) : Math.sign(d.leverage) || 1;
    const backside = side !== going && Math.abs(off) > FIT.back;
    if (backside && !d.runHome) return this.pursue(d, target, cap, going * FIT.chase, 0);
    return this.pursue(d, target, cap, 0, side * (backside ? FIT.home : mag));
  },

  // The gap next to `id` toward `way` (+1 to the right of the field).
  nextGap(id, way) {
    const order = ['-D', '-C', '-B', '-A', '+A', '+B', '+C', '+D'], i = order.indexOf(id);
    return order[clamp(i + way, 0, order.length - 1)];
  },

  // Per-rep run-fit state for one defender (initDefender): a bust (FIT) on
  // the difficulty's `bust` share of men, and whether a back-side man stays
  // home (`home`), from his form.
  runDiscipline(d) {
    const skill = this.skill, u = d.form ?? 0.5;
    d.runBust = null;
    if (d.role !== 'cb' && digit(u, BUST_DIGIT) < (skill.bust ?? 0)) {
      const k = digit(u, KIND_DIGIT);
      d.runBust = k < FIT.jump ? 'jump' : k < FIT.jump + FIT.overShare ? 'over' : 'late';
    }
    d.runHome = digit(u, HOME_DIGIT) < (skill.home ?? 0.7);
    if (d.runBust === 'late') d.readRun += FIT.late;
  },
};
