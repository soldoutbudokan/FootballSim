// The blend tree: turns one player's simulation snapshot into animation
// targets. Pure functions (no renderer) so the decisions are unit-tested.
//
// Inputs are ONLY the snapshot (plan 3.1) plus the player's role; missing new
// fields (speed, lean, backpedal) are derived. Output says which locomotion
// clips play with what weight and rate, which action overlay plays and how
// far through it we are, and which procedural layers must stand in for clips
// the model does not have.

import { LOCOMOTION, UPPER_BODY_SLOTS } from './clips.js';
import { blendSpace1D, strideRate } from './gait.js';

// Nominal durations of timed actions (seconds, plan 3.4).
export const ACTION_DURATION = { cut: 0.2, juke: 0.45, throw: 0.4, catch: 0.45, tackle: 1.0, stumble: 0.7, fall: 0.9, getup: 1.2 };
// The ball leaves the quarterback's hand this far into the throw.
export const THROW_RELEASE = 0.23;

const KNOWN_ACTIONS = new Set(['ready', 'run', 'cut', 'juke', 'block', 'throw', 'catch', 'carry', 'wrapped', 'tackle', 'down', 'stumble']);
const LINEMEN = new Set(['ol', 'dl']);
const HOLD_BALL = new Set(['throw', 'catch', 'down', 'juke', 'wrapped', 'cut', 'stumble', 'tackle']);

// Speed, heading-relative velocity and the visual action for a player.
//   p: snapshot player; spec: {role, team}; state: snapshot (phase, carrier)
export function derive(p, spec = {}, state = {}) {
  const vx = Number(p.vx) || 0, vz = Number(p.vz) || 0;
  const speed = Number.isFinite(p.speed) ? p.speed : Math.hypot(vx, vz);
  const facing = Number(p.facing) || 0;
  // Heading frame: forward = (sin f, cos f), right = (cos f, -sin f) in sim x/z.
  const forward = vx * Math.sin(facing) + vz * Math.cos(facing);
  const lateral = vx * Math.cos(facing) - vz * Math.sin(facing);
  const backpedal = typeof p.backpedal === 'boolean' ? p.backpedal : speed > 0.8 && forward < -0.45 * speed;
  return {
    speed, forward, lateral, backpedal,
    lean: Number.isFinite(p.lean) ? Math.max(-1, Math.min(1, p.lean)) : null,
    action: visualAction(p, spec, state),
  };
}

// The action the body should show. Pre-snap everyone is in a stance; the
// ball carrier carries unless doing something more specific.
export function visualAction(p, spec = {}, state = {}) {
  let action = KNOWN_ACTIONS.has(p.action) ? p.action : 'run';
  if (state.phase === 'presnap') return 'ready';
  if (state.carrier && state.carrier === p.id && !HOLD_BALL.has(action) && action !== 'block') action = 'carry';
  if (action === 'run' && p.engaged != null && state.phase !== 'dead') action = 'block';
  return action;
}

// Which stance a role takes in 'ready'.
export function stanceFor(spec = {}) {
  if (LINEMEN.has(spec.role)) return 'three';
  if (spec.role === 'qb') return 'gun';
  if (spec.role === 'wr') return 'split';
  return 'two';
}

// Ordered locomotion points that the model can actually play.
//   gaits: {slot: analyseGait result} for measured clips
export function locomotionPoints(available, gaits = {}) {
  const points = [];
  for (const { slot, speed } of LOCOMOTION) {
    if (!has(available, slot)) continue;
    const measured = gaits[slot]?.speed;
    // Trust a measured speed only near the nominal one: clips are often
    // authored slower or faster than their names say, but not wildly.
    let s = slot === 'idle' ? 0 : measured > speed * 0.5 && measured < speed * 1.8 ? measured : speed;
    // The names keep their order (a "run" measured slower than the "jog"
    // still sits above it): speeds stay strictly increasing.
    const previous = points[points.length - 1];
    if (previous && s <= previous.speed) s = Math.max(previous.speed + 0.3, speed);
    points.push({ slot, speed: s });
  }
  return points;
}

