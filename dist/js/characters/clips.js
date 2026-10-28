// Animation clip slots: the names the animation layer understands, how clip
// names and file names map onto them, and what to fall back to when a clip
// is missing. Pure data and functions (no renderer), unit-tested in Node.

// Every slot, in the order MODELS.md documents them. The file
// dist/models/clips/<slot>.glb (or .fbx) fills the slot of the same name.
export const CLIP_SLOTS = [
  'idle', 'stance2', 'stance3',
  'walk', 'jog', 'run', 'sprint', 'backpedal',
  'shuffle-left', 'shuffle-right',
  'cut-left', 'cut-right', 'juke-left', 'juke-right',
  'throw', 'catch', 'carry', 'block',
  'tackle', 'wrapped', 'fall', 'stumble', 'getup',
];

// The game is fully playable with these; everything else improves it.
export const REQUIRED_SLOTS = ['idle', 'run'];
export const RECOMMENDED_SLOTS = ['walk', 'sprint', 'stance2', 'stance3', 'throw', 'catch', 'carry', 'tackle', 'fall'];

// Cyclic clips loop and are phase-synchronised; the rest play once.
export const LOOPING_SLOTS = new Set([
  'idle', 'stance2', 'stance3', 'walk', 'jog', 'run', 'sprint', 'backpedal',
  'shuffle-left', 'shuffle-right', 'carry', 'block', 'wrapped',
]);

// Locomotion blend space: slots in speed order with the nominal ground speed
// (yards/s) used when a clip's own speed cannot be measured.
export const LOCOMOTION = [
  { slot: 'idle', speed: 0 },
  { slot: 'walk', speed: 1.6 },
  { slot: 'jog', speed: 3.6 },
  { slot: 'run', speed: 6.0 },
  { slot: 'sprint', speed: 8.6 },
];

// Overlays that only drive the upper body when the player is moving, so the
// legs keep running underneath.
export const UPPER_BODY_SLOTS = new Set(['carry', 'catch', 'throw', 'block']);

// Words people (and Mixamo) use for each slot. Matching is on normalised
// names: lowercase, words separated by single dashes.
const ALIASES = {
  idle: ['idle', 'breathing-idle', 'standing-idle', 'stand', 'idle-1', 'happy-idle', 'neutral-idle'],
  stance2: ['stance2', 'two-point', 'two-point-stance', '2-point', '2pt', 'linebacker-stance', 'defensive-stance', 'ready', 'ready-stance', 'crouch-idle'],
  stance3: ['stance3', 'three-point', 'three-point-stance', '3-point', '3pt', 'lineman-stance', 'football-hike', 'hike'],
  walk: ['walk', 'walking', 'walk-forward', 'walking-forward'],
  jog: ['jog', 'jogging', 'jog-forward', 'slow-run', 'light-jog'],
  run: ['run', 'running', 'run-forward', 'running-forward', 'fast-jog'],
  sprint: ['sprint', 'sprinting', 'fast-run', 'fast-running', 'run-fast', 'sprint-forward'],
  backpedal: ['backpedal', 'back-pedal', 'run-backward', 'running-backward', 'jog-backward', 'jog-backwards', 'walk-backward', 'walking-backwards', 'backwards-run'],
  'shuffle-left': ['shuffle-left', 'left-shuffle', 'strafe-left', 'left-strafe', 'side-step-left', 'left-side-step', 'jog-strafe-left'],
  'shuffle-right': ['shuffle-right', 'right-shuffle', 'strafe-right', 'right-strafe', 'side-step-right', 'right-side-step', 'jog-strafe-right'],
  'cut-left': ['cut-left', 'left-cut', 'running-left-turn', 'left-turn', 'run-left-turn', 'change-direction-left'],
  'cut-right': ['cut-right', 'right-cut', 'running-right-turn', 'right-turn', 'run-right-turn', 'change-direction-right'],
  'juke-left': ['juke-left', 'left-juke', 'dodge-left', 'left-dodge', 'evade-left'],
  'juke-right': ['juke-right', 'right-juke', 'dodge-right', 'right-dodge', 'evade-right'],
  throw: ['throw', 'throwing', 'pass', 'quarterback-pass', 'qb-pass', 'football-pass', 'toss'],
  catch: ['catch', 'catching', 'receiver-catch', 'receive', 'football-catch'],
  carry: ['carry', 'ball-carry', 'carry-ball', 'running-with-ball', 'tuck'],
  block: ['block', 'blocking', 'pass-block', 'offensive-block', 'push', 'pushing', 'shove'],
  tackle: ['tackle', 'tackling', 'football-tackle', 'running-tackle', 'dive', 'diving'],
  wrapped: ['wrapped', 'being-tackled', 'tackled', 'struggle', 'struggling', 'hit-reaction'],
  fall: ['fall', 'falling', 'fall-flat', 'falling-down', 'knocked-down', 'knockdown', 'death', 'dying', 'down'],
  stumble: ['stumble', 'stumbling', 'trip', 'tripping', 'stumble-backwards', 'off-balance'],
  getup: ['getup', 'get-up', 'getting-up', 'stand-up', 'standing-up', 'rise'],
};
export const CLIP_ALIASES = ALIASES;

