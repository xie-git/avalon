/* ============================================================
   AVALON — Host Screen JS
   ============================================================ */

const socket = io();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let gameCode = null;
let currentPhase = null;
let players = [];
let playerOrder = [];
let discussionDuration = 300;
let proposalDuration = 60;
let missionSizes = [];
let currentMission = 0;
let missionResults = [];
let consecutiveRejections = 0;
let currentLeaderName = '';
let proposedTeam = [];
let pendingVoters = [];
let timerMax = 0;

// Reorder mode state
let reorderMode = false;
let selectedNodeIndex = -1;

// ---------------------------------------------------------------------------
// Audio Manager
// ---------------------------------------------------------------------------
const TRACKS = {
    lobby:          '/static/sounds/andorios-rpg-medieval-animated-music-320583.mp3',
    night:          '/static/sounds/energysound-cinema-trailer-music-509286.mp3',
    round_fanfare:  '/static/sounds/tunetank-medieval-happy-music-412790.mp3',
    discussion:     '/static/sounds/raspberrymusic-dead-of-night-epic-medieval-video-game-478788.mp3',
    proposal:       '/static/sounds/siarhei_korbut-medieval-backstreet-atmosphere-short-391172.mp3',
    tension:        '/static/sounds/nickpanekaiassets-mars-bringer-of-silicon-218150.mp3',
    mission_reveal: '/static/sounds/kaazoom-together-we-stand-30-sec-edit-military-brass-orchestral-459954.mp3',
    assassin:       '/static/sounds/nickpanekaiassets-tense-medieval-score-for-video-games-217791.mp3',
    good_wins:      '/static/sounds/eaglaxle-gaming-victory-464016.mp3',
    evil_wins:      '/static/sounds/freesound_community-075747_inception-horn-victory-82997.mp3',
};

let _currentAudio = null;
let _currentTrackKey = null;
let _pendingFade = null;
const _audioCache = {};
let _masterVolume = 0.55;

function _getAudio(key) {
    if (!_audioCache[key]) _audioCache[key] = new Audio(TRACKS[key]);
    return _audioCache[key];
}

function playTrack(key, { loop = true } = {}) {
    if (_currentTrackKey === key) return;
    // Set key immediately so rapid calls don't stack
    _currentTrackKey = key;
    // Cancel any in-progress fade
    if (_pendingFade) { clearInterval(_pendingFade); _pendingFade = null; }
    const prev = _currentAudio;
    const startNew = () => {
        const audio = _getAudio(key);
        audio.loop = loop;
        audio.currentTime = 0;
        audio.volume = 0;
        _currentAudio = audio;
        audio.play().catch(() => {});
        if (_masterVolume > 0) {
            let v = 0;
            _pendingFade = setInterval(() => {
                v = Math.min(_masterVolume, v + 0.04);
                audio.volume = v;
                if (v >= _masterVolume) { clearInterval(_pendingFade); _pendingFade = null; }
            }, 80);
        }
    };
    if (prev && !prev.paused) {
        let v = prev.volume;
        _pendingFade = setInterval(() => {
            v = Math.max(0, v - 0.1);
            prev.volume = v;
            if (v <= 0) {
                clearInterval(_pendingFade); _pendingFade = null;
                prev.pause(); prev.currentTime = 0;
                startNew();
            }
        }, 40);
    } else {
        startNew();
    }
}

// Exposed globally so dev panel iframe can call this
window.setMusicVolume = function(vol) {
    _masterVolume = vol;
    if (_currentAudio) _currentAudio.volume = vol;
    const slider = document.getElementById('music-vol-slider');
    const display = document.getElementById('music-vol-display');
    if (slider) slider.value = Math.round(vol * 100);
    if (display) display.textContent = Math.round(vol * 100) + '%';
    const btn = document.getElementById('btn-mute-music');
    if (btn) btn.textContent = vol === 0 ? '🔇 Muted' : '🔊 Mute';
};

// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
    currentPhase = id.replace('screen-', '');
    if (typeof _syncMusicButton === 'function') _syncMusicButton();
}

