/* ============================================================
   AVALON — Host Screen JS
   ============================================================ */

const socket = io();
// Presentation-only layer (narrator voice, sound, spectacle); see showtime.js.
const ST = window.AvalonShowtime || null;
const connectionStatus = document.getElementById('connection-status');
const presenceTable = new AvalonPresenceTable({
    mode: 'host',
});
const HOST_CODE_KEY = 'avalon-host-game-code';
const HOST_TOKEN_KEY = 'avalon-host-token';
const PAIRED_DISPLAY_KEY = 'avalon-host-is-paired-display';
const ANALYTICS_ID_KEY = 'avalon-analytics-id';

function loadDeferredArtwork(root = document) {
    root.querySelectorAll('img[data-src]').forEach(image => {
        image.src = image.dataset.src;
        image.removeAttribute('data-src');
    });
    const backgrounds = root.matches?.('[data-deferred-background]') ? [root] : [];
    backgrounds.push(...root.querySelectorAll('[data-deferred-background]'));
    backgrounds.forEach(element => {
        element.style.setProperty(
            '--deferred-background-art',
            `url("${element.dataset.deferredBackground}")`,
        );
        element.removeAttribute('data-deferred-background');
    });
}

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
let hostMissionOutcomeTimer = null;
let hostMissionOutcomeReadyAt = 0;

// A later phase can arrive before the quest-outcome animation timer fires (for
// example when players continue quickly after the final quest). Cancel it so a
// stale timer cannot pull this screen back to the finished quest's result.
function cancelPendingHostMissionOutcome() {
    clearTimeout(hostMissionOutcomeTimer);
    hostMissionOutcomeTimer = null;
}
let hostVoteRevealSequence = 0;
let latestHostMissionReveal = null;
let gameOutcomeTimer = null;
let lastGameOutcomeAnnouncementKey = null;
let gameStartingTimer = null;
let gameStartingUntil = 0;
let pendingPostOpeningScreen = null;
// Showtime bookkeeping (presentation only).
let lastResolvedShieldCount = -1;
let lastReadyCount = -1;
let lastNightConfirmed = 0;
let previewNames = new Set();
let lastVotedNames = new Set();
let finaleKey = null;
let honoursCeremony = null;

const QUEST_CARD_FLIP_MS = 820;
const QUEST_OUTCOME_HOLD_MS = 3500;

const HOST_MUSIC_TRACKS = {
    'quiet-night': '/static/music/loops/quiet-night.mp3',
    'celtic-realm': '/static/music/loops/celtic-realm.mp3',
    'waterfall-citadel': '/static/music/loops/waterfall-citadel.mp3',
};
const VOTE_RESULT_FLAVOR = {
    approved: [
        'The court lends its trust. The chosen fellowship rides for Avalon.',
        'With the council’s blessing, the questing party sets forth.',
        'The banners rise. This fellowship now carries the realm’s hope.',
        'Consent is given, though trust remains a dangerous wager.',
    ],
    rejected: [
        'Trust fractures at the table. A new fellowship must be named.',
        'The council withholds its blessing. The crown passes onward.',
        'Doubt rules the chamber. The proposed fellowship will not ride.',
        'The court refuses the call. Avalon awaits another company.',
    ],
};

const QUEST_OUTCOME_ART = {
    success: '/static/assets/quests/quest-success-alt.webp?v=20260830',
    fail: '/static/assets/quests/quest-failed-wide.webp?v=20260827-production-polish',
};

const GAME_OUTCOME_ART = {
    good: '/static/assets/results/good-wins-finale-wide.webp?v=20260829-reference-finale',
    evil: '/static/assets/results/evil-wins-finale-wide.webp?v=20260829-reference-finale',
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
    strip.classList.toggle(
        'hidden',
        !tvChatEnabled || !gameStartedAt || !tvChatMessages.length
            || document.body.classList.contains('host-cinematic-active')
    );
    strip.replaceChildren();
    tvChatMessages.slice(-3).forEach(item => {
        const line = document.createElement('div');
        line.classList.toggle('narrator', item.actor_type === 'narrator');
        const name = document.createElement('strong');
        name.textContent = item.name;
        if (item.actor_type !== 'narrator') name.dataset.i18nSkip = '';
        const spectatorLabel = document.createElement('em');
        spectatorLabel.textContent = item.is_spectator ? ' · spectator' : '';
        name.style.color = presenceTable.colorForName(item.name, item.color_index);
        const message = document.createElement('span');
        if (item.actor_type !== 'narrator') message.dataset.i18nSkip = '';
        appendLinkifiedText(message, item.message);
        line.append(name, spectatorLabel, message);
        strip.appendChild(line);
    });
}

// One candle per player; each lights when that player confirms their role.
function renderNightCandles(confirmed, total) {
    const screen = document.getElementById('screen-night');
    if (!screen) return;
    if (!screen.querySelector('.st-moon')) {
        const moon = document.createElement('div');
        moon.className = 'st-moon';
        moon.setAttribute('aria-hidden', 'true');
        screen.prepend(moon);
    }
    let row = screen.querySelector('.st-candles');
    if (!row) {
        row = document.createElement('div');
        row.className = 'st-candles';
        row.setAttribute('aria-hidden', 'true');
        screen.querySelector('.night-progress')?.before(row);
    }
    const count = Math.max(0, Math.min(10, Number(total) || 0));
    if (row.children.length !== count) {
        row.replaceChildren(...Array.from({ length: count }, () => {
            const candle = document.createElement('i');
            candle.className = 'st-candle';
            return candle;
        }));
    }
    const lit = Math.max(0, Math.min(count, Number(confirmed) || 0));
    [...row.children].forEach((candle, index) => {
        const wasLit = candle.classList.contains('lit');
        candle.classList.toggle('lit', index < lit);
        if (!wasLit && index < lit && lit > lastNightConfirmed) {
            ST?.sfx.play('j-tick-up', { gain: 0.5, delay: 60 });
            window.setTimeout(() => ST?.fx.sparkleAt(candle, 'ember', 14), 200);
        }
    });
    lastNightConfirmed = lit;
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
    const namesElement = document.createElement('span');
    namesElement.dataset.i18nSkip = '';
    namesElement.textContent = cleanNames.join(', ');
    pending.append(label, namesElement);
}


// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
function showScreen(id) {
    const previousScreenId = document.querySelector('.screen.active')?.id || null;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) {
        loadDeferredArtwork(target);
        target.classList.add('active');
    }
    currentPhase = id.replace('screen-', '');
    const isEntrySurface = id === 'screen-title' || id === 'screen-lobby';
    document.body.classList.toggle('host-entry-active', isEntrySurface);
    if (isEntrySurface) hideGameHeader();
    document.body.classList.toggle(
        'host-cinematic-active',
        id === 'screen-game-starting'
            || id === 'screen-vote-reveal'
            || id === 'screen-mission'
            || id === 'screen-mission-cards'
            || id === 'screen-mission-reveal'
            || id === 'screen-game-over',
    );
    const topMeta = document.getElementById('host-top-meta');
    topMeta.classList.toggle(
        'hidden',
        !gameCode || id === 'screen-title' || id === 'screen-lobby' || id === 'screen-game-starting',
    );
    if (previousScreenId !== id) applyScreenAmbience(id);
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
    const changing = document.querySelector('.screen.active')?.id !== id;
    if (changing) {
        ST?.sfx.synth('whoosh', { gain: 0.22, length: 0.45 }, delay);
        ST?.sfx.play('cloth', { gain: 0.6, delay: delay + 40 });
    }
    overlay.classList.add('active');
    setTimeout(() => {
        showScreen(id);
        overlay.classList.remove('active');
    }, delay + 300);
}

// Ambient particles and set dressing for each screen of the display.
function applyScreenAmbience(id) {
    if (!ST) return;
    const ambience = {
        'screen-lobby': ['mote', { rate: 5 }],
        'screen-game-starting': ['ember', { rate: 9 }],
        'screen-night': ['firefly', { rate: 3 }],
        'screen-round': ['mote', { rate: 3 }],
        'screen-proposal': ['mote', { rate: 3 }],
        'screen-assassin': ['ember', { rate: 7, palette: 'evil' }],
    }[id];
    if (ambience) ST.fx.ambient(...ambience);
    else if (id !== 'screen-game-over') ST.fx.ambient(null);
    if (id === 'screen-assassin') {
        const screen = document.getElementById('screen-assassin');
        if (!screen.querySelector('.st-spotlight')) {
            const light = document.createElement('div');
            light.className = 'st-spotlight';
            light.setAttribute('aria-hidden', 'true');
            screen.prepend(light);
        }
    }
    if (id === 'screen-lobby') document.getElementById('room-code-display')?.classList.add('st-shimmer');
}

function resetHostPresentationForRoomChange() {
    setHostMusic('off');
    closeHonoursCeremony();
    finaleKey = null;
    lastResolvedShieldCount = -1;
    lastReadyCount = -1;
    ST?.herald.stop();
    ST?.fx.clear();
    clearTimeout(gameStartingTimer);
    gameStartingTimer = null;
    gameStartingUntil = 0;
    pendingPostOpeningScreen = null;
    clearInterval(gameClockInterval);
    gameClockInterval = null;
    gameStartedAt = null;
    latestHostMissionReveal = null;
    clearTimeout(hostMissionOutcomeTimer);
    hostMissionOutcomeTimer = null;
    hostMissionOutcomeReadyAt = 0;
    hostMissionRevealSequence += 1;
    hostVoteRevealSequence += 1;
    resetGameOutcomeAnnouncement();
    hideGameHeader();
    hideSuspendedDisplayRecovery();
    document.body.classList.remove('host-gameplay', 'host-cinematic-active');
    document.getElementById('host-top-meta')?.classList.add('hidden');
    document.getElementById('host-chat-strip')?.classList.add('hidden');
    document.getElementById('host-chat-strip')?.replaceChildren();
    document.getElementById('mission-tracker')?.replaceChildren();
    document.getElementById('host-mission-rail')?.replaceChildren();
    document.getElementById('page-transition')?.classList.remove('active');
    const flashOverlay = document.getElementById('flash-overlay');
    if (flashOverlay) {
        flashOverlay.removeAttribute('class');
        flashOverlay.style.opacity = '0';
    }
    presenceTable.setRoleReveal(null);
    presenceTable.setRoleManifest([]);
    presenceTable.setGameStatus({ mode: 'lobby', completedIds: [], completedNames: [], leaderName: '' });
    document.getElementById('roles-reveal-grid')?.replaceChildren();
    document.getElementById('mission-cards-display')?.replaceChildren();
    document.getElementById('vote-cards-container')?.replaceChildren();
    const pairButton = document.getElementById('btn-pair-host-display');
    if (pairButton) {
        pairButton.disabled = false;
        pairButton.textContent = 'Pair Display';
    }
    const gameOver = document.getElementById('screen-game-over');
    gameOver?.classList.remove('winner-good', 'winner-evil');
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
    const resolved = missionResults.filter(Boolean).length;
    if (resolved > lastResolvedShieldCount && lastResolvedShieldCount >= 0) {
        const shield = tracker.querySelector(`[data-mission-index="${resolved - 1}"]`);
        if (shield) {
            shield.classList.add('st-shield-new');
            const passed = missionResults[resolved - 1] === 'pass';
            ST?.sfx.play(passed ? 'bell' : 'clang', { gain: 0.7, delay: 250 });
            window.setTimeout(() => ST?.fx.sparkleAt(shield, passed ? 'gold' : 'evil', 30), 420);
        }
    }
    lastResolvedShieldCount = resolved;
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
    label.dataset.i18nSkip = "";
    identity.appendChild(label);
    return identity;
}

