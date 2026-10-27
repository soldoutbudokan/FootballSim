import * as THREE from '../vendor/three.module.js';
import { HDRLoader } from '../vendor/HDRLoader.js';
import { FORMATION, RECEIVERS, ROUTE_COLORS, routeFor } from './plays.js';
import { WIDTH, seededRandom } from './sim.js';
const rand=seededRandom(4839), UP=new THREE.Vector3(0,1,0);
const mat=(color,roughness=.75,metalness=0)=>new THREE.MeshStandardMaterial({color,roughness,metalness});
const cubeGeo=new THREE.BoxGeometry(1,1,1),cylinderGeo=new THREE.CylinderGeometry(1,1,1,12);
function box(parent,material,x,y,z,w,h,d){const m=new THREE.Mesh(cubeGeo,material);m.position.set(x,y,z);m.scale.set(w,h,d);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function tubeBetween(parent,material,a,b,r=.035){const av=new THREE.Vector3(...a),bv=new THREE.Vector3(...b),delta=bv.clone().sub(av),m=new THREE.Mesh(cylinderGeo,material);m.position.copy(av).add(bv).multiplyScalar(.5);m.quaternion.setFromUnitVectors(UP,delta.clone().normalize());m.scale.set(r,delta.length(),r);parent.add(m);return m;}
function canvasTexture(w,h,draw){const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;return t;}
function labelTexture(text,fg='#d7e0e5',bg='#152430',size=128){return canvasTexture(1024,size,(c,w,h)=>{c.fillStyle=bg;c.fillRect(0,0,w,h);c.fillStyle=fg;c.font=`800 ${h*.56}px Arial`;c.textAlign='center';c.textBaseline='middle';c.fillText(text,w/2,h/2);});}

// Everything static: sky, lighting, the playing surface, surroundings, play art
// and field overlays (line of scrimmage, first-down line). Scene units are yards;
// +z in simulation space maps to -z in scene space (see FieldScene).
export class Environment {
  constructor(scene,renderer,assetManager){
    this.scene=scene;this.renderer=renderer;this.assetManager=assetManager;
    scene.background=new THREE.Color('#b8d3df');scene.fog=new THREE.Fog('#b8d3df',120,340);
    this.art=new THREE.Group();scene.add(this.art);
    this.ambient=new THREE.HemisphereLight('#d4e8ff','#526444',2.05);scene.add(this.ambient);
    this.sun=new THREE.DirectionalLight('#fff0ce',3.1);this.sun.position.set(-44,62,10);this.sun.target.position.set(0,0,-45);this.sun.castShadow=true;this.sun.shadow.bias=-.00015;this.sun.shadow.normalBias=.035;this.sun.shadow.camera.left=-40;this.sun.shadow.camera.right=40;this.sun.shadow.camera.top=45;this.sun.shadow.camera.bottom=-45;this.sun.shadow.camera.near=1;this.sun.shadow.camera.far=180;scene.add(this.sun,this.sun.target);
    this.buildSky();this.buildField();this.buildStadium();this.buildGrass();
    new HDRLoader(assetManager).load('./assets/noon_grass_1k.hdr',texture=>{texture.mapping=THREE.EquirectangularReflectionMapping;this.environmentTexture=texture;scene.environment=texture;scene.environmentIntensity=this.lighting==='night'?.12:.38;});
  }
  buildSky(){
    this.skyMaterial=new THREE.ShaderMaterial({side:THREE.BackSide,depthWrite:false,uniforms:{top:{value:new THREE.Color('#4c85b2')},bottom:{value:new THREE.Color('#dae1d7')},sunDir:{value:new THREE.Vector3(-.5,.65,.2).normalize()}},vertexShader:'varying vec3 vPosition; void main(){vPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'varying vec3 vPosition; uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; void main(){ vec3 dir=normalize(vPosition); float h=pow(max(0.,dir.y),.55); vec3 col=mix(bottom,top,h); float sun=pow(max(0.,dot(dir,sunDir)),650.); col+=vec3(1.,.85,.5)*sun*3.; gl_FragColor=vec4(col,1.); }'});
    this.sky=new THREE.Mesh(new THREE.SphereGeometry(450,32,16),this.skyMaterial);this.scene.add(this.sky);
  }
  buildField(){
    const tex=canvasTexture(2048,4096,(c,w,h)=>{
      const sx=w/WIDTH,sy=h/120; c.fillStyle='#306343';c.fillRect(0,0,w,h);
      for(let z=10;z<110;z+=5){c.fillStyle=(z/5)%2?'#39734a':'#336943';c.fillRect(0,(120-z-5)*sy,w,5*sy);}
      const noise=document.createElement('canvas');noise.width=256;noise.height=512;const n=noise.getContext('2d'),data=n.createImageData(256,512);for(let i=0;i<data.data.length;i+=4){const v=rand()*255;data.data[i]=v;data.data[i+1]=v;data.data[i+2]=v;data.data[i+3]=10;}n.putImageData(data,0,0);c.drawImage(noise,0,0,w,h);
      c.fillStyle='#163c43';c.fillRect(0,0,w,10*sy);c.fillRect(0,110*sy,w,10*sy);
      c.fillStyle='#f1f3db';c.strokeStyle='#eef0d8';
      c.lineWidth=.12*sx;c.strokeRect(.12*sx,.12*sy,w-.24*sx,h-.24*sy);
      for(let z=10;z<=110;z+=5){const y=(120-z)*sy;c.fillRect(0,y-.06*sy,w,.12*sy);}
      for(let z=11;z<110;z++){const y=(120-z)*sy;for(const x of [-26.15,-3.08,3.08,26.15])c.fillRect((x+WIDTH/2-.35)*sx,y-.05*sy,.7*sx,.10*sy);}
      c.textAlign='center';c.textBaseline='middle';c.font=`900 ${2.4*sx}px Arial`;
      for(let z=20;z<110;z+=10){const num=50-Math.abs(60-z);for(const side of [-1,1]){c.save();c.translate((WIDTH/2+side*19)*sx,(120-z)*sy);c.rotate(side===-1?Math.PI/2:-Math.PI/2);c.scale(1,1.25);c.fillText(String(num),0,0);c.restore();}}
      c.save();c.translate(w/2,h/2);c.globalAlpha=.55;c.fillStyle='#102d3b';c.beginPath();c.moveTo(-145,-125);c.lineTo(145,-125);c.lineTo(105,125);c.lineTo(-105,125);c.closePath();c.fill();c.fillStyle='#c1e793';c.font='italic 900 210px Arial';c.fillText('F',-8,12);c.restore();
      for(const y of [5*sy,115*sy]){c.save();c.translate(w/2,y);if(y>h/2)c.rotate(Math.PI);c.font='900 140px Arial';c.fillStyle='#dae8d1';c.fillText('F O O T B A L L S I M',0,0);c.restore();}
    });tex.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
    const ground=mat('#496a43');box(this.scene,ground,0,-.2,-60,160,.3,225);
    const loader=new THREE.TextureLoader(this.assetManager),tile=2/.9144;
    const detail=loader.load('./assets/sparse_grass_diff_1k.jpg');detail.colorSpace=THREE.SRGBColorSpace;detail.wrapS=detail.wrapT=THREE.RepeatWrapping;
    const normal=loader.load('./assets/sparse_grass_nor_gl_1k.jpg'),roughness=loader.load('./assets/sparse_grass_rough_1k.jpg');
    for(const t of [detail,normal,roughness]){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());}
    for(const t of [normal,roughness])t.repeat.set(WIDTH/tile,120/tile);
    this.turfMaterial=new THREE.MeshStandardMaterial({map:tex,normalMap:normal,normalScale:new THREE.Vector2(.2,.2),roughnessMap:roughness,roughness:.98});
    this.turfMaterial.onBeforeCompile=shader=>{shader.uniforms.turfDetail={value:detail};shader.fragmentShader='uniform sampler2D turfDetail;\n'+shader.fragmentShader;shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\nvec3 grassDetail = texture2D(turfDetail, vMapUv * vec2(24.384,54.864)).rgb;\nfloat fieldPaint = smoothstep(0.48,0.75,max(diffuseColor.r,max(diffuseColor.g,diffuseColor.b)));\nfloat grassVariation = clamp(dot(grassDetail,vec3(0.2126,0.7152,0.0722))*2.2+0.67,0.72,1.25);\ndiffuseColor.rgb *= mix(grassVariation,1.0,fieldPaint);');};
    const field=new THREE.Mesh(new THREE.PlaneGeometry(WIDTH,120),this.turfMaterial);field.rotation.x=-Math.PI/2;field.position.set(0,.006,-60);field.receiveShadow=true;this.scene.add(field);
    const sideline=mat('#e3e5d5');box(this.scene,sideline,-27.7,-.005,-60,1.9,.02,123);box(this.scene,sideline,27.7,-.005,-60,1.9,.02,123);
    const orange=mat('#e96322');for(const x of [-WIDTH/2,WIDTH/2])for(const z of [10,110])box(this.scene,orange,x,.22,-z,.15,.44,.15);
    this.los=new THREE.Mesh(new THREE.PlaneGeometry(WIDTH,.12),new THREE.MeshBasicMaterial({color:'#6edbff',transparent:true,opacity:.55,depthWrite:false}));this.los.rotation.x=-Math.PI/2;this.los.position.y=.023;this.scene.add(this.los);
    this.firstDown=new THREE.Mesh(new THREE.PlaneGeometry(WIDTH,.15),new THREE.MeshBasicMaterial({color:'#edbf5d',transparent:true,opacity:.65,depthWrite:false}));this.firstDown.rotation.x=-Math.PI/2;this.firstDown.position.y=.025;this.scene.add(this.firstDown);
    const yellow=mat('#efcd4f',.5,.25);for(const z of [0,-120]){tubeBetween(this.scene,yellow,[0,0,z],[0,3.5,z],.13);tubeBetween(this.scene,yellow,[-3.08,3.5,z],[3.08,3.5,z],.075);tubeBetween(this.scene,yellow,[-3.08,3.5,z],[-3.08,9,z],.075);tubeBetween(this.scene,yellow,[3.08,3.5,z],[3.08,9,z],.075);box(this.scene,mat('#223d4b'),0,1,z,.55,2,.55);}
  }
  buildGrass(){
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-.022,0,0,.022,0,0,.007,.11,0],3));g.computeVertexNormals();
    const grassMat=new THREE.MeshStandardMaterial({color:'#50804b',side:THREE.DoubleSide,roughness:1});this.grass=new THREE.InstancedMesh(g,grassMat,40000);
    const dummy=new THREE.Object3D();for(let i=0;i<40000;i++){dummy.position.set((rand()-.5)*51.8,.009,-10-rand()*100);dummy.rotation.y=rand()*Math.PI;dummy.scale.setScalar(.6+rand()*.7);dummy.updateMatrix();this.grass.setMatrixAt(i,dummy.matrix);}this.grass.count=10000;this.scene.add(this.grass);
  }
  buildStadium(){
    const concrete=mat('#9dadae'),navy=mat('#193441'),steel=mat('#5e727d',.55,.25),dark=mat('#253b48'),glass=mat('#294b5b',.22,.35),white=mat('#d7dfdd');
    const crowdGeo=new THREE.CapsuleGeometry(.18,.35,2,5),crowdMat=mat('#e1dfd0');this.crowd=new THREE.InstancedMesh(crowdGeo,crowdMat,7500);const dummy=new THREE.Object3D(),col=new THREE.Color();
    for(let i=0;i<7500;i++){const side=i%2===0?-1:1,row=Math.floor(rand()*18),z=-4-rand()*112;dummy.position.set(side*(34+row*.85),1.3+row*.48,z);dummy.rotation.set(0,side>0?-Math.PI/2:Math.PI/2,0);dummy.scale.setScalar(.8+rand()*.3);dummy.updateMatrix();this.crowd.setMatrixAt(i,dummy.matrix);col.set(['#c0c9c6','#23475b','#3a535d','#c8dba4','#b77a57','#879da8'][Math.floor(rand()*6)]);this.crowd.setColorAt(i,col);}this.crowd.count=2600;this.scene.add(this.crowd);
    for(const side of [-1,1]) {
      for(let row=0;row<19;row++){box(this.scene,concrete,side*(33+row*.85),.32+row*.48,-60,1.3,.48,121);box(this.scene,navy,side*(33+row*.85),.65+row*.48,-60,.45,.16,118);}
      box(this.scene,navy,side*31.7,.75,-60,.8,1.6,125);box(this.scene,steel,side*50,10.2,-60,.15,1.2,125);
      for(const z of [-7,-36,-64,-93,-118]){box(this.scene,concrete,side*42,5.0,z,18,.12,1.7);}
      box(this.scene,dark,side*49,12,-60,7,6,46);box(this.scene,glass,side*45.45,12.3,-60,.12,3.2,43);box(this.scene,white,side*49,15.2,-60,9,.5,49);
      const banner=new THREE.Mesh(new THREE.PlaneGeometry(44,2.1),new THREE.MeshBasicMaterial({map:labelTexture('F O O T B A L L S I M   /   PRACTICE FACILITY','#c1ef88')}));banner.position.set(side*45.3,10.1,-60);banner.rotation.y=side>0?-Math.PI/2:Math.PI/2;this.scene.add(banner);
      for(const z of [-10,-110]) {
        tubeBetween(this.scene,steel,[side*40,0,z],[side*40,26,z],.2);
        box(this.scene,dark,side*40,26,z,6,1.3,.4);const bulb=new THREE.MeshBasicMaterial({color:'#fff5d5'});for(let n=0;n<7;n++)box(this.scene,bulb,side*40+(n-3)*.8,26,z+.23,.55,.75,.05);
      }
    }
    for(const z of [9,-129]){box(this.scene,dark,0,6,z,32,11,2);const board=new THREE.Mesh(new THREE.PlaneGeometry(28,7),new THREE.MeshBasicMaterial({map:canvasTexture(1024,256,(c,w,h)=>{c.fillStyle='#071a25';c.fillRect(0,0,w,h);c.fillStyle='#b9ee7a';c.textAlign='center';c.font='bold 27px Arial';c.fillText('F O O T B A L L S I M',w/2,53);c.fillStyle='#f1f4e9';c.font='900 90px Arial';c.fillText('PRACTICE',w/2,157);c.fillStyle='#88a4ae';c.font='24px Arial';c.fillText('EVERY REP. EVERY READ.',w/2,215);})}));board.position.set(0,7,z+(z<0?1.02:-1.02));if(z>0)board.rotation.y=Math.PI;this.scene.add(board);}
    this.details=new THREE.Group();this.scene.add(this.details);
    const bench=mat('#b4bec0');for(const side of [-1,1])for(const z of [-30,-43,-56,-69,-82]){box(this.details,bench,side*29.8,.55,z,1,.12,7);box(this.details,dark,side*29.8,.22,z-2,.65,.5,.2);box(this.details,dark,side*29.8,.22,z+2,.65,.5,.2);}
    const pad=mat('#16404b');for(let i=0;i<5;i++){box(this.details,pad,-30.5,.85,-13-i*1.2,.7,1.7,.6);box(this.details,steel,-30.5,.1,-13-i*1.2,1,.15,1);}
    const cooler=mat('#df743c');box(this.details,cooler,30,1,-91,1.2,.8,1.4);box(this.details,white,30,1.45,-91,1.25,.1,1.45);
    const building=mat('#708c94');for(let i=0;i<30;i++){const x=(rand()-.5)*320,z=-170-rand()*65,h=8+rand()*30;box(this.scene,building,x,h/2,z,8+rand()*15,h,9+rand()*10);}
  }
  setLighting(mode){
    const presets={day:{top:'#4c85b2',bottom:'#dae1d7',fog:'#b8d3df',sun:'#fff0ce',intensity:3.1,ambient:2.05,pos:[-44,62,10],exposure:1.08},sunset:{top:'#4d6d91',bottom:'#e6b188',fog:'#bcae9d',sun:'#ffc18a',intensity:3.3,ambient:1.4,pos:[-75,24,-5],exposure:1.02},night:{top:'#071322',bottom:'#344957',fog:'#233744',sun:'#d6ebff',intensity:2.2,ambient:1.25,pos:[-36,65,-15],exposure:1.18}};
    const p=presets[mode]||presets.day;this.lighting=mode;this.scene.environmentIntensity=mode==='night'?.12:.38;this.skyMaterial.uniforms.top.value.set(p.top);this.skyMaterial.uniforms.bottom.value.set(p.bottom);this.scene.fog.color.set(p.fog);this.sun.color.set(p.sun);this.sun.intensity=p.intensity;this.ambient.intensity=p.ambient;this.lightOffset=p.pos;this.sun.position.set(...p.pos);this.renderer.toneMappingExposure=p.exposure;this.skyMaterial.uniforms.sunDir.value.copy(this.sun.position).normalize();
  }
  setQuality(profile){
    this.renderer.shadowMap.enabled=profile.shadow>0;this.sun.castShadow=profile.shadow>0;
    if(profile.shadow&&this.sun.shadow.mapSize.x!==profile.shadow){this.sun.shadow.mapSize.set(profile.shadow,profile.shadow);if(this.sun.shadow.map){this.sun.shadow.map.dispose();this.sun.shadow.map=null;}}
    this.crowd.count=profile.crowd;this.grass.count=profile.grass;this.details.visible=profile.detail;
  }
  setPlay(play,spot,flip,toGo=null){
    while(this.art.children.length){const child=this.art.children[0];this.art.remove(child);child.geometry?.dispose();child.material?.dispose();}
    RECEIVERS.forEach((id,i)=>{const p=FORMATION.find(p=>p.id===id),route=routeFor(play,id,spot,flip),points=[new THREE.Vector3(flip?-p.x:p.x,.07,-(spot+p.z)),...route.map(p=>new THREE.Vector3(p.x,.07,-p.z))];
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineDashedMaterial({color:ROUTE_COLORS[i],dashSize:.65,gapSize:.25,transparent:true,opacity:.85}));line.computeLineDistances();this.art.add(line);
      if(points.length>1){const end=points.at(-1),prev=points.at(-2),d=end.clone().sub(prev).normalize(),perp=new THREE.Vector3(-d.z,0,d.x);const ap=[end.clone().addScaledVector(d,-.8).addScaledVector(perp,.4),end,end.clone().addScaledVector(d,-.8).addScaledVector(perp,-.4)];this.art.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ap),new THREE.LineBasicMaterial({color:ROUTE_COLORS[i]})));}
    });this.los.position.z=-spot;this.firstDown.visible=toGo!==null;this.firstDown.position.z=-Math.min(110,spot+(toGo??0));this.sun.target.position.z=-spot-7;const off=this.lightOffset||[-44,62,10];this.sun.position.set(off[0],off[1],-spot+off[2]);
  }
  // Called once per rendered frame; use for time-based effects (wind, lights).
  update(state,dt,{menu=false}={}){}
}
