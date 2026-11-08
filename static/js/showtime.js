/* ============================================================
   AVALON — Showtime: voiced narrator, sound, and spectacle.

   One shared module for the paired display (/host) and phones (/).
   Everything here is presentation only: it never sends game commands
   and only reacts to public events the page already receives.

   - Herald: queue of pre-rendered narrator clips (static/voice) with an
     animated on-screen narrator, captions, and music ducking.
   - Sfx: CC0 samples (static/sfx) plus small Web Audio synthesis.
   - Fx: particle canvas, title cards, announcements, and screen shake.
   - Awards: end-of-game Royal Honours computed from the public summary.
   ============================================================ */
(function () {
    'use strict';

    const PAGE = location.pathname.startsWith('/host') ? 'host' : 'player';
    const ASSET_VERSION = '20261108-showtime-3';
    const SETTINGS_KEY = 'avalon-showtime-settings';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // -----------------------------------------------------------------------
    // Settings (per device). The display speaks by default; phones are quiet
    // unless someone turns sound on for a TV-less game.
    // -----------------------------------------------------------------------
    const DEFAULTS = PAGE === 'host'
        ? { voice: true, sfx: true, captions: true, voiceVolume: 90, sfxVolume: 70, chatter: 'normal' }
        : { voice: false, sfx: false, captions: true, voiceVolume: 90, sfxVolume: 60, chatter: 'normal' };
    let settings = { ...DEFAULTS };
    try {
        const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        if (stored && typeof stored === 'object') settings = { ...DEFAULTS, ...stored };
    } catch (_) { /* storage optional */ }
    const listeners = new Set();
    function saveSettings(patch) {
        settings = { ...settings, ...patch };
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* optional */ }
        applyVolumes();
        listeners.forEach(fn => { try { fn(settings); } catch (_) { /* ignore */ } });
        if (!settings.voice) Herald.stop();
        if (settings.voice || settings.sfx) unlockHint();
    }

    // -----------------------------------------------------------------------
    // Audio graph
    // -----------------------------------------------------------------------
    let ctx = null;
    let master = null;
    let voiceBus = null;
    let sfxBus = null;
    let analyser = null;
    let unlocked = false;

    function audio() {
        if (ctx) return ctx;
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try {
            ctx = new AC({ latencyHint: 'interactive' });
        } catch (_) {
            return null;
        }
        master = ctx.createGain();
        master.connect(ctx.destination);
        voiceBus = ctx.createGain();
        sfxBus = ctx.createGain();
        analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        voiceBus.connect(analyser);
        analyser.connect(master);
        sfxBus.connect(master);
        applyVolumes();
        return ctx;
    }

    function applyVolumes() {
        if (!ctx) return;
        voiceBus.gain.value = Math.max(0, Math.min(1, settings.voiceVolume / 100));
        sfxBus.gain.value = Math.max(0, Math.min(1, settings.sfxVolume / 100));
    }

    function ready() {
        return Boolean(ctx && ctx.state === 'running');
    }

    function unlock() {
        const context = audio();
        if (!context) return;
        if (context.state !== 'running') context.resume().catch(() => {});
        // iOS needs a sound started inside the gesture.
        try {
            const buffer = context.createBuffer(1, 1, 22050);
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            source.start(0);
        } catch (_) { /* ignore */ }
        if (!unlocked) {
            unlocked = true;
            Herald.loadManifest();
            if (settings.sfx) Sfx.preload();
        }
        window.setTimeout(unlockHint, 120);
    }
    ['pointerdown', 'keydown', 'touchend'].forEach(type => {
        window.addEventListener(type, unlock, { capture: true, passive: true });
    });

    let unlockChip = null;
    function unlockHint() {
        const wanted = (settings.voice || settings.sfx) && !ready() && PAGE === 'host';
        if (!wanted) {
            unlockChip?.classList.remove('visible');
            return;
        }
        if (!unlockChip) {
            unlockChip = document.createElement('button');
            unlockChip.type = 'button';
            unlockChip.className = 'st-unlock-chip';
            unlockChip.innerHTML = '<span aria-hidden="true">🔊</span> Tap to enable the narrator';
            unlockChip.addEventListener('click', unlock);
            document.body.appendChild(unlockChip);
        }
        unlockChip.classList.add('visible');
    }
    window.setTimeout(unlockHint, 1500);

    // -----------------------------------------------------------------------
    // Buffer loading
    // -----------------------------------------------------------------------
    const bufferCache = new Map();
    function loadBuffer(url) {
        if (bufferCache.has(url)) return bufferCache.get(url);
        const context = audio();
        if (!context) return Promise.reject(new Error('no audio'));
        const promise = fetch(url, { credentials: 'same-origin' })
            .then(response => {
                if (!response.ok) throw new Error(`audio ${response.status}`);
                return response.arrayBuffer();
            })
            .then(data => new Promise((resolve, reject) => {
                // Safari still prefers the callback form.
                const result = context.decodeAudioData(data, resolve, reject);
                if (result && result.then) result.then(resolve, reject);
            }));
        promise.catch(() => bufferCache.delete(url));
        bufferCache.set(url, promise);
        if (bufferCache.size > 160) bufferCache.delete(bufferCache.keys().next().value);
        return promise;
    }

    // -----------------------------------------------------------------------
    // Sound effects
    // -----------------------------------------------------------------------
    const SAMPLE_NAMES = [
        'shuffle', 'place1', 'place2', 'place3', 'slide1', 'slide2', 'slide3',
        'token1', 'token2', 'token3', 'fan', 'stack', 'coins', 'blade', 'slash',
        'door-open', 'door-close', 'book-open', 'page', 'book-close', 'cloth',
        'bell', 'clang', 'stamp', 'thud', 'shatter',
        'j-approve', 'j-reject', 'j-ready', 'j-join', 'j-magic', 'j-doom',
        'j-tension', 'j-sinister', 'j-ping-up', 'j-ping-down', 'j-fall', 'j-tick-up',
        'hit-big', 'hit-long', 'hit-short', 'hit-sting',
    ];
    const SAMPLE_GAIN = {
        shuffle: 0.9, fan: 0.9, bell: 0.55, clang: 0.5, stamp: 0.8, thud: 0.75,
        shatter: 0.5, 'hit-big': 0.7, 'hit-long': 0.7, 'hit-short': 0.65,
        'hit-sting': 0.65, cloth: 0.45, 'door-open': 0.6, 'door-close': 0.6,
    };
    const ALIASES = {
        place: ['place1', 'place2', 'place3'],
        slide: ['slide1', 'slide2', 'slide3'],
        token: ['token1', 'token2', 'token3'],
    };
    const sampleUrl = name => `/static/sfx/${name}.mp3?v=${ASSET_VERSION}`;
    const lastPlayed = new Map();

    function sfxAllowed() {
        return settings.sfx && ready() && document.visibilityState !== 'hidden';
    }

    function noiseBuffer(seconds = 1) {
        const context = audio();
        const length = Math.floor(context.sampleRate * seconds);
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        return buffer;
    }
    let sharedNoise = null;

    function envGain(start, peak, attack, release) {
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + release);
        return gain;
    }

    const synth = {
        boom(t, { gain = 0.9, from = 110, to = 38, length = 1.1 } = {}) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(from, t);
            osc.frequency.exponentialRampToValueAtTime(to, t + length * 0.8);
            const env = envGain(t, gain, 0.01, length);
            osc.connect(env).connect(sfxBus);
            osc.start(t);
            osc.stop(t + length + 0.1);
            synth.noiseHit(t, { gain: gain * 0.35, freq: 900, q: 0.6, length: 0.25 });
        },
        noiseHit(t, { gain = 0.4, freq = 1200, q = 1, length = 0.2, type = 'bandpass' } = {}) {
            sharedNoise ||= noiseBuffer(2);
            const source = ctx.createBufferSource();
            source.buffer = sharedNoise;
            const filter = ctx.createBiquadFilter();
            filter.type = type;
            filter.frequency.value = freq;
            filter.Q.value = q;
            const env = envGain(t, gain, 0.004, length);
            source.connect(filter).connect(env).connect(sfxBus);
            source.start(t, Math.random() * 1.5, length + 0.1);
        },
        whoosh(t, { gain = 0.35, length = 0.55, up = true } = {}) {
            sharedNoise ||= noiseBuffer(2);
            const source = ctx.createBufferSource();
            source.buffer = sharedNoise;
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.Q.value = 1.4;
            filter.frequency.setValueAtTime(up ? 300 : 2600, t);
            filter.frequency.exponentialRampToValueAtTime(up ? 2600 : 300, t + length);
            const env = envGain(t, gain, length * 0.55, length * 0.45);
            source.connect(filter).connect(env).connect(sfxBus);
            source.start(t, Math.random(), length + 0.1);
        },
        drumroll(t, { length = 2, gain = 0.3, crescendo = true } = {}) {
            const hits = Math.floor(length * 22);
            for (let i = 0; i < hits; i++) {
                const p = i / hits;
                const level = gain * (crescendo ? 0.35 + p * 0.65 : 1) * (0.8 + Math.random() * 0.3);
                synth.noiseHit(t + i / 22, { gain: level, freq: 260 + Math.random() * 80, q: 1.8, length: 0.08 });
            }
            synth.boom(t + length, { gain: gain * 2.2, from: 90, to: 45, length: 0.8 });
        },
        heartbeat(t, { gain = 0.8, beats = 2, interval = 0.85 } = {}) {
            for (let i = 0; i < beats; i++) {
                const at = t + i * interval;
                synth.boom(at, { gain, from: 70, to: 34, length: 0.28 });
                synth.boom(at + 0.2, { gain: gain * 0.7, from: 64, to: 32, length: 0.3 });
            }
        },
        tick(t, { gain = 0.25, high = false } = {}) {
            const osc = ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.value = high ? 1760 : 1180;
            const filter = ctx.createBiquadFilter();
            filter.type = 'highpass';
            filter.frequency.value = 700;
            const env = envGain(t, gain, 0.002, 0.05);
            osc.connect(filter).connect(env).connect(sfxBus);
            osc.start(t);
            osc.stop(t + 0.08);
        },
        shimmer(t, { gain = 0.16, notes = [1318.5, 1567.98, 1975.53, 2637.02], step = 0.06 } = {}) {
            notes.forEach((frequency, index) => {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = frequency;
                const env = envGain(t + index * step, gain, 0.01, 0.9);
                osc.connect(env).connect(sfxBus);
                osc.start(t + index * step);
                osc.stop(t + index * step + 1);
            });
        },
        gong(t, { gain = 0.4, base = 98 } = {}) {
            [1, 1.47, 2.09, 2.56, 3.2, 4.1].forEach((ratio, index) => {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = base * ratio;
                const env = envGain(t, gain / (index + 1.2), 0.012, 3.6 - index * 0.35);
                osc.connect(env).connect(sfxBus);
                osc.start(t);
                osc.stop(t + 4);
            });
        },
        choir(t, { chord = [220, 277.18, 329.63, 440], length = 2.4, gain = 0.07, minor = false } = {}) {
            const notes = minor ? chord.map((f, i) => (i === 1 ? f * 0.9439 : f)) : chord;
            const formant = ctx.createBiquadFilter();
            formant.type = 'bandpass';
            formant.frequency.value = 800;
            formant.Q.value = 0.9;
            const env = ctx.createGain();
            env.gain.setValueAtTime(0.0001, t);
            env.gain.exponentialRampToValueAtTime(gain, t + length * 0.35);
            env.gain.exponentialRampToValueAtTime(0.0001, t + length);
            formant.connect(env).connect(sfxBus);
            notes.forEach(frequency => {
                [-6, 6].forEach(detune => {
                    const osc = ctx.createOscillator();
                    osc.type = 'sawtooth';
                    osc.frequency.value = frequency;
                    osc.detune.value = detune;
                    osc.connect(formant);
                    osc.start(t);
                    osc.stop(t + length + 0.1);
                });
            });
        },
        fanfare(t, { gain = 0.11, minor = false } = {}) {
            const third = minor ? 311.13 : 329.63;
            const notes = [[261.63, 0, 0.16], [261.63, 0.18, 0.12], [392, 0.32, 0.18], [third * 2, 0.52, 0.9]];
            notes.forEach(([frequency, offset, length]) => {
                const filter = ctx.createBiquadFilter();
                filter.type = 'lowpass';
                filter.frequency.setValueAtTime(900, t + offset);
                filter.frequency.linearRampToValueAtTime(2400, t + offset + 0.08);
                const env = envGain(t + offset, gain, 0.03, length);
                filter.connect(env).connect(sfxBus);
                [frequency, frequency * 1.5].forEach((f, index) => {
                    const osc = ctx.createOscillator();
                    osc.type = 'sawtooth';
                    osc.frequency.value = f;
                    osc.detune.value = index ? 4 : -3;
                    osc.connect(filter);
                    osc.start(t + offset);
                    osc.stop(t + offset + length + 0.1);
                });
            });
        },
    };

    const Sfx = {
        preload() {
            if (!audio()) return;
            SAMPLE_NAMES.forEach(name => loadBuffer(sampleUrl(name)).catch(() => {}));
        },
        play(name, { gain = 1, delay = 0, rate = 1, minGap = 40 } = {}) {
            if (!sfxAllowed()) return;
            const choices = ALIASES[name];
            const sample = choices ? choices[Math.floor(Math.random() * choices.length)] : name;
            const now = performance.now();
            if (now - (lastPlayed.get(name) || 0) < minGap) return;
            lastPlayed.set(name, now);
            loadBuffer(sampleUrl(sample)).then(buffer => {
                if (!sfxAllowed()) return;
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.playbackRate.value = rate;
                const level = ctx.createGain();
                level.gain.value = gain * (SAMPLE_GAIN[sample] ?? 0.8);
                source.connect(level).connect(sfxBus);
                source.start(ctx.currentTime + delay / 1000);
            }).catch(() => {});
        },
        synth(name, options = {}, delay = 0) {
            if (!sfxAllowed() || !synth[name]) return;
            try { synth[name](ctx.currentTime + 0.02 + delay / 1000, options); } catch (_) { /* optional */ }
        },
    };

    // -----------------------------------------------------------------------
    // Herald — the voiced Court Narrator
    // -----------------------------------------------------------------------
    const RAVEN_SVG = `
<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="st-raven-sheen" cx="40%" cy="30%" r="75%">
      <stop offset="0" stop-color="#3b3f5c"/><stop offset="0.55" stop-color="#15161f"/><stop offset="1" stop-color="#07070b"/>
    </radialGradient>
    <linearGradient id="st-raven-gold" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#fff1b8"/><stop offset="0.5" stop-color="#e3b44c"/><stop offset="1" stop-color="#9a6a1c"/>
    </linearGradient>
  </defs>
  <g class="st-raven">
    <path class="st-raven-tail" d="M40 100 L22 116 L48 108 Z" fill="#0b0b10"/>
    <path class="st-raven-body" d="M30 100 C27 76 41 57 61 55 C80 53 95 65 97 86 C98 94 95 101 90 106 L40 106 Z" fill="url(#st-raven-sheen)"/>
    <path class="st-raven-wing" d="M42 72 C55 64 77 66 88 84 C76 81 59 84 45 95 Z" fill="#232638"/>
    <path d="M48 80 C58 75 70 76 79 83" stroke="#3e4462" stroke-width="2" fill="none" stroke-linecap="round"/>
    <g class="st-raven-head">
      <circle cx="58" cy="44" r="21" fill="url(#st-raven-sheen)"/>
      <path class="st-raven-beak-top" d="M74 39 L103 47 L75 51 Z" fill="#2c2b33" stroke="#4b4a55" stroke-width="1"/>
      <g class="st-raven-jaw"><path d="M75 49.5 L98 50.5 L74 56 Z" fill="#1d1c22" stroke="#3d3c46" stroke-width="1"/></g>
      <g class="st-raven-eye">
        <circle cx="64" cy="40" r="5" fill="url(#st-raven-gold)"/>
        <circle cx="65" cy="40" r="2.3" fill="#120d05"/>
        <circle cx="63.4" cy="38.4" r="1" fill="#fff"/>
      </g>
      <path class="st-raven-brow" d="M57 31.5 L72 34" stroke="#e3b44c" stroke-width="2.6" stroke-linecap="round"/>
      <path class="st-raven-crown" d="M41 27 L44 13 L50 21 L56 8 L62 21 L68 13 L71 27 Z" fill="url(#st-raven-gold)" stroke="#6d4a10" stroke-width="1" transform="rotate(-14 56 26)"/>
      <circle cx="56" cy="16" r="1.8" fill="#c0392b" transform="rotate(-14 56 26)"/>
    </g>
  </g>
</svg>`;

    let manifest = null;
    let manifestPromise = null;
    let heraldEl = null;
    let heraldText = null;
    let currentSource = null;
    let current = null;
    let queue = [];
    let holdUntil = 0;
    let pumpTimer = null;
    let mouthFrame = null;
    let lastSpokeAt = 0;
    let hideTimer = null;
    const takeHistory = new Map();
    const MUSIC_DUCK = 0.38;

    function ensureHerald() {
        if (heraldEl) return;
        heraldEl = document.createElement('div');
        heraldEl.className = `st-herald st-herald-${PAGE}`;
        heraldEl.setAttribute('aria-live', 'polite');
        heraldEl.innerHTML = `
            <div class="st-herald-medallion">${RAVEN_SVG}</div>
            <div class="st-herald-scroll">
                <span class="st-herald-name">The Court Narrator</span>
                <p class="st-herald-text" data-i18n-skip></p>
            </div>`;
        heraldText = heraldEl.querySelector('.st-herald-text');
        document.body.appendChild(heraldEl);
    }

    function musicElement() {
        return PAGE === 'host' ? document.getElementById('host-music-player') : null;
    }
    function musicBaseVolume() {
        const slider = document.getElementById('host-music-volume');
        return slider ? Number(slider.value) / 100 : 0.34;
    }
    let duckTimer = null;
    function duck(on) {
        const element = musicElement();
        if (!element) return;
        clearInterval(duckTimer);
        const target = musicBaseVolume() * (on ? MUSIC_DUCK : 1);
        duckTimer = setInterval(() => {
            const delta = target - element.volume;
            if (Math.abs(delta) < 0.02) {
                element.volume = Math.max(0, Math.min(1, target));
                clearInterval(duckTimer);
            } else {
                element.volume = Math.max(0, Math.min(1, element.volume + delta * 0.25));
            }
        }, 40);
    }

    function pickTake(cue) {
        const ids = manifest?.cues?.[cue];
        if (!ids?.length) return null;
        const used = takeHistory.get(cue) || [];
        let options = ids.filter(id => !used.includes(id));
        if (!options.length) {
            options = ids.filter(id => id !== used[used.length - 1]);
            used.length = 0;
        }
        const choice = options[Math.floor(Math.random() * options.length)] || ids[0];
        used.push(choice);
        takeHistory.set(cue, used);
        return choice;
    }

    function captionFor(ids) {
        return ids.map(id => manifest?.clips?.[id]?.t || '').filter(Boolean).join(' ');
    }

    function voiceAllowed() {
        return settings.voice && ready() && manifest;
    }

    function showCaption(text, durationMs) {
        ensureHerald();
        clearTimeout(hideTimer);
        heraldText.replaceChildren();
        const words = text.split(/\s+/).filter(Boolean);
        const step = Math.max(60, Math.min(380, (durationMs * 0.92) / Math.max(1, words.length)));
        words.forEach((word, index) => {
            const span = document.createElement('span');
            span.textContent = `${word} `;
            span.style.animationDelay = `${Math.round(index * step)}ms`;
            heraldText.appendChild(span);
        });
        heraldEl.classList.toggle('captions-off', !settings.captions);
        heraldEl.classList.toggle('long', text.length > 120);
        heraldEl.classList.remove('leaving');
        heraldEl.classList.add('speaking', 'visible');
    }

    function hideCaption(after = 900) {
        if (!heraldEl) return;
        heraldEl.classList.remove('speaking');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            heraldEl.classList.add('leaving');
            hideTimer = setTimeout(() => heraldEl.classList.remove('visible', 'leaving'), 420);
        }, after);
    }

    function animateMouth() {
        cancelAnimationFrame(mouthFrame);
        const data = new Uint8Array(analyser.fftSize);
        let smooth = 0;
        const frame = () => {
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const v = (data[i] - 128) / 128;
                sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            smooth = smooth * 0.55 + Math.min(1, rms * 6) * 0.45;
            heraldEl?.style.setProperty('--jaw', smooth.toFixed(3));
            if (currentSource) mouthFrame = requestAnimationFrame(frame);
            else heraldEl?.style.setProperty('--jaw', '0');
        };
        mouthFrame = requestAnimationFrame(frame);
    }

    async function playItem(item) {
        current = item;
        const ids = item.ids.filter(id => manifest.clips[id]);
        if (!ids.length) {
            current = null;
            return pump();
        }
        let buffers;
        try {
            buffers = await Promise.all(ids.map(id => loadBuffer(`${manifest.base}${id}.mp3?v=${manifest.clips[id].h}`)));
        } catch (_) {
            current = null;
            return pump();
        }
        if (current !== item || !voiceAllowed()) {
            current = null;
            return pump();
        }
        const gap = 0.18;
        const total = buffers.reduce((sum, buffer) => sum + buffer.duration, 0) + gap * (buffers.length - 1);
        showCaption(item.caption || captionFor(ids), total * 1000);
        duck(true);
        item.onStart?.();
        let at = ctx.currentTime + 0.05;
        const sources = buffers.map(buffer => {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(voiceBus);
            source.start(at);
            at += buffer.duration + gap;
            return source;
        });
        currentSource = sources[sources.length - 1];
        currentSource.allSources = sources;
        animateMouth();
        lastSpokeAt = Date.now();
        currentSource.onended = () => {
            if (current !== item) return;
            currentSource = null;
            current = null;
            lastSpokeAt = Date.now();
            hideCaption(item.linger ?? 700);
            duck(false);
            item.onEnd?.();
            clearTimeout(pumpTimer);
            pumpTimer = setTimeout(pump, item.gapAfter ?? 450);
        };
    }

    function pump() {
        clearTimeout(pumpTimer);
        if (current || !queue.length) return;
        const now = Date.now();
        if (now < holdUntil && !queue.some(item => item.bypassHold)) {
            pumpTimer = setTimeout(pump, holdUntil - now + 20);
            return;
        }
        queue = queue.filter(item => item.expiresAt > now && (now >= holdUntil || item.bypassHold || item.expiresAt > holdUntil));
        if (!queue.length) return;
        queue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
        const nextIndex = now < holdUntil ? queue.findIndex(item => item.bypassHold) : 0;
        if (nextIndex < 0) {
            pumpTimer = setTimeout(pump, holdUntil - now + 20);
            return;
        }
        const [next] = queue.splice(nextIndex, 1);
        if (!voiceAllowed()) {
            queue = [];
            return;
        }
        playItem(next);
    }

    let sequence = 0;
    function enqueue(item) {
        if (!settings.voice) return null;
        if (!manifest) {
            Herald.loadManifest()?.then(() => enqueue(item));
            return null;
        }
        if (!ready()) return null;
        const now = Date.now();
        const entry = {
            priority: 50, ttl: 12000, tag: null, ...item,
            seq: ++sequence, expiresAt: now + (item.ttl ?? 12000) + (item.delay || 0),
        };
        if (entry.tag) queue = queue.filter(other => other.tag !== entry.tag);
        if (entry.interrupt && current) Herald.stop({ keepQueue: true });
        if (entry.delay) {
            setTimeout(() => {
                queue.push(entry);
                pump();
            }, entry.delay);
        } else {
            queue.push(entry);
            pump();
        }
        return entry;
    }

    // ----- Pacing ----------------------------------------------------------
    // The narrator should feel like a guest who chimes in, not a commentator
    // reading every event aloud.  "Key" beats always speak; everything else is
    // flavour that needs a quiet gap, fits a rolling budget and grows rarer
    // each time the same cue (or cue family) has been heard this game.
    const KEY_CUES = new Set([
        'start.opening', 'proposal.forced', 'rejection.4', 'score.decider', 'mission.5',
        'assassin.start', 'assassin.strike', 'assassin.hit', 'assassin.miss',
        'end.good', 'end.evil_missions', 'end.evil_assassin', 'end.evil_rejections', 'end.roles',
        'awards.intro', 'awards.outro', 'vote.tie', 'vote.unanimous_no',
        'quest.fail_many', 'rematch.lobby', 'lobby.welcome',
    ]);
    const PACE = {
        quiet: { gap: 40000, decay: 0.4, mult: 0.6, budget: 2 },
        normal: { gap: 18000, decay: 0.55, mult: 1, budget: 3 },
        chatty: { gap: 8000, decay: 0.8, mult: 1.35, budget: 6 },
    };
    const BUDGET_WINDOW_MS = 240000;
    let paceHeard = new Map();
    let paceLog = [];
    function paceProfile() {
        return PACE[settings.chatter] || PACE.normal;
    }
    function isKeyCue(cue, options) {
        if (options.pace) return options.pace === 'key';
        return KEY_CUES.has(cue) || cue.startsWith('award.') || cue.startsWith('mc.') || cue.startsWith('time.') || (options.priority || 0) >= 90;
    }
    function paceAllows(cue, options) {
        if (isKeyCue(cue, options)) return true;
        const profile = paceProfile();
        const now = Date.now();
        if (now - lastSpokeAt < (options.minGap ?? profile.gap)) return false;
        paceLog = paceLog.filter(at => now - at < BUDGET_WINDOW_MS);
        if (paceLog.length >= profile.budget) return false;
        const family = cue.split('.')[0];
        const own = paceHeard.get(cue) || 0;
        const kin = paceHeard.get(`#${family}`) || 0;
        const chance = Math.min(1, (options.chance ?? 1) * profile.mult)
            * profile.decay ** own * Math.sqrt(profile.decay) ** Math.max(0, kin - own);
        return Math.random() < chance;
    }
    const familyHeardAt = new Map();
    function paceNote(cue, key) {
        familyHeardAt.set(cue.split('.')[0], Date.now());
        paceHeard.set(cue, (paceHeard.get(cue) || 0) + 1);
        const family = `#${cue.split('.')[0]}`;
        paceHeard.set(family, (paceHeard.get(family) || 0) + 1);
        if (!key) paceLog.push(Date.now());
    }

    const Herald = {
        loadManifest() {
            if (manifest) return Promise.resolve(manifest);
            if (manifestPromise) return manifestPromise;
            manifestPromise = fetch(`/static/voice/manifest.json?v=${ASSET_VERSION}`, { credentials: 'same-origin' })
                .then(response => (response.ok ? response.json() : null))
                .then(data => {
                    manifest = data && data.clips ? data : null;
                    if (!manifest) manifestPromise = null;
                    return manifest;
                })
                .catch(() => { manifestPromise = null; return null; });
            return manifestPromise;
        },
        /** Speak one take of an event cue. Options: priority, chance, delay, ttl, tag, ifIdle, interrupt. */
        cue(cue, options = {}) {
            if (!settings.voice) return false;
            const key = isKeyCue(cue, options);
            if (key && options.chance != null && Math.random() > options.chance) return false;
            if (options.ifIdle && (current || queue.length || Date.now() - lastSpokeAt < (options.quietMs ?? 2500))) return false;
            if (!manifest) {
                Herald.loadManifest()?.then(data => { if (data) Herald.cue(cue, { ...options, chance: key ? null : options.chance }); });
                return false;
            }
            if (!manifest.cues?.[cue]?.length) return false;
            if (!options.unpaced && !paceAllows(cue, options)) return false;
            const id = pickTake(cue);
            if (!id) return false;
            const queued = Boolean(enqueue({ ...options, ids: [id], kind: 'cue', cue }));
            if (queued) paceNote(cue, key);
            return queued;
        },
        /** When a cue of this family (e.g. 'vote') was last queued. */
        lastFamilyAt(family) {
            return familyHeardAt.get(family) || 0;
        },
        /** Forget what has been heard (new game). */
        resetPacing() {
            paceHeard = new Map();
            paceLog = [];
        },
        /** Speak explicit clip ids (used for Court Narrator chat lines). */
        clips(ids, options = {}) {
            if (!Array.isArray(ids) || !ids.length) return false;
            return Boolean(enqueue({ priority: 40, ttl: 16000, ...options, ids, kind: 'narrator' }));
        },
        /** Delay new lines until a cinematic beat has landed. */
        hold(ms) {
            holdUntil = Math.max(holdUntil, Date.now() + ms);
        },
        release() {
            holdUntil = 0;
            pump();
        },
        hasPending(kind) {
            return queue.some(item => !kind || item.kind === kind) || Boolean(current && (!kind || current.kind === kind));
        },
        speaking() {
            return Boolean(current);
        },
        lastSpokeAt: () => lastSpokeAt,
        stop({ keepQueue = false } = {}) {
            if (!keepQueue) queue = [];
            const source = currentSource;
            current = null;
            currentSource = null;
            source?.allSources?.forEach(item => { try { item.stop(); } catch (_) { /* ended */ } });
            hideCaption(0);
            duck(false);
        },
        clear(tagOrKind) {
            queue = queue.filter(item => item.tag !== tagOrKind && item.kind !== tagOrKind);
        },
    };

    // -----------------------------------------------------------------------
    // Particles
    // -----------------------------------------------------------------------
    let canvas = null;
    let paint = null;
    let particles = [];
    let ambient = null;
    let ambientAccumulator = 0;
    let frameHandle = null;
    let lastFrame = 0;
    const PALETTES = {
        gold: ['#ffe9a3', '#f2c94c', '#d4a537', '#fff7dc', '#b8862b'],
        good: ['#ffe9a3', '#f2c94c', '#8fb8ff', '#4f7fd9', '#fff7dc'],
        evil: ['#ff5a4f', '#b3261e', '#3a0d0b', '#ff9a6b', '#5c1512'],
        ember: ['#ffb347', '#ff7b29', '#ffd27a', '#ff5a1f'],
        ash: ['#6d6464', '#4a4141', '#8a2e25', '#2d2626'],
        night: ['#cfe3ff', '#ffffff', '#a6c8ff', '#fff2c6'],
        magic: ['#c9b6ff', '#ffffff', '#8fe3ff', '#ffe9a3'],
    };

    function ensureCanvas() {
        if (canvas) return true;
        canvas = document.createElement('canvas');
        canvas.className = 'st-fx-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        document.body.appendChild(canvas);
        paint = canvas.getContext('2d');
        resize();
        window.addEventListener('resize', resize);
        return Boolean(paint);
    }
    function resize() {
        if (!canvas) return;
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(window.innerWidth * ratio);
        canvas.height = Math.round(window.innerHeight * ratio);
        paint.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    const pick = list => list[Math.floor(Math.random() * list.length)];
    const between = (a, b) => a + Math.random() * (b - a);
    const MAX_PARTICLES = 420;

    function spawn(kind, x, y, palette) {
        const W = window.innerWidth;
        const H = window.innerHeight;
        const colors = PALETTES[palette] || PALETTES.gold;
        switch (kind) {
        case 'confetti':
            return {
                kind, x: x ?? between(0, W), y: y ?? between(-H * 0.2, -10),
                vx: between(-60, 60), vy: between(40, 160), g: 140, drag: 0.6,
                w: between(6, 12), h: between(9, 18), rot: between(0, 6.28), vr: between(-7, 7),
                wobble: between(0, 6.28), life: between(4, 6.5), age: 0, color: pick(colors),
            };
        case 'burst': {
            const angle = between(0, Math.PI * 2);
            const speed = between(180, 620);
            return {
                kind: 'confetti', x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 180,
                g: 520, drag: 1.6, w: between(6, 11), h: between(8, 15), rot: between(0, 6.28),
                vr: between(-10, 10), wobble: between(0, 6.28), life: between(2.4, 4), age: 0, color: pick(colors),
            };
        }
        case 'sparkle': {
            const angle = between(0, Math.PI * 2);
            const speed = between(60, 360);
            return {
                kind, x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
                g: 40, drag: 2.4, size: between(1.5, 4.2), life: between(0.6, 1.4), age: 0, color: pick(colors),
            };
        }
        case 'ember':
            return {
                kind, x: x ?? between(0, W), y: y ?? H + 10, vx: between(-14, 14), vy: between(-70, -25),
                g: -4, drag: 0.1, size: between(1.2, 3.4), life: between(4, 9), age: 0,
                wobble: between(0, 6.28), color: pick(colors),
            };
        case 'ash':
            return {
                kind, x: x ?? between(0, W), y: y ?? between(-40, -5), vx: between(-20, 20), vy: between(20, 70),
                g: 6, drag: 0.2, size: between(1.5, 4.5), life: between(5, 10), age: 0,
                wobble: between(0, 6.28), color: pick(colors),
            };
        case 'mote':
            return {
                kind: 'ember', x: x ?? between(0, W), y: y ?? between(0, H), vx: between(-8, 8), vy: between(-14, -4),
                g: 0, drag: 0, size: between(0.8, 2.2), life: between(6, 12), age: 0,
                wobble: between(0, 6.28), color: pick(colors),
            };
        case 'firefly':
            return {
                kind, x: x ?? between(0, W), y: y ?? between(H * 0.3, H), vx: between(-12, 12), vy: between(-10, 10),
                g: 0, drag: 0, size: between(1.6, 3), life: between(5, 9), age: 0,
                wobble: between(0, 6.28), color: pick(colors),
            };
        default:
            return null;
        }
    }

    function tick(now) {
        const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000);
        lastFrame = now;
        const W = window.innerWidth;
        const H = window.innerHeight;
        paint.clearRect(0, 0, W, H);
        if (ambient && !reducedMotion.matches && document.visibilityState === 'visible') {
            ambientAccumulator += dt * ambient.rate;
            while (ambientAccumulator > 1 && particles.length < MAX_PARTICLES) {
                ambientAccumulator -= 1;
                const p = spawn(ambient.kind, undefined, undefined, ambient.palette);
                if (p) particles.push(p);
            }
        }
        particles = particles.filter(p => (p.age += dt) < p.life && p.y < H + 80 && p.y > -H);
        for (const p of particles) {
            p.vy += p.g * dt;
            p.vx -= p.vx * p.drag * dt;
            p.vy -= p.vy * p.drag * dt * (p.kind === 'confetti' ? 0.6 : 1);
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            const fade = Math.min(1, (p.life - p.age) / 0.8, p.age / 0.25);
            paint.globalAlpha = Math.max(0, fade);
            if (p.kind === 'confetti') {
                p.rot += p.vr * dt;
                p.wobble += dt * 6;
                paint.save();
                paint.translate(p.x + Math.sin(p.wobble) * 6, p.y);
                paint.rotate(p.rot);
                paint.scale(1, Math.cos(p.wobble));
                paint.fillStyle = p.color;
                paint.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                paint.restore();
            } else {
                p.wobble = (p.wobble || 0) + dt * 1.6;
                const x = p.x + Math.sin(p.wobble) * (p.kind === 'firefly' ? 14 : 5);
                const glow = p.kind === 'firefly' ? 0.5 + 0.5 * Math.sin(p.age * 3.2) : 1;
                paint.globalAlpha *= glow;
                paint.fillStyle = p.color;
                paint.shadowColor = p.color;
                paint.shadowBlur = p.kind === 'ash' ? 0 : p.size * 4;
                paint.beginPath();
                paint.arc(x, p.y, p.size, 0, Math.PI * 2);
                paint.fill();
                paint.shadowBlur = 0;
            }
        }
        paint.globalAlpha = 1;
        if (particles.length || ambient) frameHandle = requestAnimationFrame(tick);
        else {
            frameHandle = null;
            lastFrame = 0;
        }
    }
    function run() {
        if (!frameHandle && ensureCanvas()) frameHandle = requestAnimationFrame(tick);
    }

    const Fx = {
        burst(kind = 'confetti', { x, y, count = 120, palette = 'gold' } = {}) {
            if (!ensureCanvas()) return;
            const scale = reducedMotion.matches ? 0.15 : (PAGE === 'player' ? 0.5 : 1);
            const total = Math.round(count * scale);
            const W = window.innerWidth;
            const H = window.innerHeight;
            for (let i = 0; i < total && particles.length < MAX_PARTICLES; i++) {
                const p = spawn(kind, x ?? (kind === 'confetti' ? undefined : W / 2), y ?? (kind === 'confetti' ? undefined : H / 2), palette);
                if (p) particles.push(p);
            }
            run();
        },
        cannons(palette = 'gold') {
            const W = window.innerWidth;
            const H = window.innerHeight;
            Fx.burst('burst', { x: W * 0.08, y: H * 0.92, count: 90, palette });
            Fx.burst('burst', { x: W * 0.92, y: H * 0.92, count: 90, palette });
            setTimeout(() => Fx.burst('confetti', { count: 140, palette }), 260);
        },
        sparkleAt(element, palette = 'gold', count = 26) {
            const rect = element?.getBoundingClientRect?.();
            if (!rect) return;
            Fx.burst('sparkle', { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, count, palette });
        },
        ambient(kind, { rate = 6, palette } = {}) {
            if (!kind) {
                ambient = null;
                return;
            }
            const defaults = { ember: 'ember', mote: 'gold', firefly: 'night', ash: 'ash' };
            ambient = { kind, rate: PAGE === 'player' ? rate * 0.4 : rate, palette: palette || defaults[kind] || 'gold' };
            if (ensureCanvas()) run();
        },
        clear() {
            particles = [];
            ambient = null;
        },
        shake(strength = 'medium') {
            if (reducedMotion.matches) return;
            const app = document.getElementById('app') || document.body;
            app.classList.remove('st-shake-light', 'st-shake-medium', 'st-shake-heavy');
            void app.offsetWidth;
            app.classList.add(`st-shake-${strength}`);
            setTimeout(() => app.classList.remove(`st-shake-${strength}`), 700);
        },
        pulse(element, className = 'st-pop') {
            if (!element) return;
            element.classList.remove(className);
            void element.offsetWidth;
            element.classList.add(className);
            setTimeout(() => element.classList.remove(className), 900);
        },
    };

    // -----------------------------------------------------------------------
    // Title cards and announcements
    // -----------------------------------------------------------------------
    let titleEl = null;
    let titleTimer = null;
    function titleCard({ eyebrow = '', title = '', subtitle = '', tone = 'gold', duration = 2300, sound = 'hit-big' } = {}) {
        if (!titleEl) {
            titleEl = document.createElement('div');
            titleEl.className = 'st-title-card';
            titleEl.setAttribute('aria-hidden', 'true');
            titleEl.innerHTML = `
                <div class="st-title-rays"></div>
                <div class="st-title-banner">
                    <span class="st-title-eyebrow"></span>
                    <strong class="st-title-main"></strong>
                    <span class="st-title-sub"></span>
                    <i class="st-title-flourish" aria-hidden="true"></i>
                </div>`;
            document.body.appendChild(titleEl);
        }
        clearTimeout(titleTimer);
        titleEl.className = `st-title-card tone-${tone}`;
        titleEl.querySelector('.st-title-eyebrow').textContent = eyebrow;
        titleEl.querySelector('.st-title-main').textContent = title;
        titleEl.querySelector('.st-title-sub').textContent = subtitle;
        window.AvalonI18n?.refresh?.([titleEl]);
        void titleEl.offsetWidth;
        titleEl.classList.add('visible');
        if (sound) Sfx.play(sound);
        Sfx.synth('whoosh', { gain: 0.25, length: 0.4 });
        const hold = reducedMotion.matches ? Math.min(duration, 1400) : duration;
        titleTimer = setTimeout(() => {
            titleEl.classList.add('leaving');
            titleTimer = setTimeout(() => titleEl.classList.remove('visible', 'leaving'), 520);
        }, hold);
    }

    let announceStack = null;
    function announce({ icon = '⚔', title = '', detail = '', tone = 'gold', duration = 3400 } = {}) {
        if (!announceStack) {
            announceStack = document.createElement('div');
            announceStack.className = 'st-announce-stack';
            announceStack.setAttribute('aria-live', 'polite');
            document.body.appendChild(announceStack);
        }
        const item = document.createElement('div');
        item.className = `st-announce tone-${tone}`;
        const iconEl = document.createElement('span');
        iconEl.className = 'st-announce-icon';
        iconEl.textContent = icon;
        const copy = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = title;
        strong.dataset.i18nSkip = '';
        const small = document.createElement('small');
        small.textContent = detail;
        copy.append(strong, small);
        item.append(iconEl, copy);
        announceStack.appendChild(item);
        while (announceStack.children.length > 3) announceStack.firstElementChild.remove();
        requestAnimationFrame(() => item.classList.add('visible'));
        setTimeout(() => {
            item.classList.add('leaving');
            setTimeout(() => item.remove(), 520);
        }, duration);
    }

    function stamp(text, tone = 'gold') {
        const element = document.createElement('div');
        element.className = `st-stamp tone-${tone}`;
        element.textContent = text;
        document.body.appendChild(element);
        Sfx.play('stamp');
        setTimeout(() => element.remove(), 1600);
    }

    // -----------------------------------------------------------------------
    // Royal Honours (end-of-game awards) from the public summary only.
    // -----------------------------------------------------------------------
    function computeAwards(summary, observedBallots = []) {
        const players = summary.players || [];
        const names = players.map(player => player.name);
        if (names.length < 2) return [];
        const byName = new Map(players.map(player => [player.name, player]));
        const teamOf = name => byName.get(name)?.team || summary.roles?.[name]?.team;
        const approve = new Map(names.map(name => [name, 0]));
        const reject = new Map(names.map(name => [name, 0]));
        const ballots = new Map(names.map(name => [name, 0]));
        const rejectedLeads = new Map();
        // Individual ballots are not kept in the stored history; the page passes
        // the public reveals it witnessed during this game (memory only).
        const witnessed = new Map((observedBallots || []).map(item => [`${item.mission_num}:${item.attempt}`, item.votes]));
        (summary.proposal_history || []).forEach(proposal => {
            const votes = proposal.votes || witnessed.get(`${proposal.mission_num}:${proposal.attempt}`) || {};
            Object.entries(votes).forEach(([name, vote]) => {
                if (!ballots.has(name)) return;
                ballots.set(name, ballots.get(name) + 1);
                (vote === 'approve' ? approve : reject).set(name, (vote === 'approve' ? approve : reject).get(name) + 1);
            });
            if (proposal.approved === false && proposal.leader_name) {
                rejectedLeads.set(proposal.leader_name, (rejectedLeads.get(proposal.leader_name) || 0) + 1);
            }
        });
        const quests = new Map(names.map(name => [name, 0]));
        const failedQuests = new Map();
        const passedQuests = new Map();
        const ledWins = new Map();
        const missions = summary.mission_history || [];
        missions.forEach(mission => {
            (mission.team || []).forEach(name => {
                quests.set(name, (quests.get(name) || 0) + 1);
                const bucket = mission.passed ? passedQuests : failedQuests;
                bucket.set(name, (bucket.get(name) || 0) + 1);
            });
            if (mission.passed && mission.leader_name) ledWins.set(mission.leader_name, (ledWins.get(mission.leader_name) || 0) + 1);
        });
        const best = (map, filter = () => true, min = 1) => {
            let top = null;
            map.forEach((value, name) => {
                if (!filter(name) || value < min) return;
                if (!top || value > top.value) top = { name, value };
            });
            return top;
        };
        const candidates = [];
        const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
        const trusting = (() => {
            let top = null;
            names.forEach(name => {
                const total = ballots.get(name);
                if (total < 3) return;
                const ratio = approve.get(name) / total;
                if (ratio >= 0.7 && (!top || ratio > top.ratio || (ratio === top.ratio && total > top.total))) top = { name, ratio, total };
            });
            return top;
        })();
        if (trusting) candidates.push({ cue: 'award.trusting', icon: '🐕', title: 'The Golden Retriever', name: trusting.name, stat: `Approved ${approve.get(trusting.name)} of ${trusting.total} parties`, weight: 3 });
        const skeptic = best(reject, () => true, 3);
        if (skeptic) candidates.push({ cue: 'award.skeptic', icon: '🏰', title: 'The Drawbridge', name: skeptic.name, stat: `Rejected ${skeptic.value} ${skeptic.value === 1 ? 'party' : 'parties'}`, weight: 3 });
        const traveller = best(quests, () => true, Math.max(2, Math.ceil(missions.length * 0.6)));
        if (traveller) candidates.push({ cue: 'award.traveller', icon: '🗺', title: 'Most Well-Travelled', name: traveller.name, stat: `Rode on ${plural(traveller.value, 'quest')}`, weight: 2 });
        if (missions.length >= 3) {
            const homebody = names.filter(name => (quests.get(name) || 0) === 0);
            if (homebody.length === 1) candidates.push({ cue: 'award.homebody', icon: '🔥', title: 'The Homebody', name: homebody[0], stat: 'Never left the castle', weight: 2 });
        }
        const saboteur = best(failedQuests, name => teamOf(name) === 'evil', 1);
        if (saboteur) candidates.push({ cue: 'award.saboteur', icon: '🗡', title: 'Master Saboteur', name: saboteur.name, stat: `Present at ${plural(saboteur.value, 'failed quest')}`, weight: 4, tone: 'evil' });
        const poker = best(passedQuests, name => teamOf(name) === 'evil', 1);
        if (poker && poker.name !== saboteur?.name) candidates.push({ cue: 'award.poker_face', icon: '🎭', title: 'Best Poker Face', name: poker.name, stat: `Evil, yet trusted on ${plural(poker.value, 'successful quest')}`, weight: 4, tone: 'evil' });
        const unlucky = best(rejectedLeads, () => true, 2);
        if (unlucky) candidates.push({ cue: 'award.unlucky_leader', icon: '👑', title: 'Rejected Royalty', name: unlucky.name, stat: `${plural(unlucky.value, 'proposal')} turned down`, weight: 2 });
        const kingmaker = best(ledWins, () => true, 2);
        if (kingmaker) candidates.push({ cue: 'award.kingmaker', icon: '⚜', title: 'The Kingmaker', name: kingmaker.name, stat: `Led ${plural(kingmaker.value, 'successful quest')}`, weight: 2 });

        // Choose up to three distinct recipients, favouring the funniest awards.
        candidates.sort((a, b) => b.weight - a.weight || Math.random() - 0.5);
        const chosen = [];
        const used = new Set();
        for (const award of candidates) {
            if (chosen.length >= 3) break;
            if (used.has(award.name)) continue;
            used.add(award.name);
            chosen.push(award);
        }
        const roleName = role => Object.entries(summary.roles || {}).find(([, info]) => (info.role || info) === role)?.[0];
        if (summary.win_reason === 'assassination_failed') {
            const merlin = roleName('Merlin');
            if (merlin) chosen.push({ cue: 'award.merlin', icon: '🔮', title: 'Survivor of the Blade', name: merlin, stat: 'Merlin, undiscovered', weight: 9, tone: 'good' });
        } else if (summary.win_reason === 'assassination') {
            const assassin = roleName('Assassin');
            if (assassin) chosen.push({ cue: 'award.assassin', icon: '🎯', title: 'The Perfect Aim', name: assassin, stat: 'Found Merlin', weight: 9, tone: 'evil' });
        }
        return chosen.map(award => ({ ...award, player: byName.get(award.name) || { name: award.name } }));
    }

    // -----------------------------------------------------------------------
    // Settings UI helpers (pages decide where to mount them).
    // -----------------------------------------------------------------------
    function buildSettingsSection({ compact = false } = {}) {
        const section = document.createElement('section');
        section.className = `st-settings${compact ? ' compact' : ''}`;
        section.innerHTML = compact ? `
            <label class="st-toggle"><input type="checkbox" data-st-setting="sound"><span><strong>Narrator &amp; sound on this phone</strong><small>For games without a shared TV. Usually leave this off.</small></span></label>
            <label class="st-range"><span>Volume</span><input type="range" min="0" max="100" step="1" data-st-setting="voiceVolume"></label>
        ` : `
            <label class="st-toggle"><input type="checkbox" data-st-setting="voice"><span><strong>Narrator voice</strong><small>The Court Narrator speaks on this display</small></span></label>
            <label class="st-toggle"><input type="checkbox" data-st-setting="sfx"><span><strong>Sound effects</strong><small>Cards, drums, fanfares</small></span></label>
            <label class="st-toggle"><input type="checkbox" data-st-setting="captions"><span><strong>Captions</strong><small>Show the narrator's words</small></span></label>
            <label class="st-select"><span><strong>Narrator chattiness</strong><small>How often he jokes between announcements</small></span><select data-st-setting="chatter"><option value="quiet">Quiet</option><option value="normal">Normal</option><option value="chatty">Chatty</option></select></label>
            <label class="st-range"><span>Voice volume</span><input type="range" min="0" max="100" step="1" data-st-setting="voiceVolume"></label>
            <label class="st-range"><span>Effects volume</span><input type="range" min="0" max="100" step="1" data-st-setting="sfxVolume"></label>
            <button type="button" class="btn st-test-voice">Test the narrator</button>
        `;
        const sync = () => {
            section.querySelectorAll('[data-st-setting]').forEach(input => {
                const key = input.dataset.stSetting;
                if (key === 'sound') input.checked = settings.voice && settings.sfx;
                else if (input.tagName === 'SELECT') input.value = String(settings[key] || 'normal');
                else if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
                else input.value = String(settings[key]);
            });
        };
        section.addEventListener('input', event => {
            const input = event.target.closest('[data-st-setting]');
            if (!input) return;
            const key = input.dataset.stSetting;
            if (key === 'sound') saveSettings({ voice: input.checked, sfx: input.checked });
            else if (input.tagName === 'SELECT') saveSettings({ [key]: input.value });
            else if (input.type === 'checkbox') saveSettings({ [key]: input.checked });
            else saveSettings({ [key]: Number(input.value) });
            if (input.type === 'checkbox' && input.checked) {
                unlock();
                window.setTimeout(() => Sfx.play('j-ready'), 120);
            }
        });
        section.querySelector('.st-test-voice')?.addEventListener('click', () => {
            unlock();
            Herald.loadManifest().then(() => Herald.cue('lobby.join', { priority: 90, interrupt: true, unpaced: true }));
        });
        listeners.add(sync);
        sync();
        return section;
    }

    // Ballots seen at public vote reveals during the current game (memory only).
    let ballots = [];
    let ballotMission = 1;
    let ballotAttempt = 1;
    function attachBallotRecorder(io) {
        io.on('round_start', data => {
            ballotMission = Number(data.mission_num) || 1;
            ballotAttempt = (Number(data.reject_count) || 0) + 1;
            if (ballotMission === 1 && ballotAttempt === 1) ballots = [];
        });
        io.on('rejection_warning', data => { ballotAttempt = (Number(data.consecutive) || 0) + 1; });
        io.on('vote_reveal', data => {
            if (data && data.votes) ballots.push({ mission_num: ballotMission, attempt: ballotAttempt, votes: { ...data.votes } });
        });
        io.on('return_to_lobby', () => { ballots = []; });
        io.on('game_ended', () => { ballots = []; });
    }

    // -----------------------------------------------------------------------
    // "Who are we waiting on?" — public waiting list + host force-continue
    // -----------------------------------------------------------------------
    const STAGE_TEXT = {
        opening: 'to enter Avalon',
        night: 'to confirm their role',
        mission_intro: 'to enter the quest',
        mission_cards: 'to play a quest card',
        vote: 'to vote',
        vote_reveal: 'to continue',
        mission_reveal: 'to continue',
    };
    const FORCE_TEXT = {
        opening: 'Start the night without them',
        night: 'End the night without them',
        mission_intro: 'Open the quest without them',
        vote_reveal: 'Continue without them',
        mission_reveal: 'Continue without them',
    };
    let waitData = null;
    let waitReceivedAt = 0;
    let waitStageSince = 0;
    let waitStageKey = '';
    let waitOpts = { myId: () => null, isHost: () => false };
    let waitPill = null;
    let waitTimer = null;
    const flowCards = new Set();

    function nameList(pending) {
        const shown = pending.slice(0, 4).map(item => `<span class="st-wait-name${item.connected ? '' : ' offline'}" data-i18n-skip>${escapeText(item.name)}${item.connected ? '' : ' <em>offline</em>'}</span>`);
        if (pending.length > 4) shown.push(`<span class="st-wait-more">+${pending.length - 4} more</span>`);
        return shown.join('');
    }
    function escapeText(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    function forceReadyIn() {
        if (!waitData || waitData.force_in_seconds == null) return Infinity;
        return Math.max(0, waitData.force_in_seconds * 1000 - (Date.now() - waitReceivedAt));
    }
    function renderWaiting() {
        clearTimeout(waitTimer);
        const data = waitData;
        const pending = (data && data.pending) || [];
        const myId = waitOpts.myId();
        const mine = myId && pending.some(item => item.player_id === myId);
        const age = Date.now() - waitStageSince;
        const quickStage = data && (data.stage === 'vote' || data.stage === 'mission_cards');
        // Show once it is genuinely a wait: a few names left, or a while passed.
        const worth = pending.length && (pending.length <= 3 || age > 10000) && !(quickStage && pending.length > 3);
        if (!waitPill) {
            waitPill = document.createElement('div');
            waitPill.className = `st-waiting st-waiting-${PAGE}`;
            waitPill.setAttribute('role', 'status');
            waitPill.setAttribute('aria-live', 'polite');
            document.body.appendChild(waitPill);
        }
        if (!data || !data.stage || !worth || mine) {
            waitPill.classList.remove('visible');
        } else {
            const offline = pending.some(item => !item.connected);
            const hostHint = offline && waitOpts.isHost() && FORCE_TEXT[data.stage] && age > 20000;
            waitPill.innerHTML = `<span class="st-wait-label">Waiting on</span>${nameList(pending)}<span class="st-wait-stage">${STAGE_TEXT[data.stage] || ''}</span>${hostHint ? '<span class="st-wait-hint">Host: Settings &rsaquo; Force continue</span>' : ''}`;
            waitPill.classList.add('visible');
        }
        flowCards.forEach(update => update());
        if (data && data.stage && pending.length) waitTimer = setTimeout(renderWaiting, forceReadyIn() < 30000 ? 1000 : 2500);
    }
    function setWaiting(data) {
        const key = data && data.stage ? `${data.stage}:${data.mission_num}` : '';
        if (key !== waitStageKey) {
            waitStageKey = key;
            waitStageSince = Date.now();
        }
        waitData = data && data.stage ? data : null;
        waitReceivedAt = Date.now();
        renderWaiting();
    }
    function attachWaiting(io, opts = {}) {
        waitOpts = { ...waitOpts, ...opts };
        io.on('waiting_status', setWaiting);
        io.on('state_snapshot', snap => setWaiting(snap && snap.waiting));
        io.on('host_registered', data => setWaiting(data && data.waiting));
        io.on('game_over', () => setWaiting(null));
        io.on('return_to_lobby', () => setWaiting(null));
        io.on('game_ended', () => setWaiting(null));
        io.on('flow_forced', data => {
            const names = (data && data.skipped_names) || [];
            announce({ icon: '⏩', title: 'The host rides on', detail: names.length ? `Continuing without ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}` : '', tone: 'royal' });
        });
    }
    /** Host-only "Game flow" card for a Settings panel. */
    function buildFlowCard({ onForce, visible = () => true } = {}) {
        const card = document.createElement('section');
        card.className = 'st-flow-card';
        card.innerHTML = `
            <div class="st-flow-head"><strong>Game flow</strong><small>Stuck waiting on someone? Continue without them.</small></div>
            <div class="st-flow-status" aria-live="polite"></div>
            <button type="button" class="btn st-flow-force" disabled>Force continue</button>
            <small class="st-flow-note">Skips confirmations only. Votes and quest cards always wait for their player.</small>`;
        const status = card.querySelector('.st-flow-status');
        const button = card.querySelector('.st-flow-force');
        const update = () => {
            card.hidden = !visible();
            const data = waitData;
            const pending = (data && data.pending) || [];
            if (!data || !pending.length) {
                status.textContent = 'Nobody is holding up the table.';
                button.disabled = true;
                button.textContent = 'Force continue';
                return;
            }
            status.innerHTML = `Waiting on ${nameList(pending)} <span class="st-wait-stage">${STAGE_TEXT[data.stage] || ''}</span>`;
            if (!data.forceable) {
                button.disabled = true;
                button.textContent = data.stage === 'vote' ? 'Votes cannot be skipped' : 'Quest cards cannot be skipped';
                return;
            }
            const wait = forceReadyIn();
            button.disabled = wait > 0;
            button.textContent = wait > 0 ? `Force continue (${Math.ceil(wait / 1000)}s)` : (FORCE_TEXT[data.stage] || 'Force continue');
        };
        button.addEventListener('click', () => {
            const data = waitData;
            if (!data || !data.forceable) return;
            const names = (data.pending || []).map(item => item.name);
            const message = `Continue without ${names.join(', ')}? They will catch up on the next screen.`;
            if (!window.confirm(message)) return;
            button.disabled = true;
            onForce?.(data);
        });
        flowCards.add(update);
        update();
        return card;
    }

    window.AvalonShowtime = Object.freeze({
        attachWaiting,
        buildFlowCard,
        waiting: () => waitData,
        attachBallotRecorder,
        ballots: () => ballots.slice(),
        page: PAGE,
        settings: () => ({ ...settings }),
        saveSettings,
        onSettings: fn => listeners.add(fn),
        unlock,
        ready,
        herald: Herald,
        sfx: Sfx,
        fx: Fx,
        titleCard,
        announce,
        stamp,
        computeAwards,
        buildSettingsSection,
        reducedMotion: () => reducedMotion.matches,
    });
    if (settings.voice) Herald.loadManifest();
}());