function transition(id, delay = 0) {
    const overlay = document.getElementById('page-transition');
    overlay.classList.add('active');
    setTimeout(() => {
        showScreen(id);
        overlay.classList.remove('active');
    }, delay + 300);
}

// ---------------------------------------------------------------------------
// Flash overlay
// ---------------------------------------------------------------------------
function flash(type = 'white', duration = 300) {
    const el = document.getElementById('flash-overlay');
    el.className = `flash-${type}`;
    el.style.opacity = 0.6;
    setTimeout(() => { el.style.opacity = 0; }, duration);
}

// ---------------------------------------------------------------------------
// Game header
// ---------------------------------------------------------------------------
function showGameHeader() {
    document.getElementById('game-header').classList.add('visible');
}
function hideGameHeader() {
    document.getElementById('game-header').classList.remove('visible');
}

function updateMissionTracker() {
    const tracker = document.getElementById('mission-tracker');
    tracker.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const size = missionSizes[i] || '?';
        const result = missionResults[i];
        const isCurrent = !result && i === currentMission;
        const doubleFailIndicator = (i === 3 && players.length >= 7)
            ? `<span class="shield-double-fail">×2</span>` : '';
        let stateClass = '';
        if (result === 'pass') stateClass = 'pass';
        else if (result === 'fail') stateClass = 'fail';
        else if (isCurrent) stateClass = 'current';

        tracker.innerHTML += `
            <div class="mission-shield ${stateClass}">
                ${doubleFailIndicator}
                <svg class="shield-svg" viewBox="0 0 52 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path class="shield-path" d="M26 2 L50 12 L50 36 Q50 54 26 62 Q2 54 2 36 L2 12 Z"/>
                </svg>
                <span class="shield-num">${i + 1}</span>
                <span class="shield-size">${size}p</span>
            </div>`;
    }
}

function updateRejectionTracker() {
    const tracker = document.getElementById('rejection-tracker');
    // Keep label, rebuild tokens
    const label = tracker.querySelector('.rejection-label');
    tracker.innerHTML = '';
    tracker.appendChild(label);
    for (let i = 0; i < 5; i++) {
        const tok = document.createElement('div');
        tok.className = 'rejection-token' + (i < consecutiveRejections ? ' filled' : '');
        tracker.appendChild(tok);
    }
}

function updateLeaderDisplay(name) {
    document.getElementById('leader-display').innerHTML =
        `Leader: <span>${name}</span>`;
}

// ---------------------------------------------------------------------------
// Lobby: Round table rendering
// ---------------------------------------------------------------------------
function renderRoundTable(playerList) {
    const svg = document.getElementById('player-nodes');
    svg.innerHTML = '';
    const n = playerList.length;
    if (!n) return;
    const cx = 250, cy = 250, r = 195;
    playerList.forEach((p, i) => {
        const angle = (2 * Math.PI * i / n) - Math.PI / 2;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        const isLeader = p.name === currentLeaderName;
        const isDisconnected = !p.connected;
        const isSelected = reorderMode && selectedNodeIndex === i;
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', `player-node${isLeader ? ' leader' : ''}${isDisconnected ? ' disconnected' : ''}${isSelected ? ' reorder-selected' : ''}${reorderMode ? ' reorder-mode' : ''}`);
        g.innerHTML = `
            <circle cx="${x}" cy="${y}" r="30"/>
            ${isLeader ? `<text x="${x}" y="${y - 38}" class="crown-icon">♔</text>` : ''}
            <text x="${x}" y="${y}">${escapeHtml(p.name)}</text>
        `;
        if (reorderMode) {
            g.style.cursor = 'pointer';
            g.addEventListener('click', () => handleNodeClick(i));
        }
        svg.appendChild(g);
    });
}

