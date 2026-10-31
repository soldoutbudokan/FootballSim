// Shared helpers and small constants for the simulation modules. Units are
// yards and seconds; +z points downfield and +x is the offense's right.
export const STEP = 1 / 120;
export const DEG = Math.PI / 180;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));
export const smoothstep = t => t * t * (3 - 2 * t);
export const ZERO = Object.freeze({ x: 0, z: 0 });
export const STUMBLE_SPEED = 0.3;      // a stumbling player's top speed, share of his own
export const GET_OFF = { ol: 0.06, qb: 0, rb: 0.1, wr: 0.18, te: 0.18, dl: 0.2, lb: 0.28, cb: 0.28, s: 0.28 };
// Pursuit leverage: each pursuer aims min..min+spread yards to his own side
// of the carrier's path (the side he lined up on), fading out between `far`
// and `near` yards from the carrier so he still closes to make the tackle;
// a defender in front of the runner takes only `front` of it. Pursuers
// arrive side by side instead of in single file.
export const LEVERAGE = { min: 1.0, spread: 0.5, near: 2.5, far: 7, front: 0.25 };
// Once the carrier is wrapped up, pursuers who are not in on the tackle pull
// up: those within `reach` yards of their spot steer to it, radius..radius+
// spread yards from the carrier and fanned out to their own side; the rest
// ease off where they are, braking at brake..brake+brakeSpread of full, so
// they stop at varied spots. A defender already within `pileOn` yards keeps
// coming and can join the tackle.
export const PULL_UP = { radius: 1.8, spread: 2.7, fan: 28 * DEG, flank: 55 * DEG, effort: 0.7, pileOn: 1.6, reach: 6, brake: 0.5, brakeSpread: 0.4 };

// 0 while fresh, rising to 1 as the tank empties below 60 %.
export function fatigueOf(p) { return clamp((0.6 - p.stamina) / 0.6, 0, 1); }

export function speedCap(p, effort = 1) {
  const cap = p.top * effort * (1 - 0.12 * fatigueOf(p));
  return p.action === 'stumble' ? cap * STUMBLE_SPEED : cap;
}

export function scaled(x, z, speed) {
  const d = Math.hypot(x, z);
  return d > 1e-6 ? { x: x / d * speed, z: z / d * speed } : ZERO;
}

// Toward a point, slowing so the player stops on it (or passes at `exit`).
export function seekWant(p, target, cap, exit = 0) {
  const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
  if (d < 0.05) return ZERO;
  return scaled(dx, dz, Math.min(cap, Math.sqrt(exit * exit + 1.6 * p.brake * d)));
}

// Match a moving target's velocity and close the gap to it.
export function trackWant(p, target, velocity, cap, gain = 2.5) {
  const wx = velocity.x + (target.x - p.x) * gain, wz = velocity.z + (target.z - p.z) * gain;
  const speed = Math.hypot(wx, wz);
  return speed > cap ? scaled(wx, wz, cap) : { x: wx, z: wz };
}

// Arrive at `target` when the ball does, `timeLeft` seconds from now.
export function meetWant(p, target, timeLeft, cap) {
  const dx = target.x - p.x, dz = target.z - p.z, d = Math.hypot(dx, dz);
  if (d < 0.25) return ZERO;
  return scaled(dx, dz, Math.min(cap, d / Math.max(0.15, timeLeft)));
}

// Lateral shade of a pursuit aim point: `leverage` yards along the normal of