function renderLeaderName(elementId, name, { crown = false } = {}) {
    const element = document.getElementById(elementId);
    const identity = createLeaderIdentity(name);
    if (crown) {
        identity.classList.add('st-crown-drop');
        ST?.sfx.play('coins', { gain: 0.5, delay: 500 });
    }
    element.replaceChildren(identity);
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
// Lobby: draggable round table + game turn order
// ---------------------------------------------------------------------------
function renderRoundTable(playerList) {
    const container = document.getElementById('lobby-round-table');
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
        li.innerHTML = `<span class="reorder-num">${i + 1}</span><span data-i18n-skip>${escapeHtml(p.name)}</span>${p.ready ? '<span class="ready-mark">✓ Ready</span>' : ''}`;
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
    if (lastReadyCount >= 0 && ready > lastReadyCount && currentPhase === 'lobby') {
        ST?.sfx.play('j-ready', { gain: 0.6 });
        ST?.fx.pulse(document.getElementById('host-ready-summary'));
    }
    lastReadyCount = ready;
    const readySummary = document.getElementById('host-ready-summary');
    readySummary.querySelector('strong').textContent = `${ready} ready`;
    readySummary.querySelector('span').textContent = `${n - ready} not ready`;
    const notReadyNames = playerList.filter(player => !player.ready).map(player => player.name);
    document.getElementById('host-ready-detail').textContent = disconnected.length
        ? `Waiting for ${disconnected.map(player => player.name).join(', ')} to reconnect`
        : notReadyNames.length
            ? `Not ready: ${notReadyNames.join(', ')}`
            : n ? 'Every player is ready' : 'Waiting for players to join';
    const footerTitle = document.getElementById('host-ready-footer-title');
    const footerCount = document.getElementById('host-ready-footer-count');
    if (footerTitle) {
        footerTitle.textContent = disconnected.length
            ? 'Waiting for the fellowship'
            : ready === n && n >= 6 ? 'The fellowship is ready' : 'Waiting for players';
    }
    if (footerCount) footerCount.textContent = `${ready} of ${Math.max(6, n)} players ready`;
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
    const sequence = ++hostVoteRevealSequence;
    const container = document.getElementById('vote-cards-container');
    container.replaceChildren();
    const entries = Object.entries(votes);
    container.dataset.playerCount = String(entries.length);
    entries.forEach(([name, vote], i) => {
        const card = document.createElement('div');
        card.className = 'cinematic-vote-card sealed';
        const player = players.find(candidate => candidate.name === name) || {};
        const portrait = document.createElement('span');
        portrait.className = 'cinematic-vote-portrait';
        portrait.classList.toggle('selfie-portrait', Boolean(player.avatar_image));
        portrait.appendChild(presenceTable.createPortraitElement(
            player.avatar_index,
            player.color_index,
            player.avatar_image
        ));
        const label = document.createElement('span');
        label.className = 'cinematic-vote-name';
        label.textContent = name;
        label.dataset.i18nSkip = "";
        const stamp = document.createElement('span');
        stamp.className = 'cinematic-vote-stamp';
        stamp.innerHTML = `<b>${vote === 'approve' ? '✓' : '×'}</b><strong>${vote.toUpperCase()}</strong>`;
        card.append(portrait, label, stamp);
        container.appendChild(card);
        setTimeout(() => {
            if (sequence !== hostVoteRevealSequence) return;
            card.className = `cinematic-vote-card ${vote} revealed`;
            tallyVote(vote);
            if (vote === 'approve') {
                ST?.sfx.play('slide', { gain: 0.9 });
                ST?.sfx.synth('shimmer', { gain: 0.07, notes: [1046.5, 1318.5, 1568] });
            } else {
                ST?.sfx.play('thud', { gain: 0.9 });
                ST?.sfx.synth('boom', { gain: 0.35, from: 90, to: 50, length: 0.35 });
            }
        }, 650 + i * 700);
    });
    // Live tally above the cards.
    const tally = ensureVoteTally();
    let approveSoFar = 0;
    let rejectSoFar = 0;
    const renderTally = () => {
        tally.querySelector('.approve b').firstChild.textContent = String(approveSoFar);
        tally.querySelector('.reject b').firstChild.textContent = String(rejectSoFar);
        const total = Math.max(1, entries.length);
        tally.querySelector('.st-vote-tally-bar .approve').style.width = `${(approveSoFar / total) * 100}%`;
        tally.querySelector('.st-vote-tally-bar .reject').style.width = `${(rejectSoFar / total) * 100}%`;
    };
    function tallyVote(vote) {
        if (vote === 'approve') approveSoFar += 1;
        else rejectSoFar += 1;
        renderTally();
        ST?.fx.pulse(tally.querySelector(vote === 'approve' ? '.approve b' : '.reject b'));
    }
    renderTally();
    const revealMs = 650 + entries.length * 700 + 900;
    ST?.herald.hold(revealMs + 400);
    ST?.sfx.synth('drumroll', { length: Math.max(1, (revealMs - 900) / 1000), gain: 0.22 }, 150);
    const resultCopy = document.getElementById('vote-result-copy-host');
    resultCopy.classList.add('hidden');
    setTimeout(() => {
        if (sequence !== hostVoteRevealSequence) return;
        const approved = entries.filter(([,v]) => v === 'approve').length;
        const rejected = entries.length - approved;
        const isApproved = approved > rejected;
        const banner = document.getElementById('vote-result-banner');
        banner.className = `vote-result-banner ${isApproved ? 'approved' : 'rejected'} st-slam`;
        banner.textContent = isApproved ? 'The Quest Party Rides Forth!' : 'The Court Dissents!';
        celebrateVoteResult({ approved, rejected, isApproved });
        document.getElementById('vote-result-flavor-host').textContent = (
            isApproved ? VOTE_RESULT_FLAVOR.approved : VOTE_RESULT_FLAVOR.rejected
        )[Math.floor(Math.random() * VOTE_RESULT_FLAVOR.approved.length)];
        document.getElementById('vote-result-ready-host').textContent = 'Continue on your phones when ready';
        resultCopy.classList.remove('hidden');
    }, 650 + entries.length * 700 + 900);
}

function ensureVoteTally() {
    let tally = document.getElementById('st-vote-tally');
    if (!tally) {
        tally = document.createElement('div');
        tally.id = 'st-vote-tally';
        tally.className = 'st-vote-tally';
        tally.setAttribute('aria-hidden', 'true');
        tally.innerHTML = `
            <span class="approve"><b>0<small>APPROVE</small></b></span>
            <div class="st-vote-tally-bar"><i class="approve"></i><i class="reject"></i></div>
            <span class="reject"><b>0<small>REJECT</small></b></span>`;
        document.getElementById('vote-cards-container')?.before(tally);
    }
    return tally;
}

function celebrateVoteResult({ approved, rejected, isApproved }) {
    if (!ST) return;
    if (isApproved) {
        ST.sfx.play('j-approve');
        ST.sfx.synth('fanfare', { gain: 0.08 }, 120);
        ST.fx.burst('confetti', { count: rejected === 0 ? 160 : 80, palette: 'gold' });
    } else {
        ST.sfx.play('j-reject');
        ST.sfx.play('stamp', { gain: 0.8 });
        ST.fx.shake(approved === 0 ? 'heavy' : 'medium');
    }
    // The MC always announces the verdict.
    {
        const cue = rejected === 0 ? 'vote.unanimous_yes'
            : approved === 0 ? 'vote.unanimous_no'
                : approved === rejected ? 'vote.tie'
                    : isApproved ? 'vote.approved' : 'vote.rejected';
        ST.herald.cue(cue, { priority: 80, ttl: 7000, pace: 'key' });
    }
    ST.herald.release();
}

function setHostMusic(trackId) {
    const player = document.getElementById('host-music-player');
    const selectedTrack = HOST_MUSIC_TRACKS[trackId];
    player.pause();
    player.removeAttribute('src');
    player.load();
    document.querySelectorAll('.host-music-button').forEach(button => {
        const selected = button.dataset.musicTrack === (selectedTrack ? trackId : 'off');
        button.classList.toggle('active', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    if (!selectedTrack) return;
    player.src = selectedTrack;
    player.volume = Number(document.getElementById('host-music-volume').value) / 100;
    player.play().catch(() => setHostMusic('off'));
}

function setHostMusicVolume(value) {
    const volume = Math.max(0, Math.min(100, Number(value)));
    const player = document.getElementById('host-music-player');
    document.querySelectorAll('.host-music-volume').forEach(slider => {
        slider.value = String(volume);
        slider.setAttribute('aria-valuetext', `${volume} percent`);
    });
    document.querySelectorAll('.host-music-volume-output').forEach(output => {
        output.value = `${volume}%`;
    });
    player.volume = volume / 100;
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
        portrait.classList.toggle('selfie-portrait', Boolean(player.avatar_image));
        portrait.appendChild(presenceTable.createPortraitElement(player.avatar_index, player.color_index, player.avatar_image));
        const label = document.createElement('span');
        label.className = 'identity-avatar-name';
        label.textContent = name;
        label.dataset.i18nSkip = "";
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
        if (instant || !ST) return;
        if (card === 'success') {
            ST.sfx.play('j-ping-up', { gain: 0.8 });
            ST.sfx.play('slide', { gain: 0.7 });
            window.setTimeout(() => ST.fx.sparkleAt(element, 'gold', 34), 60);
        } else {
            ST.sfx.play('shatter', { gain: 0.8 });
            ST.sfx.synth('boom', { gain: 0.8, from: 120, to: 36, length: 0.9 });
            flash('red', 260);
            ST.fx.shake('medium');
            window.setTimeout(() => ST.fx.sparkleAt(element, 'evil', 40), 60);
        }
    };
    cards.forEach((card, i) => {
        const el = document.createElement('div');
        el.className = `mission-result-card sealed${instant ? '' : ' st-shuffling'}`;
        el.style.setProperty('--st-dir', i % 2 ? '-1' : '1');
        el.style.setProperty('--st-index', String(i));
        container.appendChild(el);
        if (instant) revealCard(el, card);
        else {
            window.setTimeout(() => el.classList.remove('st-shuffling'), 1100);
            if (i === cards.length - 1 && cards.length > 1) {
                // The last card gets a heartbeat and a glow before it turns.
                window.setTimeout(() => {
                    if (sequence !== hostMissionRevealSequence) return;
                    el.classList.add('st-last-card');
                    ST?.sfx.synth('heartbeat', { gain: 0.75, beats: 1 });
                }, 1200 + (i - 1) * 1100 + 350);
            }
            window.setTimeout(() => revealCard(el, card), 1200 + i * 1100);
        }
    });
    if (!instant && ST) {
        ST.sfx.play('shuffle', { delay: 80 });
        ST.sfx.play('fan', { delay: 950, gain: 0.7 });
        ST.herald.cue(Math.random() < 0.5 ? 'quest.reveal' : 'quest.sealed', { priority: 74, ttl: 3500, interrupt: true, pace: 'key' });
        ST.herald.hold(1200 + cards.length * 1100 + QUEST_CARD_FLIP_MS + QUEST_OUTCOME_HOLD_MS);
    }
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
    clearTimeout(hostMissionOutcomeTimer);
    hostMissionOutcomeTimer = null;
    const finalCardDelay = cards.length ? 1200 + (cards.length - 1) * 1100 : 0;
    hostMissionOutcomeReadyAt = instant
        ? Date.now()
        : Date.now() + finalCardDelay + QUEST_CARD_FLIP_MS + QUEST_OUTCOME_HOLD_MS;
    cardStage.classList.remove('hidden', 'is-complete');
    animateMissionReveal(cards, { instant });
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
    if (!instant) celebrateQuestOutcome(passed, failures, data);
}

function celebrateQuestOutcome(passed, failures, data) {
    if (!ST) return;
    if (passed) {
        ST.sfx.play('hit-big');
        ST.sfx.synth('fanfare', { gain: 0.1 }, 200);
        ST.sfx.synth('choir', { length: 2.6, gain: 0.05 }, 150);
        window.setTimeout(() => ST.fx.cannons('gold'), 250);
    } else {
        ST.sfx.play('j-doom');
        ST.sfx.synth('gong', { gain: 0.35, base: 73 }, 100);
        ST.sfx.synth('choir', { length: 2.8, gain: 0.05, minor: true, chord: [146.83, 185, 220, 293.66] }, 250);
        ST.fx.shake('heavy');
        ST.fx.burst('ash', { count: 160, palette: 'ash' });
    }
    {
        const closeCall = passed && failures >= 1 && data.requires_double_fail;
        const firstQuestFell = !passed && Number(data.mission_num) === 1 && Math.random() < 0.6;
        const cue = closeCall ? 'quest.close_call'
            : passed ? 'quest.success'
                : failures > 1 ? 'quest.fail_many'
                    : firstQuestFell ? 'mission1.fail' : 'quest.fail_one';
        ST.herald.cue(cue, { priority: 82, ttl: 8000, pace: 'key' });
    }
    ST.herald.release();
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
    const finale = document.createElement('section');
    finale.className = `chronicle-entry chronicle-finale ${summary.winner === 'good' ? 'pass' : 'fail'}`;
    const finaleTitle = document.createElement('strong');
    finaleTitle.textContent = 'Final Reckoning';
    const finaleDetail = document.createElement('span');
    finaleDetail.textContent = gameWinReason(summary);
    finale.append(finaleTitle, finaleDetail);
    container.appendChild(finale);
    if (summary.final_word?.message) {
        const word = document.createElement('section');
        word.className = 'chronicle-entry chronicle-final-word';
        const title = document.createElement('strong');
        title.textContent = 'Court Narrator · Final Word';
        const copy = document.createElement('span');
        copy.textContent = summary.final_word.message;
        word.append(title, copy);
        container.appendChild(word);
    }
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
    const finalWord = document.getElementById('final-word-host');
    finalWord.textContent = summary.final_word?.message || '';
    finalWord.classList.toggle('hidden', !summary.final_word?.message);

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
    renderHonoursList(summary);
    if (announce) showGameOutcomeAnnouncement(summary);
}

// ---------------------------------------------------------------------------
// Showtime finale: verdict, fireworks, final word, then the Royal Honours.
// ---------------------------------------------------------------------------
function honoursAwards(summary) {
    try { return ST?.computeAwards(summary, ST.ballots()) || []; } catch (_) { return []; }
}

function renderHonoursList(summary) {
    let section = document.getElementById('host-honours');
    if (!section) {
        section = document.createElement('section');
        section.id = 'host-honours';
        section.className = 'game-chronicle st-honours-section';
        section.innerHTML = '<h3>Royal Honours</h3><div class="st-honours-list"></div>';
        document.querySelector('#screen-game-over .host-chronicle')?.before(section);
    }
    const list = section.querySelector('.st-honours-list');
    list.replaceChildren(...honoursAwards(summary).map(award => {
        const chip = document.createElement('div');
        chip.className = 'st-honour-chip';
        const icon = document.createElement('span');
        icon.textContent = award.icon;
        const title = document.createElement('strong');
        title.textContent = award.title;
        const detail = document.createElement('small');
        const name = document.createElement('b');
        name.textContent = award.name;
        name.dataset.i18nSkip = '';
        detail.append(name, document.createTextNode(` · ${award.stat}`));
        chip.append(icon, title, detail);
        return chip;
    }));
}

function runShowtimeFinale(summary) {
    if (!ST) return;
    const key = `${gameCode}:${gameStartedAt}:${summary.winner}:${summary.win_reason}`;
    if (finaleKey === key) return;
    finaleKey = key;
    const good = summary.winner === 'good';
    const assassination = summary.win_reason === 'assassination' && window.AVALON_ASSASSINATION_REVEAL_ENABLED;
    const verdictAt = assassination ? 3600 : 700;
    ST.herald.stop();
    window.setTimeout(() => {
        if (finaleKey !== key) return;
        if (good) {
            ST.sfx.play('hit-long');
            ST.sfx.synth('fanfare', { gain: 0.12 }, 150);
            ST.sfx.synth('choir', { length: 3.4, gain: 0.06 }, 100);
            ST.fx.cannons('good');
            window.setTimeout(() => ST.fx.cannons('gold'), 1400);
            ST.fx.ambient('mote', { rate: 8, palette: 'good' });
        } else {
            ST.sfx.play('j-doom');
            ST.sfx.synth('gong', { gain: 0.45, base: 65 }, 60);
            ST.sfx.synth('choir', { length: 3.6, gain: 0.06, minor: true, chord: [130.81, 164.81, 196, 261.63] }, 200);
            ST.fx.shake('heavy');
            ST.fx.burst('ash', { count: 200 });
            ST.fx.ambient('ember', { rate: 10, palette: 'evil' });
        }
    }, verdictAt);
    const reason = summary.win_reason;
    const verdict = reason === 'assassination' ? 'assassin.hit'
        : reason === 'assassination_failed' ? 'assassin.miss'
            : reason === 'rejections' ? 'end.evil_rejections'
                : good ? 'end.good' : 'end.evil_missions';
    ST.herald.cue(verdict, { priority: 96, delay: verdictAt + 500, ttl: 9000 });
    const finalVoice = summary.final_word?.voice;
    if (Array.isArray(finalVoice) && finalVoice.length) {
        ST.herald.clips(finalVoice, { priority: 90, delay: verdictAt + 900, ttl: 20000, caption: summary.final_word.message });
    }
    const awards = honoursAwards(summary);
    if (awards.length) {
        window.setTimeout(() => {
            if (finaleKey === key) startHonoursCeremony(awards, key);
        }, verdictAt + 9500);
    }
}

function closeHonoursCeremony() {
    if (!honoursCeremony) return;
    honoursCeremony.timers.forEach(clearTimeout);
    honoursCeremony.element.classList.remove('visible');
    const element = honoursCeremony.element;
    window.setTimeout(() => element.remove(), 600);
    honoursCeremony = null;
}

function buildAwardCard(award) {
    const card = document.createElement('article');
    card.className = `st-award${award.tone ? ` tone-${award.tone}` : ''}`;
    const ribbon = document.createElement('span');
    ribbon.className = 'st-award-ribbon';
    ribbon.textContent = 'Royal Honour';
    const icon = document.createElement('div');
    icon.className = 'st-award-icon';
    icon.textContent = award.icon;
    const title = document.createElement('div');
    title.className = 'st-award-title';
    title.textContent = award.title;
    const portrait = document.createElement('div');
    portrait.className = 'st-award-portrait';
    const player = award.player || {};
    if (player.avatar_image) {
        const image = document.createElement('img');
        image.src = player.avatar_image;
        image.alt = '';
        portrait.appendChild(image);
    } else {
        portrait.appendChild(presenceTable.createPortraitElement(player.avatar_index, player.color_index));
    }
    const name = document.createElement('div');
    name.className = 'st-award-name';
    name.dataset.i18nSkip = '';
    name.textContent = award.name;
    const stat = document.createElement('div');
    stat.className = 'st-award-stat';
    stat.textContent = award.stat;
    card.append(ribbon, icon, title, portrait, name, stat);
    return card;
}

function startHonoursCeremony(awards, key, waited = 0) {
    // Let the verdict and Final Word finish before the ceremony begins.
    if (ST.herald.hasPending() && waited < 12000) {
        window.setTimeout(() => {
            if (finaleKey === key) startHonoursCeremony(awards, key, waited + 500);
        }, 500);
        return;
    }
    closeHonoursCeremony();
    const element = document.createElement('div');
    element.className = 'st-honours';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', 'Royal Honours');
    element.innerHTML = '<div class="st-honours-heading">The Royal Honours</div><div class="st-honours-skip">Click anywhere to skip</div>';
    document.body.appendChild(element);
    const ceremony = { element, timers: [], key };
    honoursCeremony = ceremony;
    element.addEventListener('click', closeHonoursCeremony);
    ST.sfx.play('book-open');
    ST.sfx.play('hit-sting', { delay: 300 });
    requestAnimationFrame(() => element.classList.add('visible'));
    const voiceOn = () => ST.settings().voice && ST.ready();
    const later = (fn, ms) => ceremony.timers.push(window.setTimeout(() => {
        if (honoursCeremony === ceremony) fn();
    }, ms));
    // Each beat advances when its line finishes, or after a fallback delay.
    const beat = (cue, next, { fallbackVoice = 9000, fallbackSilent = 4200, pause = 900 } = {}) => {
        let advanced = false;
        const advance = () => {
            if (advanced || honoursCeremony !== ceremony) return;
            advanced = true;
            later(next, pause);
        };
        const queued = ST.herald.cue(cue, { priority: 85, ttl: 8000, delay: 350, onEnd: advance });
        later(advance, queued && voiceOn() ? fallbackVoice : fallbackSilent);
    };
    const showAward = index => {
        if (index >= awards.length) {
            ST.fx.cannons('gold');
            ST.sfx.play('hit-big');
            beat('awards.outro', closeHonoursCeremony, { fallbackSilent: 2600, pause: 1400 });
            return;
        }
        const award = awards[index];
        const card = buildAwardCard(award);
        element.querySelectorAll('.st-award.active').forEach(old => {
            old.classList.remove('active');
            old.classList.add('leaving');
            window.setTimeout(() => old.remove(), 520);
        });
        element.appendChild(card);
        requestAnimationFrame(() => card.classList.add('active'));
        ST.sfx.play('page');
        ST.sfx.play(award.tone === 'evil' ? 'j-sinister' : 'j-ready', { delay: 380 });
        window.setTimeout(() => ST.fx.sparkleAt(card.querySelector('.st-award-portrait'), award.tone === 'evil' ? 'evil' : 'gold', 50), 650);
        beat(award.cue, () => showAward(index + 1), { pause: 1300 });
    };
    beat('awards.intro', () => showAward(0), { fallbackSilent: 1800, pause: 400 });
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
    const roomCode = document.getElementById('finale-room-code-host');
    if (roomCode) roomCode.textContent = gameCode || '----';
    const party = card.querySelector('.victory-card-party');
    party.replaceChildren();
    winningPlayers.forEach(player => {
        const person = document.createElement('div');
        person.className = 'victory-person';
        const portrait = document.createElement('div');
        portrait.className = 'victory-person-portrait';
        if (player.avatar_image) {
            portrait.classList.add('selfie-portrait');
            const image = document.createElement('img');
            image.src = player.avatar_image;
            image.alt = '';
            portrait.appendChild(image);
        } else {
            portrait.appendChild(presenceTable.createPortraitElement(player.avatar_index, player.color_index));
        }
        const name = document.createElement('strong');
        name.textContent = player.name;
        name.dataset.i18nSkip = "";
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
    resetHostPresentationForRoomChange();
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
    loadDeferredArtwork();
    const roomChanged = Boolean(gameCode && gameCode !== data.code);
    if (roomChanged || data.phase === 'LOBBY') resetHostPresentationForRoomChange();
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
            'ROLE_ASSIGNMENT': 'screen-game-starting',
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
        if (data.phase === 'ROLE_ASSIGNMENT') {
            const opening = document.getElementById('screen-game-starting');
            opening.classList.add('is-revealed');
            const openingStatus = data.opening_status || {};
            document.getElementById('game-opening-status').textContent = openingStatus.complete
                ? 'The fellowship is ready.'
                : `${openingStatus.acknowledged_count || 0} of ${openingStatus.required_count || players.filter(player => !player.is_bot).length} players ready`;
            hideGameHeader();
        } else if (data.phase === 'NIGHT_PHASE') {
            spawnStars();
            document.getElementById('night-confirmed').textContent = data.night_confirmed || 0;
            document.getElementById('night-total').textContent = data.night_total || players.length;
            lastNightConfirmed = Number(data.night_confirmed) || 0;
            renderNightCandles(data.night_confirmed || 0, data.night_total || players.length);
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
        } else if (data.phase === 'TEAM_VOTE' || data.phase === 'VOTE_REVEAL') {
            proposedTeam = data.proposed_team || [];
            document.getElementById('vote-team-names').dataset.i18nSkip = '';
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
                card.dataset.i18nSkip = "";
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
    presenceTable.setRoleManifest(data.role_manifest || []);
    if (data.settings) {
        renderDiscussionSetting(data.settings.discussion_time);
        renderProposalSetting(data.settings.proposal_time);
    }
});

socket.on('game_starting', data => {
    players = players; // keep
    lastResolvedShieldCount = 0;
    lastNightConfirmed = 0;
    finaleKey = null;
    closeHonoursCeremony();
    presenceTable.setGameStatus({ mode: 'game' });
    startGameClock(data.game_started_at);
    flash('white', 500);
    hideGameHeader();
    gameStartingUntil = 0;
    pendingPostOpeningScreen = null;
    showScreen('screen-game-starting');
    const opening = document.getElementById('screen-game-starting');
    opening.classList.remove('is-revealed');
    void opening.offsetWidth;
    requestAnimationFrame(() => opening.classList.add('is-revealed'));
    clearTimeout(gameStartingTimer);
    gameStartingTimer = null;
    const status = document.getElementById('game-opening-status');
    if (status) status.textContent = `${data.acknowledged_count || 0} of ${data.required_count || data.player_count || 0} players ready`;
    renderTvChat();
});

socket.on('game_opening_ack_status', data => {
    const status = document.getElementById('game-opening-status');
    if (!status) return;
    status.textContent = data.complete
        ? 'The fellowship is ready.'
        : `${data.acknowledged_count || 0} of ${data.required_count || 0} players ready`;
});

socket.on('night_phase_start', data => {
    presenceTable.setGameStatus({ mode: 'game' });
    spawnStars();
    document.getElementById('night-total').textContent = data.total_players;
    document.getElementById('night-confirmed').textContent = data.confirmed || 0;
    lastNightConfirmed = Number(data.confirmed) || 0;
    renderNightCandles(data.confirmed || 0, data.total_players);
    renderNightPending(data.pending_names || players.map(player => player.name));
    hideGameHeader();
    transition('screen-night');
});

socket.on('night_phase_progress', data => {
    document.getElementById('night-confirmed').textContent = data.confirmed;
    document.getElementById('night-total').textContent = data.total;
    renderNightCandles(data.confirmed, data.total);
    renderNightPending(data.pending_names || []);
});

socket.on('night_phase_complete', () => {
    // Transition happens on round_start
});

socket.on('round_start', data => {
    cancelPendingHostMissionOutcome();
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
    renderLeaderName('round-leader-name', data.leader_name, { crown: true });
    if (!data.reject_count && ST) {
        const good = missionResults.filter(result => result === 'pass').length;
        const evil = missionResults.filter(result => result === 'fail').length;
        const finalQuest = data.mission_num === 5 || (good === 2 && evil === 2);
        window.setTimeout(() => ST.titleCard({
            eyebrow: finalQuest ? 'The final quest' : `Quest ${data.mission_num} of 5`,
            title: `Mission ${data.mission_num}`,
            subtitle: data.mission_num === 1 ? 'The fellowship gathers' : `Good ${good} · Evil ${evil}`,
            tone: finalQuest ? 'blood' : evil > good ? 'night' : 'gold',
        }), 380);
    }
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
    document.getElementById('screen-round').classList.toggle(
        'st-final-seconds',
        data.remaining_seconds <= 10 && data.remaining_seconds > 0,
    );
    if (data.remaining_seconds <= 3 && data.remaining_seconds > 0) {
        document.getElementById('screen-round').classList.add('screen-edge-warning');
        setTimeout(() => document.getElementById('screen-round').classList.remove('screen-edge-warning'), 1500);
    }
});

socket.on('discussion_end', () => {
    document.getElementById('screen-round').classList.remove('st-final-seconds');
});

socket.on('proposal_start', data => {
    currentLeaderName = data.leader_name;
    presenceTable.setGameStatus({ mode: 'game', leaderId: data.leader_id, leaderName: data.leader_name });
    updateLeaderDisplay(data.leader_name);
    proposedTeam = [];
    previewNames = new Set();
    document.getElementById('proposed-players-display').classList.remove('st-locked');
    document.querySelector('#screen-proposal .st-seal')?.remove();
    renderLeaderName('proposal-leader-name', data.leader_name, { crown: true });
    if (data.forced && ST) {
        window.setTimeout(() => ST.titleCard({
            eyebrow: 'Four parties rejected',
            title: 'Binding Proposal',
            subtitle: 'No vote. This party rides.',
            tone: 'blood',
            sound: 'hit-long',
        }), 380);
    }
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
    const names = data.team_names || [];
    let added = 0;
    names.forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'proposed-player-chip selected';
        if (!previewNames.has(name)) {
            chip.classList.add('st-new');
            added += 1;
        }
        chip.textContent = name;
        chip.dataset.i18nSkip = "";
        container.appendChild(chip);
    });
    if (added) ST?.sfx.play('token', { gain: 0.9 });
    else if (names.length < previewNames.size) ST?.sfx.play('slide', { gain: 0.5 });
    previewNames = new Set(names);
});

socket.on('team_proposed', data => {
    proposedTeam = data.team || [];
    const screen = document.getElementById('screen-proposal');
    if (!screen.querySelector('.st-seal')) {
        const seal = document.createElement('div');
        seal.className = 'st-seal';
        seal.setAttribute('aria-hidden', 'true');
        seal.textContent = 'Party Sealed';
        screen.appendChild(seal);
        ST?.sfx.play('stamp', { delay: 200 });
        ST?.fx.shake('light');
    }
    const container = document.getElementById('proposed-players-display');
    container.classList.add('st-locked');
    container.innerHTML = '';
    proposedTeam.forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'proposed-player-chip selected';
        chip.textContent = name;
        chip.dataset.i18nSkip = "";
        container.appendChild(chip);
    });
});

socket.on('vote_start', data => {
    document.getElementById('vote-result-banner').classList.add('hidden');
    proposedTeam = data.team || [];
    pendingVoters = players.map(p => p.name);
    presenceTable.setGameStatus({ mode: 'vote', leaderName: currentLeaderName });
    document.getElementById('vote-team-names').dataset.i18nSkip = '';
            document.getElementById('vote-team-names').textContent = proposedTeam.join(', ');
    document.getElementById('vote-leader-label').textContent = `${currentLeaderName} proposes:`;
    lastVotedNames = new Set();
    renderVoteStatus([], pendingVoters);
    transition('screen-vote');
    if (ST) {
        window.setTimeout(() => ST.titleCard({
            eyebrow: `Proposal ${Math.min(5, consecutiveRejections + 1)} of 5`,
            title: 'The Vote',
            subtitle: 'Approve or reject on your phones',
            tone: consecutiveRejections >= 3 ? 'blood' : 'royal',
            duration: 1900,
        }), 360);
    }
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
        const fresh = !lastVotedNames.has(name) ? ' st-just-voted' : '';
        grid.innerHTML += `<div class="vote-status-chip voted${fresh}"><span class="vote-status-icon">✓</span>${escapeHtml(name)}</div>`;
    });
    lastVotedNames = new Set(voted);
    remaining.forEach(name => {
        grid.innerHTML += `<div class="vote-status-chip"><span class="vote-status-icon">⋯</span>${escapeHtml(name)}</div>`;
    });
}