const has = (available, slot) => (available instanceof Set ? available.has(slot) : !!available?.[slot]);

// The overlay clip slot for an action, honouring left/right variants.
export function overlaySlotFor(action, d, spec = {}) {
  switch (action) {
    case 'ready': {
      const stance = stanceFor(spec);
      return stance === 'three' ? 'stance3' : stance === 'gun' ? null : 'stance2';
    }
    case 'cut': return (d.lean ?? Math.sign(d.lateral)) >= 0 ? 'cut-right' : 'cut-left';
    case 'juke': return d.lateral >= 0 ? 'juke-right' : 'juke-left';
    case 'down': return 'fall';
    case 'block': case 'throw': case 'catch': case 'carry': case 'tackle': case 'wrapped': case 'stumble':
      return action;
    default: return null;
  }
}

// The full plan for one player this frame.
//   elapsed: seconds since this action began (tracked by the caller)
//   ctx: {available: Set|object of slots, gaits: {slot: gait}}
export function planAnimation(p, spec, state, elapsed, ctx) {
  const d = derive(p, spec, state);
  const available = ctx.available;
  const plan = {
    action: d.action, speed: d.speed, lean: d.lean ?? 0, backpedal: d.backpedal, lateral: d.lateral, forward: d.forward,
    locomotion: [], mode: 'forward', reverse: false, stretch: 1, cycleRate: 0,
    overlay: null,
    procedural: { action: null, stance: null, progress: 0, strafe: 0, backpedal: false },
  };

  // Locomotion: which direction we travel relative to the body.
  const moving = d.speed > 0.6;
  let mode = 'forward';
  if (moving && d.backpedal) mode = 'backpedal';
  else if (moving && Math.abs(d.lateral) > 0.72 * d.speed && d.speed < 6.5) mode = d.lateral > 0 ? 'shuffle-right' : 'shuffle-left';
  plan.mode = mode;

  const points = locomotionPoints(available, ctx.gaits);
  if (mode !== 'forward' && has(available, mode)) {
    // A dedicated clip: blend from idle by speed, rate from its own gait.
    const gait = ctx.gaits?.[mode];
    const top = gait?.speed > 0.5 ? gait.speed : mode === 'backpedal' ? 3.5 : 2.5;
    const w = Math.min(1, d.speed / Math.max(0.5, top * 0.6));
    plan.locomotion = [{ slot: mode, weight: w }];
    if (w < 1 && points[0]) plan.locomotion.push({ slot: points[0].slot, weight: 1 - w });
    const rate = strideRate(gait, d.speed);
    plan.cycleRate = rate.cycleRate; plan.stretch = 1;
  } else {
    // Forward blend space; backpedal and shuffle borrow it.
    plan.locomotion = blendSpace1D(points, d.speed).filter(e => e.weight > 1e-4);
    let rate = 0, stretch = 0, total = 0;
    for (const e of plan.locomotion) {
      const r = strideRate(ctx.gaits?.[e.slot], d.speed);
      rate += r.cycleRate * e.weight; stretch += r.stretch * e.weight; total += e.weight;
    }
    plan.cycleRate = total ? rate / total : 0;
    plan.stretch = total ? stretch / total : 1;
    if (mode === 'backpedal') { plan.reverse = true; plan.procedural.backpedal = true; }
    if (mode.startsWith('shuffle')) {
      // Turn the legs toward travel (positive = to the player's right).
      plan.procedural.strafe = Math.max(-1.22, Math.min(1.22, Math.atan2(d.lateral, Math.abs(d.forward))));
      plan.reverse = d.forward < -0.2 * d.speed;
    }
  }

  // Action overlay (a clip) or its procedural stand-in.
  const wanted = overlaySlotFor(d.action, d, spec);
  const slot = wanted && resolveOverlay(wanted, available);
  const duration = ACTION_DURATION[d.action === 'down' ? 'fall' : d.action] || 0;
  const progress = duration ? Math.min(1, Math.max(0, elapsed / duration)) : 0;
  if (slot) {
    const upper = UPPER_BODY_SLOTS.has(slot) ? smoothstep(0.8, 2.2, d.speed) : 0;
    plan.overlay = { slot, progress, elapsed, upper, hold: slot === 'fall' };
  }
  if (!slot || d.action === 'ready') {
    // Stances keep their procedural tweaks (gun crouch, WR stagger) even with clips.
    plan.procedural.action = slot ? null : proceduralFor(d.action);
    if (d.action === 'ready') plan.procedural.stance = slot ? null : stanceFor(spec);
    plan.procedural.progress = progress;
  }
  if (d.action === 'ready' && stanceFor(spec) === 'gun') plan.procedural.stance = 'gun';
  return plan;
}

