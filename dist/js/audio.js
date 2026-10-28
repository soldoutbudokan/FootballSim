// Short synthesized practice-field sounds. Nothing plays until the player turns
// sound on; simulation events without a sound here are ignored.
export class FieldAudio {
  constructor() {
    this.enabled = false;
    this.context = null;
  }

  async setEnabled(value) {
    this.enabled = value;
    if (value) {
      this.init();
      await this.context?.resume();
    } else {
      await this.context?.suspend();
    }
  }

  init() {
    if (this.context) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.master.gain.value = .22;
    this.master.connect(this.context.destination);

    // One shared white-noise buffer feeds every percussive sound.
    const rate = this.context.sampleRate;
    this.noise = this.context.createBuffer(1, rate, rate);
    const white = this.noise.getChannelData(0);
    for (let i = 0; i < white.length; i++) white[i] = Math.random() * 2 - 1;

    // A soft outdoor bed: low brown noise, like wind across an open field.
    const bed = this.context.createBuffer(1, rate * 3, rate), data = bed.getChannelData(0);
    let lastSample = 0;
    for (let i = 0; i < data.length; i++) {
      lastSample = (lastSample + (Math.random() * 2 - 1) * .02) / 1.02;
      data[i] = lastSample * 3;
    }
    this.ambience = this.context.createBufferSource();
    this.ambience.buffer = bed;
    this.ambience.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    const gain = this.context.createGain();
    gain.gain.value = .09;
    this.ambience.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    this.ambience.start();
  }

  suspend() { this.context?.suspend(); }
  resume() { if (this.enabled) this.context?.resume(); }

  get ready() { return this.enabled && !!this.context; }

  // A pitched blip with a fast attack and exponential decay.
  tone(freq, duration, volume = .3, type = 'sine', end = freq, delay = 0) {
    if (!this.ready) return;
    const t = this.context.currentTime + delay;
    const osc = this.context.createOscillator(), gain = this.context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), t + duration);
    gain.gain.setValueAtTime(.001, t);
    gain.gain.linearRampToValueAtTime(volume, t + .008);
    gain.gain.exponentialRampToValueAtTime(.001, t + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + .02);
  }

  // A filtered noise burst: pads colliding, cleats scraping turf.
  burst({ duration = .1, volume = .3, type = 'bandpass', freq = 800, q = 1, end = freq, delay = 0 } = {}) {
    if (!this.ready) return;
    const t = this.context.currentTime + delay;
    const source = this.context.createBufferSource(), filter = this.context.createBiquadFilter(), gain = this.context.createGain();
    source.buffer = this.noise;
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, end), t + duration);
    gain.gain.setValueAtTime(.001, t);
    gain.gain.linearRampToValueAtTime(volume, t + .006);
    gain.gain.exponentialRampToValueAtTime(.001, t + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(t, Math.random() * .5);
    source.stop(t + duration + .02);
  }

  event(name) {
    const sound = SOUNDS[name];
    if (sound) sound(this);
  }
}

const SOUNDS = {
  snap: a => a.tone(220, .1, .2, 'triangle', 90),
  throw: a => a.tone(320, .12, .12, 'sine', 160),
  catch: a => a.tone(110, .12, .55, 'triangle', 40),
  handoff: a => a.tone(110, .12, .55, 'triangle', 40),
  whistle: a => a.tone(2200, .28, .12, 'sine', 1900),
  interception: a => a.tone(2200, .28, .12, 'sine', 1900),
  touchdown: a => { a.tone(520, .5, .24, 'triangle', 780); a.tone(780, .45, .2, 'triangle', 1040, .18); },
  juke: a => { a.tone(160, .08, .12, 'triangle', 90); a.burst({ duration: .09, volume: .12, type: 'highpass', freq: 2400, end: 1600 }); },
  // Quiet cleat scrape on a plant-and-cut.
  cut: a => a.burst({ duration: .07, volume: .07, type: 'highpass', freq: 3000, end: 1800 }),
  // Pad thud: a low body hit with a short noisy crack on top.
  tackle: a => { a.tone(90, .18, .5, 'sine', 45); a.burst({ duration: .12, volume: .35, type: 'lowpass', freq: 900, end: 200 }); },
  // Glancing contact, then the carrier's cleats digging back in.
  'broken-tackle': a => {
    a.tone(130, .1, .28, 'sine', 70);
    a.burst({ duration: .08, volume: .22, type: 'bandpass', freq: 700, q: .8, end: 400 });
    a.burst({ duration: .08, volume: .1, type: 'highpass', freq: 2800, end: 1800, delay: .09 });
  },
  // The ball hitting the turf and bouncing once.
  drop: a => { a.tone(150, .07, .3, 'triangle', 80); a.tone(170, .05, .16, 'triangle', 90, .16); },
  // Title menu navigation tick.
  menu: a => a.tone(660, .035, .05, 'square', 520),
};