socket.on('vote_reveal', data => {
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
    ST?.fx.shake('heavy');
    ST?.sfx.play('j-doom');
    const banner = document.getElementById('vote-result-banner');
    banner.className = 'vote-result-banner rejected';
    banner.textContent = 'CHAOS REIGNS — EVIL TRIUMPHS!';
    document.getElementById('vote-result-flavor-host').textContent = 'Five fellowships have fallen to doubt. Evil claims the realm.';
    document.getElementById('vote-result-copy-host').classList.remove('hidden');
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
        card.dataset.i18nSkip = "";
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
    document.getElementById('vote-result-ready-host').textContent = data.complete
        ? 'The fellowship is ready to continue'
        : `${data.acknowledged_count} of ${data.required_count} ready to continue`;
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
    const playedElement = document.getElementById('mission-played');
    if (Number(data.played) > Number(playedElement.textContent || 0)) ST?.fx.pulse(playedElement.closest('.mission-progress') || playedElement);
    playedElement.textContent = data.played;
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
    const reveal = latestHostMissionReveal;
    clearTimeout(hostMissionOutcomeTimer);
    const delay = Math.max(0, hostMissionOutcomeReadyAt - Date.now());
    hostMissionOutcomeTimer = window.setTimeout(() => {
        hostMissionOutcomeTimer = null;
        transition('screen-mission-reveal');
        window.setTimeout(() => showHostMissionOutcome(reveal), 300);
    }, delay);
});

