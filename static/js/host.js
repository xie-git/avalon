/* ============================================================
   AVALON — Host Screen JS
   ============================================================ */

const socket = io();
const connectionStatus = document.getElementById('connection-status');
const presenceTable = new AvalonPresenceTable({
    mode: 'host',
    onPublicChange: update => socket.emit('update_public_spectrum', update),
});
const HOST_CODE_KEY = 'avalon-host-game-code';
const HOST_TOKEN_KEY = 'avalon-host-token';
const TV_CHAT_KEY = 'avalon-tv-chat-enabled';
const presenceScreenLabels = {
    'screen-night': 'Night Phase',
    'screen-round': 'Mission Discussion',
    'screen-proposal': 'Quest Party',
    'screen-vote': 'Fellowship Vote',
    'screen-vote-reveal': 'The Votes Are Revealed',
    'screen-mission': 'The Quest Begins',
    'screen-mission-reveal': 'The Quest Returns',
    'screen-assassin': 'The Final Choice',
    'screen-game-over': 'Roles Revealed',
};

function showConnectionStatus(message) {
    connectionStatus.textContent = message;
    connectionStatus.classList.remove('hidden');
}

function hideConnectionStatus() {
    connectionStatus.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let gameCode = null;
let currentPhase = null;
let players = [];
let playerOrder = [];
let discussionDuration = 60;
let proposalDuration = 60;
let missionSizes = [];
let currentMission = 0;
let missionResults = [];
let missionHistory = [];
let consecutiveRejections = 0;
let currentLeaderName = '';
let proposedTeam = [];
let pendingVoters = [];
let timerMax = 0;
let betaTestMode = false;
let betaTestPlayerCount = 6;
let gameStartedAt = null;
let gameClockInterval = null;
let tvChatMessages = [];
let tvChatEnabled = localStorage.getItem(TV_CHAT_KEY) !== 'false';

function hostSession() {
    const code = localStorage.getItem(HOST_CODE_KEY) || sessionStorage.getItem('host_game_code');
    const token = localStorage.getItem(HOST_TOKEN_KEY) || sessionStorage.getItem('host_token');
    if (code && token) {
        localStorage.setItem(HOST_CODE_KEY, code);
        localStorage.setItem(HOST_TOKEN_KEY, token);
    }
    return { code, token };
}

function saveHostSession(code, token) {
    localStorage.setItem(HOST_CODE_KEY, code);
    localStorage.setItem(HOST_TOKEN_KEY, token);
}

function clearHostSession() {
    localStorage.removeItem(HOST_CODE_KEY);
    localStorage.removeItem(HOST_TOKEN_KEY);
    sessionStorage.removeItem('host_game_code');
    sessionStorage.removeItem('host_token');
}

function joinLink() {
    if (!gameCode) return window.location.origin;
    return `${window.location.origin}/?room=${encodeURIComponent(gameCode)}`;
}

function updateJoinTools() {
    const qr = document.getElementById('join-qr');
    if (!gameCode) {
        qr.classList.add('hidden');
        qr.removeAttribute('src');
        return;
    }
    qr.src = `/join-qr.svg?room=${encodeURIComponent(gameCode)}`;
    qr.classList.remove('hidden');
}

function renderTvChat() {
    const strip = document.getElementById('host-chat-strip');
    strip.classList.toggle('hidden', !tvChatEnabled || !gameStartedAt || !tvChatMessages.length);
    strip.replaceChildren();
    tvChatMessages.slice(-2).forEach(item => {
        const line = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = item.name;
        name.style.color = presenceTable.colorForName(item.name, item.color_index);
        const message = document.createElement('span');
        message.textContent = item.message;
        line.append(name, message);
        strip.appendChild(line);
    });
}

function renderRecoveryList() {
    const list = document.getElementById('seat-recovery-list');
    list.replaceChildren();
    const disconnected = players.filter(player => !player.connected && !player.is_bot);
    if (!disconnected.length) {
        document.getElementById('seat-recovery-result').classList.add('hidden');
        return;
    }
    const label = document.createElement('div');
    label.className = 'seat-recovery-label';
    label.textContent = 'Disconnected players';
    list.appendChild(label);
    disconnected.forEach(player => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn seat-recovery-button';
        button.textContent = `Recover ${player.name}’s seat`;
        button.addEventListener('click', () => {
            button.disabled = true;
            socket.emit('request_seat_recovery', { player_id: player.player_id });
        });
        list.appendChild(button);
    });
}


// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
    currentPhase = id.replace('screen-', '');
    const topMeta = document.getElementById('host-top-meta');
    topMeta.classList.toggle('hidden', !gameCode || id === 'screen-title' || id === 'screen-lobby');
    const presenceLabel = presenceScreenLabels[id];
    if (id === 'screen-lobby' && players.length) renderRoundTable(players);
    else if (presenceLabel && players.length) presenceTable.show(target, presenceLabel);
    else presenceTable.hide();
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
            <div class="mission-shield ${stateClass}${missionHistory[i] ? ' mission-history-clickable' : ''}" data-mission-index="${i}" ${missionHistory[i] ? 'role="button" tabindex="0"' : ''}>
                ${doubleFailIndicator}
                <svg class="shield-svg" viewBox="0 0 52 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path class="shield-path" d="M26 2 L50 12 L50 36 Q50 54 26 62 Q2 54 2 36 L2 12 Z"/>
                </svg>
                <span class="shield-size" aria-label="${size} players">${size}</span>
            </div>`;
    }
    tracker.querySelectorAll('.mission-history-clickable').forEach(shield => {
        const show = event => {
            event.stopPropagation();
            AvalonMissionTooltip.show(shield, missionHistory[Number(shield.dataset.missionIndex)]);
        };
        shield.addEventListener('click', show);
        shield.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') show(event);
        });
    });
}

function formatElapsed(seconds) {
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function updateGameStats() {
    document.getElementById('host-fails').textContent = `${missionResults.filter(r => r === 'fail').length}/3`;
    updateHostProposalTrack();
    if (gameStartedAt) document.getElementById('host-game-time').textContent = formatElapsed(Math.max(0, Math.floor((Date.now() - gameStartedAt) / 1000)));
}
function updateHostProposalTrack() {
    const track = document.getElementById('host-proposal-track');
    const count = document.getElementById('host-proposal-count');
    if (!track || !count) return;
    const attempt = Math.min(5, consecutiveRejections + 1);
    count.textContent = `${attempt} / 5`;
    track.setAttribute('aria-label', `Team proposal ${attempt} of 5`);
    track.classList.toggle('danger', attempt >= 5);
    track.querySelectorAll('.proposal-track-tokens i').forEach((token, index) => {
        token.classList.toggle('active', index < attempt);
    });
}
function startGameClock(epochSeconds) {
    if (!epochSeconds) return;
    gameStartedAt = Number(epochSeconds) * 1000;
    clearInterval(gameClockInterval);
    updateGameStats();
    gameClockInterval = setInterval(updateGameStats, 1000);
}

function updateLeaderDisplay(name) {
    document.getElementById('leader-display').innerHTML =
        `Leader: <span>${name}</span>`;
}

function showHostRoomCode(code) {
    const badge = document.getElementById('host-room-code-badge');
    badge.querySelector('strong').textContent = code || '----';
}

function syncPresencePlayers(playerList = players) {
    presenceTable.setPlayers(playerList || [], playerOrder || []);
}

// ---------------------------------------------------------------------------
// Lobby: private suspicion spectrum + draggable game turn order
// ---------------------------------------------------------------------------
function renderRoundTable(playerList) {
    const container = document.getElementById('lobby-spectrum');
    if (container && playerList.length) presenceTable.showInline(container, 'Drag anywhere · overlap avatars to cluster');
    else presenceTable.hide();
}

let _dragSrcIndex = -1;

function renderReorderList(playerList) {
    const list = document.getElementById('reorder-list');
    if (!list) return;
    list.innerHTML = '';
    playerList.forEach((p, i) => {
        const li = document.createElement('li');
        li.className = 'reorder-item';
        li.draggable = true;
        li.dataset.index = i;
        li.innerHTML = `<span class="reorder-num">${i + 1}</span>${escapeHtml(p.name)}${p.ready ? '<span class="ready-mark">✓ Ready</span>' : ''}`;

        li.addEventListener('dragstart', e => {
            _dragSrcIndex = i;
            li.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('drag-over'); });
        li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
        li.addEventListener('drop', e => {
            e.preventDefault();
            li.classList.remove('drag-over');
            const destIndex = parseInt(li.dataset.index);
            if (_dragSrcIndex === destIndex) return;
            const moved = players.splice(_dragSrcIndex, 1)[0];
            players.splice(destIndex, 0, moved);
            socket.emit('reorder_players', { order: players.map(p => p.name) });
            renderRoundTable(players);
            renderReorderList(players);
        });
        list.appendChild(li);
    });
}

function renderLobbyPlayers(playerList) {
    players = playerList;
    syncPresencePlayers(playerList);
    renderRoundTable(playerList);
    renderReorderList(playerList);
    const n = playerList.length;
    const dot = document.getElementById('player-count-dot');
    const txt = document.getElementById('player-count-text');
    const valid = n >= 6 && n <= 10;
    dot.className = 'count-dot ' + (valid ? 'valid' : (n > 0 ? 'invalid' : ''));
    txt.textContent = `${n} / 10 Players`;
    const btn = document.getElementById('btn-start-game');
    const hint = document.getElementById('start-game-hint');
    btn.disabled = !valid;
    btn.classList.toggle('beta-start', betaTestMode && valid);
    btn.textContent = betaTestMode ? 'Start Beta Test Game' : 'Begin the Quest';
    hint.textContent = valid
        ? (betaTestMode ? 'Bots make random legal moves automatically' : `${playerList.filter(player => player.ready).length} of ${n} ready`)
        : (n < 6 ? `Need ${6 - n} more player(s)` : 'Too many players (max 10)');
    renderRecoveryList();
}

function renderBetaTestMode(enabled, targetCount = betaTestPlayerCount) {
    betaTestMode = Boolean(enabled);
    betaTestPlayerCount = Number(targetCount) || 6;
    document.getElementById('beta-player-count').value = String(betaTestPlayerCount);
    const toggle = document.getElementById('btn-beta-test-mode');
    toggle.classList.toggle('enabled', betaTestMode);
    toggle.setAttribute('aria-pressed', String(betaTestMode));
    toggle.querySelector('.beta-toggle-state').textContent = betaTestMode ? 'ON' : 'OFF';
    renderLobbyPlayers(players);
}

function renderProposalSetting(seconds) {
    proposalDuration = Number(seconds) || 0;
    document.getElementById('proposal-timer-enabled').checked = proposalDuration > 0;
    document.getElementById('proposal-time-display').textContent = proposalDuration > 0 ? fmtTime(proposalDuration) : 'Off';
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

function renderChronicle(container, summary) {
    if (!container) return;
    container.replaceChildren();
    const proposals = summary.proposal_history || [];
    const missions = summary.mission_history || [];
    const completedMissionNumbers = new Set(missions.map(item => item.mission_num));
    missions.forEach(mission => {
        const section = document.createElement('section');
        section.className = `chronicle-entry ${mission.passed ? 'pass' : 'fail'}`;
        const title = document.createElement('strong');
        title.textContent = `Mission ${mission.mission_num} — ${mission.passed ? 'Succeeded' : 'Failed'}`;
        const detail = document.createElement('span');
        detail.textContent = `${mission.leader_name} led ${mission.team.join(', ')} · ${mission.success_count} Success / ${mission.fail_count} Fail`;
        section.append(title, detail);
        proposals.filter(item => item.mission_num === mission.mission_num && !item.approved).forEach(item => {
            const rejected = document.createElement('small');
            rejected.textContent = `Rejected proposal by ${item.leader_name}: ${item.approve_count}–${item.reject_count}`;
            section.appendChild(rejected);
        });
        container.appendChild(section);
    });
    proposals.filter(item => !completedMissionNumbers.has(item.mission_num)).forEach(item => {
        const section = document.createElement('section');
        section.className = 'chronicle-entry rejected';
        section.textContent = `Mission ${item.mission_num}: ${item.leader_name}’s party was rejected ${item.approve_count}–${item.reject_count}`;
        container.appendChild(section);
    });
}

// ---------------------------------------------------------------------------
// Game over: role reveal
// ---------------------------------------------------------------------------
function renderGameOver(summary) {
    if (summary.win_reason === 'rejections') consecutiveRejections = 5;
    updateHostProposalTrack();
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

    grid.replaceChildren();
    grid.classList.add('hidden');
    presenceTable.setRoleReveal(summary.roles || {});
    renderChronicle(document.getElementById('chronicle-host'), summary);
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
    const { code: stored, token: hostToken } = hostSession();
    if (stored && hostToken) {
        showConnectionStatus('Connected — restoring the host screen…');
        socket.emit('register_host_screen', { game_code: stored, host_token: hostToken });
    } else hideConnectionStatus();
});

socket.on('disconnect', () => showConnectionStatus('Connection lost — reconnecting…'));
socket.on('connect_error', () => showConnectionStatus('Unable to reach the game server — retrying…'));

socket.on('game_created', data => {
    gameCode = data.room_code;
    saveHostSession(gameCode, data.host_token);
    presenceTable.setRoomCode(gameCode);
    showHostRoomCode(gameCode);
    hideConnectionStatus();
    document.getElementById('host-create-error').textContent = '';
    document.getElementById('btn-create-game').disabled = false;
    document.getElementById('room-code-display').textContent = gameCode;
    document.getElementById('join-url-display').textContent = `Join at ${data.join_url}`;
    updateJoinTools();
    transition('screen-lobby');
});

socket.on('host_registered', data => {
    gameCode = data.code;
    presenceTable.setRoomCode(gameCode);
    showHostRoomCode(gameCode);
    hideConnectionStatus();
    document.getElementById('room-code-display').textContent = gameCode;
    document.getElementById('join-url-display').textContent = `Join at ${data.join_url}`;
    updateJoinTools();
    players = data.players || [];
    missionSizes = data.mission_sizes || [];
    missionResults = data.mission_results || [];
    missionHistory = data.mission_history || [];
    tvChatMessages = data.recent_chat || [];
    currentMission = data.current_mission || 0;
    consecutiveRejections = data.consecutive_rejections || 0;
    currentLeaderName = data.current_leader || '';
    betaTestMode = Boolean(data.beta_test_mode);
    betaTestPlayerCount = Number(data.beta_test_player_count) || 6;
    if (data.game_started_at) startGameClock(data.game_started_at);
    updateHostProposalTrack();
    if (data.discussion_time) discussionDuration = data.discussion_time;
    renderProposalSetting(data.proposal_time);
    timerMax = discussionDuration;
    syncPresencePlayers(players);
    presenceTable.setPublicPositions(data.public_spectrum || {});
    renderTvChat();
    renderRecoveryList();

    if (data.phase === 'LOBBY') {
        transition('screen-lobby');
        renderLobbyPlayers(players);
        renderBetaTestMode(betaTestMode, betaTestPlayerCount);
    } else {
        // Mid-game reconnect — restore header and show appropriate screen
        showGameHeader();
        updateMissionTracker();
        updateGameStats();
        if (currentLeaderName) updateLeaderDisplay(currentLeaderName);
        renderRoundTable(players);
        const phaseScreenMap = {
            'ROUND_START': 'screen-round',
            'DISCUSSION': 'screen-round',
            'TEAM_PROPOSAL': 'screen-proposal',
            'TEAM_VOTE': 'screen-vote',
            'VOTE_REVEAL': 'screen-vote-reveal',
            'MISSION': 'screen-mission',
            'MISSION_REVEAL': 'screen-mission-reveal',
            'ASSASSIN_PHASE': 'screen-assassin',
            'GAME_OVER': 'screen-game-over',
            'NIGHT_PHASE': 'screen-night',
        };
        const targetScreen = phaseScreenMap[data.phase] || 'screen-round';
        showScreen(targetScreen);
        if (data.phase === 'NIGHT_PHASE') {
            spawnStars();
            document.getElementById('night-confirmed').textContent = data.night_confirmed || 0;
            document.getElementById('night-total').textContent = data.night_total || players.length;
            hideGameHeader();
        } else if (data.phase === 'TEAM_PROPOSAL') {
            document.getElementById('proposal-leader-name').textContent =
                currentLeaderName;
            document.getElementById('proposal-mission-size').textContent =
                `Select ${missionSizes[currentMission] || '?'} members for the quest`;
            document.getElementById('proposal-timer-host').textContent =
                data.timer_remaining === null ? 'Take the time you need' : fmtTime(data.timer_remaining);
        } else if (data.phase === 'TEAM_VOTE' || data.phase === 'VOTE_REVEAL') {
            proposedTeam = data.proposed_team || [];
            document.getElementById('vote-team-names').textContent =
                proposedTeam.join(', ');
            document.getElementById('vote-leader-label').textContent =
                `${currentLeaderName} proposes:`;
            const voted = Object.keys(data.votes || {});
            renderVoteStatus(voted, players.map(p => p.name).filter(n => !voted.includes(n)));
            if (data.phase === 'VOTE_REVEAL') animateVoteReveal(data.votes || {});
        } else if (data.phase === 'MISSION') {
            proposedTeam = data.proposed_team || [];
            const proposedTeamIds = data.proposed_team_ids || [];
            const display = document.getElementById('mission-team-display');
            display.innerHTML = '';
            proposedTeam.forEach((name, index) => {
                const card = document.createElement('div');
                card.className = 'mission-member-card';
                card.dataset.playerId = proposedTeamIds[index] || '';
                card.textContent = name;
                display.appendChild(card);
            });
            renderMissionStatus({
                played: data.mission_cards_played,
                total: proposedTeam.length,
                played_player_ids: data.mission_cards_played_ids || [],
            });
        } else if (data.phase === 'MISSION_REVEAL' && data.pending_mission_outcome) {
            const latest = data.latest_mission;
            if (latest) {
                const cards = [
                    ...Array(latest.success_count).fill('success'),
                    ...Array(latest.fail_count).fill('fail'),
                ];
                animateMissionReveal(cards);
                const banner = document.getElementById('mission-result-banner');
                banner.className = `mission-result-banner ${latest.passed ? 'pass' : 'fail'}`;
                banner.textContent = latest.passed ? '⚔ The Quest Succeeds!' : '☠ The Quest Has Failed...';
                banner.classList.remove('hidden');
            }
        } else if (data.phase === 'ASSASSIN_PHASE') {
            document.getElementById('assassin-choosing-text').textContent =
                `${data.assassin_name} deliberates...`;
        } else if (data.phase === 'GAME_OVER' && data.summary) {
            renderGameOver(data.summary);
        }
    }
});

socket.on('player_joined', data => {
    players = data.players || [];
    syncPresencePlayers(players);
    renderLobbyPlayers(players);
});

socket.on('player_disconnected', data => {
    players = data.players || [];
    syncPresencePlayers(players);
    if (currentPhase === 'lobby') renderLobbyPlayers(players);
    else renderRoundTable(players);
    renderRecoveryList();
});

socket.on('player_reconnected', data => {
    players = data.players || [];
    syncPresencePlayers(players);
    if (currentPhase === 'lobby') renderLobbyPlayers(players);
    else renderRoundTable(players);
    renderRecoveryList();
});

socket.on('lobby_update', data => {
    players = data.players || [];
    renderLobbyPlayers(players);
    presenceTable.setPublicPositions(data.public_spectrum || {});
    if (data.settings) {
        discussionDuration = data.settings.discussion_time;
        const dispEl = document.getElementById('discussion-time-display');
        const sliderEl = document.getElementById('discussion-slider');
        if (dispEl) dispEl.textContent = fmtTime(discussionDuration);
        if (sliderEl) sliderEl.value = discussionDuration;
        renderProposalSetting(data.settings.proposal_time);
        renderBetaTestMode(data.settings.beta_test_mode, data.settings.beta_test_player_count);
    }
});

socket.on('public_spectrum_updated', data => {
    presenceTable.setPublicPositions(data.positions || {});
});

socket.on('game_starting', data => {
    players = players; // keep
    startGameClock(data.game_started_at);
    flash('white', 500);
    renderTvChat();
});

socket.on('night_phase_start', data => {
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
    currentMission = data.mission_num - 1;
    currentLeaderName = data.leader_name;
    consecutiveRejections = data.reject_count;
    missionResults = data.mission_results || [];
    missionHistory = data.mission_history || missionHistory;
    missionSizes = data.mission_sizes || [];
    if (data.player_order) playerOrder = data.player_order;
    syncPresencePlayers(players);

    document.getElementById('round-title').textContent = `Mission ${data.mission_num}`;
    document.getElementById('round-leader-name').textContent = data.leader_name;
    updateMissionTracker();
    updateGameStats();
    updateLeaderDisplay(data.leader_name);
    showGameHeader();
    transition('screen-round');
});

socket.on('discussion_start', data => {
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
    currentLeaderName = data.leader_name;
    updateLeaderDisplay(data.leader_name);
    proposedTeam = [];
    document.getElementById('proposal-leader-name').textContent = data.leader_name;
    document.getElementById('proposal-mission-size').textContent =
        `Select ${data.mission_size} members for the quest`;
    proposalDuration = Number(data.duration_seconds) || 0;
    document.getElementById('proposal-timer-host').textContent = proposalDuration ? fmtTime(proposalDuration) : 'No timer';
    document.getElementById('proposed-players-display').innerHTML = '';
    transition('screen-proposal');
});

socket.on('proposal_tick', data => {
    const timer = document.getElementById('proposal-timer-host');
    timer.textContent = fmtTime(data.remaining_seconds);
    timer.classList.toggle('warning', data.remaining_seconds <= 10);
});

socket.on('proposal_timer_expired', () => {
    const timer = document.getElementById('proposal-timer-host');
    timer.textContent = 'Take the time you need';
    timer.classList.remove('warning');
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
    document.getElementById('vote-result-banner').classList.add('hidden');
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
    updateLeaderDisplay(data.leader_name);
    updateHostProposalTrack();
});

socket.on('evil_wins_by_rejection', () => {
    consecutiveRejections = 5;
    updateHostProposalTrack();
    flash('red', 1000);
    const banner = document.getElementById('vote-result-banner');
    banner.className = 'vote-result-banner rejected';
    banner.textContent = 'CHAOS REIGNS — EVIL TRIUMPHS!';
    banner.classList.remove('hidden');
});

socket.on('mission_start', data => {
    consecutiveRejections = 0;
    updateHostProposalTrack();
    proposedTeam = data.team || [];
    const display = document.getElementById('mission-team-display');
    display.innerHTML = '';
    const teamIds = data.team_ids || [];
    proposedTeam.forEach((name, index) => {
        const card = document.createElement('div');
        card.className = 'mission-member-card';
        card.dataset.name = name;
        card.dataset.playerId = teamIds[index] || '';
        card.textContent = name;
        display.appendChild(card);
    });
    document.getElementById('mission-played').textContent = 0;
    document.getElementById('mission-total').textContent = proposedTeam.length;
    transition('screen-mission');
});

socket.on('mission_waiting', data => {
    renderMissionStatus(data);
});

function renderMissionStatus(data) {
    document.getElementById('mission-played').textContent = data.played;
    document.getElementById('mission-total').textContent = data.total;
    const playedIds = new Set(data.played_player_ids || []);
    const playedNames = new Set(data.played_players || []);
    document.querySelectorAll('.mission-member-card').forEach(card => {
        card.classList.toggle(
            'played',
            playedIds.has(card.dataset.playerId) || playedNames.has(card.dataset.name),
        );
    });
}

socket.on('mission_reveal', data => {
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
    missionHistory = data.mission_history || missionHistory;
    updateMissionTracker();
    updateGameStats();
    if (data.good_wins < 3 && data.evil_wins < 3) {
        currentMission++;
    }
});

socket.on('mission_complete', () => {});

socket.on('assassin_phase_start', data => {
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
    renderGameOver(data);
    transition('screen-game-over');
});

socket.on('chat_message', data => {
    tvChatMessages.push(data);
    if (tvChatMessages.length > 20) tvChatMessages.shift();
    renderTvChat();
});

socket.on('seat_recovery_code', data => {
    renderRecoveryList();
    const result = document.getElementById('seat-recovery-result');
    result.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `${data.player_name}’s recovery code`;
    const code = document.createElement('span');
    code.textContent = data.code;
    const note = document.createElement('small');
    note.textContent = 'Enter this on the replacement phone within five minutes.';
    result.append(title, code, note);
    result.classList.remove('hidden');
});

socket.on('return_to_lobby', data => {
    clearInterval(gameClockInterval); gameClockInterval = null; gameStartedAt = null;
    document.getElementById('host-game-time').textContent = '00:00';
    players = data.players || [];
    currentMission = 0;
    missionResults = [];
    missionHistory = [];
    consecutiveRejections = 0;
    currentLeaderName = '';
    tvChatMessages = [];
    renderTvChat();
    hideGameHeader();
    presenceTable.setRoleReveal(null);
    renderLobbyPlayers(players);
    transition('screen-lobby');
});

socket.on('game_ended', () => {
    clearInterval(gameClockInterval);
    gameClockInterval = null;
    gameStartedAt = null;
    gameCode = null;
    players = [];
    playerOrder = [];
    missionSizes = [];
    missionResults = [];
    missionHistory = [];
    currentMission = 0;
    consecutiveRejections = 0;
    currentLeaderName = '';
    proposedTeam = [];
    pendingVoters = [];
    tvChatMessages = [];
    document.getElementById('host-game-time').textContent = '00:00';
    document.getElementById('room-code-display').textContent = '----';
    document.getElementById('join-url-display').textContent = '';
    hideGameHeader();
    presenceTable.setRoleReveal(null);
    clearHostSession();
    presenceTable.hide();
    presenceTable.setRoomCode('');
    showHostRoomCode('');
    updateJoinTools();
    renderTvChat();
    renderLobbyPlayers([]);
    document.getElementById('btn-create-game').disabled = false;
    transition('screen-title');
});

socket.on('error', data => {
    console.warn('[server error]', data.message);
    const errorEl = document.getElementById('host-create-error');
    if (errorEl && document.getElementById('screen-title').classList.contains('active')) {
        errorEl.textContent = data.message;
        document.getElementById('btn-create-game').disabled = false;
    }
    if (currentPhase === 'lobby') {
        document.getElementById('btn-start-game').disabled = false;
    }
    if (/host authorization invalid|Game not found/i.test(data.message || '')) {
        clearHostSession();
        showHostRoomCode('');
        hideConnectionStatus();
        showScreen('screen-title');
        document.getElementById('host-create-error').textContent =
            'The previous game is no longer available. Create a new game to continue.';
        document.getElementById('btn-create-game').disabled = false;
    }
});

// ---------------------------------------------------------------------------
// UI event listeners
// ---------------------------------------------------------------------------

document.getElementById('btn-create-game').addEventListener('click', () => {
    document.getElementById('host-create-error').textContent = '';
    document.getElementById('btn-create-game').disabled = true;
    socket.emit('create_game');
});

document.getElementById('btn-start-game').addEventListener('click', () => {
    document.getElementById('btn-start-game').disabled = true;
    socket.emit('start_game');
});

document.getElementById('btn-close-room').addEventListener('click', async () => {
    const ok = await showConfirm(
        'Close This Room?',
        'All joined players will be disconnected and this room code will stop working.'
    );
    if (ok) socket.emit('end_game');
});

document.getElementById('btn-beta-test-mode').addEventListener('click', () => {
    socket.emit('set_beta_test_mode', { enabled: !betaTestMode, target_count: betaTestPlayerCount });
});
document.getElementById('beta-player-count').addEventListener('change', event => {
    betaTestPlayerCount = Number(event.target.value);
    socket.emit('set_beta_test_mode', { enabled: betaTestMode, target_count: betaTestPlayerCount });
});

document.getElementById('btn-return-lobby').addEventListener('click', () => {
    socket.emit('return_to_lobby');
});

// In-game settings
document.getElementById('btn-host-settings').addEventListener('click', () => {
    renderRecoveryList();
    document.getElementById('host-settings-modal').style.display = 'flex';
});
document.getElementById('btn-host-settings-close').addEventListener('click', () => {
    document.getElementById('host-settings-modal').style.display = 'none';
});
document.getElementById('btn-host-back-lobby').addEventListener('click', async () => {
    document.getElementById('host-settings-modal').style.display = 'none';
    const ok = await showConfirm('Back to Lobby?', 'The current game will be abandoned. All players will return to the lobby.');
    if (ok) socket.emit('return_to_lobby');
});
document.getElementById('btn-host-end-game').addEventListener('click', async () => {
    document.getElementById('host-settings-modal').style.display = 'none';
    const ok = await showConfirm('End Game?', 'All players will be sent back to the join screen. The game will be deleted.');
    if (ok) socket.emit('end_game');
});

// Lobby settings are host-authorized server events.
document.getElementById('discussion-slider').addEventListener('input', e => {
    discussionDuration = parseInt(e.target.value);
    document.getElementById('discussion-time-display').textContent = fmtTime(discussionDuration);
});
document.getElementById('discussion-slider').addEventListener('change', () => {
    socket.emit('update_settings', { discussion_time: discussionDuration });
});
document.getElementById('proposal-timer-enabled').addEventListener('change', event => {
    const seconds = event.target.checked ? 60 : 0;
    renderProposalSetting(seconds);
    socket.emit('update_settings', { proposal_time: seconds });
});

const tvChatToggle = document.getElementById('toggle-tv-chat');
tvChatToggle.checked = tvChatEnabled;
tvChatToggle.addEventListener('change', event => {
    tvChatEnabled = event.target.checked;
    localStorage.setItem(TV_CHAT_KEY, String(tvChatEnabled));
    renderTvChat();
});

document.getElementById('btn-copy-join').addEventListener('click', async event => {
    const text = `Join our Avalon game: ${joinLink()}`;
    try {
        await navigator.clipboard.writeText(text);
        event.currentTarget.textContent = 'Copied!';
    } catch (_) {
        window.prompt('Copy this invite:', text);
    }
    setTimeout(() => { event.currentTarget.textContent = 'Copy Invite'; }, 1800);
});

document.getElementById('btn-share-join').addEventListener('click', async () => {
    const url = joinLink();
    if (navigator.share) {
        try { await navigator.share({ title: 'Join Avalon', text: `Room ${gameCode}`, url }); } catch (_) { /* cancelled */ }
    } else {
        try { await navigator.clipboard.writeText(url); } catch (_) { window.prompt('Copy this invite:', url); }
    }
});
