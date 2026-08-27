/* ============================================================
   AVALON — Host Screen JS
   ============================================================ */

const socket = io();
const connectionStatus = document.getElementById('connection-status');
const presenceTable = new AvalonPresenceTable({
    mode: 'host',
});
const HOST_CODE_KEY = 'avalon-host-game-code';
const HOST_TOKEN_KEY = 'avalon-host-token';
const PAIRED_DISPLAY_KEY = 'avalon-host-is-paired-display';
const ANALYTICS_ID_KEY = 'avalon-analytics-id';

function randomUuid() {
    return crypto.randomUUID ? crypto.randomUUID() :
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
            const random = Math.random() * 16 | 0;
            return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
        });
}

function analyticsId() {
    let value = localStorage.getItem(ANALYTICS_ID_KEY);
    if (!value) {
        value = randomUuid();
        localStorage.setItem(ANALYTICS_ID_KEY, value);
    }
    return value;
}

const ANALYTICS_ID = analyticsId();
const CLIENT_SESSION_ID = randomUuid();
let clientEventSequence = 0;
let socketConnectionCount = 0;

function dimensionBucket(value) {
    if (value <= 430) return 'xs';
    if (value <= 768) return 'sm';
    if (value <= 1024) return 'md';
    if (value <= 1440) return 'lg';
    return 'xl';
}

function clientContext() {
    const navigation = performance.getEntriesByType?.('navigation')?.[0];
    return {
        screen_class: window.innerWidth >= 1200 ? 'tv' : 'desktop',
        display_mode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
        viewport_width_bucket: dimensionBucket(window.innerWidth),
        viewport_height_bucket: dimensionBucket(window.innerHeight),
        timezone_offset_minutes: new Date().getTimezoneOffset(),
        locale: (navigator.language || 'unknown').slice(0, 16),
        color_scheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        reduced_motion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        touch_capable: navigator.maxTouchPoints > 0,
        online: navigator.onLine,
        navigation_ms: navigation ? Math.round(navigation.duration) : 0,
    };
}

function track(eventType, payload = {}) {
    socket.emit('client_analytics', {
        analytics_id: ANALYTICS_ID,
        client_session_id: CLIENT_SESSION_ID,
        client_event_id: randomUuid(),
        client_sequence: ++clientEventSequence,
        client_occurred_at: new Date().toISOString(),
        client_uptime_ms: Math.round(performance.now()),
        page: 'host',
        client_context: clientContext(),
        event_type: eventType,
        payload,
    });
}

document.addEventListener('click', event => {
    const control = event.target.closest?.('button[id], a[id], [role="button"][id]');
    if (!control || !/^[A-Za-z0-9_-]{1,64}$/.test(control.id)) return;
    track('ui_control_activated', {
        control_id: control.id,
        context: document.querySelector('.screen.active')?.id || 'entry',
    });
});

window.addEventListener('error', event => {
    track('client_error', {
        error_category: event.error?.name || 'script_error',
        context: document.querySelector('.screen.active')?.id || 'unknown',
    });
});

window.addEventListener('unhandledrejection', event => {
    track('client_error', {
        error_category: event.reason?.name || 'unhandled_promise',
        context: document.querySelector('.screen.active')?.id || 'unknown',
    });
});
const presenceScreenLabels = {
    'screen-night': 'Night Phase',
    'screen-round': 'Mission Discussion',
    'screen-proposal': 'Quest Party',
    'screen-vote': 'Fellowship Vote',
    'screen-vote-reveal': 'The Votes Are Revealed',
    'screen-assassin': 'The Final Choice',
};

function showConnectionStatus(message) {
    connectionStatus.textContent = message;
    connectionStatus.classList.remove('hidden');
}

function hideConnectionStatus() {
    connectionStatus.classList.add('hidden');
}

function showSuspendedDisplayRecovery() {
    showConnectionStatus('Game saved — waiting for a player to resume within 24 hours');
    document.getElementById('suspended-display-recovery').classList.remove('hidden');
}

function hideSuspendedDisplayRecovery() {
    document.getElementById('suspended-display-recovery').classList.add('hidden');
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
let gameStartedAt = null;
let gameClockInterval = null;
let tvChatMessages = [];
const tvChatEnabled = true;
let isPairedDisplay = localStorage.getItem(PAIRED_DISPLAY_KEY) === 'true';
let chatAudioContext = null;
let hostMissionRevealSequence = 0;
let latestHostMissionReveal = null;
let gameOutcomeTimer = null;
let lastGameOutcomeAnnouncementKey = null;

const QUEST_OUTCOME_ART = {
    success: '/static/assets/quests/quest-successful.png?v=20260825-cinematic',
    fail: '/static/assets/quests/quest-failed.png?v=20260825-cinematic',
};

const GAME_OUTCOME_ART = {
    good: '/static/assets/results/good-wins-wide.png?v=20260827',
    evil: '/static/assets/results/evil-wins-wide.png?v=20260827',
};

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

function appendLinkifiedText(container, value) {
    const text = String(value);
    const urlPattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
    let cursor = 0;
    for (const match of text.matchAll(urlPattern)) {
        const raw = match[0];
        let label = raw;
        let trailing = '';
        while (/[.,!?;:)\]}]$/.test(label)) {
            trailing = label.slice(-1) + trailing;
            label = label.slice(0, -1);
        }
        container.append(document.createTextNode(text.slice(cursor, match.index)));
        const href = label.toLowerCase().startsWith('www.') ? `https://${label}` : label;
        try {
            const parsed = new URL(href);
            if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && label) {
                const link = document.createElement('a');
                link.href = parsed.href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = label;
                container.appendChild(link);
            } else {
                container.append(document.createTextNode(label));
            }
        } catch (_error) {
            container.append(document.createTextNode(label));
        }
        container.append(document.createTextNode(trailing));
        cursor = match.index + raw.length;
    }
    container.append(document.createTextNode(text.slice(cursor)));
}

