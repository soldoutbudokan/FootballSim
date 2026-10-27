import * as THREE from '../vendor/three.module.js';
import { Environment } from './environment.js';
import { Athletes } from './athletes.js';
import { pixelRatio, PROFILES } from './graphics.js';

// Orchestrates the renderer, camera and the two visual layers. Simulation space
// is yards with +z toward the opponent's goal; scene space negates z.
export class FieldScene {
  constructor(canvas,players){
    this.canvas=canvas;this.scene=new THREE.Scene();
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'default'});
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.08;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.camera=new THREE.PerspectiveCamera(54,1,.15,600);this.camera.position.set(7,14,-6);this.cameraTarget=new THREE.Vector3(0,1,-43);this.camera.lookAt(this.cameraTarget);
    this.cameraMode='broadcast';this.profile=PROFILES[1];this.scale=1;this.firstFrame=true;this.currentSpot=35;
    this.assetsReady=false;this.assetManager=new THREE.LoadingManager(()=>{this.assetsReady=true;});this.assetManager.onError=url=>console.error('Environment asset failed: '+url);
    this.environment=new Environment(this.scene,this.renderer,this.assetManager);
    this.athletes=new Athletes(this.scene,players);
    this.projectVector=new THREE.Vector3();this.resize();
  }
  get firstDown(){return this.environment.firstDown;}
  setLighting(mode){this.environment.setLighting(mode);}
  setQuality(profile,scale=1){this.profile=profile;this.scale=scale;this.environment.setQuality(profile);this.athletes.setQuality(profile);this.resize();}
  resize(){const w=this.canvas.clientWidth||window.innerWidth,h=this.canvas.clientHeight||window.innerHeight;this.renderer.setPixelRatio(pixelRatio(w,h,window.devicePixelRatio||1,this.profile,this.scale));this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
  setPlay(play,spot,flip,toGo=null){this.currentSpot=spot;this.environment.setPlay(play,spot,flip,toGo);}
  project(x,y,z){this.projectVector.set(x,y,-z).project(this.camera);return {x:(this.projectVector.x*.5+.5)*this.canvas.clientWidth,y:(-.5*this.projectVector.y+.5)*this.canvas.clientHeight,visible:this.projectVector.z<1&&this.projectVector.z>-1&&Math.abs(this.projectVector.x)<1.05&&Math.abs(this.projectVector.y)<1.05};}
  render(state,dt,{menu=false,showArt=false,replay=false}={}){
    this.environment.art.visible=showArt&&state.phase==='presnap';
    const controlled=this.athletes.update(state,dt,{menu});
    const target=new THREE.Vector3(),position=new THREE.Vector3();
    if(menu){const t=performance.now()*.000045;target.set(0,1,-state.spot-8);position.set(24+Math.sin(t)*5,17,-state.spot+23);}
    else if(replay){target.set(state.ball.x,1.3,-state.ball.z);position.set(controlled.x+16,10,-controlled.z+14);}
    else {
      const settings={broadcast:[15,23,13],wide:[26,31,18],qb:[4.3,8,17]};const [height,back,ahead]=settings[this.cameraMode]||settings.broadcast;
      let cx=controlled.x*.45,cz=controlled.z;
      if(state.phase==='air'){cx=controlled.x*.3+state.ball.x*.7;cz=controlled.z*.35+state.ball.z*.65;}
      target.set(cx,1,-cz-ahead);position.set(cx,height,-cz+back);
    }
    const smoothing=this.firstFrame?1:1-Math.exp(-dt*(menu?1.5:4));this.camera.position.lerp(position,smoothing);this.cameraTarget.lerp(target,smoothing);this.camera.lookAt(this.cameraTarget);this.firstFrame=false;
    this.environment.update(state,dt,{menu});
    this.renderer.render(this.scene,this.camera);
  }
}
