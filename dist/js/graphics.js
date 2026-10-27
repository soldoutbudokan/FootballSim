// Following racer2: physical-pixel budgets, warmup, sustained-load sampling.
// The simulation always runs at 120 Hz, independently of these visual budgets.
export const PROFILES = [
  { id:'performance', label:'Performance', pixels:800000, dpr:.85, shadow:0, crowd:900, grass:0, detail:false },
  { id:'balanced', label:'Balanced', pixels:1500000, dpr:1.15, shadow:1024, crowd:2600, grass:10000, detail:true },
  { id:'high', label:'High', pixels:2500000, dpr:1.5, shadow:2048, crowd:5200, grass:24000, detail:true },
  { id:'ultra', label:'Ultra', pixels:4200000, dpr:2, shadow:4096, crowd:7500, grass:40000, detail:true },
];
export function pixelRatio(w,h,dpr,profile,scale=1) {
  return Math.max(1/Math.max(1,w,h), Math.min(dpr,profile.dpr,Math.sqrt(profile.pixels/Math.max(1,w*h)))*scale);
}
export class AdaptiveGraphics {
  constructor(apply,mode='auto') { this.apply=apply; this.select(mode); }
  select(mode) {
    this.mode=['auto',...PROFILES.map(p=>p.id)].includes(mode)?mode:'auto';
    this.level=this.mode==='auto'?1:PROFILES.findIndex(p=>p.id===this.mode);
    this.scale=1; this.pending=null; this.reset(); this.apply(PROFILES[this.level],this.scale);
  }
  reset() { this.warmup=2; this.elapsed=0; this.count=0; this.bad=0; this.good=0; }
  sample(ms,active=true,safeToChange=true) {
    if(this.mode!=='auto') return;
    if(!active) {this.reset(); return;}
    if(!Number.isFinite(ms)||ms<=0||ms>250) {this.elapsed=0; this.count=0; return;}
    if(this.warmup>0){this.warmup-=ms/1000;return;}
    this.elapsed+=Math.min(ms,100); this.count++;
    if(this.elapsed>=2000) {
      const avg=this.elapsed/this.count;
      this.bad=avg>24?this.bad+1:0; this.good=avg<18?this.good+1:0;
      if(this.bad>=2) this.pending=-1;
      if(this.good>=6 && this.level<3) this.pending=1;
      this.elapsed=0;this.count=0;
    }
    if(this.pending!==null&&safeToChange) {
      if(this.pending<0) { if(this.level>0)this.level--; else this.scale=Math.max(.65,this.scale-.1); }
      else if(this.scale<1)this.scale=Math.min(1,this.scale+.1); else this.level=Math.min(3,this.level+1);
      this.pending=null;this.reset();this.apply(PROFILES[this.level],this.scale);
    }
  }
  get profile(){return PROFILES[this.level];}
}