const ALIAS_LOOKUP = new Map();
for (const [slot, list] of Object.entries(ALIASES)) for (const alias of list) ALIAS_LOOKUP.set(alias, slot);

// "Armature|mixamo.com|Layer0", "Running (1).fbx", "Fast_Run" -> "fast-run".
export function normaliseClipName(name) {
  let out = String(name || '');
  out = out.split(/[\\/]/).pop();                  // directories
  out = out.replace(/\.(glb|gltf|fbx)$/i, '');      // extensions
  const parts = out.split('|').filter(p => !/^(armature|mixamo\.com|layer\d*|take\s*\d*|scene|root)$/i.test(p.trim()));
  out = parts.length ? parts[parts.length - 1] : out;
  out = out
    .replace(/mixamo\.com/ig, '')
    .replace(/\(\d+\)/g, '')                        // "Running (1)"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out;
}

// The slot a clip (or clip file) fills, or null.
export function slotForClipName(name) {
  const key = normaliseClipName(name);
  if (!key) return null;
  if (CLIP_SLOTS.includes(key)) return key;
  if (ALIAS_LOOKUP.has(key)) return ALIAS_LOOKUP.get(key);
  // "in-place" and similar Mixamo suffixes do not change the meaning.
  const trimmed = key.replace(/-(in-place|inplace|loop|cycle|anim|animation|clip|\d+)$/g, '');
  if (trimmed !== key) return slotForClipName(trimmed);
  return null;
}

// Assigns clips to slots. `clips` is [{name, source}] where source is
// 'file' (named after its file: wins) or 'model' (embedded in the model).
// `aliases` lets the caller force {slot: clipName}.
export function assignSlots(clips, aliases = {}) {
  const slots = {};
  const rank = c => (c.source === 'file' ? 2 : 1);
  for (const clip of clips) {
    const forced = Object.entries(aliases).find(([, name]) => name === clip.name);
    const slot = forced ? forced[0] : slotForClipName(clip.fileName || clip.name);
    if (!slot || !CLIP_SLOTS.includes(slot)) continue;
    if (!slots[slot] || rank(clip) > rank(slots[slot])) slots[slot] = clip;
  }
  return slots;
}

// What stands in for a missing slot: another clip (played as-is), the
// procedural overlay, or both. The animation layer walks this list.
export const FALLBACKS = {
  idle: ['walk'],
  stance2: ['idle'],
  stance3: ['stance2', 'idle'],
  walk: ['jog', 'run'],
  jog: ['run', 'walk'],
  run: ['jog', 'sprint', 'walk'],
  sprint: ['run', 'jog'],
  backpedal: [],            // locomotion played in reverse + procedural posture
  'shuffle-left': [],       // locomotion with the hips turned toward travel
  'shuffle-right': [],
  'cut-left': [], 'cut-right': [], 'juke-left': [], 'juke-right': [],
  throw: [], catch: [], carry: [], block: [],
  tackle: [], wrapped: [], fall: [], stumble: [], getup: [],
};

// Resolves which available clip plays for a slot (the slot itself or the
// first available fallback), or null when only the procedural layer is left.
export function resolveSlot(slot, available) {
  const has = s => (available instanceof Set ? available.has(s) : !!available[s]);
  if (has(slot)) return slot;
  for (const alt of FALLBACKS[slot] || []) if (has(alt)) return alt;
  return null;
}

// Validates a dist/models/index.json listing; returns {modelUrl, clipUrls}
// resolved against the index's own URL, or null when no model is listed.
export function resolveModelIndex(index, baseUrl = './models/') {
  if (!index || typeof index !== 'object' || !index.model) return null;
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const join = file => (/^(\.{0,2}\/|[a-z]+:)/i.test(file) ? file : base + file);
  const clipUrls = {};
  for (const file of index.clips || []) {
    const slot = slotForClipName(file);
    if (slot && !clipUrls[slot]) clipUrls[slot] = join(file);
  }
  return { modelUrl: join(index.model), clipUrls };
}

// Builds the index object from a directory listing (used by tests and by the
// optional index generator). Files: paths relative to dist/models/.
export function buildModelIndex(files) {
  const sorted = [...files].map(f => f.replace(/\\/g, '/')).sort();
  const model = sorted.find(f => /^player\.(glb|gltf|fbx)$/i.test(f)) || null;
  const clips = sorted.filter(f => /^clips\/[^/]+\.(glb|gltf|fbx)$/i.test(f));
  return { model, clips };
}