// Overlays only use their own clip (or a left/right twin): a missing throw
// should not play a catch clip.
function resolveOverlay(slot, available) {
  if (has(available, slot)) return slot;
  if (slot === 'stance3' && has(available, 'stance2')) return 'stance2';
  return null;
}

const PROCEDURAL = { cut: 'cut', juke: 'juke', block: 'block', throw: 'throw', catch: 'catch', carry: 'carry', tackle: 'tackle', wrapped: 'wrapped', down: 'down', stumble: 'stumble' };
function proceduralFor(action) { return PROCEDURAL[action] || null; }

export function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Tracks how long the current action has been running, from the snapshot.
// Replay-safe: elapsed comes from actionTime when the action is timed. A
// throw whose timer restarts after the release (the sim re-arms it) keeps
// going into the follow-through instead of winding up again.
// A timer that stops changing (the simulation freezes everyone when the
// play is dead, mid-tackle) falls back to real time after a short stall.
export class ActionClock {
  constructor() { this.action = null; this.elapsed = 0; this.lastTime = 0; this.offset = 0; this.stall = 0; }
  update(action, actionTime, dt, { released = false } = {}) {
    const duration = ACTION_DURATION[action];
    const time = Number(actionTime) || 0;
    dt = Math.max(0, dt || 0);
    if (action !== this.action) {
      this.action = action; this.offset = 0; this.stall = 0;
      this.elapsed = duration && time > 0 ? Math.max(0, duration - time) : 0;
    } else if (duration && time > 0 && time !== this.lastTime) {
      this.stall = 0;
      if (time > this.lastTime + 0.05 && action === 'throw' && released) this.offset = Math.max(this.offset, this.elapsed);
      const fromTimer = Math.max(0, duration - time);
      this.elapsed = this.offset
        ? Math.max(this.elapsed, THROW_RELEASE + fromTimer * ((duration - THROW_RELEASE) / duration))
        : fromTimer;
    } else if (duration && time > 0) {
      this.stall += dt;
      if (this.stall > 0.12) this.elapsed += dt;
    } else {
      this.elapsed += dt;
    }
    this.lastTime = time;
    return this.elapsed;
  }
}

// Moves weights toward their targets with a fixed cross-fade time so clip
// changes never pop.
export function approachWeights(current, target, dt, fade = 0.15) {
  const step = fade > 0 ? dt / fade : 1;
  const out = {};
  for (const key of new Set([...Object.keys(current), ...Object.keys(target)])) {
    const from = current[key] || 0, to = target[key] || 0;
    const next = from < to ? Math.min(to, from + step) : Math.max(to, from - step);
    if (next > 1e-4) out[key] = next;
  }
  return out;
}

// Estimates lean (-1..1, positive turning right) from the heading change when
// the snapshot does not carry it: lateral acceleration over lateral grip.
export function estimateLean(prevFacing, facing, speed, dt, grip = 12) {
  if (!(dt > 0) || prevFacing == null) return 0;
  let delta = facing - prevFacing;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return Math.max(-1, Math.min(1, (delta / dt) * speed / grip));
}
