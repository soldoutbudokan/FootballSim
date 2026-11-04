// Distances and route landmarks are in yards, relative to the line of scrimmage.
// `speed` is each player's top speed in yards/s (sim.js adds the rest of the
// physical model by role).
export const RECEIVERS = ['X', 'Y', 'A', 'B', 'R'];
// Receivers 1-5: sky, gold, pink, lavender, coral. Five hues well apart and
// none of them green, so route art reads on the turf (contrast 2.7-4.4 against
// #3f6b3a-#4a7a42 grass) and badges read on navy.
export const ROUTE_COLORS = ['#7ad7ff', '#ffd45e', '#ffa3da', '#cdb8ff', '#ffab85'];
export const FORMATION = [
  { id:'QB', number:12, role:'qb', x:0, z:-5, speed:7.6 },
  { id:'LT', number:72, role:'ol', x:-3.2, z:-.35, speed:7.0 },
  { id:'LG', number:66, role:'ol', x:-1.6, z:-.35, speed:6.8 },
  { id:'C', number:60, role:'ol', x:0, z:-.25, speed:6.8 },
  { id:'RG', number:68, role:'ol', x:1.6, z:-.35, speed:6.8 },
  { id:'RT', number:75, role:'ol', x:3.2, z:-.35, speed:7.0 },
  { id:'X', number:11, role:'wr', x:-21, z:0, speed:9.3 },
  { id:'Y', number:18, role:'wr', x:-10, z:-1.1, speed:9.2 },
  { id:'A', number:87, role:'te', x:6.4, z:-1.1, speed:8.3 },
  { id:'B', number:1, role:'wr', x:21, z:0, speed:9.4 },
  { id:'R', number:26, role:'rb', x:-2.4, z:-5.6, speed:9.0 },
];
// Keep the same player IDs and personnel so receiver buttons remain stable.
// An alignment changes the actual snap locations, not just the play-card label.
function alignment(overrides) {
  return FORMATION.map(player => ({ ...player, ...(overrides[player.id] || {}) }));
}
export const FORMATIONS = {
  doubles: { id:'doubles', label:'GUN · DOUBLES', personnel:'11', players:FORMATION },
  trips: { id:'trips', label:'GUN · TRIPS', personnel:'11', players:alignment({
    Y:{x:12,z:-1.2}, A:{x:6,z:-1.2},
  }) },
  bunch: { id:'bunch', label:'GUN · BUNCH', personnel:'11', players:alignment({
    Y:{x:8,z:-1.6}, A:{x:12,z:-1.6}, B:{x:10,z:0},
  }) },
  empty: { id:'empty', label:'GUN · EMPTY', personnel:'11', players:alignment({
    Y:{x:-7,z:-1.2}, A:{x:9,z:-1.2}, R:{x:-14,z:-1.2},
  }) },
  pistol: { id:'pistol', label:'PISTOL · SLOT', personnel:'11', players:alignment({
    QB:{x:0,z:-4}, A:{x:5,z:-1.2}, R:{x:0,z:-7},
  }) },
  tight: { id:'tight', label:'GUN · TIGHT', personnel:'11', players:alignment({
    X:{x:-8,z:0}, Y:{x:-5.5,z:-1.2}, A:{x:5.5,z:-1.2}, B:{x:8,z:0},
  }) },
  singleback: { id:'singleback', label:'SINGLEBACK · TE', personnel:'11', players:alignment({
    QB:{x:0,z:-1.4}, A:{x:5,z:0}, B:{x:21,z:-1.2}, R:{x:0,z:-6.6},
  }) },
  // Two by two with the tight end flexed out to the right slot.
  spread: { id:'spread', label:'GUN · SPREAD', personnel:'11', players:alignment({
    A:{x:11,z:-1.2},
  }) },
  // Three by one with the tight end as #3 off the right tackle and the back
  // offset to the trips side.
  trey: { id:'trey', label:'GUN · TREY', personnel:'11', players:alignment({
    Y:{x:13,z:-1.2}, A:{x:4.8,z:-1.1}, R:{x:2.4,z:-5.6},
  }) },
};
export function formationFor(play) {
  return (FORMATIONS[play?.formationId] || FORMATIONS.doubles).players;
}

