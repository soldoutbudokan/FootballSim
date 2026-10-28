# Player models and animation clips

The game draws all 22 athletes from one rigged character model, recoloured per
team and animated from the simulation. Drop the files below into `dist/models/`
and they are used automatically; no code changes. Without a model the game
keeps its built-in procedural athletes.

## Files

| Path | What |
|---|---|
| `dist/models/player.glb` | The character: one rigged, skinned humanoid in its bind pose. Its own animations (if any) are used as clips. |
| `dist/models/clips/<slot>.glb` or `.fbx` | Optional separate clip files, one animation each, named after the slot (list below). A separate file wins over a clip of the same slot inside `player.glb`. |
| `dist/models/index.json` | Already committed. Names the model file and lists separate clip files: `{"model": "player.glb", "clips": ["clips/run.fbx", "clips/throw.fbx"]}`. Edit it only to use `player.fbx` or to list separate clips. |

When the scene is built the game sends a `HEAD` request for the model named
in `index.json`. If it exists, the skinned athletes load in the background
and replace the procedural ones; a failed load keeps the procedural ones and
logs the reason in the browser console. URL switches: `?athletes=skinned` forces the model,
`?athletes=procedural` forces the built-in athletes, `?athletes=dev` loads the
development stand-in `dist/dev/Xbot.glb` (development checkouts only; it is
never published).

## Formats

- **glTF 2.0 binary (`.glb`)**, preferred; `.gltf` works with its `.bin` and
  textures next to it. Meshopt compression (gltfpack, gltf-transform) is fine.
  **No Draco compression** (leave Blender's "Compression" unticked) and no
  KTX2/Basis textures. JPEG, PNG and WebP textures work.
- **FBX 7.x (`.fbx`)**, binary or ASCII. **Mixamo FBX loads directly**, both as
  the model ("With Skin") and as clip files ("Without Skin"). To use an FBX as
  the model, name it `player.fbx` and set `"model": "player.fbx"` in `index.json`.
- One character per file. Morph targets and cameras/lights in the file are ignored.

## Rig

- A humanoid skeleton. **Mixamo's auto-rigger is recommended** (upload the
  mesh at mixamo.com, place the markers, download FBX "With Skin", T-pose).
- Bind pose: T-pose (A-pose also works). Any unit, any scale, Y-up or Z-up,
  facing any axis: up is measured from the hips to the head, left from the
  right hip to the left hip.
- Required bones: hips, spine, head, and on both sides upper arm, forearm,
  hand, thigh, shin, foot. Neck, chest, clavicles and toes are used when present;
  fingers and helper/twist bones are left to the clips.
- Bone names: Mixamo names (`mixamorig:Hips`, any `mixamorigN:` prefix) map
  exactly. Unreal (`pelvis`, `spine_01`, `upperarm_l`), Unity/VRM (`UpperArm.L`),
  3ds Max Biped (`Bip01 L UpperArm`), Rigify `DEF-` bones, DAZ and Character
  Creator names are recognised, and anything else is auto-detected from words,
  the hierarchy and name similarity. The console reports bones it cannot map.
- Size: the model is scaled to 2.06 yd (6 ft 2 in) from the soles to the top of
  the head (the helmet), feet on the ground. Offensive and defensive linemen are
  drawn 2.12 yd tall and about 8 % wider. Model the helmet, pads and cleats on
  the character; there is no separate equipment.
- Root motion is ignored (the simulation moves the players). Export locomotion
  "In Place" if you can; drift is removed either way.

## Clips

Name each clip file (or each action inside `player.glb`) exactly after its slot.
Common Mixamo names are also recognised ("Running", "Breathing Idle",
"Running Backward", "Jog Strafe Left", "Quarterback Pass", "Football Hike", ...).
**Only `idle` and `run` are required**; every other slot falls back to a
procedural pose layered on the clips, so idle + walk + run alone is playable.
Playback speed of the locomotion clips follows the simulation: cadence and
stride are measured from each clip at load.

| Slot | Need | Used for | Loops |
|---|---|---|---|
| `idle` | required | standing still; base of the procedural stances | yes |
| `run` | required | running, about 6 yd/s | yes |
| `walk` | recommended | about 1.6 yd/s | yes |
| `sprint` | recommended | about 8.6 yd/s and faster | yes |
| `jog` | optional | about 3.6 yd/s | yes |
| `backpedal` | optional | defensive backs backpedalling (else `run` reversed, low) | yes |
| `shuffle-left`, `shuffle-right` | optional | side shuffle (else legs turned toward travel) | yes |
| `stance2` | recommended | two-point stance: linebackers, backs, receivers, defensive backs | yes |
| `stance3` | recommended | three-point stance: offensive and defensive linemen | yes |
| `cut-left`, `cut-right` | optional | plant and cut, about 0.2 s | no |
| `juke-left`, `juke-right` | optional | juke, about 0.45 s | no |
| `throw` | recommended | right-handed pass; its release frame is found automatically and timed to the ball leaving the hand 0.23 s into the 0.4 s throw | no |
| `catch` | recommended | two-handed catch; the contact frame is found automatically | no |
| `carry` | recommended | ball carrier's arms (right arm tuck); plays over the legs when running | yes |
| `block` | optional | engaged blocker, arms extended | yes |
| `tackle` | recommended | the tackler's wrap or dive, about 1 s, ending on the ground | no |
| `wrapped` | optional | ball carrier being tackled, legs driving | yes |
| `fall` | recommended | going down; its last frame is held while the play is dead | no |
| `stumble` | optional | missed tackle, off balance, about 0.7 s | no |
| `getup` | optional | reserved, not used yet | no |