function handleNodeClick(index) {
    if (!reorderMode) return;
    if (selectedNodeIndex === -1) {
        selectedNodeIndex = index;
        document.getElementById('reorder-hint').textContent = 'Now tap the destination seat';
        renderRoundTable(players);
    } else if (selectedNodeIndex === index) {
        // Deselect
        selectedNodeIndex = -1;
        document.getElementById('reorder-hint').textContent = 'Tap a seat to move it';
        renderRoundTable(players);
    } else {
        // Swap
        const tmp = players[selectedNodeIndex];
        players[selectedNodeIndex] = players[index];
        players[index] = tmp;
        selectedNodeIndex = -1;
        socket.emit('reorder_players', { order: players.map(p => p.name) });
        renderRoundTable(players);
        document.getElementById('reorder-hint').textContent = 'Tap a seat to move it';
    }
}

function renderLobbyPlayers(playerList) {
    players = playerList;
    renderRoundTable(playerList);
    const n = playerList.length;
    const dot = document.getElementById('player-count-dot');
    const txt = document.getElementById('player-count-text');
    const valid = n >= 6 && n <= 10;
    dot.className = 'count-dot ' + (valid ? 'valid' : (n > 0 ? 'invalid' : ''));
    txt.textContent = `${n} / 10 Players`;
    const btn = document.getElementById('btn-start-game');
    const hint = document.getElementById('start-game-hint');
    btn.disabled = !valid;
    hint.textContent = valid ? '' : (n < 6 ? `Need ${6 - n} more player(s)` : 'Too many players (max 10)');
}

// ---------------------------------------------------------------------------
// Discussion timer
// ---------------------------------------------------------------------------
let timerInterval = null;

function updateTimerRing(ringId, remaining, max) {
    const ring = document.getElementById(ringId);
    const textEl = document.getElementById(ringId.replace('-ring', '-text'));
    if (!ring) return;
    const circ = 2 * Math.PI * 90; // r=90
    const fraction = Math.max(0, remaining / max);
    ring.style.strokeDashoffset = circ * (1 - fraction);
    const warning = remaining <= 10;
    ring.classList.toggle('warning', warning);
    if (textEl) {
        textEl.classList.toggle('warning', warning);
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        textEl.textContent = m > 0 ? `${m}:${String(s).padStart(2,'0')}` : remaining;
    }
}

// ---------------------------------------------------------------------------
// Night phase stars
// ---------------------------------------------------------------------------
function spawnStars() {
    const container = document.getElementById('night-stars');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < 80; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        star.style.left = Math.random() * 100 + '%';
        star.style.top = Math.random() * 100 + '%';
        star.style.setProperty('--dur', (2 + Math.random() * 3).toFixed(1) + 's');
        star.style.setProperty('--delay', (-Math.random() * 5).toFixed(1) + 's');
        container.appendChild(star);
    }
}

// ---------------------------------------------------------------------------
// Vote reveal animation
// ---------------------------------------------------------------------------
function animateVoteReveal(votes) {
    const container = document.getElementById('vote-cards-container');
    container.innerHTML = '';
    const entries = Object.entries(votes);
    entries.forEach(([name, vote], i) => {
        const card = document.createElement('div');
        card.className = 'vote-card';
        card.innerHTML = `
            <div class="vote-card-inner">
                <div class="vote-card-front">?</div>
                <div class="vote-card-back ${vote}">
                    <span class="vote-label">${vote.toUpperCase()}</span>
                    <span class="player-name-label">${escapeHtml(name)}</span>
                </div>
            </div>`;
        container.appendChild(card);
        setTimeout(() => {
            card.classList.add('flipped');
            flash(vote === 'approve' ? 'blue' : 'red', 200);
        }, 500 + i * 350);
    });
    setTimeout(() => {
        const approved = entries.filter(([,v]) => v === 'approve').length;
        const rejected = entries.length - approved;
        const isApproved = approved > rejected;
        const banner = document.getElementById('vote-result-banner');
        banner.className = `vote-result-banner ${isApproved ? 'approved' : 'rejected'}`;
        banner.textContent = isApproved ? 'The Quest Party Rides Forth!' : 'The Court Dissents!';
        banner.classList.remove('hidden');
    }, 500 + entries.length * 350 + 500);
}