// Original implementations of common coaching concepts. Names describe the
// route combinations; no team playbook pages or licensed diagrams are bundled.
// References for the concepts (coordinates and coaching tips below are original):
// https://www.xandolabs.com/the-lab/offense/pass-game/quick-game-pass-concepts/spread-passing-study-snag-concept/
// https://www.samfleener.com/football/offense-fundamentals/plays-concepts/pass-concepts
// Each `read` is the coaching cue. {X} names a receiver by ID; the cue shows
// him by his pass key (passKey below: X A, Y W, A S, B D, R Space; X and B
// swap keys when the play flips). Pass cues name the key defender and the
// progression.
const CALLS = [
  { id:'mesh', name:'Mesh concept', formation:'GUN · DOUBLES', type:'pass', tag:'SHORT', read:'Read the linebackers as {X} and {A} mesh. Against man, hit the crosser running away; against zone, find {Y} sitting behind them.', routes:{ X:[[-21,5],[-6,5],[19,5]], Y:[[-10,10],[-4,10]], A:[[6.4,4],[-7,4],[-22,4]], B:[[21,12],[10,24]], R:[[-9,-2],[-16,2],[-21,9]] } },
  { id:'flood', name:'PA flood', formation:'GUN · DOUBLES', type:'pa', tag:'PLAY ACTION', read:'Let the fake develop, then flood the sideline: {B} clears deep, {Y} sails under him and {A} runs the flat. Throw off the flat defender.', routes:{ X:[[-21,12],[-3,24],[12,30]], Y:[[-10,7],[2,13],[18,15]], A:[[12,0],[22,2]], B:[[21,18],[21,42]], R:[[0,-4],[-4,-1],[-9,3]] } },
  { id:'verts', name:'Four verticals', formation:'GUN · DOUBLES', type:'pass', tag:'DEEP', read:'Read the safeties. Hold them with your eyes, then hit the open seam, {Y} or {A}, before the deep zones close, with {R} as the checkdown.', routes:{ X:[[-21,15],[-21,45]], Y:[[-10,14],[-9,42]], A:[[6.4,14],[9,42]], B:[[21,15],[21,45]], R:[[-6,-1],[-10,3],[-10,7]] } },
  { id:'slants', name:'Quick slants', formation:'GUN · DOUBLES', type:'pass', tag:'QUICK GAME', read:'Three-step read off the outside linebackers. As {Y} and {R} widen them, throw {X} or {B} on the break inside, or {A} in the middle.', routes:{ X:[[-21,3],[-10,13],[2,23]], Y:[[-11,2],[-22,3]], A:[[6.4,4],[-3,14]], B:[[21,3],[10,13],[-2,23]], R:[[2,-2],[11,1],[21,3]] } },
  { id:'drive', name:'Dagger', formation:'GUN · DOUBLES', type:'pass', tag:'INTERMEDIATE', read:'Read the deep middle: {Y}’s seam pulls the safety and opens the window for {X}’s dig. The checkdown is {A} on the drag.', routes:{ X:[[-21,15],[-5,15],[16,15]], Y:[[-10,15],[-5,42]], A:[[6.4,3],[-6,3],[-22,3]], B:[[21,12],[21,9]], R:[[-8,-1],[-13,5]] } },
  { id:'corners', name:'Smash', formation:'GUN · DOUBLES', type:'pass', tag:'ZONE BEATER', read:'High-low the cornerback: hit {B}’s hitch if he sinks, or {A}’s corner over him if he sits. {X} and {Y} run the same pair on the other side.', routes:{ X:[[-21,6],[-21,4]], Y:[[-10,10],[-22,22]], A:[[6.4,10],[21,23]], B:[[21,6],[21,4]], R:[[0,-2],[0,5]] } },
  { id:'zone', name:'Inside zone', formation:'GUN · DOUBLES', type:'run', tag:'RUN', blocking:'zone', lane:1.7, read:'Follow the right guard, press the gap, then cut into daylight. Sprint after the line opens.', routes:{ X:[[-21,7]], Y:[[-10,5]], A:[[5,4]], B:[[21,7]], R:[[0,-3],[1.7,1],[2,10],[2,40]] } },
  { id:'stretch', name:'HB stretch', formation:'GUN · DOUBLES', type:'run', tag:'RUN', blocking:'stretch', lane:10, read:'Stretch the defense to the right. Take the handoff across the quarterback, then cut upfield off the tight end’s outside shoulder.', routes:{ X:[[-21,7]], Y:[[-7,3]], A:[[9,3]], B:[[21,7]], R:[[6,-3.4],[10,-1],[13,6],[13,40]] } },

  { id:'stick', name:'Trips stick', formationId:'trips', type:'pass', family:'quick', tag:'QUICK GAME',
    read:'Read the flat defender on the trips side: {A} settles inside him while {Y} widens to the flat. {B} clears the sideline.',
    routes:{ X:[[-21,5],[-11,14]], Y:[[16,1],[24,3]], A:[[6,6],[8,5]], B:[[21,18],[21,43]], R:[[-7,-2],[-12,3]] } },
  { id:'snag', name:'Bunch snag', formationId:'bunch', type:'pass', family:'quick', tag:'TRIANGLE READ',
    read:'Read the flat defender: {A} stretches the corner, {B} sits in the snag window and {Y} runs to the flat. Throw where he leaves.',
    routes:{ X:[[-21,12],[-21,9]], Y:[[14,0],[24,2]], A:[[12,9],[24,22]], B:[[6,5],[6,4]], R:[[-7,-1],[-10,5]] } },
  { id:'spacing', name:'Empty spacing', formationId:'empty', type:'pass', family:'quick', tag:'QUICK GAME',
    read:'Read the linebackers: throw {Y} or {A} sitting inside if they widen, or {X}, {B} or {R} on the outside hitches if they stay in.',
    routes:{ X:[[-21,6],[-21,4]], Y:[[-4,6],[-4,5]], A:[[7,6],[7,5]], B:[[21,6],[21,4]], R:[[-14,5],[-14,4]] } },
  { id:'levels', name:'Trips levels', formationId:'trips', type:'pass', tag:'INTERMEDIATE',
    read:'Read the inside linebacker as {A} clears the seam: throw {Y}’s shallow in if he drops, or {B}’s dig behind him if he jumps it.',
    routes:{ X:[[-21,18],[-21,42]], Y:[[12,5],[1,5],[-14,5]], A:[[6,16],[6,40]], B:[[21,12],[8,12],[-10,12]], R:[[-7,-1],[-13,4]] } },
  { id:'ycross', name:'Tight end cross', formationId:'pistol', type:'pass', tag:'CROSSING',
    read:'Watch the safeties as {A} crosses behind the linebackers and {X} clears the sideline. If they squeeze the cross, take {Y} underneath.',
    routes:{ X:[[-21,18],[-21,43]], Y:[[-10,4],[1,4],[20,4]], A:[[5,8],[-8,15],[-23,20]], B:[[21,13],[21,10]], R:[[-5,-3],[-12,1],[-19,3]] } },
  { id:'shallow', name:'Drive shallow', formationId:'tight', type:'pass', tag:'MAN BEATER',
    read:'Read the middle linebacker as {X} runs under {A}’s dig. Throw the shallow against man, or the dig behind him if he drives down.',
    routes:{ X:[[-8,3],[5,3],[24,3]], Y:[[-5.5,16],[-15,35]], A:[[5.5,11],[-8,11],[-22,11]], B:[[8,15],[20,35]], R:[[-8,-1],[-15,2]] } },
  { id:'mills', name:'Mills post-dig', type:'pass', tag:'DEEP SHOT',
    read:'Read the deep safety as {B} runs the post over {A}’s dig. Take the dig if he stays deep; throw the post only when he drives down on it.',
    routes:{ X:[[-21,12],[-21,9]], Y:[[-10,5],[-21,5]], A:[[6.4,13],[-6,13],[-19,13]], B:[[21,16],[9,29],[-3,43]], R:[[-6,-1],[-7,5]] } },
  { id:'scissors', name:'Bunch scissors', formationId:'bunch', type:'pass', tag:'DEEP SHOT',
    read:'Read the deep safety as {B}’s post and {A}’s corner split behind him. Throw away from him, or to {Y} in the flat if both shots are covered.',
    routes:{ X:[[-21,13],[-7,13]], Y:[[15,0],[24,2]], A:[[12,11],[24,25]], B:[[10,16],[-4,32]], R:[[-7,-1],[-11,5]] } },
  { id:'postwheel', name:'Post-wheel', formationId:'trips', type:'pass', tag:'DOUBLE MOVE',
    read:'Read the cornerback as {B} runs the post and {Y} wheels up the sideline. Throw the wheel once it clears its man; {A} is the outlet.',
    routes:{ X:[[-21,10],[-21,7]], Y:[[18,2],[24,6],[24,35]], A:[[6,5],[0,5]], B:[[21,13],[8,28],[-1,39]], R:[[-7,-1],[-15,3]] } },
  { id:'curlflat', name:'Curl-flat', type:'pass', tag:'ZONE BEATER',
    read:'Read either outside linebacker. If he widens, throw the curl behind him, {X} or {B}; if he sinks, hit the flat, {Y} or {A}.',
    routes:{ X:[[-21,12],[-19,9]], Y:[[-16,1],[-24,3]], A:[[14,1],[24,3]], B:[[21,12],[19,9]], R:[[0,-1],[0,5]] } },
  { id:'ohio', name:'Empty Ohio', formationId:'empty', type:'pass', family:'quick', tag:'SIDELINE READ',
    read:'Read the cornerbacks as {X} and {B} fade to clear space for the outs by {Y} and {A}. Throw on the break; {R} sits inside against pressure.',
    routes:{ X:[[-21,16],[-23,40]], Y:[[-7,5],[-20,5]], A:[[9,5],[22,5]], B:[[21,16],[23,40]], R:[[-10,6],[-10,4]] } },
  { id:'boot', name:'PA boot flood', formationId:'singleback', type:'pa', tag:'PLAY ACTION',
    read:'After the fake, roll toward {B} if the edge is clear. Read the flat defender: {A} runs the flat, {Y} crosses behind him and {B} clears deep.',
    routes:{ X:[[-21,14],[-5,30]], Y:[[-10,8],[4,11],[21,13]], A:[[12,1],[24,3]], B:[[21,20],[21,43]], R:[[0,-3],[-7,-1],[-14,3]] } },
  { id:'yankee', name:'PA Yankee', formationId:'pistol', type:'pa', tag:'PLAY ACTION',
    read:'After the fake, read the deep safety: {B}’s post clears the middle for {X}’s over route. Take the crossing window, or {A} in the flat.',
    routes:{ X:[[-21,14],[-5,22],[21,25]], Y:[[-10,7],[-14,5]], A:[[5,3],[15,3]], B:[[21,18],[7,33],[-5,45]], R:[[0,-3],[-5,-1],[-8,4]] } },
  { id:'power', name:'Power right', formationId:'tight', type:'run', tag:'GAP RUN', blocking:'power', pullingGuard:'LG', lane:4.5,
    read:'Take the mesh toward the right tackle. Follow the pulling left guard through the gap, then accelerate upfield.',
    routes:{ X:[[-8,6]], Y:[[-5.5,4]], A:[[6,4]], B:[[10,7]], R:[[0,-4],[3,-2],[4.5,2],[5,14],[5,40]] } },
  { id:'counter', name:'Pistol counter', formationId:'pistol', type:'run', tag:'GAP RUN', blocking:'counter', pullingGuard:'RG', lane:-4.5,
    read:'The back takes a short step right before coming left. Follow the pulling right guard and cut up inside his block.',
    routes:{ X:[[-21,7]], Y:[[-10,4]], A:[[1,4]], B:[[21,7]], R:[[1.2,-5.5],[-.5,-4],[-4.5,-1],[-5,12],[-5,40]] } },
  { id:'widezone', name:'Singleback wide zone', formationId:'singleback', type:'run', tag:'OUTSIDE RUN', blocking:'stretch', lane:-10,
    read:'Press the left edge from under center. Keep moving wide if the defense is sealed; plant upfield when a crease opens.',
    routes:{ X:[[-21,7]], Y:[[-12,4]], A:[[2,4]], B:[[21,7]], R:[[0,-2.6],[-6,-2],[-11,0],[-14,9],[-14,40]] } },

  // Quick game.
  { id:'dslant', name:'Trips double slant', formationId:'trips', type:'pass', family:'quick', tag:'QUICK GAME',
    read:'Read the hook defender over the trips. If he widens with {A}’s arrow, throw {Y}’s slant inside him; if he sits, hit {B}’s slant behind him. {X}’s hitch beats press backside.',
    routes:{ X:[[-21,6],[-20,4]], Y:[[12,3],[5,7],[-6,10]], A:[[10,1],[18,2],[24,3]], B:[[21,3],[13,10],[3,17]], R:[[-5,-1],[-6,4]] } },
  { id:'spot', name:'Trips spot', formationId:'trips', type:'pass', family:'quick', tag:'TRIANGLE READ',
    read:'Read the flat defender: {A} runs the flat, {B} sits at 5 inside the cornerback and {Y} runs the corner over them. Throw where he leaves; {X}’s slant is the backside answer.',
    routes:{ X:[[-21,3],[-12,11],[-2,19]], Y:[[12,10],[22,22]], A:[[11,0],[22,2]], B:[[21,5],[16,6],[16,5]], R:[[-5,-1],[-6,4]] } },
  { id:'ystick', name:'Spread stick', formationId:'spread', type:'pass', family:'quick', tag:'QUICK GAME',
    read:'Read the flat defender on {A}’s side: {A} settles inside him at 6 while {R} runs under him to the flat and {B} clears. Backside, {Y}’s stick and {X}’s slant beat man.',
    routes:{ X:[[-21,3],[-12,10],[-3,17]], Y:[[-10,6],[-8,5]], A:[[11,6],[9,5]], B:[[21,16],[22,42]], R:[[2,-3],[9,-1],[18,2]] } },

  // Intermediate.
  { id:'sail', name:'Trips sail', formationId:'trips', type:'pass', tag:'FLOOD',
    read:'Flood the trips sideline: {B} clears the cornerback, {Y} breaks out under him at 14 and {A} runs the flat. Throw off the flat defender; {X}’s dig is the backside answer.',
    routes:{ X:[[-21,12],[-9,12],[2,12]], Y:[[12,11],[17,14],[24,16]], A:[[9,1],[17,2],[24,4]], B:[[21,16],[22,42]], R:[[-6,-2],[-8,4]] } },
  { id:'drivedig', name:'Doubles drive', type:'pass', tag:'INTERMEDIATE',
    read:'Read the middle linebacker: {Y}’s shallow runs under him and {X}’s dig breaks behind him. Throw the one he leaves; {A}’s seam holds the safety and {B} curls backside.',
    routes:{ X:[[-21,12],[-8,12],[6,12]], Y:[[-10,2],[-2,3],[14,4]], A:[[6.4,14],[8,40]], B:[[21,12],[20,9]], R:[[-6,-2],[-14,1],[-21,3]] } },
  { id:'digwheel', name:'Dig-wheel', type:'pass', tag:'HIGH-LOW',
    read:'Read the cornerback over {B}. If he drives on the dig, {A}’s wheel runs past him up the sideline; if he carries the wheel, throw the dig. {Y}’s seam holds the safety; {X} curls backside.',
    routes:{ X:[[-21,12],[-20,9]], Y:[[-10,14],[-10,40]], A:[[12,2],[19,5],[22,12],[22,40]], B:[[21,12],[9,12],[-3,12]], R:[[-6,-1],[-8,5]] } },
  { id:'hank', name:'Spread hank', formationId:'spread', type:'pass', tag:'ZONE BEATER',
    read:'Read the hook defenders: {Y} and {A} sit inside them at 6 while {X} and {B} curl at 8. Throw the hook he widens off, or the curl behind him if he sinks; {R} runs the flat.',
    routes:{ X:[[-21,11],[-20,8]], Y:[[-10,7],[-6,6]], A:[[11,7],[7,6]], B:[[21,11],[20,8]], R:[[-6,-2],[-14,1],[-22,3]] } },
  { id:'switch', name:'Switch verticals', formationId:'spread', type:'pass', tag:'DEEP',
    read:'Read the deep middle: throw the seam away from him, {X} or {A}. {X} and {Y} switch releases so the cornerback and the nickel must pass them off; {B} curls under the backside cornerback, and {R} is the checkdown.',
    routes:{ X:[[-21,5],[-13,12],[-9,42]], Y:[[-10,3],[-15,9],[-16,42]], A:[[11,12],[10,40]], B:[[21,13],[20,10]], R:[[-6,-1],[-8,5]] } },

  // Shots.
  { id:'sluggo', name:'Sluggo', type:'pass', tag:'DOUBLE MOVE',
    read:'Sell the slant, then read the cornerbacks over {X} and {B}: if one jumps the slant, throw the go over him. If both stay deep, take {Y}’s out or {A} sitting over the ball.',
    routes:{ X:[[-21,2],[-18,5],[-18,12],[-19,42]], Y:[[-10,5],[-18,5]], A:[[6.4,6],[5,5]], B:[[21,2],[18,5],[18,12],[19,42]], R:[[2,-2],[6,3]] } },
  { id:'postcorner', name:'Post-corner', formationId:'spread', type:'pass', tag:'DEEP SHOT',
    read:'Read the safety over {Y}: {Y} stems to the post to turn him inside, then breaks to the corner. If the cornerback sinks under it, throw {X}’s dig; {A} sits over the ball against pressure.',
    routes:{ X:[[-21,12],[-9,12],[0,12]], Y:[[-10,10],[-7,14],[-21,27]], A:[[11,8],[9,7]], B:[[21,16],[21,42]], R:[[-6,-1],[-8,5]] } },
  { id:'deepover', name:'Trey deep over', formationId:'trey', type:'pass', tag:'DEEP SHOT',
    read:'Read the deep safety: {Y}’s post and {B}’s go clear the trips side for {X}’s deep over from the backside. Throw it into the window they leave; {A}’s drag is the outlet.',
    routes:{ X:[[-21,10],[-12,16],[6,21],[22,23]], Y:[[13,13],[5,30]], A:[[4.8,3],[-6,4],[-20,5]], B:[[21,16],[21,42]], R:[[6,-3],[13,0],[19,3]] } },

  // Red zone.
  { id:'fadesmash', name:'Fade-smash', type:'pass', tag:'RED ZONE',
    read:'Left, high-low the cornerback: {X}’s hitch if he sinks, {Y}’s corner over him if he sits. Right, throw {B}’s fade against press, or {A} in the flat if the cornerback bails.',
    routes:{ X:[[-21,5],[-21,4]], Y:[[-10,8],[-20,16]], A:[[11,0],[20,2]], B:[[21,3],[23,16],[24,30]], R:[[2,-2],[5,3]] } },
  { id:'shallowmesh', name:'Shallow mesh', formationId:'spread', type:'pass', tag:'RED ZONE',
    read:'Against man, {Y} and {A} cross a yard apart to rub their men; throw the one running free. Against zone, {R} sits over the ball behind the linebackers while {X} and {B} hold the cornerbacks.',
    routes:{ X:[[-21,5],[-23,18]], Y:[[-10,2],[0,2],[18,3]], A:[[11,3],[0,3],[-18,4]], B:[[21,6],[21,4]], R:[[-1,-2],[0,6]] } },
  { id:'bootcorner', name:'PA boot corner', formationId:'tight', type:'pa', tag:'PLAY ACTION',
    read:'After the fake, roll toward {A} and {B}. Read the flat defender: {A} runs the flat, {B} the corner over him and {Y} crosses behind. Throw where he leaves, or run if the edge is clear.',
    routes:{ X:[[-8,12],[0,26]], Y:[[-5.5,6],[4,10],[16,12]], A:[[10,1],[20,3]], B:[[9,9],[21,19]], R:[[0,-4],[-5,-1.5],[-9,2]] } },

  // Short-yardage runs.
  { id:'duo', name:'Singleback duo', formationId:'singleback', type:'run', tag:'INSIDE RUN', blocking:'power', lane:-2,
    read:'Downhill from under center. Hit the left A gap behind the double teams, read the middle linebacker and cut off his flow.',
    routes:{ X:[[-21,7]], Y:[[-8,3]], A:[[4,3]], B:[[21,7]], R:[[0,-4],[-1.8,-1],[-2.2,8],[-2.2,40]] } },
  { id:'sweep', name:'Trey weak sweep', formationId:'trey', type:'run', tag:'OUTSIDE RUN', blocking:'stretch', pullingGuard:'LG', lane:-11,
    read:'Take the handoff across the quarterback, away from the trips. The left guard pulls to lead the edge; turn upfield behind him once the corner is sealed.',
    routes:{ X:[[-21,6]], Y:[[11,4]], A:[[3,3]], B:[[21,7]], R:[[-5.6,-3.4],[-10,-1],[-13,6],[-13,40]] } },
];