The quarterback's shotgun stance, the head turning toward a ball in the air,
banking into turns and leaning with speed are always procedural.

## Materials (recolouring)

Every player gets the practice uniform: offense navy `#0f2742` with white
numbers, defense white `#f1f1ee` with navy numbers, the quarterback in red
`#c8322b`, silver `#c9ccd1` pants, navy helmets and socks, varied skin tones.
Name materials (or meshes) so each part is found; matching ignores case:

| Name contains | Part |
|---|---|
| `Jersey`, `Shirt`, `Top`, `Torso`, `Uniform` | jersey |
| `Pants`, `Shorts`, `Trousers`, `Bottom` | pants |
| `Helmet` | helmet shell |
| `Facemask`, `Cage` | facemask |
| `Visor` | visor |
| `Skin`, `Body`, `Face`, `Head`, `Arms`, `Hands`, `Legs` | skin |
| `Socks` | socks |
| `Shoes`, `Cleats`, `Boots` | cleats |
| `Gloves` | gloves |
| `Number` | number area: its UVs (0..1) get the player's number on the jersey colour |
| `Hair`, `Eye`, `Teeth`, `Brow` | kept as authored |

Textures are kept and tinted by their brightness, so paint clothing textures in
light greys (folds, seams, mesh) rather than in colour. A model with a single
material, or with no jersey/pants names, is recoloured by body region from its
skin weights (head = helmet, chest and upper arms = jersey, hips and thighs =
pants, shins = socks, feet = cleats, hands = gloves). Without a `Number`
material, numbers are drawn on the chest and back, following the torso.

## Size (GitHub Pages)

- `player.glb` at most 5 MB including textures (3 MB is comfortable); every
  file well under GitHub's 100 MB limit, the whole site under 1 GB.
- At most about 30 000 triangles and 4 materials: 22 copies are drawn every
  frame (and again for shadows). Distant players switch to an automatically
  reduced mesh.
- Textures 1024 x 1024 (2048 at most), JPEG or WebP for colour.
- Clips: 30 fps is plenty. Mixamo "Without Skin" FBX files are 0.2 to 1 MB
  each; clips embedded in `player.glb` share one skeleton and are smaller.

For reference, the 49 000-triangle development stand-in renders 22 players
for about the same frame cost as the procedural athletes: at the balanced
profile the whole frame draws 344 000 to 378 000 triangles in 246 to 274
draw calls (procedural: 326 000 in 261 to 285), at performance 170 000 in
about 220 to 245 (procedural: 231 000 in 232 to 256). Animating all 22
costs 4 to 7 ms of script per frame on a slow shared CPU.

## Licence

Ship only a model and clips whose licence allows distributing them inside the
game, which is a public website (the files can be downloaded). Mixamo's
characters and animations may be used royalty-free in games, including
commercial ones; they may not be redistributed as stand-alone asset packs.
Record the source and licence of every file in `ASSETS.md`.

## Exporting from Blender

1. File > Import > FBX with the default options: the character ("With Skin")
   first, then each clip FBX ("Without Skin").
2. In Dope Sheet > Action Editor, rename each imported action to its slot
   name (`run`, `throw`, ...) and click its shield icon (fake user) so it is
   kept and exported. Delete the extra armatures the clip imports brought in.
   Leave the character in its bind pose with no action assigned.
3. Select the mesh and armature, Object > Apply > All Transforms. Name the
   materials as in the table above.
4. File > Export > glTF 2.0: Format "glTF Binary (.glb)"; Include "Selected
   Objects"; Transform "+Y Up"; Mesh "Apply Modifiers"; Animation on, mode
   "Actions", "Always Sample Animations" on; Compression off. Save as
   `dist/models/player.glb`.

Or skip Blender: put the Mixamo FBX at `dist/models/player.fbx` (set
`"model": "player.fbx"` in `index.json`) and the clip FBX files at
`dist/models/clips/<slot>.fbx`, listed in `index.json`.

## Checking a model

Run `npm run dev`, open `http://localhost:8000/?athletes=skinned&debug=1` and
look at the browser console: it names unmapped bones, clips that did not match
a slot and why a load failed. `window.footballsim.view.athletes.status` reads
`ready` once the model is in, and `.active.asset.clips` lists the slots found.
