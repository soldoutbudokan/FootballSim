// Open-field pursuit decisions: coming to balance before a tackle, and the
// underneath man who comes up for a quarterback who runs. The angles
// themselves are in sim.js (pursue, pursueAngle); the tackle odds are the
// same at every difficulty, and what a level changes is how many defenders
// make these decisions.
import { clamp, dist } from './common.js';

// One per-rep draw per player (`form`) gives the per-rep choices below,
// through digits of it nothing else uses (as in sim/run.js).
const digit = (u, k) => (u * k) % 1;
const GATHER_DIGIT = 5381;

// Coming to balance. A pursuer in front of the runner (the runner's heading
// within `cone` of the line to him, running at `moving` yd/s or more) who is
// within `time` s of meeting him at the rate they close (and `from` yd)
// stops sprinting at a spot the runner may never reach: he shortens his stride to `speed` of his top speed and squares up to
// where the runner is, so a cut or a juke finds him on his feet. A tackler
// moving slower than `steady` of his top speed is under control: a runner's
// move in the last moment (sim.js TACKLE `shaken`) costs him only
// 1 - `hold` of what it costs a man running flat out (none of it above
// `hot`). A man chasing from behind or from the side never gathers. Within
// `strike` yd he goes for the tackle. The share of defenders who do it at
// all is the difficulty's `gather`.
export const GATHER = { from: 3.5, time: 0.22, cone: 0.5, moving: 3, speed: 0.68, strike: 1.1, steady: 0.72, hot: 0.92, hold: 0.45, lead: 0.1 };
// The quarterback runs. Once he heads for the line (as the defense saw him:
// running upfield at `speed` yd/s or more, within the difficulty's `trigger`
// yd of the line, out of the pocket or within `close` yd of the line, and
// not winding up to throw), the nearest underneath zone
// defender or robber within `range` yd leaves his coverage and comes up for
// him; the others stay on their receivers until he is over the line. The
// man is picked once and has committed.
export const TRIGGER = { speed: 2.5, range: 14, close: 3 };

const OUT = new Set(['stumble', 'tackle', 'down']);

export const pursuit = {
  // Per-rep choices for one defender (initDefender).
  pursuitDiscipline(d) {
    const u = d.form ?? 0.5, skill = this.skill;
    d.gathers = digit(u, GATHER_DIGIT) < (skill.gather ?? 0.5);
  },

  // How a pursuer closes on the runner he saw (`seen`): when he is coming to
  // balance (GATHER), the share of his speed he keeps (`gather`, 0 for a man
  // who runs flat out), and where the runner is by now as far as he knows.
  closing(d, seen) {
    const lag = this.time - seen.t, x = seen.x + seen.vx * lag, z = seen.z + seen.vz * lag;
    const gx = d.x - x, gz = d.z - z, gap = Math.hypot(gx, gz), speed = Math.hypot(seen.vx, seen.vz);
    const plan = { gather: 0, x, z };
    if (!d.gathers || gap < GATHER.strike || gap > GATHER.from || speed < GATHER.moving) return plan;
    // In front of him: the runner is coming his way.
    if ((seen.vx * gx + seen.vz * gz) / (speed * Math.max(gap, 1e-6)) < GATHER.cone) return plan;
    // Not yet: they are still more than `time` s apart at the rate they close.
    const rate = ((seen.vx - d.vx) * gx + (seen.vz - d.vz) * gz) / Math.max(gap, 1e-6);
    if (gap > rate * GATHER.time) return plan;
    plan.gather = GATHER.speed;
    return plan;
  },

  // How much of a runner's last-moment move a tackler rides out (GATHER):
  // 0 running flat out, `hold` under control.
  balance(d) {
    const share = Math.hypot(d.vx, d.vz) / d.top;
    return GATHER.hold * clamp((GATHER.hot - share) / (GATHER.hot - GATHER.steady), 0, 1);
  },

  // The quarterback is running at the line (TRIGGER): pick the underneath
  // man who comes up for him. Returns that man's id, or null.
  runTrigger() {
    const rep = this.call.rep, reach = this.skill.trigger ?? 0;
    if (rep.trigger) return rep.trigger;
    if (!reach || this.throwIntent || this.carrier !== 'QB' || this.phase !== 'live' || this.crossedLine || this.play.type === 'run') return null;
    const seen = this.perceive('QB', this.skill.latency);
    if (seen.vz < TRIGGER.speed || seen.z < this.spot - reach || !(rep.scrambled || seen.z > this.spot - TRIGGER.close)) return null;
    let pick = null, near = TRIGGER.range;
    for (const d of this.defense) {
      const kind = d.assign?.kind;
      if (d.rushing || d.engaged || OUT.has(d.action) || (kind !== 'under' && kind !== 'rat')) continue;
      const g = dist(d, seen);
      if (g < near) { near = g; pick = d; }
    }
    if (pick) rep.trigger = pick.id;
    return rep.trigger || null;
  },
};