// ---------------------------------------------------------------------------
// Mission reveal animation
// ---------------------------------------------------------------------------
function animateMissionReveal(cards) {
    const container = document.getElementById('mission-cards-display');
    container.innerHTML = '';
    cards.forEach((card, i) => {
        const el = document.createElement('div');
        el.className = 'mission-result-card';
        el.innerHTML = `<span class="card-icon">?</span><span>${card.toUpperCase()}</span>`;
        container.appendChild(el);
        setTimeout(() => {
            el.className = `mission-result-card revealed-${card}`;
            el.innerHTML = card === 'success'
                ? `<span class="card-icon">☀</span><span>SUCCESS</span>`
                : `<span class="card-icon">☠</span><span>FAIL</span>`;
            flash(card === 'success' ? 'blue' : 'red', 200);
        }, 800 + i * 600);
    });
}

// ---------------------------------------------------------------------------
// Game over: role reveal
// ---------------------------------------------------------------------------
function renderGameOver(summary) {
    const banner = document.getElementById('game-over-banner');
    const reasonEl = document.getElementById('win-reason-text');
    const grid = document.getElementById('roles-reveal-grid');

    banner.className = `game-over-banner ${summary.winner === 'good' ? 'good-wins' : 'evil-wins'}`;
    banner.textContent = summary.winner === 'good' ? 'GOOD WINS' : 'EVIL WINS';
    flash(summary.winner === 'good' ? 'blue' : 'red', 800);

    const reasons = {
        missions: 'by completing 3 quests',
        assassination: 'by assassinating Merlin',
        assassination_failed: 'Merlin survived the Assassin',
        rejections: 'by 5 consecutive rejections',
    };
    reasonEl.textContent = reasons[summary.win_reason] || summary.win_reason;

    grid.innerHTML = '';
    (summary.player_order || Object.keys(summary.roles)).forEach((name, idx) => {
        const info = summary.roles[name];
        const card = document.createElement('div');
        card.className = `role-reveal-card ${info.team}`;
        card.style.animationDelay = `${idx * 0.1}s`;
        card.innerHTML = `
            <div class="player-name">${escapeHtml(name)}</div>
            <div class="player-role">${info.role}</div>`;
        grid.appendChild(card);
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${sec}s`;
}

// ---------------------------------------------------------------------------
// In-game confirmation modal
// ---------------------------------------------------------------------------
let _confirmResolve = null;

function showConfirm(title, body) {
    return new Promise(resolve => {
        _confirmResolve = resolve;
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-body').textContent = body;
        document.getElementById('confirm-modal').classList.add('open');
    });
}

document.getElementById('confirm-yes').addEventListener('click', () => {
    document.getElementById('confirm-modal').classList.remove('open');
    if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
});

document.getElementById('confirm-no').addEventListener('click', () => {
    document.getElementById('confirm-modal').classList.remove('open');
    if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
});

// ---------------------------------------------------------------------------
// SocketIO events
// ---------------------------------------------------------------------------

socket.on('connect', () => {
    // Check URL fragment for dev panel auto-registration (e.g. /host#auto_code=ABCD)
    const hashMatch = window.location.hash.match(/auto_code=([A-Z]{4})/);
    if (hashMatch) {
        gameCode = hashMatch[1];
        sessionStorage.setItem('host_game_code', gameCode);
        socket.emit('register_host_screen', { game_code: gameCode });
        return;
    }
    // Otherwise try session storage reconnect
    const stored = sessionStorage.getItem('host_game_code');
    if (stored) {
        socket.emit('register_host_screen', { game_code: stored });
    }
});

socket.on('game_created', data => {
    playTrack('lobby');
    gameCode = data.room_code;
    sessionStorage.setItem('host_game_code', gameCode);
    document.getElementById('room-code-display').textContent = gameCode;
    document.getElementById('join-url-display').textContent = `Join at ${data.join_url}`;
    transition('screen-lobby');
});

socket.on('host_registered', data => {
    gameCode = data.code;
    players = data.players || [];
    if (data.phase === 'LOBBY') {
        playTrack('lobby');
        transition('screen-lobby');
        renderLobbyPlayers(players);
    }
});

socket.on('player_joined', data => {
    players = data.players || [];
    renderLobbyPlayers(players);
});

socket.on('player_disconnected', data => {
    players = data.players || [];
    if (currentPhase === 'lobby') renderLobbyPlayers(players);
    else renderRoundTable(players);
});

socket.on('player_reconnected', data => {
    players = data.players || [];
    if (currentPhase === 'lobby') renderLobbyPlayers(players);
    else renderRoundTable(players);
});

socket.on('lobby_update', data => {
    players = data.players || [];
    renderLobbyPlayers(players);
    if (data.settings) {
        discussionDuration = data.settings.discussion_time;
        proposalDuration = data.settings.proposal_time;
        document.getElementById('discussion-time-display').textContent = fmtTime(discussionDuration);
        document.getElementById('proposal-time-display').textContent = fmtTime(proposalDuration);
        document.getElementById('discussion-slider').value = discussionDuration;
        document.getElementById('proposal-slider').value = proposalDuration;
    }
});

socket.on('game_starting', data => {
    players = players; // keep
    flash('white', 500);
});

socket.on('night_phase_start', data => {
    playTrack('night');
    spawnStars();
    document.getElementById('night-total').textContent = data.total_players;
    document.getElementById('night-confirmed').textContent = 0;
    hideGameHeader();
    transition('screen-night');
});

socket.on('night_phase_progress', data => {
    document.getElementById('night-confirmed').textContent = data.confirmed;
    document.getElementById('night-total').textContent = data.total;
});

socket.on('night_phase_complete', () => {
    // Transition happens on round_start
});

socket.on('round_start', data => {
    playTrack('round_fanfare');
    currentMission = data.mission_num - 1;
    currentLeaderName = data.leader_name;
    consecutiveRejections = data.reject_count;
    missionResults = data.mission_results || [];
    missionSizes = data.mission_sizes || [];
    if (data.player_order) playerOrder = data.player_order;

    document.getElementById('round-title').textContent = `Mission ${data.mission_num}`;
    document.getElementById('round-leader-name').textContent = data.leader_name;
    updateMissionTracker();
    updateRejectionTracker();
    updateLeaderDisplay(data.leader_name);
    showGameHeader();
    transition('screen-round');
});

socket.on('discussion_start', data => {
    playTrack('discussion');
    timerMax = data.duration_seconds;
    updateTimerRing('timer-ring', timerMax, timerMax);
    showScreen('screen-round');
});

socket.on('discussion_tick', data => {
    updateTimerRing('timer-ring', data.remaining_seconds, timerMax);
    if (data.remaining_seconds <= 3 && data.remaining_seconds > 0) {
        document.getElementById('screen-round').classList.add('screen-edge-warning');
        setTimeout(() => document.getElementById('screen-round').classList.remove('screen-edge-warning'), 1500);
    }
});

socket.on('discussion_end', () => {});

socket.on('proposal_start', data => {
    playTrack('proposal');
    currentLeaderName = data.leader_name;
    updateLeaderDisplay(data.leader_name);
    proposedTeam = [];
    document.getElementById('proposal-leader-name').textContent = data.leader_name;
    document.getElementById('proposal-mission-size').textContent =
        `Select ${data.mission_size} members for the quest`;
    document.getElementById('proposed-players-display').innerHTML = '';
    timerMax = data.duration_seconds;
    updateTimerRing('proposal-timer-ring', timerMax, timerMax);
    transition('screen-proposal');
});

socket.on('proposal_tick', data => {
    updateTimerRing('proposal-timer-ring', data.remaining_seconds, timerMax);
});

socket.on('proposal_timer_expired', () => {
    document.getElementById('proposal-timer-text').textContent = '—';
});

socket.on('team_preview', data => {
    const container = document.getElementById('proposed-players-display');
    container.innerHTML = '';
    (data.team_names || []).forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'proposed-player-chip selected';
        chip.textContent = name;
        container.appendChild(chip);
    });
});

socket.on('team_proposed', data => {
    proposedTeam = data.team || [];
    const container = document.getElementById('proposed-players-display');
    container.innerHTML = '';
    proposedTeam.forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'proposed-player-chip selected';
        chip.textContent = name;
        container.appendChild(chip);
    });
});

socket.on('vote_start', data => {
    playTrack('tension');
    proposedTeam = data.team || [];
    pendingVoters = players.map(p => p.name);
    document.getElementById('vote-team-names').textContent = proposedTeam.join(', ');
    document.getElementById('vote-leader-label').textContent = `${currentLeaderName} proposes:`;
    renderVoteStatus([], pendingVoters);
    transition('screen-vote');
});

socket.on('vote_waiting', data => {
    renderVoteStatus(data.voted || [], data.remaining || []);
});

function renderVoteStatus(voted, remaining) {
    const grid = document.getElementById('vote-status-grid');
    grid.innerHTML = '';
    voted.forEach(name => {
        grid.innerHTML += `<div class="vote-status-chip voted"><span class="vote-status-icon">✓</span>${escapeHtml(name)}</div>`;
    });
    remaining.forEach(name => {
        grid.innerHTML += `<div class="vote-status-chip"><span class="vote-status-icon">⋯</span>${escapeHtml(name)}</div>`;
    });
}

socket.on('vote_reveal', data => {
    transition('screen-vote-reveal');
    setTimeout(() => animateVoteReveal(data.votes), 400);
});

socket.on('rejection_warning', data => {
    consecutiveRejections = data.consecutive;
    updateRejectionTracker();
    updateLeaderDisplay(data.leader_name);
});

socket.on('evil_wins_by_rejection', () => {
    flash('red', 1000);
    const banner = document.getElementById('vote-result-banner');
    banner.className = 'vote-result-banner rejected';
    banner.textContent = 'CHAOS REIGNS — EVIL TRIUMPHS!';
    banner.classList.remove('hidden');
});

socket.on('mission_start', data => {
    playTrack('tension');
    proposedTeam = data.team || [];
    const display = document.getElementById('mission-team-display');
    display.innerHTML = '';
    proposedTeam.forEach(name => {
        const card = document.createElement('div');
        card.className = 'mission-member-card';
        card.dataset.name = name;
        card.textContent = name;
        display.appendChild(card);
    });
    document.getElementById('mission-played').textContent = 0;
    document.getElementById('mission-total').textContent = proposedTeam.length;
    transition('screen-mission');
});

socket.on('mission_waiting', data => {
    document.getElementById('mission-played').textContent = data.played;
    document.getElementById('mission-total').textContent = data.total;
    // Mark one more card as played (can't tell which)
    const cards = document.querySelectorAll('.mission-member-card:not(.played)');
    if (cards.length > 0) cards[0].classList.add('played');
});

socket.on('mission_reveal', data => {
    playTrack('mission_reveal');
    document.getElementById('mission-result-banner').classList.add('hidden');
    transition('screen-mission-reveal');
    setTimeout(() => {
        animateMissionReveal(data.cards_shuffled);
        setTimeout(() => {
            const banner = document.getElementById('mission-result-banner');
            banner.className = `mission-result-banner ${data.passed ? 'pass' : 'fail'}`;
            banner.textContent = data.passed ? '⚔ The Quest Succeeds!' : '☠ The Quest Has Failed...';
            banner.classList.remove('hidden');
            flash(data.passed ? 'blue' : 'red', 600);
        }, 800 + data.cards_shuffled.length * 600 + 500);
    }, 400);
});

socket.on('mission_tracker_update', data => {
    missionResults = data.mission_results || [];
    updateMissionTracker();
    if (data.good_wins < 3 && data.evil_wins < 3) {
        currentMission++;
    }
});

socket.on('assassin_phase_start', data => {
    playTrack('assassin');
    document.getElementById('assassin-choosing-text').textContent =
        `${data.assassin_name} deliberates...`;
    hideGameHeader();
    transition('screen-assassin');
});

socket.on('assassination_result', data => {
    const text = data.was_merlin
        ? `${data.target_name} was MERLIN — Evil claims victory!`
        : `${data.target_name} was not Merlin. Good prevails!`;
    document.getElementById('assassin-choosing-text').textContent = text;
    flash(data.was_merlin ? 'red' : 'blue', 800);
});

socket.on('game_over', data => {
    playTrack(data.winner === 'good' ? 'good_wins' : 'evil_wins', { loop: true });
    renderGameOver(data);
    transition('screen-game-over');
});

socket.on('return_to_lobby', data => {
    playTrack('lobby');
    players = data.players || [];
    currentMission = 0;
    missionResults = [];
    consecutiveRejections = 0;
    currentLeaderName = '';
    hideGameHeader();
    renderLobbyPlayers(players);
    transition('screen-lobby');
});

socket.on('error', data => {
    console.warn('[server error]', data.message);
});

// ---------------------------------------------------------------------------
// UI event listeners
// ---------------------------------------------------------------------------

document.getElementById('btn-create-game').addEventListener('click', () => {
    socket.emit('create_game');
});

document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('start_game');
});

document.getElementById('btn-skip-discussion').addEventListener('click', async () => {
    const ok = await showConfirm('End Discussion?', 'All players will be notified and the leader will begin selecting their quest party.');
    if (ok) socket.emit('skip_discussion', { confirmed: true });
});

document.getElementById('btn-reorder-toggle').addEventListener('click', () => {
    reorderMode = !reorderMode;
    selectedNodeIndex = -1;
    const btn = document.getElementById('btn-reorder-toggle');
    const hint = document.getElementById('reorder-hint');
    if (reorderMode) {
        btn.textContent = '✓ Done Reordering';
        btn.style.borderColor = 'var(--gold)';
        hint.textContent = 'Tap a seat to move it';
    } else {
        btn.textContent = '↕ Reorder Seats';
        btn.style.borderColor = '';
        hint.textContent = '';
    }
    renderRoundTable(players);
});

document.getElementById('btn-return-lobby').addEventListener('click', () => {
    socket.emit('return_to_lobby');
});

// Settings sliders (emit to server — host screen acts as a relay for settings)
// Note: host screen doesn't have a player ID so settings changes must come from
// the host player's phone. The sliders here are display-only for reference.
// We'll still emit to let a connected host player update settings if desired.
document.getElementById('discussion-slider').addEventListener('input', e => {
    discussionDuration = parseInt(e.target.value);
    document.getElementById('discussion-time-display').textContent = fmtTime(discussionDuration);
    socket.emit('update_settings', { discussion_time: discussionDuration });
});

document.getElementById('proposal-slider').addEventListener('input', e => {
    proposalDuration = parseInt(e.target.value);
    document.getElementById('proposal-time-display').textContent = fmtTime(proposalDuration);
    socket.emit('update_settings', { proposal_time: proposalDuration });
});

// Music controls — lobby settings panel
document.getElementById('music-vol-slider').addEventListener('input', e => {
    window.setMusicVolume(parseInt(e.target.value) / 100);
});
document.getElementById('btn-mute-music').addEventListener('click', () => {
    window.setMusicVolume(_masterVolume > 0 ? 0 : 0.55);
});

// Music controls — floating in-game panel
let _musicPanelOpen = false;
const _floatPanel = document.getElementById('music-controls-float');
const _toggleBtn = document.getElementById('btn-music-toggle');

document.getElementById('btn-music-toggle').addEventListener('click', () => {
    _musicPanelOpen = !_musicPanelOpen;
    _floatPanel.style.display = _musicPanelOpen ? 'flex' : 'none';
    _toggleBtn.style.display = _musicPanelOpen ? 'none' : 'block';
});

document.getElementById('music-vol-float').addEventListener('input', e => {
    window.setMusicVolume(parseInt(e.target.value) / 100);
});

document.getElementById('btn-mute-float').addEventListener('click', () => {
    const newVol = _masterVolume > 0 ? 0 : 0.55;
    window.setMusicVolume(newVol);
    document.getElementById('music-vol-float').value = Math.round(newVol * 100);
});

// Show/hide floating music button during game (not on title/lobby)
function _syncMusicButton() {
    const inGame = currentPhase && currentPhase !== 'title' && currentPhase !== 'lobby';
    _toggleBtn.style.display = inGame ? 'block' : 'none';
    if (!inGame) { _floatPanel.style.display = 'none'; _musicPanelOpen = false; }
}
