export class FieldAudio {
  constructor(){this.enabled=false;this.context=null;}
  async setEnabled(value){this.enabled=value;if(value){this.init();await this.context?.resume();}else await this.context?.suspend();}
  init(){if(this.context)return;const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;this.context=new AC();this.master=this.context.createGain();this.master.gain.value=.22;this.master.connect(this.context.destination);
    const buffer=this.context.createBuffer(1,this.context.sampleRate*3,this.context.sampleRate),data=buffer.getChannelData(0);let last=0;for(let i=0;i<data.length;i++){last=(last+(Math.random()*2-1)*.02)/1.02;data[i]=last*3;}
    this.ambience=this.context.createBufferSource();this.ambience.buffer=buffer;this.ambience.loop=true;const filter=this.context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=700;const gain=this.context.createGain();gain.gain.value=.11;this.ambience.connect(filter);filter.connect(gain);gain.connect(this.master);this.ambience.start();
  }
  suspend(){this.context?.suspend();}
  resume(){if(this.enabled)this.context?.resume();}
  tone(freq,duration,volume=.3,type='sine',end=freq){if(!this.enabled||!this.context)return;const t=this.context.currentTime,o=this.context.createOscillator(),g=this.context.createGain();o.type=type;o.frequency.setValueAtTime(freq,t);o.frequency.exponentialRampToValueAtTime(Math.max(20,end),t+duration);g.gain.setValueAtTime(.001,t);g.gain.linearRampToValueAtTime(volume,t+.008);g.gain.exponentialRampToValueAtTime(.001,t+duration);o.connect(g);g.connect(this.master);o.start(t);o.stop(t+duration+.02);}
  event(name){if(name==='snap')this.tone(220,.1,.2,'triangle',90);else if(name==='throw')this.tone(320,.12,.12,'sine',160);else if(name==='catch'||name==='handoff')this.tone(110,.12,.55,'triangle',40);else if(name==='whistle'||name==='interception')this.tone(2200,.28,.12,'sine',1900);else if(name==='touchdown'){this.tone(520,.5,.24,'triangle',780);setTimeout(()=>this.tone(780,.45,.2,'triangle',1040),180);}else if(name==='juke')this.tone(160,.08,.12,'triangle',90);}
}