// Preserve the original eight IDs and their order for saved choices/shortcuts;
// new calls go at the end. sim/offense.js profiles every call from its
// routes and cue to call it for the situation.
export const PLAYS = CALLS.map(play => {
  const formationId = play.formationId || 'doubles';
  const family = play.family || (play.type === 'run' ? 'run' : play.type === 'pa' ? 'playaction' : 'dropback');
  return { ...play, formationId, formation:FORMATIONS[formationId].label, personnel:FORMATIONS[formationId].personnel, family };
});
// Keyboard pass keys in slot order. The game camera sits behind the offense,
// so A and D throw to the outside receivers on the left and right of the
// screen, W to the slot, S to the tight end and Space to the back (the
// checkdown). `code` is the KeyboardEvent code; `label` is what badges show.
export const PASS_KEYS = [
  { code:'KeyA', label:'A' }, { code:'KeyW', label:'W' }, { code:'KeyS', label:'S' },
  { code:'KeyD', label:'D' }, { code:'Space', label:'Space' },
];
// Receiver index (RECEIVERS order) to key slot and back: the same swap both
// ways. A flipped play mirrors X to the right and B to the left, so they swap
// keys and A stays the left outside receiver.
export function passSlot(index, flip=false) {
  return flip && (index === 0 || index === 3) ? 3 - index : index;
}
export function passKey(index, flip=false) { return PASS_KEYS[passSlot(index, flip)]; }
// The cue as segments for the renderer: { text } or { receiver } (0-4, the
// index into RECEIVERS and ROUTE_COLORS). An unknown token stays as text.
export function readParts(play) {
  const parts = [];
  (play?.read || '').split(/\{(\w+)\}/).forEach((piece, i) => {
    const receiver = i % 2 ? RECEIVERS.indexOf(piece) : -1;
    if (receiver >= 0) parts.push({ receiver });
    else if (piece) parts.push({ text: i % 2 ? `{${piece}}` : piece });
  });
  return parts;
}
// The cue as plain text with pass keys: "S settles inside him while W widens".
export function readText(play, flip=false) {
  return readParts(play).map(part => part.text ?? passKey(part.receiver, flip).label).join('');
}
// Coverage families the defense can call (dist/js/sim/defense.js). `rushers`
// is the family's usual count; the call itself decides who comes.
export const COVERAGES = {
  cover3: { label:'Cover 3', description:'Three deep zones · four underneath · sky, buzz or cloud rotation', rushers:4 },
  cover1: { label:'Cover 1', description:'Man across · a free safety deep · a robber, a spy or a fifth rusher', rushers:4 },
  cover2: { label:'Cover 2', description:'Two deep safeties · five underneath · corners in the flats', rushers:4 },
  tampa2: { label:'Tampa 2', description:'Cover 2 with the middle linebacker running the deep middle', rushers:4 },
  cover4: { label:'Cover 4', description:'Quarters: corners carry #1 deep, safeties read #2', rushers:4 },
  cover6: { label:'Cover 6', description:'Quarters to the strength · Cover 2 to the weak side', rushers:4 },
  man: { label:'2-man', description:'Man coverage · two high safeties', rushers:4 },
  blitz: { label:'Cover 0 blitz', description:'Six rushers · man across · no deep help', rushers:6 },
  firezone: { label:'Fire zone', description:'Five rush · a lineman drops · three under, three deep', rushers:5 },
  creeper: { label:'Sim pressure', description:'Pressure look · four rush, a lineman drops, seven cover', rushers:4 },
  random: { label:'Disguised / random', description:'Read the defense after the snap', rushers:4 },
};
export function routeFor(play, id, spot, flip=false) {
  return (play.routes[id] || []).map(([x,z]) => ({ x:flip?-x:x, z:Math.min(118, spot+z) }));
}