function renderTvChat() {
    const strip = document.getElementById('host-chat-strip');
    strip.classList.toggle('hidden', !tvChatEnabled || !gameStartedAt || !tvChatMessages.length);
    strip.replaceChildren();
    tvChatMessages.slice(-3).forEach(item => {
        const line = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = `${item.name}${item.is_spectator ? ' · spectator' : ''}`;
        name.style.color = presenceTable.colorForName(item.name, item.color_index);
        const message = document.createElement('span');
        appendLinkifiedText(message, item.message);
        line.append(name, message);
        strip.appendChild(line);
    });
}

function renderNightPending(names = []) {
    const pending = document.getElementById('night-pending');
    const cleanNames = Array.isArray(names) ? names.filter(Boolean) : [];
    pending.replaceChildren();
    pending.classList.toggle('complete', !cleanNames.length);
    if (!cleanNames.length) {
        pending.textContent = '✓ Everyone understands their role';
        return;
    }
    const label = document.createElement('strong');
    label.textContent = 'Still waiting: ';
    pending.append(label, document.createTextNode(cleanNames.join(', ')));
}


// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
function showScreen(id) {
    const previousScreenId = document.querySelector('.screen.active')?.id || null;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
    currentPhase = id.replace('screen-', '');
    document.body.classList.toggle(
        'host-cinematic-active',
        id === 'screen-mission' || id === 'screen-mission-reveal' || id === 'screen-game-over',
    );
    const topMeta = document.getElementById('host-top-meta');
    topMeta.classList.toggle('hidden', !gameCode || id === 'screen-title' || id === 'screen-lobby');
    const presenceLabel = presenceScreenLabels[id];
    if (id === 'screen-lobby' && players.length) renderRoundTable(players);
    else if (presenceLabel && players.length) presenceTable.show(target, presenceLabel);
    else presenceTable.hide();
    if (target && previousScreenId !== id) {
        track('screen_viewed', {
            screen_id: id,
            previous_screen_id: previousScreenId || 'none',
            context: 'host_display',
        });
    }
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
    document.getElementById('host-mission-rail').classList.add('visible');
    document.body.classList.add('host-gameplay');
}
function hideGameHeader() {
    document.getElementById('game-header').classList.remove('visible');
    document.getElementById('host-mission-rail').classList.remove('visible');
    document.body.classList.remove('host-gameplay');
}

function renderMissionRail() {
    const rail = document.getElementById('host-mission-rail');
    rail.replaceChildren();
    for (let index = 0; index < 5; index++) {
        const history = missionHistory[index];
        const result = missionResults[index];
        const current = !result && index === currentMission;
        const item = document.createElement('section');
        item.className = `host-mission-summary ${result || (current ? 'current' : 'future')}`;

        const heading = document.createElement('div');
        heading.className = 'host-mission-summary-heading';
        const title = document.createElement('strong');
        title.textContent = `Mission ${index + 1}`;
        const state = document.createElement('span');
        state.textContent = result === 'pass' ? 'Succeeded' : result === 'fail' ? 'Failed' : current ? 'Current' : 'Upcoming';
        heading.append(title, state);
        item.appendChild(heading);

        const requirement = document.createElement('p');
        const size = missionSizes[index] || '?';
        requirement.textContent = `${size} knight${size === 1 ? '' : 's'}${index === 3 && players.length >= 7 ? ' · 2 fails required' : ''}`;
        item.appendChild(requirement);

        if (history) {
            const leader = document.createElement('p');
            leader.textContent = `Led by ${history.leader_name}`;
            const party = document.createElement('p');
            party.className = 'host-mission-party';
            party.textContent = (history.team || []).join(', ');
            const cards = document.createElement('small');
            cards.textContent = `${history.success_count} success · ${history.fail_count} failure${history.fail_count === 1 ? '' : 's'}`;
            item.append(leader, party, cards);
        } else if (current && currentLeaderName) {
            const leader = document.createElement('p');
            leader.textContent = `${currentLeaderName} leads this mission`;
            item.appendChild(leader);
        }
        rail.appendChild(item);
    }
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
    renderMissionRail();
}

