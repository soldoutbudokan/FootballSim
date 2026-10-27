// Distances and route landmarks are in yards, relative to the line of scrimmage.
export const RECEIVERS = ['X', 'Y', 'A', 'B', 'R'];
export const ROUTE_COLORS = ['#6ee7ff', '#ffd16b', '#b6f46c', '#e4a4ff', '#ff9e83'];
export const FORMATION = [
  { id:'QB', number:12, role:'qb', x:0, z:-5, speed:6.5 },
  { id:'LT', number:72, role:'ol', x:-3.2, z:-.35, speed:4.5 },
  { id:'LG', number:66, role:'ol', x:-1.6, z:-.35, speed:4.4 },
  { id:'C', number:60, role:'ol', x:0, z:-.25, speed:4.4 },
  { id:'RG', number:68, role:'ol', x:1.6, z:-.35, speed:4.4 },
  { id:'RT', number:75, role:'ol', x:3.2, z:-.35, speed:4.5 },
  { id:'X', number:11, role:'wr', x:-21, z:0, speed:8.7 },
  { id:'Y', number:18, role:'wr', x:-10, z:-1.1, speed:8.6 },
  { id:'A', number:87, role:'te', x:6.4, z:-1.1, speed:7.7 },
  { id:'B', number:1, role:'wr', x:21, z:0, speed:9 },
  { id:'R', number:26, role:'rb', x:-3.5, z:-6, speed:8.5 },
];
export const PLAYS = [
  { id:'mesh', name:'Mesh concept', formation:'GUN · DOUBLES', type:'pass', tag:'SHORT', read:'Read the shallow crossers. Against zone, find the sit route behind the linebackers.', routes:{ X:[[-21,5],[-6,5],[19,5]], Y:[[-10,10],[-4,10]], A:[[6.4,4],[-7,4],[-22,4]], B:[[21,12],[10,24]], R:[[-9,-2],[-16,2],[-21,9]] } },
  { id:'flood', name:'PA flood', formation:'GUN · DOUBLES', type:'pa', tag:'PLAY ACTION', read:'The right sideline is a three-level read: flat, sail, then the go route. Let the fake develop.', routes:{ X:[[-21,12],[-3,24],[12,30]], Y:[[-10,7],[2,13],[18,15]], A:[[12,0],[22,2]], B:[[21,18],[21,42]], R:[[0,-4],[-4,-1],[-9,3]] } },
  { id:'verts', name:'Four verticals', formation:'GUN · DOUBLES', type:'pass', tag:'DEEP', read:'Hold the safeties with your eyes. Attack the seam before the deep zones close.', routes:{ X:[[-21,15],[-21,45]], Y:[[-10,14],[-9,42]], A:[[6.4,14],[9,42]], B:[[21,15],[21,45]], R:[[-6,-1],[-10,3],[-10,7]] } },
  { id:'slants', name:'Quick slants', formation:'GUN · DOUBLES', type:'pass', tag:'QUICK GAME', read:'A three-step read. Throw as the outside receiver breaks inside; the flat holds the linebacker.', routes:{ X:[[-21,3],[-10,13],[2,23]], Y:[[-11,2],[-22,3]], A:[[6.4,4],[-3,14]], B:[[21,3],[10,13],[-2,23]], R:[[2,-2],[11,1],[21,3]] } },
  { id:'drive', name:'Dagger', formation:'GUN · DOUBLES', type:'pass', tag:'INTERMEDIATE', read:'The seam clears the middle. Wait for the deep dig, with the drag as your checkdown.', routes:{ X:[[-21,15],[-5,15],[16,15]], Y:[[-10,15],[-5,42]], A:[[6.4,3],[-6,3],[-22,3]], B:[[21,12],[21,9]], R:[[-8,-1],[-13,5]] } },
  { id:'corners', name:'Smash', formation:'GUN · DOUBLES', type:'pass', tag:'ZONE BEATER', read:'High-low the cornerback. Take the hitch if he sinks; throw the corner if he stays underneath.', routes:{ X:[[-21,6],[-21,4]], Y:[[-10,10],[-22,22]], A:[[6.4,10],[21,23]], B:[[21,6],[21,4]], R:[[0,-2],[0,5]] } },
  { id:'zone', name:'Inside zone', formation:'GUN · DOUBLES', type:'run', tag:'RUN', lane:1.7, read:'Follow the right guard, press the gap, then cut into daylight. Sprint after the line opens.', routes:{ X:[[-21,7]], Y:[[-10,5]], A:[[5,4]], B:[[21,7]], R:[[0,-3],[1.7,1],[2,10],[2,40]] } },
  { id:'stretch', name:'HB stretch', formation:'GUN · DOUBLES', type:'run', tag:'RUN', lane:-10, read:'Stretch the defense to the left. Cut upfield off the tackle’s outside shoulder.', routes:{ X:[[-21,7]], Y:[[-13,3]], A:[[3,3]], B:[[21,7]], R:[[-6,-4],[-10,-1],[-13,6],[-13,40]] } },
];
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
export function hotRouteFor(id,kind) {
  const p=FORMATION.find(p=>p.id===id);if(!p||!RECEIVERS.includes(id))return null;
  const x=p.x,inside=x<0?1:-1,outside=-inside,edge=v=>Math.max(-25.5,Math.min(25.5,v));
  const routes={
    streak:[[x,10],[x,42]], slant:[[x,3],[edge(x+inside*10),13],[edge(x+inside*20),23]],
    drag:[[x,3],[edge(x+inside*12),4],[edge(x+inside*25),5]],
    in:[[x,10],[edge(x+inside*13),10]], out:[[x,8],[edge(x+outside*12),8]],
    curl:[[x,11],[x,8]], flat:[[edge(x+outside*7),1],[edge(x+outside*16),3]],
    corner:[[x,11],[edge(x+outside*12),24]],
  };return routes[kind]||null;
}
