import * as THREE from '../vendor/three.module.js';
const mat=(color,roughness=.75,metalness=0)=>new THREE.MeshStandardMaterial({color,roughness,metalness});
const cubeGeo=new THREE.BoxGeometry(1,1,1),sphereGeo=new THREE.SphereGeometry(1,16,12);
const cylinderGeo=new THREE.CylinderGeometry(1,1,1,12),capsuleGeo=new THREE.CapsuleGeometry(1,1,4,10);
function box(parent,material,x,y,z,w,h,d){const m=new THREE.Mesh(cubeGeo,material);m.position.set(x,y,z);m.scale.set(w,h,d);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function sphere(parent,material,x,y,z,w,h,d){const m=new THREE.Mesh(sphereGeo,material);m.position.set(x,y,z);m.scale.set(w,h,d);parent.add(m);return m;}
function canvasTexture(w,h,draw){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}

// Rigid parts are instanced across all 22 articulated rigs. This keeps detailed
// helmets, pads and limbs affordable without changing any simulation behavior.
class RigBatch {
  constructor(scene){this.scene=scene;this.batches=new Map();}
  part(parent,geometry,material,x,y,z,sx,sy,sz){const node=new THREE.Object3D();node.position.set(x,y,z);node.scale.set(sx,sy,sz);parent.add(node);const key=geometry.uuid+material.uuid;if(!this.batches.has(key))this.batches.set(key,{geometry,material,nodes:[]});this.batches.get(key).nodes.push(node);return node;}
  finish(){for(const b of this.batches.values()){b.mesh=new THREE.InstancedMesh(b.geometry,b.material,b.nodes.length);b.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);b.mesh.castShadow=true;b.mesh.receiveShadow=true;b.mesh.frustumCulled=false;this.scene.add(b.mesh);}}
  update(){for(const b of this.batches.values()){for(let i=0;i<b.nodes.length;i++)b.mesh.setMatrixAt(i,b.nodes[i].matrixWorld);b.mesh.instanceMatrix.needsUpdate=true;}}
}
function makeRig(batch,scene,spec,palette,skin) {
  const root=new THREE.Group(),body=new THREE.Group();root.add(body);scene.add(root);
  const part=(parent,geo,m,x,y,z,sx,sy,sz)=>batch.part(parent,geo,m,x,y,z,sx,sy,sz);
  part(body,sphereGeo,palette.jersey,0,1.27,0,.32,.34,.205);
  part(body,sphereGeo,palette.jersey,0,1.43,0,.405,.18,.22);
  part(body,sphereGeo,palette.pants,0,.96,0,.26,.21,.18);
  part(body,cylinderGeo,palette.belt,0,1.025,0,.255,.035,.185);
  const head=new THREE.Group();head.position.set(0,1.77,0);head.scale.setScalar(.84);body.add(head);
  part(head,sphereGeo,skin,0,-.035,.12,.16,.185,.15);
  part(head,sphereGeo,palette.helmet,0,.035,-.025,.237,.248,.25);
  part(head,sphereGeo,palette.stripe,0,.08,-.035,.035,.218,.242);
  part(head,cubeGeo,palette.visor,0,.005,.241,.295,.065,.014);
  part(head,cylinderGeo,palette.cage,0,-.102,.305,.012,.29,.012).rotation.z=Math.PI/2;
  part(head,cylinderGeo,palette.cage,0,-.185,.26,.012,.265,.012).rotation.z=Math.PI/2;
  for(const side of [-1,1]) {
    const bar=part(head,cylinderGeo,palette.cage,side*.145,-.105,.25,.012,.21,.012);bar.rotation.x=.45;
    part(head,sphereGeo,palette.helmet,side*.213,-.045,-.005,.033,.095,.095);
    part(head,sphereGeo,palette.gloves,side*.12,-.183,.16,.045,.025,.075);
  }
  const arms=[],legs=[];
  for(const side of [-1,1]) {
    const shoulder=new THREE.Group();shoulder.position.set(side*.37,1.44,0);body.add(shoulder);
    part(shoulder,sphereGeo,palette.jersey,0,-.065,0,.16,.19,.18);
    part(shoulder,cylinderGeo,palette.stripe,0,-.175,0,.132,.028,.14);
    part(shoulder,capsuleGeo,skin,0,-.25,0,.093,.16,.093);
    const elbow=new THREE.Group();elbow.position.set(0,-.39,0);shoulder.add(elbow);
    part(elbow,capsuleGeo,skin,0,-.13,0,.075,.12,.075);
    part(elbow,cylinderGeo,palette.socks,0,-.21,0,.08,.065,.08);
    part(elbow,sphereGeo,palette.gloves,0,-.29,.016,.086,.112,.065);
    arms.push({shoulder,elbow});
    const hip=new THREE.Group();hip.position.set(side*.15,.92,0);body.add(hip);
    part(hip,capsuleGeo,palette.pants,0,-.18,0,.128,.16,.14);
    part(hip,cubeGeo,palette.stripe,side*.115,-.15,0,.018,.29,.14);
    const knee=new THREE.Group();knee.position.set(0,-.4,0);hip.add(knee);
    part(knee,capsuleGeo,palette.socks,0,-.17,0,.078,.135,.08);
    part(knee,sphereGeo,palette.pants,0,-.015,.045,.105,.10,.07);
    part(knee,sphereGeo,palette.boots,0,-.36,.065,.107,.075,.19);
    part(knee,cubeGeo,palette.stripe,0,-.402,.055,.18,.018,.3);
    legs.push({hip,knee});
  }
  const number=canvasTexture(128,128,(c,w,h)=>{c.clearRect(0,0,w,h);c.textAlign='center';c.fillStyle=palette.number;c.font='bold 15px Arial';c.fillText(spec.team==='offense'?'OFFENSE':'DEFENSE',w/2,24);c.font='900 76px Arial';c.fillText(String(spec.number),w/2,98);});
  const numberMaterial=new THREE.MeshStandardMaterial({map:number,transparent:true,roughness:1,depthWrite:false});
  for(const side of [-1,1]){const mesh=new THREE.Mesh(new THREE.PlaneGeometry(.4,.42),numberMaterial);mesh.position.set(0,1.285,side*.212);if(side<0)mesh.rotation.y=Math.PI;body.add(mesh);}
  const scale=spec.role==='ol'||spec.role==='dl'?1.1:spec.role==='te'?1.035:1;root.scale.set(scale*.86,scale,scale);
  return {root,body,head,arms,legs};
}
function animateRig(rig,p,time,deadTime=0){
  const {root,body,head,arms,legs}=rig;root.position.set(p.x,0,-p.z);root.rotation.set(0,Math.PI-p.facing,0);
  const speed=Math.hypot(p.vx,p.vz),run=Math.min(1,speed/6),phase=p.phase*2.55;
  body.position.y=Math.abs(Math.sin(phase))*run*.055;body.rotation.set(.08*run,0,0);head.rotation.set(0,0,0);
  for(let i=0;i<2;i++){
    const wave=Math.sin(phase+i*Math.PI),{hip,knee}=legs[i],{shoulder,elbow}=arms[i];
    hip.rotation.set(wave*.72*run,0,0);knee.rotation.set(Math.max(0,-wave)*1.05*run+.06,0,0);
    shoulder.rotation.set(-wave*.65*run-.12,0,(i===0?1:-1)*.13);elbow.rotation.set(-.55-run*.4,0,0);
  }
  if(p.action==='ready'){
    body.position.y=-.14;body.rotation.x=.25;legs.forEach(l=>{l.hip.rotation.x=-.2;l.knee.rotation.x=.4;});arms.forEach(a=>{a.shoulder.rotation.x=-.35;a.elbow.rotation.x=-.7;});
    if(['LT','LG','C','RG','RT','DE1','DE2','DT1','DT2'].includes(p.id)){body.position.y=-.31;body.rotation.x=.58;arms[1].shoulder.rotation.x=.15;arms[1].elbow.rotation.x=-.12;}
  }else if(p.action==='block'||p.engaged){body.rotation.x=.22;arms.forEach(a=>{a.shoulder.rotation.x=-1.2;a.elbow.rotation.x=-.45;});}
  else if(p.action==='throw'){const progress=1-Math.min(1,p.actionTime/.4);arms[1].shoulder.rotation.x=-2.2+progress*1.7;arms[1].elbow.rotation.x=-.8+progress*.5;body.rotation.y=-.32+progress*.6;}
  else if(p.action==='catch'){arms.forEach(a=>{a.shoulder.rotation.x=-1.7;a.elbow.rotation.x=-.25;});}
  else if(p.action==='carry'){arms[1].shoulder.rotation.x=-.38;arms[1].elbow.rotation.x=-1.7;}
  else if(p.action==='juke'){body.rotation.z=-.25;}
  else if(p.action==='down'||p.action==='tackle'){const fall=Math.min(1,deadTime*3);root.rotation.x=fall*1.32;root.position.y=-.05;body.position.y=-fall*.25;arms.forEach(a=>{a.shoulder.rotation.x=-1.4;});}
}