function formatElapsed(seconds) {
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function updateGameStats() {
    const failCount = missionResults.filter(r => r === 'fail').length;
    document.getElementById('host-fails').textContent = `${failCount}/3`;
    document.querySelectorAll('.host-fail-tokens i').forEach((token, index) => {
        token.classList.toggle('active', index < failCount);
    });
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
function startGameClock(epochSeconds, elapsedSeconds = null) {
    if (!epochSeconds && elapsedSeconds == null) return;
    gameStartedAt = elapsedSeconds == null
        ? Number(epochSeconds) * 1000
        : Date.now() - Number(elapsedSeconds) * 1000;
    clearInterval(gameClockInterval);
    updateGameStats();
    gameClockInterval = setInterval(updateGameStats, 1000);
}

function updateLeaderDisplay(name) {
    const display = document.getElementById('leader-display');
    display.replaceChildren(document.createTextNode('Leader: '));
    const identity = createLeaderIdentity(name);
    display.appendChild(identity);
}

function createLeaderIdentity(name) {
    const identity = document.createElement('span');
    identity.className = 'leader-identity';
    const leader = players.find(player => player.name === name);
    if (leader && leader.avatar_image) {
        identity.classList.add('has-selfie');
        const selfie = document.createElement('img');
        selfie.className = 'leader-selfie';
        selfie.src = leader.avatar_image;
        selfie.alt = '';
        identity.appendChild(selfie);
    }
    const label = document.createElement('span');
    label.textContent = name || '—';
    identity.appendChild(label);
    return identity;
}

function renderLeaderName(elementId, name) {
    const element = document.getElementById(elementId);
    element.replaceChildren(createLeaderIdentity(name));
}

function playChatChime() {
    if (!isPairedDisplay || !tvChatEnabled || !gameStartedAt || document.visibilityState === 'hidden') return;
    try {
        chatAudioContext ||= new (window.AudioContext || window.webkitAudioContext)();
        if (chatAudioContext.state === 'suspended') chatAudioContext.resume().catch(() => {});
        const oscillator = chatAudioContext.createOscillator();
        const gain = chatAudioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(660, chatAudioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(880, chatAudioContext.currentTime + 0.08);
        gain.gain.setValueAtTime(0.0001, chatAudioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.055, chatAudioContext.currentTime + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, chatAudioContext.currentTime + 0.13);
        oscillator.connect(gain).connect(chatAudioContext.destination);
        oscillator.start();
        oscillator.stop(chatAudioContext.currentTime + 0.14);
    } catch (_) { /* Audio is optional and may be blocked by the display browser. */ }
}

function showHostRoomCode(code) {
    const badge = document.getElementById('host-room-code-badge');
    badge.querySelector('strong').textContent = code || '----';
}

function renderSpectatorCount(count = 0) {
    const element = document.getElementById('host-spectator-count');
    const total = Math.max(0, Number(count) || 0);
    element.textContent = `◈ ${total} spectator${total === 1 ? '' : 's'}`;
    element.classList.toggle('hidden', !isPairedDisplay);
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

function renderReorderList(playerList) {
    const list = document.getElementById('reorder-list');
    if (!list) return;
    list.innerHTML = '';
    playerList.forEach((p, i) => {
        const li = document.createElement('li');
        li.className = 'reorder-item';
        li.innerHTML = `<span class="reorder-num">${i + 1}</span>${escapeHtml(p.name)}${p.ready ? '<span class="ready-mark">✓ Ready</span>' : ''}`;
        list.appendChild(li);
    });
}

function renderLobbyPlayers(playerList) {
    players = playerList;
    presenceTable.setGameStatus({ mode: 'lobby' });
    syncPresencePlayers(playerList);
    renderRoundTable(playerList);
    renderReorderList(playerList);
    const n = playerList.length;
    const dot = document.getElementById('player-count-dot');
    const txt = document.getElementById('player-count-text');
    const disconnected = playerList.filter(player => !player.connected);
    const valid = n >= 6 && n <= 10 && disconnected.length === 0;
    dot.className = 'count-dot ' + (valid ? 'valid' : (n > 0 ? 'invalid' : ''));
    txt.textContent = `${n} / 10 Players`;
    const ready = playerList.filter(player => player.ready).length;
    const readySummary = document.getElementById('host-ready-summary');
    readySummary.querySelector('strong').textContent = `${ready} ready`;
    readySummary.querySelector('span').textContent = `${n - ready} not ready`;
    const notReadyNames = playerList.filter(player => !player.ready).map(player => player.name);
    document.getElementById('host-ready-detail').textContent = disconnected.length
        ? `Waiting for ${disconnected.map(player => player.name).join(', ')} to reconnect`
        : notReadyNames.length
            ? `Not ready: ${notReadyNames.join(', ')}`
            : n ? 'Every player is ready' : 'Waiting for players to join';
}

function renderProposalSetting(seconds) {
    proposalDuration = Number(seconds) || 0;
}

function renderDiscussionSetting(seconds) {
    discussionDuration = Number(seconds);
    if (!Number.isFinite(discussionDuration)) discussionDuration = 60;
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
    if (!max) {
        ring.style.strokeDashoffset = 0;
        ring.classList.remove('warning');
        if (textEl) {
            textEl.classList.remove('warning');
            textEl.textContent = '∞';
        }
        return;
    }
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
    container.replaceChildren();
    const entries = Object.entries(votes);
    entries.forEach(([name, vote], i) => {
        const card = document.createElement('div');
        card.className = `vote-avatar-card ${vote}`;
        const player = players.find(candidate => candidate.name === name) || {};
        const portrait = document.createElement('span');
        portrait.className = 'vote-avatar-portrait';
        portrait.appendChild(presenceTable.createPortraitElement(
            player.avatar_index,
            player.color_index,
            player.avatar_image
        ));
        const label = document.createElement('span');
        label.className = 'vote-avatar-name';
        label.textContent = name;
        const stamp = document.createElement('span');
        stamp.className = 'vote-avatar-stamp';
        stamp.innerHTML = `<b>${vote === 'approve' ? '✓' : '×'}</b><strong>${vote.toUpperCase()}</strong>`;
        card.append(portrait, label, stamp);
        container.appendChild(card);
        setTimeout(() => {
            card.classList.add('revealed');
        }, 650 + i * 700);
    });
    setTimeout(() => {
        const approved = entries.filter(([,v]) => v === 'approve').length;
        const rejected = entries.length - approved;
        const isApproved = approved > rejected;
        const banner = document.getElementById('vote-result-banner');
        banner.className = `vote-result-banner ${isApproved ? 'approved' : 'rejected'}`;
        banner.textContent = isApproved ? 'The Quest Party Rides Forth!' : 'The Court Dissents!';
        banner.classList.remove('hidden');
    }, 650 + entries.length * 700 + 900);
}

function renderHostCinematicParty(container, names = []) {
    if (!container) return;
    container.replaceChildren();
    container.dataset.count = String(names.length);
    names.forEach(name => {
        const player = players.find(candidate => candidate.name === name) || {};
        const member = document.createElement('div');
        member.className = 'cinematic-party-member';
        const portrait = document.createElement('span');
        portrait.className = 'identity-avatar-portrait';
        portrait.appendChild(presenceTable.createPortraitElement(player.avatar_index, player.color_index, player.avatar_image));
        const label = document.createElement('span');
        label.className = 'identity-avatar-name';
        label.textContent = name;
        member.append(portrait, label);
        container.appendChild(member);
    });
}

// ---------------------------------------------------------------------------
// Mission reveal animation
// ---------------------------------------------------------------------------
function animateMissionReveal(cards, { instant = false, onComplete = null } = {}) {
    const sequence = ++hostMissionRevealSequence;
    const container = document.getElementById('mission-cards-display');
    container.replaceChildren();
    const revealCard = (element, card) => {
        if (sequence !== hostMissionRevealSequence) return;
        element.className = `mission-result-card revealed-${card}`;
        element.innerHTML = card === 'success'
            ? '<span class="card-icon">☀</span><span>SUCCESS</span>'
            : '<span class="card-icon">☠</span><span>FAIL</span>';
    };
    cards.forEach((card, i) => {
        const el = document.createElement('div');
        el.className = 'mission-result-card';
        el.innerHTML = '<span class="card-icon">?</span><span>SEALED</span>';
        container.appendChild(el);
        if (instant) revealCard(el, card);
        else window.setTimeout(() => revealCard(el, card), 1200 + i * 1100);
    });
    const completeAfter = instant ? 0 : 1200 + cards.length * 1100 + 900;
    window.setTimeout(() => {
        if (sequence === hostMissionRevealSequence && onComplete) onComplete();
    }, completeAfter);
}

function showHostMissionCards(data, { instant = false } = {}) {
    latestHostMissionReveal = data;
    const cardStage = document.getElementById('host-card-reveal-stage');
    const successes = Math.max(0, Number(data.success_count) || 0);
    const failures = Math.max(0, Number(data.fail_count) || 0);
    const cards = Array.isArray(data.cards_shuffled) && data.cards_shuffled.length
        ? data.cards_shuffled
        : [
            ...Array(successes).fill('success'),
            ...Array(failures).fill('fail'),
        ];
    cardStage.classList.remove('hidden', 'is-complete');
    animateMissionReveal(cards, {
        instant,
        onComplete: () => cardStage.classList.add('is-complete'),
    });
}

function showHostMissionOutcome(data, { instant = false } = {}) {
    const passed = Boolean(data.passed);
    const reveal = document.getElementById('host-quest-reveal');
    const continuePrompt = document.getElementById('host-quest-continue');
    continuePrompt.textContent = 'Continue on your phones when ready';
    continuePrompt.classList.remove('is-ready');
    const artPath = passed ? QUEST_OUTCOME_ART.success : QUEST_OUTCOME_ART.fail;
    reveal.className = `cinematic-reveal host-quest-reveal ${passed ? 'success' : 'fail'}`;
    document.getElementById('host-quest-reveal-backdrop').src = artPath;
    const art = document.getElementById('host-quest-reveal-art');
    art.src = artPath;
    art.alt = passed
        ? 'Knights celebrating a successful quest'
        : 'Knights returning from a failed quest';

    const successes = Math.max(0, Number(data.success_count) || 0);
    const failures = Math.max(0, Number(data.fail_count) || 0);
    document.getElementById('host-mission-reveal-detail').textContent =
        `${successes} Success · ${failures} ${failures === 1 ? 'Fail' : 'Fails'}`;
    renderHostCinematicParty(document.getElementById('host-mission-result-party'), data.team || proposedTeam);
    const banner = document.getElementById('mission-result-banner');
    banner.className = 'mission-result-banner hidden';
    banner.className = `mission-result-banner ${passed ? 'pass' : 'fail'}`;
    banner.textContent = passed ? 'Quest Successful' : 'Quest Failed';
    void reveal.offsetWidth;
    requestAnimationFrame(() => reveal.classList.add('is-revealed'));
    window.setTimeout(() => continuePrompt.classList.add('is-ready'), instant ? 0 : 3200);
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
        proposals.filter(item => item.mission_num === mission.mission_num && item.forced).forEach(item => {
            const forced = document.createElement('small');
            forced.textContent = `${item.leader_name} selected the binding fifth party`;
            section.appendChild(forced);
        });
        container.appendChild(section);
    });
    proposals.filter(item => !completedMissionNumbers.has(item.mission_num)).forEach(item => {
        const section = document.createElement('section');
        section.className = `chronicle-entry${item.forced ? '' : ' rejected'}`;
        section.textContent = item.forced
            ? `Mission ${item.mission_num}: ${item.leader_name} selected the binding fifth party`
            : `Mission ${item.mission_num}: ${item.leader_name}’s party was rejected ${item.approve_count}–${item.reject_count}`;
        container.appendChild(section);
    });
}

// ---------------------------------------------------------------------------
// Game over: role reveal
// ---------------------------------------------------------------------------
function gameWinReason(summary) {
    const reasons = {
        missions: summary.winner === 'good' ? 'Good completed 3 quests' : 'Evil failed 3 quests',
        assassination: 'The Assassin struck down Merlin',
        assassination_failed: 'The Assassin missed Merlin',
        rejections: 'Five consecutive teams were rejected',
    };
    return reasons[summary.win_reason] || summary.win_reason || 'The struggle for Avalon is over';
}

function completeGameOutcomeAnnouncement() {
    const announcement = document.getElementById('game-outcome-announcement-host');
    announcement.classList.add('is-complete');
    announcement.setAttribute('aria-hidden', 'true');
    const content = document.querySelector('#screen-game-over .game-over-content');
    content?.removeAttribute('aria-hidden');
    if (content) content.inert = false;
    gameOutcomeTimer = null;
}

function showGameOutcomeAnnouncement(summary) {
    const winner = summary.winner === 'evil' ? 'evil' : 'good';
    if (
        summary.win_reason === 'assassination'
        && window.AVALON_ASSASSINATION_REVEAL_ENABLED
    ) {
        clearTimeout(gameOutcomeTimer);
        gameOutcomeTimer = null;
        const announcement = document.getElementById('game-outcome-announcement-host');
        announcement.className = 'cinematic-reveal game-outcome-announcement is-complete';
        announcement.setAttribute('aria-hidden', 'true');
        return;
    }
    const key = `${gameCode || '----'}:${gameStartedAt || 'unknown'}:${winner}:${summary.win_reason || 'unknown'}`;
    if (lastGameOutcomeAnnouncementKey === key) return;
    lastGameOutcomeAnnouncementKey = key;
    clearTimeout(gameOutcomeTimer);

    const announcement = document.getElementById('game-outcome-announcement-host');
    const artPath = GAME_OUTCOME_ART[winner];
    const content = document.querySelector('#screen-game-over .game-over-content');
    content?.setAttribute('aria-hidden', 'true');
    if (content) content.inert = true;
    announcement.className = `cinematic-reveal game-outcome-announcement ${winner}`;
    announcement.setAttribute('aria-hidden', 'false');
    document.getElementById('game-outcome-backdrop-host').src = artPath;
    const art = document.getElementById('game-outcome-art-host');
    art.src = artPath;
    art.alt = winner === 'good'
        ? 'Camelot illuminated after victory by the forces of good'
        : 'Camelot fallen under the forces of evil';
    document.getElementById('game-outcome-title-host').textContent = winner === 'good'
        ? 'Good Wins'
        : 'Evil Wins';
    document.getElementById('game-outcome-detail-host').textContent = gameWinReason(summary);
    void announcement.offsetWidth;
    requestAnimationFrame(() => announcement.classList.add('is-revealed'));
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1200 : 5800;
    gameOutcomeTimer = window.setTimeout(completeGameOutcomeAnnouncement, duration);
}

function resetGameOutcomeAnnouncement() {
    clearTimeout(gameOutcomeTimer);
    gameOutcomeTimer = null;
    lastGameOutcomeAnnouncementKey = null;
    const announcement = document.getElementById('game-outcome-announcement-host');
    announcement.className = 'cinematic-reveal game-outcome-announcement is-complete';
    announcement.setAttribute('aria-hidden', 'true');
    const content = document.querySelector('#screen-game-over .game-over-content');
    content?.removeAttribute('aria-hidden');
    if (content) content.inert = false;
}

function renderGameOver(summary, { announce = true } = {}) {
    if (summary.win_reason === 'rejections') consecutiveRejections = 5;
    updateHostProposalTrack();
    const banner = document.getElementById('game-over-banner');
    const reasonEl = document.getElementById('win-reason-text');
    const grid = document.getElementById('roles-reveal-grid');
    const gameOverScreen = document.getElementById('screen-game-over');
    gameOverScreen.classList.toggle('winner-good', summary.winner === 'good');
    gameOverScreen.classList.toggle('winner-evil', summary.winner !== 'good');

    banner.className = `game-over-banner ${summary.winner === 'good' ? 'good-wins' : 'evil-wins'}`;
    banner.textContent = summary.winner === 'good' ? 'GOOD WINS' : 'EVIL WINS';
    flash(summary.winner === 'good' ? 'blue' : 'red', 800);
    hideGameHeader();

    reasonEl.textContent = gameWinReason(summary);

    grid.replaceChildren();
    grid.classList.add('hidden');
    presenceTable.setRoleReveal(summary.roles || {});
    renderVictoryCard(document.getElementById('victory-group-card-host'), summary);
    renderRematchStatus(document.getElementById('rematch-status-host'), {
        ready_count: 0,
        total_count: (summary.players || []).length,
        ready_names: [],
    });
    renderChronicle(document.getElementById('chronicle-host'), summary);
    if (announce) showGameOutcomeAnnouncement(summary);
}

function renderVictoryCard(card, summary) {
    if (!card) return;
    const winner = summary.winner === 'evil' ? 'evil' : 'good';
    const winningPlayers = (summary.players || []).filter(player => player.team === winner);
    card.classList.toggle('evil', winner === 'evil');
    card.querySelector('.victory-card-title').textContent = winner === 'good'
        ? 'Defenders of Avalon'
        : 'Conquerors of Camelot';
    card.querySelector('.victory-card-subtitle').textContent = winner === 'good'
        ? 'The loyal fellowship preserved the realm.'
        : 'The servants of Mordred claimed the realm.';
    card.querySelector('.victory-card-room').textContent = `ROOM ${gameCode || '----'}`;
    const party = card.querySelector('.victory-card-party');
    party.replaceChildren();
    winningPlayers.forEach(player => {
        const person = document.createElement('div');
        person.className = 'victory-person';
        const portrait = document.createElement('div');
        portrait.className = 'victory-person-portrait';
        if (player.avatar_image) {
            const image = document.createElement('img');
            image.src = player.avatar_image;
            image.alt = '';
            portrait.appendChild(image);
        } else {
            portrait.appendChild(presenceTable.createPortraitElement(player.avatar_index, player.color_index));
        }
        const name = document.createElement('strong');
        name.textContent = player.name;
        const role = document.createElement('small');
        role.textContent = player.role;
        person.append(portrait, name, role);
        party.appendChild(person);
    });
}

function renderRematchStatus(element, data) {
    if (!element) return;
    const total = Number(data.total_count) || 0;
    const ready = Number(data.ready_count) || 0;
    const names = data.ready_names || [];
    element.textContent = total
        ? `${ready} of ${total} ready${names.length ? ` · ${names.join(', ')}` : ''}`
        : 'Waiting for players to choose “Run It Back”…';
}

function renderDiscussionSpotlight(data = {}) {
    const banner = document.getElementById('host-discussion-spotlight');
    if (!data.player_name) {
        banner.classList.add('hidden');
        banner.textContent = '';
        return;
    }
    banner.textContent = `♜ THE COURT CALLS ON ${data.player_name.toUpperCase()} · DEFEND YOUR CASE`;
    banner.classList.remove('hidden');
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
// SocketIO events
// ---------------------------------------------------------------------------

socket.on('connect', () => {
    track(socketConnectionCount ? 'socket_reconnected' : 'client_session_started', {
        screen_class: window.innerWidth >= 1200 ? 'tv' : 'desktop',
        display_mode: window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser',
        context: 'host_page',
        reconnect_count: socketConnectionCount,
    });
    socketConnectionCount += 1;
    const { code: stored, token: hostToken } = hostSession();
    if (stored && hostToken) {
        showConnectionStatus('Connected — restoring the host screen…');
        socket.emit('register_host_screen', {
            game_code: stored,
            host_token: hostToken,
            analytics_id: ANALYTICS_ID,
        });
    } else hideConnectionStatus();
});

document.addEventListener('visibilitychange', () => {
    track('visibility_changed', {
        visibility_state: document.visibilityState,
        session_duration_ms: Math.round(performance.now()),
    });
});

socket.on('disconnect', () => showConnectionStatus('Connection lost — reconnecting…'));
socket.on('connect_error', () => showConnectionStatus('Unable to reach the game server — retrying…'));

socket.on('display_paired', data => {
    isPairedDisplay = true;
    localStorage.setItem(PAIRED_DISPLAY_KEY, 'true');
    saveHostSession(data.room_code, data.host_token);
    document.getElementById('host-create-error').textContent = '';
    socket.emit('register_host_screen', {
        game_code: data.room_code,
        host_token: data.host_token,
        analytics_id: ANALYTICS_ID,
    });
});

socket.on('display_pairing_failed', data => {
    const button = document.getElementById('btn-pair-host-display');
    button.disabled = false;
    button.textContent = 'Pair Display';
    document.getElementById('host-create-error').textContent = data.message;
});

socket.on('host_registered', data => {
    gameCode = data.code;
    renderSpectatorCount(data.spectator_count);
    presenceTable.setRoomCode(gameCode);
    showHostRoomCode(gameCode);
    hideConnectionStatus();
    hideSuspendedDisplayRecovery();
    document.getElementById('room-code-display').textContent = gameCode;
    document.getElementById('join-url-display').textContent = `Join at ${data.join_url}`;
    updateJoinTools();
    players = data.players || [];
    playerOrder = data.player_order || players.map(player => player.name);
    missionSizes = data.mission_sizes || [];
    missionResults = data.mission_results || [];
    missionHistory = data.mission_history || [];
    tvChatMessages = data.recent_chat || [];
    currentMission = data.current_mission || 0;
    consecutiveRejections = data.consecutive_rejections || 0;
    currentLeaderName = data.current_leader || '';
    if (data.game_started_at) startGameClock(data.game_started_at, data.game_elapsed_seconds);
    updateHostProposalTrack();
    renderDiscussionSetting(data.discussion_time);
    renderProposalSetting(data.proposal_time);
    timerMax = discussionDuration;
    syncPresencePlayers(players);
    presenceTable.setPublicPositions(data.public_spectrum || {});
    presenceTable.setRoleManifest(data.role_manifest || []);
    if (data.phase !== 'LOBBY') {
        const status = {
            mode: data.phase === 'TEAM_VOTE' ? 'vote' : data.phase === 'MISSION' ? 'mission' : 'game',
            leaderName: currentLeaderName,
        };
        if (data.phase === 'TEAM_VOTE') status.completedNames = Object.keys(data.votes || {});
        if (data.phase === 'MISSION') status.completedIds = data.mission_cards_played_ids || [];
        presenceTable.setGameStatus(status);
    }
    renderTvChat();

    if (data.phase === 'LOBBY') {
        transition('screen-lobby');
        renderLobbyPlayers(players);
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
            'MISSION_REVEAL': 'screen-mission-cards',
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
            renderNightPending(data.night_pending_names || []);
            hideGameHeader();
        } else if (data.phase === 'TEAM_PROPOSAL') {
            renderLeaderName('proposal-leader-name', currentLeaderName);
            document.getElementById('proposal-mission-size').textContent =
                `Select ${missionSizes[currentMission] || '?'} members for the quest`;
            document.getElementById('host-forced-proposal-note').classList.toggle(
                'hidden',
                consecutiveRejections < 4,
            );
            document.getElementById('proposal-timer-host').textContent =
                data.timer_remaining === null ? 'Take the time you need' : fmtTime(data.timer_remaining);
        } else if (data.phase === 'DISCUSSION') {
            timerMax = Number(data.timer_remaining ?? data.discussion_time);
            updateTimerRing('timer-ring', timerMax, data.discussion_time);
            const spotlightPlayer = players.find(player => player.player_id === data.spotlight_player_id);
            renderDiscussionSpotlight({ player_name: spotlightPlayer?.name });
        } else if (data.phase === 'TEAM_VOTE' || data.phase === 'VOTE_REVEAL') {
            proposedTeam = data.proposed_team || [];
            document.getElementById('vote-team-names').textContent =
                proposedTeam.join(', ');
            document.getElementById('vote-reveal-team-names').textContent =
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
            renderHostCinematicParty(document.getElementById('host-mission-party'), proposedTeam);
            document.getElementById('host-mission-begins').classList.add('is-revealed');
            const acknowledged = (data.mission_intro_ack_ids || []).length;
            const required = players.filter(player => !player.is_bot).length;
            const introStatus = document.getElementById('host-mission-intro-status');
            introStatus.textContent = data.mission_choices_open
                ? 'Quest cards are being sealed'
                : `${acknowledged} of ${required} have entered the quest`;
            introStatus.classList.add('is-ready');
        } else if (data.phase === 'MISSION_REVEAL' && data.pending_mission_outcome) {
            const latest = data.latest_mission;
            if (latest) {
                showScreen('screen-mission-reveal');
                showHostMissionOutcome(latest, { instant: true });
            }
        } else if (data.phase === 'MISSION_REVEAL') {
            const latest = data.latest_mission;
            if (latest) showHostMissionCards(latest, { instant: true });
        } else if (data.phase === 'ASSASSIN_PHASE') {
            document.getElementById('assassin-choosing-text').textContent =
                `${data.assassin_name} deliberates...`;
        } else if (data.phase === 'GAME_OVER' && data.summary) {
            renderGameOver(data.summary);
            const readyIds = data.rematch_ready_ids || [];
            const eligible = data.summary.players || [];
            renderRematchStatus(document.getElementById('rematch-status-host'), {
                ready_count: readyIds.length,
                total_count: eligible.length,
                ready_names: eligible.filter(player => readyIds.includes(player.player_id)).map(player => player.name),
            });
        }
    }
    if (data.suspended) {
        showSuspendedDisplayRecovery();
    }
});

socket.on('room_suspended', () => {
    showSuspendedDisplayRecovery();
});

socket.on('room_resumed', () => {
    hideConnectionStatus();
    hideSuspendedDisplayRecovery();
});

socket.on('player_joined', data => {
    players = data.players || [];
    syncPresencePlayers(players);
    presenceTable.setRoleManifest(data.role_manifest || []);
    renderLobbyPlayers(players);
});

socket.on('player_disconnected', data => {
    players = data.players || [];
    syncPresencePlayers(players);
    if (currentPhase === 'lobby') renderLobbyPlayers(players);
    else renderRoundTable(players);
});

socket.on('player_reconnected', data => {
    players = data.players || [];
    syncPresencePlayers(players);
    if (currentPhase === 'lobby') renderLobbyPlayers(players);
    else renderRoundTable(players);
});

socket.on('lobby_update', data => {
    players = data.players || [];
    if (data.player_order) {
        const byName = new Map(players.map(player => [player.name, player]));
        players = data.player_order.map(name => byName.get(name)).filter(Boolean);
        playerOrder = data.player_order;
    }
    renderLobbyPlayers(players);
    presenceTable.setPublicPositions(data.public_spectrum || {});
    presenceTable.setRoleManifest(data.role_manifest || []);
    if (data.settings) {
        renderDiscussionSetting(data.settings.discussion_time);
        renderProposalSetting(data.settings.proposal_time);
    }
});

socket.on('public_spectrum_updated', data => {
    presenceTable.setPublicPositions(data.positions || {});
});

socket.on('game_starting', data => {
    players = players; // keep
    presenceTable.setGameStatus({ mode: 'game' });
    startGameClock(data.game_started_at);
    flash('white', 500);
    renderTvChat();
});

socket.on('night_phase_start', data => {
    presenceTable.setGameStatus({ mode: 'game' });
    spawnStars();
    document.getElementById('night-total').textContent = data.total_players;
    document.getElementById('night-confirmed').textContent = data.confirmed || 0;
    renderNightPending(data.pending_names || players.map(player => player.name));
    hideGameHeader();
    transition('screen-night');
});

socket.on('night_phase_progress', data => {
    document.getElementById('night-confirmed').textContent = data.confirmed;
    document.getElementById('night-total').textContent = data.total;
    renderNightPending(data.pending_names || []);
});

socket.on('night_phase_complete', () => {
    // Transition happens on round_start
});

socket.on('round_start', data => {
    currentMission = data.mission_num - 1;
    currentLeaderName = data.leader_name;
    presenceTable.setGameStatus({ mode: 'game', leaderName: data.leader_name });
    consecutiveRejections = data.reject_count;
    missionResults = data.mission_results || [];
    missionHistory = data.mission_history || missionHistory;
    missionSizes = data.mission_sizes || [];
    if (data.player_order) playerOrder = data.player_order;
    syncPresencePlayers(players);

    document.getElementById('round-title').textContent = `Mission ${data.mission_num}`;
    renderLeaderName('round-leader-name', data.leader_name);
    updateMissionTracker();
    updateGameStats();
    updateLeaderDisplay(data.leader_name);
    showGameHeader();
    transition('screen-round');
    renderDiscussionSpotlight();
});

socket.on('discussion_start', data => {
    timerMax = data.duration_seconds;
    updateTimerRing('timer-ring', timerMax, timerMax);
    renderDiscussionSpotlight();
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

socket.on('discussion_spotlight', data => {
    renderDiscussionSpotlight(data);
});

socket.on('proposal_start', data => {
    currentLeaderName = data.leader_name;
    presenceTable.setGameStatus({ mode: 'game', leaderId: data.leader_id, leaderName: data.leader_name });
    updateLeaderDisplay(data.leader_name);
    proposedTeam = [];
    renderLeaderName('proposal-leader-name', data.leader_name);
    document.getElementById('proposal-mission-size').textContent =
        `Select ${data.mission_size} members for the quest`;
    document.getElementById('host-forced-proposal-note').classList.toggle('hidden', !data.forced);
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
    presenceTable.setGameStatus({ mode: 'vote', leaderName: currentLeaderName });
    document.getElementById('vote-team-names').textContent = proposedTeam.join(', ');
    document.getElementById('vote-leader-label').textContent = `${currentLeaderName} proposes:`;
    renderVoteStatus([], pendingVoters);
    transition('screen-vote');
});

socket.on('vote_waiting', data => {
    renderVoteStatus(data.voted || [], data.remaining || []);
    presenceTable.setGameStatus({
        mode: 'vote',
        leaderName: currentLeaderName,
        completedNames: data.voted || [],
    });
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
    document.getElementById('vote-reveal-team-names').textContent = proposedTeam.join(', ');
    transition('screen-vote-reveal');
    setTimeout(() => animateVoteReveal(data.votes), 400);
});

socket.on('spectator_count_updated', data => {
    renderSpectatorCount(data.spectator_count);
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
    presenceTable.setGameStatus({ mode: 'mission', leaderName: currentLeaderName });
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
    renderHostCinematicParty(document.getElementById('host-mission-party'), proposedTeam);
    const product = document.getElementById('host-mission-begins');
    product.classList.remove('is-revealed');
    document.getElementById('host-mission-intro-status').classList.remove('is-ready');
    transition('screen-mission');
    window.setTimeout(() => product.classList.add('is-revealed'), 320);
    window.setTimeout(() => document.getElementById('host-mission-intro-status').classList.add('is-ready'), 2200);
});

socket.on('mission_intro_status', data => {
    const status = document.getElementById('host-mission-intro-status');
    status.textContent = data.complete
        ? 'The fellowship has entered · quest cards await'
        : `${data.acknowledged_count} of ${data.required_count} have entered the quest`;
});

socket.on('mission_choices_open', () => {
    document.getElementById('host-mission-intro-status').textContent = 'Quest cards are being sealed';
});

socket.on('vote_reveal_ack_status', data => {
    const banner = document.getElementById('vote-result-banner');
    if (!banner.classList.contains('hidden')) {
        banner.dataset.readyStatus = `${data.acknowledged_count} of ${data.required_count} ready`;
    }
});

socket.on('mission_reveal_ack_status', data => {
    const prompt = document.getElementById('host-quest-continue');
    prompt.textContent = data.complete
        ? 'The fellowship rides onward'
        : `${data.acknowledged_count} of ${data.required_count} ready to continue`;
});

socket.on('mission_waiting', data => {
    renderMissionStatus(data);
});

function renderMissionStatus(data) {
    document.getElementById('mission-played').textContent = data.played;
    document.getElementById('mission-total').textContent = data.total;
    const playedIds = new Set(data.played_player_ids || []);
    const playedNames = new Set(data.played_players || []);
    presenceTable.setGameStatus({
        mode: 'mission',
        leaderName: currentLeaderName,
        completedIds: data.played_player_ids || [],
        completedNames: data.played_players || [],
    });
    document.querySelectorAll('.mission-member-card').forEach(card => {
        card.classList.toggle(
            'played',
            playedIds.has(card.dataset.playerId) || playedNames.has(card.dataset.name),
        );
    });
}

socket.on('mission_reveal', data => {
    latestHostMissionReveal = data;
    transition('screen-mission-cards');
    window.setTimeout(() => showHostMissionCards(data), 420);
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

socket.on('mission_complete', () => {
    if (!latestHostMissionReveal) return;
    transition('screen-mission-reveal');
    window.setTimeout(() => showHostMissionOutcome(latestHostMissionReveal), 520);
});

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
    renderGameOver(data, { announce: false });
    transition('screen-game-over');
    window.setTimeout(() => showGameOutcomeAnnouncement(data), 320);
    track('victory_screen_viewed', { context: data.win_reason || 'unknown' });
    track('rematch_prompt_viewed', { context: 'host_display' });
});

socket.on('rematch_status', data => {
    renderRematchStatus(document.getElementById('rematch-status-host'), data);
});

socket.on('chat_message', data => {
    tvChatMessages.push(data);
    if (tvChatMessages.length > 20) tvChatMessages.shift();
    renderTvChat();
    playChatChime();
});

socket.on('return_to_lobby', data => {
    clearInterval(gameClockInterval); gameClockInterval = null; gameStartedAt = null;
    resetGameOutcomeAnnouncement();
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
    renderDiscussionSpotlight();
    if (data.settings) {
        renderDiscussionSetting(data.settings.discussion_time);
        renderProposalSetting(data.settings.proposal_time);
    }
    renderLobbyPlayers(players);
    transition('screen-lobby');
});

socket.on('game_ended', () => {
    clearInterval(gameClockInterval);
    resetGameOutcomeAnnouncement();
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
    renderSpectatorCount(0);
    updateJoinTools();
    renderTvChat();
    renderLobbyPlayers([]);
    transition('screen-title');
});

socket.on('error', data => {
    console.warn('[server error]', data.message);
    const errorEl = document.getElementById('host-create-error');
    if (errorEl && document.getElementById('screen-title').classList.contains('active')) {
        errorEl.textContent = data.message;
    }
    if (/host authorization invalid|Game not found/i.test(data.message || '')) {
        clearHostSession();
        showHostRoomCode('');
        hideConnectionStatus();
        showScreen('screen-title');
        document.getElementById('host-create-error').textContent =
            'That display session is no longer available. Generate a new pairing code on the host phone.';
    }
});

// ---------------------------------------------------------------------------
// UI event listeners
// ---------------------------------------------------------------------------

document.getElementById('btn-forget-saved-display').addEventListener('click', () => {
    clearHostSession();
    localStorage.removeItem(PAIRED_DISPLAY_KEY);
    isPairedDisplay = false;
    gameCode = null;
    presenceTable.hide();
    presenceTable.setRoomCode('');
    showHostRoomCode('');
    hideConnectionStatus();
    hideSuspendedDisplayRecovery();
    showScreen('screen-title');
    document.getElementById('host-pair-room').value = '';
    document.getElementById('host-pair-code').value = '';
    document.getElementById('host-create-error').textContent =
        'This display is ready to pair. The saved game remains recoverable from a player phone.';
    socket.disconnect();
    window.setTimeout(() => socket.connect(), 50);
});

document.getElementById('host-pair-room').addEventListener('input', event => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});
document.getElementById('host-pair-code').addEventListener('input', event => {
    event.target.value = event.target.value.replace(/\D/g, '');
});
document.getElementById('host-pair-code').addEventListener('keydown', event => {
    if (event.key === 'Enter') document.getElementById('btn-pair-host-display').click();
});
document.getElementById('btn-pair-host-display').addEventListener('click', event => {
    const roomCode = document.getElementById('host-pair-room').value.trim().toUpperCase();
    const pairingCode = document.getElementById('host-pair-code').value.trim();
    const error = document.getElementById('host-create-error');
    error.textContent = '';
    if (roomCode.length !== 4 || pairingCode.length !== 6) {
        error.textContent = 'Enter the four-letter room and six-digit display code.';
        return;
    }
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Pairing…';
    socket.emit('pair_host_display', {
        room_code: roomCode,
        pairing_code: pairingCode,
        analytics_id: ANALYTICS_ID,
    });
});