socket.on('assassin_phase_start', data => {
    cancelPendingHostMissionOutcome();
    document.getElementById('assassin-choosing-text').textContent =
        `${data.assassin_name} deliberates...`;
    hideGameHeader();
    transition('screen-assassin');
    if (ST) {
        window.setTimeout(() => ST.titleCard({
            eyebrow: 'Good has won three quests',
            title: 'The Assassin',
            subtitle: 'One strike. Find Merlin, and Evil steals the realm.',
            tone: 'blood',
            sound: 'hit-long',
            duration: 2600,
        }), 380);
    }
});

socket.on('assassination_result', data => {
    const text = data.was_merlin
        ? `${data.target_name} was MERLIN — Evil claims victory!`
        : `${data.target_name} was not Merlin. Good prevails!`;
    document.getElementById('assassin-choosing-text').textContent = text;
    flash(data.was_merlin ? 'red' : 'blue', 800);
});

socket.on('game_over', data => {
    cancelPendingHostMissionOutcome();
    renderGameOver(data, { announce: false });
    transition('screen-game-over');
    window.setTimeout(() => showGameOutcomeAnnouncement(data), 320);
    runShowtimeFinale(data);
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

socket.on('narrator_message', data => {
    tvChatMessages.push({ ...data, actor_type: 'narrator' });
    if (tvChatMessages.length > 20) tvChatMessages.shift();
    renderTvChat();
    playChatChime();
});

socket.on('return_to_lobby', data => {
    cancelPendingHostMissionOutcome();
    closeHonoursCeremony();
    finaleKey = null;
    lastResolvedShieldCount = -1;
    ST?.fx.clear();
    setHostMusic('off');
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
    if (data.settings) {
        renderDiscussionSetting(data.settings.discussion_time);
        renderProposalSetting(data.settings.proposal_time);
    }
    renderLobbyPlayers(players);
    transition('screen-lobby');
});

socket.on('game_ended', () => {
    closeHonoursCeremony();
    finaleKey = null;
    lastReadyCount = -1;
    // A room closed while paused must not leave its "game saved" notices behind.
    hideSuspendedDisplayRecovery();
    hideConnectionStatus();
    setHostMusic('off');
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
    setHostMusic('off');
    resetHostPresentationForRoomChange();
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

document.querySelectorAll('.host-music-button').forEach(button => {
    button.addEventListener('click', () => setHostMusic(button.dataset.musicTrack));
});
document.querySelectorAll('.host-music-volume').forEach(slider => {
    slider.addEventListener('input', event => setHostMusicVolume(event.target.value));
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
    resetHostPresentationForRoomChange();
    showScreen('screen-title');
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Pairing…';
    socket.emit('pair_host_display', {
        room_code: roomCode,
        pairing_code: pairingCode,
        analytics_id: ANALYTICS_ID,
    });
});

// Narrator and sound settings live in the display's Settings panel.
(function mountShowtimeSettings() {
    const panel = document.getElementById('display-settings');
    if (!ST || !panel || panel.querySelector('.st-settings')) return;
    const heading = document.createElement('h3');
    heading.className = 'st-settings-heading';
    heading.textContent = 'Narrator & sound';
    const section = ST.buildSettingsSection();
    const close = document.getElementById('btn-close-display-settings');
    panel.insertBefore(heading, close);
    panel.insertBefore(section, close);
    // A table display that created its own room is the host: it gets the
    // Force continue control. Displays paired into phone rooms only watch.
    let canHost = false;
    socket.on('host_registered', data => { canHost = Boolean(data.can_host); });
    ST.attachWaiting(socket, { myId: () => null, isHost: () => canHost });
    panel.insertBefore(ST.buildFlowCard({
        onForce: () => socket.emit('force_continue'),
        visible: () => canHost,
    }), heading);
}());
