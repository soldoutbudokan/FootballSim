// The scripted ball carrier, after a catch, a handoff or a scramble past the
// line. Nothing fancy, only consistent, so a change to the defense shows up
// as a change in yards: he looks along a fan of headings, takes the one with
// the most room downfield before any defender can get there first, jukes
// when a tackler closes from the side or head on, and sprints throughout.
import { gap, topSpeed, blocked, closing, timeFor } from './util.mjs';

const HALF = 26.67, GOAL = 110;
// Headings: every `step` radians up to `wide` either side of straight
// downfield, a new choice every `every` steps. Along each heading the
// runway is the farthest sample point (yards out) he reaches `margin` s
// before every defender, counting `momentum` s of each defender's current
// run, his tackling `reach`, `shed` s for a man still blocked, and stopping
// `edge` yd inside the sideline. Score: runway downfield plus `room` of the
// runway, less `turn` per radian of change at full speed; `goal` for a
// runway that reaches the end zone. With no runway anywhere he turns
// straight upfield.
const RUN = {
  every: 3, step: 10 * Math.PI / 180, wide: 90 * Math.PI / 180,
  samples: [1.5, 3, 5, 7.5, 10, 14, 19, 25],
  margin: 0.05, momentum: 0.25, reach: 0.9, shed: 0.7, edge: 1,
  room: 0.3, turn: 2, goal: 20,
};
// Juke away from a free tackler within `range` yd, closing faster than
// `closing` yd/s, coming in more than `angle` off the runner's own line
// (not chasing from behind), when the runner has `speed` yd/s; at most one
// every `every` s.
const JUKE = { range: 2, closing: 1, angle: 60 * Math.PI / 180, speed: 3, every: 0.5 };

export class Runner {
  constructor() {
    this.input = { x: 0, z: 1, sprint: true };
    this.count = 0; this.jukeAt = -9; this.jukes = 0;
    this.note = '';
  }

  control(sim) {
    const c = sim.byId[sim.carrier];
    if (!c) return this.input;
    if (this.count++ % RUN.every === 0) this.steer(sim, c);
    this.dodge(sim, c);
    return this.input;
  }

  steer(sim, c) {
    const speed = Math.hypot(c.vx, c.vz), top = topSpeed(c);
    const heading = speed > 1 ? Math.atan2(c.vx, c.vz) : 0;
    let best = -Infinity, pick = 0, room = 0;
    for (let a = -RUN.wide; a <= RUN.wide + 1e-9; a += RUN.step) {
      const ux = Math.sin(a), uz = Math.cos(a);
      const run = runway(sim, c, ux, uz, Math.max(0, c.vx * ux + c.vz * uz), top);
      const turn = Math.abs(Math.atan2(Math.sin(a - heading), Math.cos(a - heading)));
      const score = run.yards * uz + RUN.room * run.yards - RUN.turn * turn * speed / top + (run.goal ? RUN.goal : 0);
      if (score > best) { best = score; pick = a; room = run.yards; }
    }
    // Boxed in: no lane anywhere, so turn upfield and fall forward.
    if (!room) pick = 0;
    this.input.x = Math.sin(pick); this.input.z = Math.cos(pick); this.input.sprint = true;
    this.note = room ? `run ${Math.round(pick * 180 / Math.PI)}° room ${room}` : 'boxed in: upfield';
  }

  dodge(sim, c) {
    const speed = Math.hypot(c.vx, c.vz);
    if (speed < JUKE.speed || sim.time - this.jukeAt < JUKE.every) return;
    for (const d of sim.defense) {
      if (blocked(d) || gap(d, c) > JUKE.range || closing(d, c) < JUKE.closing) continue;
      const ds = Math.hypot(d.vx, d.vz);
      if (ds < 1 || (d.vx * c.vx + d.vz * c.vz) / (ds * speed) > Math.cos(JUKE.angle)) continue;
      // His right is (fz, -fx); juke away from the tackler's side.
      const fx = c.vx / speed, fz = c.vz / speed, right = (d.x - c.x) * fz - (d.z - c.z) * fx;
      if (sim.juke(right > 0 ? -1 : 1)) { this.jukeAt = sim.time; this.jukes++; this.note = `juke ${right > 0 ? 'left' : 'right'} (${d.id})`; }
      return;
    }
  }
}

// Yards a runner can go along (ux, uz) before a defender can be there first
// (and whether that reaches the end zone). The scripted quarterback uses it
// to decide whether to scramble.
export function runway(sim, c, ux, uz, speed, top = topSpeed(c)) {
  let yards = 0;
  for (const s of RUN.samples) {
    const px = c.x + ux * s, pz = c.z + uz * s;
    if (Math.abs(px) > HALF - RUN.edge) return { yards };
    const mine = timeFor(s, speed, top) + RUN.margin;
    for (const d of sim.defense) {
      const ex = d.x + d.vx * RUN.momentum, ez = d.z + d.vz * RUN.momentum;
      const reach = Math.max(0, Math.hypot(px - ex, pz - ez) - RUN.reach);
      const theirs = RUN.momentum + reach / topSpeed(d) + (blocked(d) ? RUN.shed : 0);
      if (theirs < mine) return { yards };
    }
    yards = s;
    if (pz >= GOAL) return { yards, goal: true };
  }
  return { yards };
}
