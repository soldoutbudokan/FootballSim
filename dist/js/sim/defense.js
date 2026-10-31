// The defensive coordinator: the roster, fronts, difficulty table, the call
// for each rep and the pre-snap alignment.
import { FORMATION, COVERAGES } from '../plays.js';

export const DIFFICULTY = {
  // Difficulty changes reads and anticipation, never bodies or catching odds.
  // `contain`: yards outside a scrambling quarterback the edge rusher on his
  // side keeps (rush lane discipline). `carry`: yards past the line where an
  // underneath defender gives up a vertical he is carrying when no deep man
  // has taken it. `help`: how far a defender with an empty zone leans toward
  // the most open receiver near him (share of the way from his landmark).
  rookie: { latency: 0.40, ballReaction: 0.42, judgment: 1.8, routeLead: 0.06, contain: 0.3, carry: 16, help: 0.2 },
  pro: { latency: 0.28, ballReaction: 0.28, judgment: 0.9, routeLead: 0.13, contain: 1.0, carry: 21, help: 0.45 },
  allpro: { latency: 0.18, ballReaction: 0.18, judgment: 0.35, routeLead: 0.20, contain: 1.5, carry: Infinity, help: 0.7 },
};

export const DEFENSE = [
  { id: 'DE1', number: 91, role: 'dl', x: -4.8, z: 1.2, speed: 7.2 },
  { id: 'DT1', number: 95, role: 'dl', x: -1.5, z: 1.2, speed: 6.9 },
  { id: 'DT2', number: 97, role: 'dl', x: 1.6, z: 1.2, speed: 6.8 },
  { id: 'DE2', number: 99, role: 'dl', x: 4.8, z: 1.2, speed: 7.2 },
  { id: 'LB1', number: 54, role: 'lb', x: -7, z: 5, speed: 8.4 },
  { id: 'LB2', number: 52, role: 'lb', x: 0, z: 6, speed: 8.2 },
  { id: 'LB3', number: 56, role: 'lb', x: 7, z: 5, speed: 8.3 },
  { id: 'CB1', number: 23, role: 'cb', x: -21, z: 6, speed: 9.3 },
  { id: 'CB2', number: 24, role: 'cb', x: 21, z: 6, speed: 9.3 },
  { id: 'FS', number: 31, role: 's', x: -9, z: 17, speed: 9.0 },
  { id: 'SS', number: 32, role: 's', x: 9, z: 17, speed: 8.9 },
];
export const FRONTS = [
  { name: 'Even', x: [-4.8, -1.6, 1.6, 4.8] }, { name: 'Over', x: [-5.8, -2.8, 0.65, 4.2] },
  { name: 'Under', x: [-4.2, -0.65, 2.8, 5.8] }, { name: 'Wide 9', x: [-7, -2, 2, 7] },
];
// Man assignments for defenders 4..10 (LB1, LB2, LB3, CB1, CB2, FS, SS).
export const MAN = {
  blitz: ['', '', 'Y', 'X', 'B', 'R', 'A'],
  base: ['Y', 'R', 'A', 'X', 'B', 'Y', 'A'],
};

export function defensiveAlignment(coverage, front, random) {
  const support = {
    cover3: [[-9, 5], [-1, 6], [6, 5], [-21, 8], [21, 8], [0, 20], [10, 8]],
    cover2: [[-8, 5], [0, 6], [8, 5], [-22, 4], [22, 4], [-12, 18], [12, 18]],
    man: [[-10, 2.5], [-2, 4], [6.4, 2.5], [-21, 2], [21, 2], [-11, 20], [11, 20]],
    blitz: [[-2.7, 1.5], [2.7, 1.5], [-10, 2.5], [-21, 1.8], [21, 1.8], [-3.5, 4], [6.4, 2.5]],
  }[coverage];
  return DEFENSE.map((spec, i) => {
    const [x, z] = i < 4 ? [FRONTS[front].x[i], 1.2] : support[i - 4];
    return { ...spec, x: x + (random() - 0.5) * 0.8, z: Math.max(0.8, z + (random() - 0.5) * 0.7) };
  });
}

export const defense = {
  // The call for a new rep: the coverage, the front and where everybody
  // lines up. Draws from the seeded stream in a fixed order.
  callDefense() {
    const cover = this.config.coverage;
    this.coverage = cover === 'random' ? ['cover3', 'cover2', 'man', 'blitz'][Math.floor(this.random() * 4)] : cover;
    const front = Math.floor(this.random() * FRONTS.length);
    this.defensiveFront = FRONTS[front].name;
    this.alignment = defensiveAlignment(this.coverage, front, this.random);
  },

  // The defenders' specs for this rep against the offense's formation: man
  // defenders travel with their assignments when the offense changes
  // formation, including an audible. The called front and shell stay.
  alignDefense(formation) {
    const ids = this.coverage === 'blitz' ? MAN.blitz : MAN.base;
    return this.alignment.map((p, i) => {
      let x = p.x, z = p.z;
      if (i >= COVERAGES[this.coverage].rushers && (this.coverage === 'blitz' || (this.coverage === 'man' && i < 9))) {
        const id = ids[i - 4], base = FORMATION.find(o => o.id === id), aligned = formation.find(o => o.id === id);
        if (base && aligned) { x += aligned.x - base.x; z = Math.max(1.2, z + aligned.z - base.z); }
      }
      return { ...p, x, z: Math.min(z, 118 - this.spot), rushing: i < COVERAGES[this.coverage].rushers };
    });
  },

  // Per-rep defensive state once the players exist.
  initDefender(d) {
    d.latency = this.skill.latency;
  },
};