// Everything that moves: the 22 athletes, the ball, the control ring and the
// soft contact shadows. Scene units are yards; simulation +z maps to scene -z.
export class Athletes {
  constructor(scene,players){
    this.scene=scene;
    const common={cage:mat('#a7b4bd',.38,.6),visor:mat('#17242d',.15,.3),belt:mat('#162431'),boots:mat('#101922',.5),gloves:mat('#f0f1e5'),socks:mat('#e2e9e2')};
    const offense={...common,jersey:mat('#10364d',.78),pants:mat('#ecf0e7',.9),helmet:mat('#123b52',.27,.5),stripe:mat('#bbef77',.55),number:'#f6f8ea'};
    const defense={...common,jersey:mat('#e9eeec',.8),pants:mat('#283442',.85),helmet:mat('#d8dfe0',.29,.5),stripe:mat('#d37648',.55),number:'#1b3445'};
    const skins=['#a36542','#613c29','#cf9369','#855438'].map(c=>mat(c,.72));
    this.batch=new RigBatch(scene);this.rigs=new Map();
    players.forEach((p,i)=>this.rigs.set(p.id,makeRig(this.batch,scene,p,p.team==='offense'?offense:defense,skins[i%skins.length])));this.batch.finish();
    this.ball=new THREE.Group();const leather=mat('#683c24',.82);sphere(this.ball,leather,0,0,0,.13,.13,.225);
    const lace=mat('#e4d7b7');for(let i=0;i<6;i++)box(this.ball,lace,0,.126,-.07+i*.028,.065,.012,.012);scene.add(this.ball);
    this.ring=new THREE.Mesh(new THREE.RingGeometry(.61,.69,48),new THREE.MeshBasicMaterial({color:'#b7f36e',side:THREE.DoubleSide,transparent:true,opacity:.95,depthWrite:false}));this.ring.rotation.x=-Math.PI/2;this.ring.position.y=.035;scene.add(this.ring);
    this.contactShadows=new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5,1.05),new THREE.MeshBasicMaterial({map:this.shadowTexture(),transparent:true,depthWrite:false,opacity:.45}),players.length);this.contactShadows.frustumCulled=false;scene.add(this.contactShadows);
    this.dummy=new THREE.Object3D();
  }
  shadowTexture(){return canvasTexture(64,64,(c)=>{const g=c.createRadialGradient(32,32,2,32,32,31);g.addColorStop(0,'rgba(0,0,0,.9)');g.addColorStop(1,'rgba(0,0,0,0)');c.fillStyle=g;c.fillRect(0,0,64,64);});}
  setQuality(profile){}
  // Poses every rig from a simulation snapshot, then refreshes world matrices and
  // the instanced part buffers so the frame can be rendered immediately after.
  update(state,dt,{menu=false}={}){
    const controlled=state.players.find(p=>p.id===(state.carrier||state.selected))||state.players[0];
    state.players.forEach((p,i)=>{const visual={...p};if(state.phase==='presnap')visual.action='ready';else if(state.carrier===p.id&&!['throw','catch','down','juke'].includes(p.action))visual.action='carry';animateRig(this.rigs.get(p.id),visual,state.time,state.deadTime);this.dummy.position.set(p.x,.022,-p.z);this.dummy.rotation.set(-Math.PI/2,0,0);this.dummy.scale.set(1,1,1);this.dummy.updateMatrix();this.contactShadows.setMatrixAt(i,this.dummy.matrix);});
    this.contactShadows.instanceMatrix.needsUpdate=true;
    this.ball.position.set(state.ball.x,state.ball.y,-state.ball.z);if(state.phase==='dead'&&controlled.action==='down')this.ball.position.y=Math.max(.22,state.ball.y-state.deadTime*3);this.ball.rotation.set(state.phase==='air'?state.time*24:.25,Math.PI/2,0);this.ball.visible=true;
    this.ring.position.set(controlled.x,.036,-controlled.z);this.ring.visible=!menu&&state.phase!=='dead';
    this.scene.updateMatrixWorld(true);this.batch.update();
    return controlled;
  }
}
