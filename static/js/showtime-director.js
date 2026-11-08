/* ============================================================
   AVALON — Showtime director.

   Decides *when* the Court Narrator speaks, using only the public events
   this page already receives. Visual timing that depends on a specific
   animation (vote flips, quest cards, awards) lives in host.js/player.js.
   ============================================================ */
(function () {
    'use strict';
    const S = window.AvalonShowtime;
    if (!S || typeof socket === 'undefined') return;
    const H = S.herald;
    const host = S.page === 'host';
    S.attachBallotRecorder(socket);

    const state = {
        names: new Set(),
        roomCode: null,
        welcomedRoom: null,
        enoughSaid: false,
        allReadySaid: false,
        lastJoinLineAt: 0,
        missionNum: 0,
        phaseTimers: new Map(),
        votePending: 0,
        gameOverAt: 0,
        instantRematchSaid: false,
        lastNarratorVoiceAt: 0,
        inLobby: false,
        rejections: 0,
    };

    function timer(key, ms, fn) {
        clearTimeout(state.phaseTimers.get(key));
        state.phaseTimers.set(key, setTimeout(() => {
            state.phaseTimers.delete(key);
            fn();
        }, ms));
    }
    function clearTimer(...keys) {
        keys.forEach(key => {
            clearTimeout(state.phaseTimers.get(key));
            state.phaseTimers.delete(key);
        });
    }
    function clearAllTimers() {
        state.phaseTimers.forEach(handle => clearTimeout(handle));
        state.phaseTimers.clear();
    }

    // ----- Lobby -------------------------------------------------------------
    function enterLobby(code, players, { welcome = true } = {}) {
        state.inLobby = true;
        state.roomCode = code;
        state.names = new Set((players || []).map(player => player.name));
        if (host && welcome && state.welcomedRoom !== code) {
            state.welcomedRoom = code;
            H.cue('lobby.welcome', { priority: 70, delay: 1400 });
        }
        state.enoughSaid = state.names.size >= 6;
        state.allReadySaid = false;
        scheduleIdle();
    }

    function scheduleIdle() {
        clearTimer('idle');
        if (!state.inLobby || state.names.size < 6) return;
        timer('idle', 150000, () => {
            if (state.inLobby) H.cue('lobby.idle', { priority: 30, ifIdle: true });
        });
    }

    function lobbyPlayers(players, { announceJoins = true } = {}) {
        if (!Array.isArray(players)) return;
        const next = new Set(players.map(player => player.name));
        const joined = players.filter(player => !state.names.has(player.name) && !player.is_bot);
        state.names = next;
        if (!state.inLobby) return;
        if (host && announceJoins && joined.length) {
            joined.slice(0, 3).forEach((player, index) => {
                setTimeout(() => {
                    S.announce({ icon: '⚔', title: player.name, detail: 'has entered the hall', tone: 'gold' });
                    S.sfx.play('j-join', { gain: 0.8 });
                    S.sfx.play('door-open', { gain: 0.45, delay: 60 });
                }, index * 450);
            });
            const now = Date.now();
            if (now - state.lastJoinLineAt > 9000 && !(next.size >= 6 && !state.enoughSaid)) {
                if (H.cue('lobby.join', { priority: 35, chance: 0.6, ifIdle: true, quietMs: 1500, delay: 700 })) {
                    state.lastJoinLineAt = now;
                }
            }
        }
        if (next.size >= 6 && !state.enoughSaid) {
            state.enoughSaid = true;
            H.cue('lobby.enough', { priority: 60, delay: 900 });
        }
        const readyCount = players.filter(player => player.ready).length;
        if (players.length >= 6 && readyCount === players.length && !state.allReadySaid) {
            state.allReadySaid = true;
            H.cue('lobby.all_ready', { priority: 55, delay: 500 });
        } else if (readyCount < players.length) {
            state.allReadySaid = false;
        }
        scheduleIdle();
    }

    socket.on('host_registered', data => {
        if (data.phase === 'LOBBY') enterLobby(data.code, data.players);
        else state.inLobby = false;
    });
    socket.on('join_success', data => {
        enterLobby(data.room_code, data.players, { welcome: false });
    });
    socket.on('player_joined', data => lobbyPlayers(data.players));
    socket.on('lobby_update', data => lobbyPlayers(data.players, { announceJoins: false }));

    // ----- Opening and night ------------------------------------------------------
    socket.on('game_starting', () => {
        state.inLobby = false;
        clearAllTimers();
        H.stop();
        S.sfx.play('hit-big');
        S.sfx.synth('gong', { gain: 0.32 }, 120);
        H.cue('start.opening', { priority: 90, delay: 1100 });
    });
    socket.on('night_phase_start', () => {
        S.sfx.play('j-magic');
        S.sfx.synth('shimmer', { gain: 0.1 }, 200);
        H.cue('night.intro', { priority: 85, delay: 900 });
    });
    socket.on('night_phase_complete', () => {
        H.cue('night.complete', { priority: 50, chance: 0.6, ifIdle: true });
    });

    // ----- Missions, leaders, discussion -------------------------------------------
    socket.on('round_start', data => {
        clearTimer('proposal-slow', 'vote-stragglers');
        const mission = Number(data.mission_num) || 1;
        const rejects = Number(data.reject_count) || 0;
        if (mission !== state.missionNum && rejects === 0) {
            state.missionNum = mission;
            H.cue(`mission.${mission}`, { priority: 80, delay: host ? 1500 : 500, tag: 'mission-intro' });
            const results = data.mission_results || [];
            const good = results.filter(item => item === 'pass').length;
            const evil = results.filter(item => item === 'fail').length;
            const score = good === 2 && evil === 0 ? 'score.good_two'
                : evil === 2 && good === 0 ? 'score.evil_two'
                    : good === 2 && evil === 2 ? 'score.decider' : null;
            if (score && Date.now() - state.lastNarratorVoiceAt > 20000) {
                H.cue(score, { priority: 45, chance: 0.75, delay: host ? 1600 : 600 });
            }
        }
        state.rejections = rejects;
    });
    socket.on('rejection_warning', data => {
        state.rejections = Number(data.consecutive) || 0;
    });

    socket.on('discussion_start', data => {
        if (Number(data.duration_seconds) === 0) return;
        H.cue('discussion.start', { priority: 30, chance: 0.4, ifIdle: true, quietMs: 3000, delay: 1800 });
    });
    socket.on('discussion_tick', data => {
        const remaining = Number(data.remaining_seconds);
        if (remaining === 10) H.cue('discussion.final10', { priority: 72, chance: 0.85 });
        if (host && remaining <= 10 && remaining > 0) {
            S.sfx.synth('tick', { gain: remaining <= 3 ? 0.32 : 0.2, high: remaining <= 3 });
            if (remaining <= 5) S.sfx.synth('heartbeat', { gain: 0.5 + (5 - remaining) * 0.08, beats: 1 }, 380);
        }
    });
    socket.on('discussion_end', () => {
        if (host) S.sfx.play('bell', { gain: 0.9 });
        H.cue('discussion.over', { priority: 40, chance: 0.45, ifIdle: true, quietMs: 1500 });
    });

    // ----- Proposal and vote -------------------------------------------------------
    socket.on('proposal_start', data => {
        clearTimer('vote-stragglers');
        if (data.forced) {
            H.cue('proposal.forced', { priority: 88, delay: 500 });
        } else if (state.rejections === 3) {
            H.cue('rejection.3', { priority: 70, delay: 700 });
        } else if (state.rejections > 0) {
            H.cue('leader.new', { priority: 40, chance: 0.55, ifIdle: true, quietMs: 2000, delay: 700 });
        } else {
            H.cue('proposal.start', { priority: 35, chance: 0.5, ifIdle: true, quietMs: 3500, delay: 900 });
        }
        timer('proposal-slow', 55000, () => H.cue('proposal.slow', { priority: 45, ifIdle: true }));
    });
    socket.on('proposal_timer_expired', () => {
        H.cue('proposal.slow', { priority: 50, chance: 0.7, ifIdle: true });
    });
    socket.on('team_proposed', () => clearTimer('proposal-slow'));
    socket.on('vote_start', () => {
        clearTimer('proposal-slow');
        state.votePending = Infinity;
        H.cue('vote.start', { priority: 60, delay: host ? 1200 : 300, ttl: 6000 });
        timer('vote-stragglers', 24000, () => {
            if (state.votePending > 0) H.cue('vote.stragglers', { priority: 50, ifIdle: true });
        });
    });
    socket.on('vote_waiting', data => {
        state.votePending = (data.remaining || []).length;
        if (host) S.sfx.play('place', { gain: 0.8 });
    });
    socket.on('vote_reveal', () => {
        clearTimer('vote-stragglers');
        H.clear('cue');
    });

    // ----- Quest -----------------------------------------------------------
    socket.on('mission_start', () => {
        state.rejections = 0;
        clearTimer('proposal-slow', 'vote-stragglers');
        S.sfx.play('hit-short');
        S.sfx.synth('whoosh', { gain: 0.3 }, 80);
        H.cue('quest.begins', { priority: 70, delay: 900, ttl: 8000 });
    });
    socket.on('mission_waiting', () => {
        if (host) S.sfx.play('place', { gain: 0.9 });
    });
    socket.on('mission_choices_open', () => {
        // Players are choosing; stay quiet so nobody gets a tell from timing.
    });

    // ----- Assassin and finale ------------------------------------------------------
    socket.on('assassin_phase_start', () => {
        clearAllTimers();
        S.sfx.play('j-sinister');
        S.sfx.synth('heartbeat', { gain: 0.7, beats: 3 }, 600);
        H.cue('assassin.start', { priority: 92, delay: host ? 1500 : 400, interrupt: true });
        timer('assassin-slow', 45000, () => H.cue('assassin.slow', { priority: 60, ifIdle: true }));
    });
    socket.on('assassination_result', () => {
        clearTimer('assassin-slow');
        H.stop();
        S.sfx.play('blade');
        S.sfx.play('slash', { delay: 420 });
    });

    socket.on('game_over', data => {
        clearAllTimers();
        state.gameOverAt = Date.now();
        state.instantRematchSaid = false;
        state.inLobby = false;
        // The display runs the full finale (with awards) itself; phones speak a
        // single verdict when their sound is on.
        if (host) return;
        const reason = data.win_reason;
        const cue = reason === 'assassination' ? 'assassin.hit'
            : reason === 'assassination_failed' ? 'assassin.miss'
                : reason === 'rejections' ? 'end.evil_rejections'
                    : data.winner === 'good' ? 'end.good' : 'end.evil_missions';
        H.cue(cue, { priority: 95, delay: 1400, interrupt: true });
    });
    socket.on('rematch_status', data => {
        const total = Number(data.total_count) || 0;
        if (total && Number(data.ready_count) === total && !state.instantRematchSaid
            && Date.now() - state.gameOverAt < 25000) {
            state.instantRematchSaid = true;
            H.cue('rematch.instant', { priority: 40, ifIdle: true });
        }
    });
    socket.on('return_to_lobby', data => {
        clearAllTimers();
        H.stop();
        state.missionNum = 0;
        enterLobby(state.roomCode, data.players, { welcome: false });
        H.cue('rematch.lobby', { priority: 70, delay: 1000 });
        if (host) S.sfx.play('door-open', { gain: 0.6 });
    });
    socket.on('game_ended', () => {
        clearAllTimers();
        H.stop();
        S.fx.clear();
        state.inLobby = false;
        state.missionNum = 0;
        state.welcomedRoom = null;
    });

    // ----- Court Narrator chat lines -------------------------------------------------
    socket.on('narrator_message', data => {
        const ids = Array.isArray(data.voice) ? data.voice.filter(id => typeof id === 'string').slice(0, 3) : [];
        if (!ids.length) return;
        if (document.getElementById('mute-narrator')?.checked) return;
        state.lastNarratorVoiceAt = Date.now();
        H.clips(ids, { priority: data.double_act_part === 2 ? 46 : 44, ttl: 18000, gapAfter: 600 });
    });

    window.AvalonShowtimeDirector = Object.freeze({
        noteNarratorVoice: () => { state.lastNarratorVoiceAt = Date.now(); },
        lastNarratorVoiceAt: () => state.lastNarratorVoiceAt,
    });
}());