// The hot-route dialog picks a route with keys 1-8 in this order.
export const HOT_ROUTES = [
  {id:'streak',label:'Streak'}, {id:'slant',label:'Slant'},
  {id:'drag',label:'Drag'}, {id:'in',label:'In'},
  {id:'out',label:'Out'}, {id:'curl',label:'Curl'},
  {id:'flat',label:'Flat'}, {id:'corner',label:'Corner'},
];
export function hotRouteFor(id,kind,play) {
  const p=formationFor(play).find(p=>p.id===id);if(!p||!RECEIVERS.includes(id))return null;
  const x=p.x,inside=x<0?1:-1,outside=-inside,edge=v=>Math.max(-25.5,Math.min(25.5,v));
  const routes={
    streak:[[x,10],[x,42]], slant:[[x,3],[edge(x+inside*10),13],[edge(x+inside*20),23]],
    drag:[[x,3],[edge(x+inside*12),4],[edge(x+inside*25),5]],
    in:[[x,10],[edge(x+inside*13),10]], out:[[x,8],[edge(x+outside*12),8]],
    curl:[[x,11],[x,8]], flat:[[edge(x+outside*7),1],[edge(x+outside*16),3]],
    corner:[[x,11],[edge(x+outside*12),24]],
  };return routes[kind]||null;
}
