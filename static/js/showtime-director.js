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
        // Obscure-event bookkeeping (all public information).
        gamesThisSession: 0,
        gameStartedAt: 0,
        playerCount: 0,
        lateSaid: false,
        discussionStartedAt: 0,
        discussionSeconds: 0,
        previewChanges: 0,
        indecisiveSaid: false,
        leaderName: null,
        voteStartedAt: 0,
        firstTryStreak: 0,
        lobbyIds: new Map(),
        readyFlips: new Map(),
        readyFlipSaid: false,
        lostAt: 0,
        introMetaDone: false,
    };
    const FIRST_GAME_KEY = 'avalon-showtime-first-game-done';
    function firstGameEver() {
        try { return !localStorage.getItem(FIRST_GAME_KEY); } catch (_) { return false; }
    }
    function markFirstGame() {
        try { localStorage.setItem(FIRST_GAME_KEY, '1'); } catch (_) { /* optional */ }
    }
    function lateNight() {
        const hour = new Date().getHours();
        return hour >= 23 || hour < 4;
    }

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

    function noticeLobbyQuirks(players) {
        if (!host) return;
        let renamed = false;
        players.forEach(player => {
            if (!player.player_id || player.is_bot) return;
            const before = state.lobbyIds.get(player.player_id);
            if (before && before.name !== player.name) renamed = true;
            if (before && before.ready !== player.ready && player.connected !== false) {
                const flips = (state.readyFlips.get(player.player_id) || 0) + 1;
                state.readyFlips.set(player.player_id, flips);
                if (flips >= 4 && !state.readyFlipSaid) {
                    state.readyFlipSaid = true;
                    H.cue('lobby.ready_flip', { priority: 40, chance: 0.9, minGap: 8000, delay: 600 });
                }
            }
            state.lobbyIds.set(player.player_id, { name: player.name, ready: Boolean(player.ready) });
        });
        if (renamed) H.cue('lobby.rename', { priority: 38, chance: 0.7, minGap: 9000, delay: 500 });
    }

    function lobbyPlayers(players, { announceJoins = true } = {}) {
        if (!Array.isArray(players)) return;
        if (state.inLobby) noticeLobbyQuirks(players);
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
        const wasLost = state.lostAt && Date.now() - state.lostAt > 6000;
        state.lostAt = 0;
        if (data.phase === 'LOBBY') enterLobby(data.code, data.players);
        else state.inLobby = false;
        if (wasLost && data.phase !== 'LOBBY') H.cue('tv.back', { priority: 45, chance: 0.75, minGap: 8000, delay: 2500 });
    });
    socket.on('disconnect', () => { state.lostAt = Date.now(); });
    socket.on('room_resumed', () => {
        if (host) H.cue('room.resumed', { priority: 55, chance: 0.85, minGap: 6000, delay: 1800 });
    });
    socket.on('join_success', data => {
        enterLobby(data.room_code, data.players, { welcome: false });
    });
    socket.on('player_joined', data => lobbyPlayers(data.players));
    socket.on('lobby_update', data => lobbyPlayers(data.players, { announceJoins: false }));

    // ----- Opening and night ------------------------------------------------------
    socket.on('game_starting', data => {
        state.inLobby = false;
        clearAllTimers();
        H.stop();
        H.resetPacing?.();
        state.gamesThisSession += 1;
        state.gameStartedAt = Date.now();
        state.playerCount = Number(data?.player_count) || state.names.size;
        state.firstTryStreak = 0;
        state.introMetaDone = false;
        state.readyFlips.clear();
        state.readyFlipSaid = false;
        S.sfx.play('hit-big');
        S.sfx.synth('gong', { gain: 0.32 }, 120);
        H.cue('start.opening', { priority: 90, delay: 1100 });
    });
    socket.on('night_phase_start', () => {
        S.sfx.play('j-magic');
        S.sfx.synth('shimmer', { gain: 0.1 }, 200);
        // The night explanation matters most in a table's first game.
        H.cue('night.intro', state.gamesThisSession <= 1
            ? { priority: 85, delay: 900, pace: 'key' }
            : { priority: 70, delay: 900, chance: 0.6, minGap: 4000 });
    });
    socket.on('night_phase_complete', () => {
        H.cue('night.complete', { priority: 50, chance: 0.5, ifIdle: true });
    });

    // One piece of "meta" colour for the first discussion: the table, the hour,
    // the marathon, or a first-ever game on this display.
    function introMeta() {
        if (state.introMetaDone || !host) return;
        state.introMetaDone = true;
        let cue = null;
        if (firstGameEver()) cue = 'meta.first_game';
        else if (state.gamesThisSession >= 3) cue = 'meta.marathon';
        else if (lateNight() && !state.lateSaid) { cue = 'meta.late'; state.lateSaid = true; }
        else if (state.playerCount >= 10) cue = Math.random() < 0.6 ? 'game.ten' : null;
        else if (state.playerCount <= 6) cue = Math.random() < 0.5 ? 'game.six' : null;
        markFirstGame();
        if (cue) timer('intro-meta', 9000, () => H.cue(cue, { priority: 46, chance: 0.9, ifIdle: true, quietMs: 3500, minGap: 9000 }));
    }

    // ----- Missions, leaders, discussion -------------------------------------------
    socket.on('round_start', data => {
        clearTimer('proposal-slow', 'vote-stragglers');
        const mission = Number(data.mission_num) || 1;
        const rejects = Number(data.reject_count) || 0;
        if (mission !== state.missionNum && rejects === 0) {
            state.missionNum = mission;
            H.cue(`mission.${mission}`, mission === 1 || mission === 5
                ? { priority: 80, delay: host ? 1500 : 500, tag: 'mission-intro', pace: 'key' }
                : { priority: 80, delay: host ? 1500 : 500, tag: 'mission-intro', chance: 0.7, minGap: 7000 });
            const results = data.mission_results || [];
            const good = results.filter(item => item === 'pass').length;
            const evil = results.filter(item => item === 'fail').length;
            const score = good === 2 && evil === 0 ? 'score.good_two'
                : evil === 2 && good === 0 ? 'score.evil_two'
                    : good === 2 && evil === 2 ? 'score.decider' : null;
            if (score && Date.now() - state.lastNarratorVoiceAt > 20000) {
                H.cue(score, { priority: 45, chance: 0.75, delay: host ? 1600 : 600, minGap: 0 });
            }
        }
        state.rejections = rejects;
    });
    socket.on('rejection_warning', data => {
        state.rejections = Number(data.consecutive) || 0;
    });

    socket.on('discussion_start', data => {
        state.discussionStartedAt = Date.now();
        state.discussionSeconds = Number(data.duration_seconds) || 0;
        if (Number(data.mission_num) === 1 && (Number(data.reject_count) || 0) === 0) introMeta();
        if (state.discussionSeconds === 0) return;
        H.cue('discussion.start', { priority: 30, chance: 0.35, ifIdle: true, quietMs: 3000, delay: 1800 });
        // Occasionally, during a lull, the narrator muses about the game itself.
        if (host && Math.random() < 0.3) {
            timer('ambient-meta', 14000 + Math.random() * 16000, () => {
                if (Date.now() - state.discussionStartedAt < 60000) {
                    H.cue('meta.ambient', { priority: 28, ifIdle: true, quietMs: 6000 });
                }
            });
        }
    });
    socket.on('discussion_tick', data => {
        const remaining = Number(data.remaining_seconds);
        if (remaining === 10) H.cue('discussion.final10', { priority: 72, chance: 0.7, minGap: 9000 });
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
        clearTimer('vote-stragglers', 'ambient-meta');
        state.leaderName = data.leader_name || null;
        state.previewChanges = 0;
        state.indecisiveSaid = false;
        const discussed = Date.now() - state.discussionStartedAt;
        if (state.discussionSeconds > 0 && state.discussionStartedAt && discussed < 8000 && !data.forced) {
            state.discussionStartedAt = 0;
            H.cue('discussion.skipped_fast', { priority: 42, chance: 0.7, delay: 800, minGap: 8000 });
            timer('proposal-slow', 55000, () => H.cue('proposal.slow', { priority: 45, ifIdle: true }));
            return;
        }
        state.discussionStartedAt = 0;
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
    socket.on('team_preview', () => {
        state.previewChanges += 1;
        if (state.previewChanges >= 8 && !state.indecisiveSaid) {
            state.indecisiveSaid = true;
            H.cue('proposal.indecisive', { priority: 44, chance: 0.75, ifIdle: true, quietMs: 3000 });
        }
    });
    socket.on('team_proposed', () => clearTimer('proposal-slow'));
    socket.on('vote_start', () => {
        clearTimer('proposal-slow');
        state.votePending = Infinity;
        state.voteStartedAt = Date.now();
        H.cue('vote.start', { priority: 60, chance: 0.45, delay: host ? 1200 : 300, ttl: 6000, minGap: 12000 });
        timer('vote-stragglers', 24000, () => {
            if (state.votePending > 1) H.cue('vote.stragglers', { priority: 50, ifIdle: true });
        });
    });
    socket.on('vote_waiting', data => {
        const remaining = (data.remaining || []).length;
        const previous = state.votePending;
        state.votePending = remaining;
        if (host) S.sfx.play('place', { gain: 0.8 });
        if (remaining === 0 && Date.now() - state.voteStartedAt < 7000) {
            H.cue('vote.speedrun', { priority: 48, chance: 0.8, minGap: 5000 });
        }
        if (remaining === 1 && previous !== 1) {
            timer('vote-holdout', 20000, () => {
                if (state.votePending === 1) H.cue('vote.holdout', { priority: 52, ifIdle: true, minGap: 10000 });
            });
        }
    });
    socket.on('vote_reveal', data => {
        clearTimer('vote-stragglers', 'vote-holdout');
        H.clear('cue');
        const votes = data?.votes || {};
        if (state.leaderName && votes[state.leaderName] === 'reject') {
            // Spoken after the tally lands; host.js holds the herald for the flips.
            timer('leader-reject', 6500, () => H.cue('vote.leader_reject', { priority: 77, chance: 0.85, minGap: 3000 }));
        }
    });

    // ----- Quest -----------------------------------------------------------
    socket.on('mission_start', () => {
        state.firstTryStreak = state.rejections === 0 ? state.firstTryStreak + 1 : 0;
        if (state.firstTryStreak === 3) {
            timer('first-try', 5200, () => H.cue('streak.first_try', { priority: 50, chance: 0.75, ifIdle: true, quietMs: 1500, minGap: 6000 }));
        }
        state.rejections = 0;
        clearTimer('proposal-slow', 'vote-stragglers');
        S.sfx.play('hit-short');
        S.sfx.synth('whoosh', { gain: 0.3 }, 80);
        H.cue('quest.begins', { priority: 70, chance: 0.55, delay: 900, ttl: 8000, minGap: 10000 });
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
        const minutes = state.gameStartedAt ? (Date.now() - state.gameStartedAt) / 60000 : 0;
        if (host && (minutes > 45 || (minutes > 0 && minutes < 14))) {
            // After the honours ceremony has had its moment.
            timer('end-meta', 52000, () => H.cue(minutes > 45 ? 'end.long' : 'end.quick', { priority: 30, chance: 0.8, ifIdle: true, quietMs: 6000 }));
        }
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
    socket.on('flow_forced', () => {
        if (host) {
            S.sfx.play('stamp', { gain: 0.8 });
            S.sfx.play('j-tick-up', { gain: 0.6, delay: 180 });
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
        // Don't say the same thing twice: a vote/quest quip right after the
        // display already reacted to that vote/quest stays text-only.
        const trigger = Number(data.trigger_id) || 0;
        const family = trigger >= 21 && trigger <= 37 ? 'vote' : trigger >= 40 && trigger <= 53 ? 'quest' : null;
        if (family && Date.now() - (H.lastFamilyAt?.(family) || 0) < 15000) return;
        state.lastNarratorVoiceAt = Date.now();
        H.clips(ids, { priority: data.double_act_part === 2 ? 46 : 44, ttl: 18000, gapAfter: 600 });
    });

    window.AvalonShowtimeDirector = Object.freeze({
        noteNarratorVoice: () => { state.lastNarratorVoiceAt = Date.now(); },
        lastNarratorVoiceAt: () => state.lastNarratorVoiceAt,
    });
}());
