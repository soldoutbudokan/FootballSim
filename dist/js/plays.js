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
// him by his pass key (X 1, Y 2, A 3, B 4, R 5), so it stays right when the
// play flips. Pass cues name the key defender and the progression.
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
];

// Preserve the original eight IDs and their order for saved choices/shortcuts.
export const PLAYS = CALLS.map(play => {
  const formationId = play.formationId || 'doubles';
  const family = play.family || (play.type === 'run' ? 'run' : play.type === 'pa' ? 'playaction' : 'dropback');
  return { ...play, formationId, formation:FORMATIONS[formationId].label, personnel:FORMATIONS[formationId].personnel, family };
});
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
// The cue as plain text with pass keys: "3 settles inside him while 2 widens".
export function readText(play) {
  return readParts(play).map(part => part.text ?? String(part.receiver + 1)).join('');
}
export const COVERAGES = {
  cover3: { label:'Cover 3 sky', description:'Three deep zones · four underneath', rushers:4 },
  cover2: { label:'Cover 2', description:'Two deep safeties · five underneath', rushers:4 },
  man: { label:'2-man', description:'Man coverage · two high safeties', rushers:4 },
  blitz: { label:'Cover 0 blitz', description:'Six rushers · no deep help', rushers:6 },
  random: { label:'Disguised / random', description:'Read the defense after the snap', rushers:4 },
};
export function routeFor(play, id, spot, flip=false) {
  return (play.routes[id] || []).map(([x,z]) => ({ x:flip?-x:x, z:Math.min(118, spot+z) }));
}

export const HOT_ROUTES = [
  {id:'streak',label:'Streak',key:'V'}, {id:'slant',label:'Slant',key:'S'},
  {id:'drag',label:'Drag',key:'D'}, {id:'in',label:'In',key:'I'},
  {id:'out',label:'Out',key:'O'}, {id:'curl',label:'Curl',key:'C'},
  {id:'flat',label:'Flat',key:'L'}, {id:'corner',label:'Corner',key:'R'},
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
