/* ============================================================
   AVALON — Player Screen JS
   ============================================================ */

const socket = io();
const connectionStatus = document.getElementById('connection-status');
const presenceTable = new AvalonPresenceTable({
    mode: 'player',
    onPrivateChange: update => socket.emit('update_spectrum_ratings', update),
});
const RECONNECT_TOKEN_KEY = 'avalon-player-session-token';
const RECONNECT_PLAYER_KEY = 'avalon-player-id';
const LARGE_TEXT_KEY = 'avalon-large-text-mode';
const EXTRA_LARGE_TEXT_KEY = 'avalon-extra-large-text-mode';
const DEFAULT_TITLE = document.title;
const presenceScreenLabels = {
    'screen-lobby': 'Drag anywhere · overlap avatars to cluster',
    'screen-night': 'Night Phase',
    'screen-discussion': 'Mission Discussion',
    'screen-proposal': 'Quest Party',
    'screen-vote': 'Fellowship Vote',
    'screen-vote-reveal-player': 'The Votes Are Revealed',
    'screen-mission': 'The Quest Begins',
    'screen-mission-reveal-player': 'The Quest Returns',
    'screen-assassin': 'The Final Choice',
    'screen-game-over': 'Roles Revealed',
};

function applyLargeTextMode(enabled, extraLarge = false) {
    const large = Boolean(enabled || extraLarge);
    document.body.classList.toggle('large-text-mode', large);
    document.body.classList.toggle('extra-large-text-mode', Boolean(extraLarge));
    const toggle = document.getElementById('toggle-large-text');
    const extraToggle = document.getElementById('toggle-extra-large-text');
    if (toggle) toggle.checked = large;
    if (extraToggle) extraToggle.checked = Boolean(extraLarge);
    try {
        localStorage.setItem(LARGE_TEXT_KEY, String(large));
        localStorage.setItem(EXTRA_LARGE_TEXT_KEY, String(Boolean(extraLarge)));
    } catch (_) { /* optional */ }
}

applyLargeTextMode(
    localStorage.getItem(LARGE_TEXT_KEY) === 'true',
    localStorage.getItem(EXTRA_LARGE_TEXT_KEY) === 'true',
);

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
let myPlayerId = null;
let myName = null;
let myRole = null;
let myTeam = null;
let isHost = false;
let gameCode = null;
let currentLeaderId = null;
let proposedTeamIds = [];
let selectedTeamIds = [];
let missionRequiredSize = 0;
let nightInfo = null;
let assassinTargetId = null;
let discussionTimerMax = 300;
let latestMissionReveal = null;
let phoneBetaTestMode = false;
let phoneBetaPlayerCount = 6;

// Mission board state
let pbMissionSizes = [];
let pbMissionResults = [];
let pbMissionHistory = [];
let pbCurrentMission = 0;
let pbTotalPlayers = 0;
let pbConsecutiveRejections = 0;
let gameStartedAt = null;
let gameClockInterval = null;

// Chat state
let chatBubbleEls = [];
let chatHistory = [];
let chatHistoryOpen = false;
const MAX_CHAT_HISTORY = 200;
let presencePlayers = [];
let wakeLock = null;

function reconnectToken() {
    try {
        const token = localStorage.getItem(RECONNECT_TOKEN_KEY) || sessionStorage.getItem('session_token');
        if (token && !localStorage.getItem(RECONNECT_TOKEN_KEY)) localStorage.setItem(RECONNECT_TOKEN_KEY, token);
        return token;
    } catch (_) {
        return sessionStorage.getItem('session_token');
    }
}

function saveReconnectSession(token, playerId) {
    try {
        localStorage.setItem(RECONNECT_TOKEN_KEY, token);
        localStorage.setItem(RECONNECT_PLAYER_KEY, playerId);
    } catch (_) {
        sessionStorage.setItem('session_token', token);
        sessionStorage.setItem('player_id', playerId);
    }
}

function clearReconnectSession() {
    try {
        localStorage.removeItem(RECONNECT_TOKEN_KEY);
        localStorage.removeItem(RECONNECT_PLAYER_KEY);
    } catch (_) { /* storage is optional */ }
    sessionStorage.removeItem('session_token');
    sessionStorage.removeItem('player_id');
}

async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) { /* unsupported, denied, or not currently visible */ }
}

function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
}

function requestAttention(message = 'Your action is needed') {
    if (navigator.vibrate) navigator.vibrate(80);
    document.title = `Avalon — ${message}`;
}

function clearAttention() {
    document.title = DEFAULT_TITLE;
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && gameStartedAt) acquireWakeLock();
});

// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
    const label = presenceScreenLabels[id];
    if (label && gameCode && presencePlayers.length) presenceTable.show(target, label);
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

function flash(type = 'white', duration = 300) {
    const el = document.getElementById('flash-overlay');
    el.className = `flash-${type}`;
    el.style.opacity = 0.5;
    setTimeout(() => { el.style.opacity = 0; }, duration);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}:${String(s).padStart(2,'0')}` : sec.toString();
}

function formatElapsed(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function updateGameClock() {
    const el = document.getElementById('pb-game-time');
    if (el && gameStartedAt) el.textContent = formatElapsed(Math.max(0, Math.floor((Date.now() - gameStartedAt) / 1000)));
}
function startGameClock(epochSeconds) {
    if (!epochSeconds) return;
    gameStartedAt = Number(epochSeconds) * 1000;
    clearInterval(gameClockInterval);
    updateGameClock();
    gameClockInterval = setInterval(updateGameClock, 1000);
}
function stopGameClock() { clearInterval(gameClockInterval); gameClockInterval = null; gameStartedAt = null; }

// ---------------------------------------------------------------------------
// Player mission board
// ---------------------------------------------------------------------------
function showPlayerBoard() {
    document.getElementById('player-board').classList.remove('hidden');
    document.body.classList.add('board-visible');
}
function hidePlayerBoard() {
    document.getElementById('player-board').classList.add('hidden');
    document.body.classList.remove('board-visible');
}

function renderPlayerBoard() {
    const shieldsEl = document.getElementById('pb-shields');
    if (!shieldsEl) return;

    shieldsEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const result = pbMissionResults[i];
        const isCurrent = !result && i === pbCurrentMission;
        const stateClass = result === 'pass' ? 'pb-pass'
                         : result === 'fail'  ? 'pb-fail'
                         : isCurrent          ? 'pb-current'
                         : 'pb-future';
        const size = pbMissionSizes[i] || '?';
        const isDouble = i === 3 && pbTotalPlayers >= 7;
        const icon = result === 'pass' ? '⚔' : result === 'fail' ? '☠' : isCurrent ? '◈' : '';
        shieldsEl.innerHTML += `<div class="pb-shield ${stateClass}${pbMissionHistory[i] ? ' mission-history-clickable' : ''}" data-mission-index="${i}" ${pbMissionHistory[i] ? 'role="button" tabindex="0"' : ''}>
            ${isDouble ? '<span class="pb-double">×2</span>' : ''}
            ${icon ? `<span class="pb-icon">${icon}</span>` : `<span class="pb-num">${i + 1}</span>`}
            <span class="pb-size">${size}p</span>
        </div>`;
    }
    shieldsEl.querySelectorAll('.mission-history-clickable').forEach(shield => {
        const show = event => {
            event.stopPropagation();
            AvalonMissionTooltip.show(shield, pbMissionHistory[Number(shield.dataset.missionIndex)]);
        };
        shield.addEventListener('click', show);
        shield.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') show(event);
        });
    });

    document.getElementById('pb-fails').textContent = `${pbMissionResults.filter(r => r === 'fail').length}/3`;
    updatePlayerProposalTrack();
    updateGameClock();
}

function updateTeamCounts(counts) {
    if (!counts) return;
    document.getElementById('pb-good-count').textContent = counts.good ?? '—';
    document.getElementById('pb-evil-count').textContent = counts.evil ?? '—';
}

function updatePlayerProposalTrack() {
    const count = document.getElementById('pb-proposal');
    const row = count && count.closest('.pb-proposal-stat');
    if (!count || !row) return;
    const attempt = Math.min(5, pbConsecutiveRejections + 1);
    count.textContent = `${attempt}/5`;
    row.classList.toggle('danger', attempt >= 5);
    row.setAttribute('aria-label', `Team proposal ${attempt} of 5`);
    row.querySelectorAll('.pb-proposal-circles i').forEach((circle, index) => {
        circle.classList.toggle('active', index < attempt);
    });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function showChat() {
    document.getElementById('chat-container').classList.remove('hidden');
    document.body.classList.add('chat-visible');
}
function hideChat() {
    toggleChatHistory(false);
    document.getElementById('chat-container').classList.add('hidden');
    document.body.classList.remove('chat-visible');
}

function fmtChatTime(value = null) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}

function addChatBubble(name, message, isSelf, colorIndex = null, timestampValue = null, showBubble = true) {
    const timestamp = fmtChatTime(timestampValue);
    const playerColor = presenceTable.colorForName(name, colorIndex);

    // Add to history
    chatHistory.push({ name, message, isSelf, timestamp });
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
    const histList = document.getElementById('chat-history-list');
    if (histList) {
        const entry = document.createElement('div');
        entry.className = 'chat-history-entry';
        entry.innerHTML = `<span class="chat-name">${escapeHtml(name)}</span>${escapeHtml(message)}<span class="chat-time">${timestamp}</span>`;
        entry.querySelector('.chat-name').style.color = playerColor;
        histList.appendChild(entry);
        while (histList.children.length > MAX_CHAT_HISTORY) {
            histList.firstElementChild.remove();
        }
        // Auto-scroll to bottom if history panel is open
        if (chatHistoryOpen) {
            const panel = document.getElementById('chat-history-panel');
            if (panel) panel.scrollTop = panel.scrollHeight;
        }
    }

    // Show ephemeral bubble only if history panel is closed
    if (chatHistoryOpen || !showBubble) return;

    const container = document.getElementById('chat-bubbles');
    if (!container) return;

    // Remove oldest if at max 4
    if (chatBubbleEls.length >= 4) {
        const oldest = chatBubbleEls.shift();
        if (oldest && oldest.parentNode) oldest.parentNode.removeChild(oldest);
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble' + (isSelf ? ' self' : '');
    bubble.innerHTML = `<span class="chat-name">${escapeHtml(name)}</span>${escapeHtml(message)}`;
    bubble.querySelector('.chat-name').style.color = playerColor;
    container.appendChild(bubble);
    chatBubbleEls.push(bubble);

    setTimeout(() => {
        bubble.classList.add('fading');
        setTimeout(() => {
            if (bubble.parentNode) bubble.parentNode.removeChild(bubble);
            chatBubbleEls = chatBubbleEls.filter(b => b !== bubble);
        }, 550);
    }, 5000);
}

function restoreRecentChat(messages) {
    chatBubbleEls.forEach(bubble => bubble.remove());
    chatBubbleEls = [];
    chatHistory = [];
    document.getElementById('chat-history-list').replaceChildren();
    (messages || []).forEach(item => {
        addChatBubble(
            item.name,
            item.message,
            item.name === myName,
            item.color_index,
            item.timestamp,
            false
        );
    });
}

function toggleChatHistory(open) {
    chatHistoryOpen = open;
    const panel = document.getElementById('chat-history-panel');
    const bubbles = document.getElementById('chat-bubbles');
    const btn = document.getElementById('btn-history-toggle');
    panel.classList.toggle('hidden', !open);
    bubbles.classList.toggle('hidden', open);
    btn.classList.toggle('active', open);
    if (open) {
        // Clear lingering ephemeral bubbles and scroll history to bottom
        chatBubbleEls.forEach(b => { if (b.parentNode) b.parentNode.removeChild(b); });
        chatBubbleEls = [];
        setTimeout(() => {
            if (panel) panel.scrollTop = panel.scrollHeight;
        }, 30);
    }
}

function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = (input.value || '').trim();
    if (!msg) return;
    socket.emit('send_chat', { message: msg });
    input.value = '';
}

const ROLE_DESCRIPTIONS = {
    'Merlin':           "You see the agents of evil. Guide your allies — but beware the Assassin.",
    'Percival':         "You see two visions — one is Merlin, one is Morgana. Trust wisely.",
    'Loyal Servant':    "You fight for Arthur. Trust your instincts.",
    'Assassin':         "Sow discord. If good prevails, strike down Merlin to steal victory.",
    'Morgana':          "You appear as Merlin to Percival. Use this to deceive.",
    'Mordred':          "Even Merlin cannot see you. You are hidden from all.",
    'Oberon':           "You serve evil alone. Your allies do not know you, nor you them.",
    'Minion of Mordred':"Serve evil. Help your allies fail quests without being discovered.",
};

// ---------------------------------------------------------------------------
// Auto-join via URL param (for dev panel)
// ---------------------------------------------------------------------------
(function checkAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const devName = params.get('dev_name');
    const devCode = params.get('room_code');
    const token = reconnectToken();
    if (token) {
        socket.on('connect', () => {
            const currentToken = reconnectToken();
            if (currentToken) socket.emit('reconnect_game', { session_token: currentToken });
        });
    } else if (devName && devCode) {
        // Wait for socket connect
        socket.on('connect', () => {
            socket.emit('join_game', { room_code: devCode, player_name: devName });
        });
    }
})();

// ---------------------------------------------------------------------------
// Lobby rendering
// ---------------------------------------------------------------------------
function renderLobbyPlayers(playerList) {
    presencePlayers = playerList || [];
    presenceTable.setPlayers(presencePlayers, window._playerOrder || []);
    const me = presencePlayers.find(player => player.player_id === myPlayerId || player.name === myName);
    const readyButton = document.getElementById('btn-ready');
    if (readyButton) {
        const ready = Boolean(me && me.ready);
        readyButton.classList.toggle('ready', ready);
        readyButton.setAttribute('aria-pressed', String(ready));
        readyButton.textContent = ready ? '✓ Ready' : 'I’m Ready';
    }
    if (isHost) updateHostStartButton(playerList.length);
    renderAvatarPicker();
}

function renderPhoneBotControls(settings = {}) {
    if ('beta_test_mode' in settings) phoneBetaTestMode = Boolean(settings.beta_test_mode);
    if (Number(settings.beta_test_player_count)) {
        phoneBetaPlayerCount = Number(settings.beta_test_player_count);
    }
    const select = document.getElementById('phone-beta-player-count');
    const button = document.getElementById('btn-phone-beta-mode');
    if (!select || !button) return;
    select.value = String(phoneBetaPlayerCount);
    button.setAttribute('aria-pressed', String(phoneBetaTestMode));
    button.textContent = phoneBetaTestMode ? 'Remove Bots' : 'Add Bots';
}

function renderAvatarPicker() {
    const options = document.getElementById('avatar-options');
    if (!options) return;
    options.replaceChildren();
    const me = presencePlayers.find(player => player.player_id === myPlayerId || player.name === myName);
    const colorIndex = me ? me.color_index : 0;
    const avatarNames = window.AVALON_AVATAR_NAMES || [];
    for (let index = 0; index < 10; index++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `avatar-option${me && !me.avatar_image && Number(me.avatar_index) === index ? ' selected' : ''}`;
        button.setAttribute('aria-label', avatarNames[index] || `Medieval character ${index + 1}`);
        button.appendChild(presenceTable.createPortraitElement(index, colorIndex));
        button.addEventListener('click', () => {
            document.querySelectorAll('.avatar-option').forEach(item => item.classList.remove('selected'));
            button.classList.add('selected');
            socket.emit('select_avatar', { avatar_index: index });
        });
        options.appendChild(button);
    }
    const preview = document.getElementById('selfie-preview');
    preview.replaceChildren();
    if (me && me.avatar_image) {
        const image = document.createElement('img');
        image.src = me.avatar_image;
        image.alt = 'Your selfie';
        preview.appendChild(image);
    } else {
        preview.textContent = '📷';
    }
}

function compressSelfie(file) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
            reject(new Error('Choose an image from your camera or photo library.'));
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            reject(new Error('That photo is too large. Choose one under 10 MB.'));
            return;
        }
        const image = new Image();
        image.onload = () => {
            const size = 128;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const context = canvas.getContext('2d');
            const side = Math.min(image.naturalWidth, image.naturalHeight);
            const sx = (image.naturalWidth - side) / 2;
            const sy = (image.naturalHeight - side) / 2;
            context.drawImage(image, sx, sy, side, side, 0, 0, size, size);
            const result = canvas.toDataURL('image/jpeg', 0.72);
            if (result.length > 50_000) reject(new Error('Could not make that photo small enough.'));
            else resolve(result);
        };
        image.onerror = () => reject(new Error('That image could not be opened.'));
        const reader = new FileReader();
        reader.onload = () => { image.src = reader.result; };
        reader.onerror = () => reject(new Error('That image could not be read.'));
        reader.readAsDataURL(file);
    });
}

// ---------------------------------------------------------------------------
// Role card
// ---------------------------------------------------------------------------
function showRoleCard(role, team) {
    myRole = role;
    myTeam = team;
    const card = document.getElementById('role-card');
    const front = document.getElementById('role-card-front');
    const badge = document.getElementById('role-team-badge');
    const nameEl = document.getElementById('role-name-display');
    const descEl = document.getElementById('role-desc-display');

    front.className = `role-card-face role-card-front-face ${team}`;
    badge.className = `role-team-badge ${team}`;
    badge.textContent = team === 'good' ? 'Forces of Good' : 'Forces of Evil';
    nameEl.textContent = role;
    descEl.textContent = ROLE_DESCRIPTIONS[role] || '';

    showScreen('screen-role');

    // Shuffle then flip
    card.classList.remove('flipped', 'shuffling');
    void card.offsetWidth; // reflow
    card.classList.add('shuffling');
    setTimeout(() => {
        card.classList.remove('shuffling');
        card.classList.add('flipped');
        document.getElementById('btn-confirm-role').disabled = false;
    }, 2500);
}

// ---------------------------------------------------------------------------
// Night phase info
// ---------------------------------------------------------------------------
function showNightInfo(info) {
    nightInfo = info;
    const labelEl = document.getElementById('night-sees-label');
    const namesEl = document.getElementById('night-sees-names');
    labelEl.textContent = info.sees_label || 'Your vision';
    namesEl.innerHTML = '';
    const confirmButton = document.getElementById('btn-confirm-night');
    confirmButton.disabled = false;
    confirmButton.classList.remove('hidden');
    document.getElementById('night-waiting-text').classList.add('hidden');
    if (info.sees && info.sees.length > 0) {
        info.sees.forEach(name => {
            const div = document.createElement('div');
            // Evil players shown in red for Merlin, blue for Percival, red for evil sees-each-other
            const isPercival = myRole === 'Percival';
            div.className = 'night-sees-name' + (isPercival ? ' good-reveal' : '');
            div.textContent = name;
            namesEl.appendChild(div);
        });
    } else {
        namesEl.innerHTML = `<div class="night-no-info">${info.sees_label || 'No special knowledge'}</div>`;
    }
    showScreen('screen-night');
}

// ---------------------------------------------------------------------------
// Discussion
// ---------------------------------------------------------------------------
function showDiscussion(data) {
    const missionInfo = document.getElementById('discussion-mission-info');
    missionInfo.textContent = `Mission ${data.mission_num || '?'} — ${data.mission_size || '?'} members needed`;
    const leaderName = data.leader_name || window._currentLeaderName || 'Unknown';
    document.getElementById('discussion-leader-name').textContent = leaderName;
    const leaderBanner = document.getElementById('leader-banner');
    const amLeader = myPlayerId === data.leader_id || myPlayerId === currentLeaderId;
    leaderBanner.classList.toggle('hidden', !amLeader);
    const endDiscussion = document.getElementById('btn-end-discussion');
    endDiscussion.disabled = false;
    endDiscussion.classList.toggle('hidden', !amLeader);
    discussionTimerMax = data.duration_seconds || discussionTimerMax;
    document.getElementById('discussion-timer-player').textContent = fmtTime(discussionTimerMax);
    const screen = document.getElementById('screen-discussion');
    presenceTable.show(screen, 'Mission Discussion', document.querySelector('#screen-discussion .discussion-info'));
    showScreen('screen-discussion');
}

function showVoteReveal(data) {
    const votes = data.votes || {};
    const entries = Object.entries(votes);
    const cards = document.getElementById('player-vote-reveal-cards');
    cards.replaceChildren();
    entries.forEach(([name, vote]) => {
        const card = document.createElement('div');
        card.className = `player-reveal-card ${vote}`;
        card.innerHTML = `<span><strong>${vote === 'approve' ? 'APPROVE' : 'REJECT'}</strong>${escapeHtml(name)}</span>`;
        cards.appendChild(card);
    });
    const approvals = entries.filter(([, vote]) => vote === 'approve').length;
    const approved = approvals > entries.length - approvals;
    document.getElementById('player-vote-reveal-result').textContent = approved
        ? 'The Quest Party Rides Forth!'
        : 'The Court Dissents!';
    const amLeader = myPlayerId === currentLeaderId;
    const continueButton = document.getElementById('btn-player-confirm-vote');
    continueButton.disabled = false;
    continueButton.classList.toggle('hidden', !amLeader);
    document.getElementById('player-vote-reveal-waiting').classList.toggle('hidden', amLeader);
    showScreen('screen-vote-reveal-player');
}

function showMissionReveal(data, canContinue = false) {
    latestMissionReveal = data;
    const cards = document.getElementById('player-mission-reveal-cards');
    cards.replaceChildren();
    const revealedCards = data.cards_shuffled || [
        ...Array(data.success_count || 0).fill('success'),
        ...Array(data.fail_count || 0).fill('fail'),
    ];
    revealedCards.forEach(value => {
        const card = document.createElement('div');
        card.className = `player-reveal-card ${value}`;
        card.innerHTML = `<span><strong>${value === 'success' ? '☀ SUCCESS' : '☠ FAIL'}</strong></span>`;
        cards.appendChild(card);
    });
    document.getElementById('player-mission-reveal-result').textContent = data.passed
        ? 'The Quest Succeeds!'
        : 'The Quest Has Failed';
    const leaderCanContinue = canContinue && myPlayerId === currentLeaderId;
    const continueButton = document.getElementById('btn-player-next-round');
    continueButton.disabled = false;
    continueButton.classList.toggle('hidden', !leaderCanContinue);
    document.getElementById('player-mission-reveal-waiting').classList.toggle('hidden', leaderCanContinue);
    showScreen('screen-mission-reveal-player');
}

// ---------------------------------------------------------------------------
// Team proposal
// ---------------------------------------------------------------------------
function showProposalScreen(data) {
    const iAmLeader = myPlayerId === data.leader_id;
    missionRequiredSize = data.mission_size;
    selectedTeamIds = [];

    document.getElementById('proposal-required').textContent = data.mission_size;
    document.getElementById('proposal-selected-count').textContent = 0;

    const list = document.getElementById('player-select-list');
    list.innerHTML = '';

    const proposalWaiting = document.getElementById('proposal-waiting-text');
    const lockBtn = document.getElementById('btn-lock-team');

    if (iAmLeader) {
        proposalWaiting.classList.add('hidden');
        lockBtn.classList.remove('hidden');
        // Build player list for leader
        // We get player list from state - use stored players or rebuild
        // Emit to get current player list from server? Or use what we have.
        // We store playerOrder from round_start
        (window._playerOrder || []).forEach(name => {
            const btn = document.createElement('button');
            btn.className = 'player-select-btn';
            btn.dataset.playerId = name; // Using name as key here; server maps names to IDs
            btn.innerHTML = `${escapeHtml(name)}<span class="check-icon">✓</span>`;
            btn.addEventListener('click', () => {
                if (btn.classList.contains('selected')) {
                    btn.classList.remove('selected');
                    selectedTeamIds = selectedTeamIds.filter(n => n !== name);
                } else if (selectedTeamIds.length < missionRequiredSize) {
                    btn.classList.add('selected');
                    selectedTeamIds.push(name);
                }
                document.getElementById('proposal-selected-count').textContent = selectedTeamIds.length;
                lockBtn.disabled = selectedTeamIds.length !== missionRequiredSize;
                // Emit preview so host can show live selection
                socket.emit('preview_team', { team_names: selectedTeamIds });
            });
            list.appendChild(btn);
        });
        lockBtn.disabled = true;
    } else {
        lockBtn.classList.add('hidden');
        proposalWaiting.classList.remove('hidden');
        proposalWaiting.textContent = `Awaiting ${data.leader_name}'s decision...`;
        presenceTable.show(document.getElementById('screen-proposal'), 'Choosing the Quest Party');
    }
    showScreen('screen-proposal');
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------
function showVoteScreen(data) {
    const team = data.team || [];
    document.getElementById('vote-leader-name-player').textContent =
        data.leader_name || window._currentLeaderName || 'Leader';
    const teamList = document.getElementById('vote-team-names-player');
    teamList.innerHTML = '';
    team.forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'vote-name-chip';
        chip.textContent = name;
        teamList.appendChild(chip);
    });
    document.getElementById('vote-buttons').classList.remove('hidden');
    document.getElementById('vote-cast-waiting').classList.add('hidden');
    document.getElementById('btn-approve').disabled = false;
    document.getElementById('btn-reject').disabled = false;
    showScreen('screen-vote');
}

// ---------------------------------------------------------------------------
// Mission card play
// ---------------------------------------------------------------------------
function showMissionScreen(data) {
    const team = data.team || [];
    const teamIds = data.team_ids || [];
    const onTeam = teamIds.includes(myPlayerId) || team.includes(myName);

    const onTeamDiv = document.getElementById('mission-on-team');
    const notOnTeamP = document.getElementById('mission-not-on-team');
    const cardPlayedP = document.getElementById('mission-card-played');
    const autoMsg = document.getElementById('auto-success-msg');
    const choices = document.getElementById('mission-card-choices');

    cardPlayedP.classList.add('hidden');

    if (onTeam) {
        onTeamDiv.classList.remove('hidden');
        notOnTeamP.classList.add('hidden');
        const failBtn = document.getElementById('btn-fail');
        if (myTeam === 'good') {
            failBtn.disabled = true;
            failBtn.style.opacity = '0.3';
            autoMsg.classList.remove('hidden');
            choices.classList.remove('hidden');
        } else {
            failBtn.disabled = false;
            failBtn.style.opacity = '';
            autoMsg.classList.add('hidden');
            choices.classList.remove('hidden');
        }
        document.getElementById('btn-success').disabled = false;
    } else {
        onTeamDiv.classList.add('hidden');
        notOnTeamP.classList.remove('hidden');
        presenceTable.show(document.getElementById('screen-mission'), 'The Quest is Underway');
    }
    showScreen('screen-mission');
}

// ---------------------------------------------------------------------------
// Assassin screen
// ---------------------------------------------------------------------------
function showAssassinScreen(data) {
    const amAssassin = data.assassin_id === myPlayerId;
    const waitingP = document.getElementById('assassin-waiting');
    const list = document.getElementById('assassin-target-list');
    const btn = document.getElementById('btn-assassinate');

    assassinTargetId = null;

    if (amAssassin) {
        waitingP.classList.add('hidden');
        btn.classList.remove('hidden');
        btn.disabled = true;
        list.innerHTML = '';
        (data.targets || []).forEach(target => {
            const b = document.createElement('button');
            b.className = 'assassin-target-btn';
            b.textContent = target.name;
            b.dataset.playerId = target.player_id;
            b.addEventListener('click', () => {
                document.querySelectorAll('.assassin-target-btn').forEach(x => x.classList.remove('selected'));
                b.classList.add('selected');
                assassinTargetId = target.player_id;
                btn.disabled = false;
            });
            list.appendChild(b);
        });
    } else {
        list.innerHTML = '';
        btn.classList.add('hidden');
        waitingP.classList.remove('hidden');
        waitingP.textContent = `${data.assassin_name} is deliberating...`;
        presenceTable.show(document.getElementById('screen-assassin'), 'Shadows Gather');
    }
    showScreen('screen-assassin');
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function renderChronicle(container, summary) {
    if (!container) return;
    container.replaceChildren();
    const proposals = summary.proposal_history || [];
    const missions = summary.mission_history || [];
    const byMission = new Map();
    const completedMissionNumbers = new Set(missions.map(item => item.mission_num));
    proposals.forEach(item => {
        const list = byMission.get(item.mission_num) || [];
        list.push(item);
        byMission.set(item.mission_num, list);
    });
    missions.forEach(mission => {
        const section = document.createElement('section');
        section.className = `chronicle-entry ${mission.passed ? 'pass' : 'fail'}`;
        const title = document.createElement('strong');
        title.textContent = `Mission ${mission.mission_num} — ${mission.passed ? 'Succeeded' : 'Failed'}`;
        const detail = document.createElement('span');
        detail.textContent = `${mission.leader_name} led ${mission.team.join(', ')} · ${mission.success_count} Success / ${mission.fail_count} Fail`;
        section.append(title, detail);
        const attempts = byMission.get(mission.mission_num) || [];
        attempts.filter(item => !item.approved).forEach(item => {
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

function showGameOver(summary) {
    if (summary.win_reason === 'rejections') pbConsecutiveRejections = 5;
    updatePlayerProposalTrack();
    presenceTable.setRoleReveal(summary.roles || {});
    const resultEl = document.getElementById('game-over-result-player');
    resultEl.textContent = summary.winner === 'good' ? 'GOOD WINS' : 'EVIL WINS';
    resultEl.className = `game-over-result ${summary.winner}`;
    flash(summary.winner === 'good' ? 'blue' : 'red', 600);

    const myRoleEl = document.getElementById('my-role-reveal-display');
    if (myRole) {
        const team = myTeam === 'good' ? 'Forces of Good' : 'Forces of Evil';
        myRoleEl.innerHTML = `You were <strong style="color:var(--gold-light)">${escapeHtml(myRole)}</strong> &mdash; ${team}`;
    }

    const reasons = {
        missions: summary.winner === 'good' ? 'Good completed 3 quests' : 'Evil failed 3 quests',
        assassination: 'The Assassin struck down Merlin',
        assassination_failed: 'The Assassin missed Merlin',
        rejections: '5 consecutive team rejections',
    };
    document.getElementById('win-reason-player').textContent = reasons[summary.win_reason] || summary.win_reason;

    const rolesList = document.getElementById('roles-list-player');
    rolesList.innerHTML = '';
    (summary.player_order || Object.keys(summary.roles)).forEach(name => {
        const info = summary.roles[name];
        const row = document.createElement('div');
        row.className = `role-row ${info.team}`;
        row.innerHTML = `<span class="r-name">${escapeHtml(name)}</span><span class="r-role">${info.role}</span>`;
        rolesList.appendChild(row);
    });
    renderChronicle(document.getElementById('chronicle-player'), summary);
    clearAttention();

    showScreen('screen-game-over');
}

// ---------------------------------------------------------------------------
// State snapshot (reconnect)
// ---------------------------------------------------------------------------
function applyStateSnapshot(snap) {
    myPlayerId = snap.my_player_id;
    myName = snap.my_name;
    isHost = snap.is_host || false;
    gameCode = snap.code;
    window._playerOrder = snap.player_order || [];
    window._playerNameToId = snap.player_name_to_id || {};
    window._currentLeaderName = snap.current_leader;
    currentLeaderId = snap.current_leader_id;
    presenceTable.setRoomCode(gameCode);
    renderLobbyPlayers(snap.players || []);
    presenceTable.setPublicPositions(snap.public_spectrum || {});
    renderPhoneBotControls(snap.settings || {});

    if (snap.my_role) {
        myRole = snap.my_role;
        myTeam = snap.my_team;
        nightInfo = snap.night_info || null;
        window._nightInfoPending = snap.night_info || null;
        populateRoleOverlay();
        document.getElementById('btn-role-reminder').classList.remove('hidden');
    }

    document.getElementById('lobby-code-display').textContent = gameCode;
    document.getElementById('lobby-host-controls').classList.toggle('hidden', !isHost);
    document.getElementById('settings-game-actions').classList.toggle('hidden', !isHost);
    document.getElementById('btn-settings').classList.remove('hidden');

    // Restore mission board state
    if (snap.mission_sizes && snap.mission_sizes.length) {
        pbMissionSizes   = snap.mission_sizes;
        pbMissionResults = snap.mission_results || [];
        pbMissionHistory = snap.mission_history || [];
        pbCurrentMission = snap.current_mission || 0;
        pbTotalPlayers   = (snap.player_order || []).length;
        pbConsecutiveRejections = snap.consecutive_rejections || 0;
    }
    updateTeamCounts(snap.team_counts);

    const inGame = snap.phase !== 'LOBBY';
    if (inGame) {
        startGameClock(snap.game_started_at);
        acquireWakeLock();
        showPlayerBoard();
        renderPlayerBoard();
        showChat();
        restoreRecentChat(snap.recent_chat || []);
    }

    switch (snap.phase) {
        case 'LOBBY':
            renderLobbyPlayers(snap.players || []);
            showScreen('screen-lobby'); break;
        case 'ROLE_ASSIGNMENT':
        case 'NIGHT_PHASE':
            if (snap.my_role) {
                if (snap.night_info) showNightInfo(snap.night_info);
                else showScreen('screen-role');
                if (snap.night_acknowledged) {
                    document.getElementById('btn-confirm-night').disabled = true;
                    document.getElementById('btn-confirm-night').classList.add('hidden');
                    document.getElementById('night-waiting-text').classList.remove('hidden');
                }
            }
            break;
        case 'DISCUSSION':
            showDiscussion({
                mission_num: snap.current_mission + 1,
                mission_size: snap.mission_size,
                leader_id: snap.current_leader_id,
                leader_name: snap.current_leader,
                duration_seconds: snap.timer_remaining ?? snap.settings.discussion_time,
            });
            break;
        case 'TEAM_PROPOSAL':
            showProposalScreen({
                leader_name: snap.current_leader,
                leader_id: snap.current_leader_id,
                mission_size: snap.mission_size,
                player_order: snap.player_order,
                player_name_to_id: snap.player_name_to_id,
                duration_seconds: snap.timer_remaining ?? snap.settings.proposal_time,
            });
            document.getElementById('proposal-timer-player').textContent = (snap.timer_remaining ?? snap.settings.proposal_time)
                ? fmtTime(snap.timer_remaining ?? snap.settings.proposal_time)
                : 'No timer';
            if (snap.i_am_leader) requestAttention('Choose the quest party');
            break;
        case 'TEAM_VOTE':
            showVoteScreen({
                team: snap.proposed_team || [],
                team_ids: snap.proposed_team_ids || [],
                leader_name: snap.current_leader,
            });
            if (snap.my_vote) {
                document.getElementById('vote-buttons').classList.add('hidden');
                document.getElementById('vote-cast-waiting').classList.remove('hidden');
                presenceTable.show(document.getElementById('screen-vote'), 'Awaiting the Court');
            } else requestAttention('Vote now');
            break;
        case 'VOTE_REVEAL':
            showVoteReveal({ votes: snap.revealed_votes || {} });
            break;
        case 'MISSION':
            showMissionScreen({
                team: snap.proposed_team || [],
                team_ids: snap.proposed_team_ids || [],
            });
            if (snap.my_mission_card) {
                document.getElementById('mission-on-team').classList.add('hidden');
                document.getElementById('mission-not-on-team').classList.add('hidden');
                document.getElementById('mission-card-played').classList.remove('hidden');
            } else if ((snap.proposed_team_ids || []).includes(myPlayerId)) requestAttention('Play your quest card');
            break;
        case 'MISSION_REVEAL':
            showMissionReveal(snap.latest_mission || {}, Boolean(snap.pending_mission_outcome));
            break;
        case 'ASSASSIN_PHASE':
            showAssassinScreen(snap);
            if (snap.assassin_id === myPlayerId) requestAttention('Choose Merlin');
            break;
        case 'GAME_OVER':
            if (snap.summary) showGameOver(snap.summary);
            break;
        default:
            showScreen('screen-lobby');
    }
}

// ---------------------------------------------------------------------------
// SocketIO events
// ---------------------------------------------------------------------------

socket.on('join_success', data => {
    const joinButton = document.getElementById('btn-join');
    const createButton = document.getElementById('btn-create-player-game');
    joinButton.disabled = false;
    joinButton.textContent = 'Join Game';
    createButton.disabled = false;
    createButton.textContent = 'Host a New Game';
    myPlayerId = data.player_id;
    myName = data.player_name;
    isHost = data.is_host;
    gameCode = data.room_code;
    presenceTable.setRoomCode(gameCode);
    hideConnectionStatus();
    saveReconnectSession(data.session_token, myPlayerId);

    document.getElementById('lobby-code-display').textContent = gameCode;
    document.getElementById('lobby-host-controls').classList.toggle('hidden', !isHost);
    document.getElementById('btn-settings').classList.remove('hidden');
    document.getElementById('settings-game-actions').classList.toggle('hidden', !isHost);
    renderLobbyPlayers(data.players || []);
    presenceTable.setPublicPositions(data.public_spectrum || {});
    renderPhoneBotControls(data.settings || {});
    showScreen('screen-lobby');
});

socket.on('state_snapshot', data => {
    hideConnectionStatus();
    applyStateSnapshot(data);
});

socket.on('seat_recovered', data => {
    saveReconnectSession(data.session_token, data.snapshot.my_player_id);
    document.getElementById('recovery-error').textContent = '';
    document.getElementById('join-recovery').classList.add('hidden');
    hideConnectionStatus();
    applyStateSnapshot(data.snapshot);
});

socket.on('seat_recovery_failed', data => {
    const button = document.getElementById('btn-recover-seat');
    button.disabled = false;
    button.textContent = 'Recover My Seat';
    document.getElementById('recovery-error').textContent = data.message;
});

socket.on('reconnect_failed', data => {
    clearReconnectSession();
    stopGameClock();
    hidePlayerBoard();
    hideChat();
    presenceTable.hide();
    document.getElementById('btn-role-reminder').classList.add('hidden');
    document.getElementById('btn-settings').classList.add('hidden');
    if (gameCode) document.getElementById('input-room-code').value = gameCode;
    document.getElementById('join-error').textContent =
        `We could not restore this seat: ${data.message}`;
    showScreen('screen-join');
    hideConnectionStatus();
});

socket.on('player_joined', data => {
    renderLobbyPlayers(data.players || []);
    updateHostStartButton(data.player_count);
});

socket.on('player_disconnected', data => {
    renderLobbyPlayers(data.players || []);
});

socket.on('player_reconnected', data => {
    renderLobbyPlayers(data.players || []);
});

socket.on('lobby_update', data => {
    renderLobbyPlayers(data.players || []);
    presenceTable.setPublicPositions(data.public_spectrum || {});
    renderPhoneBotControls(data.settings || {});
});

socket.on('public_spectrum_updated', data => {
    presenceTable.setPublicPositions(data.positions || {});
});

function updateHostStartButton(count) {
    const btn = document.getElementById('btn-host-start');
    const hint = document.getElementById('host-start-hint');
    if (!btn) return;
    const valid = count >= 6 && count <= 10;
    btn.disabled = !valid;
    hint.textContent = valid ? '' : (count < 6 ? `Need ${6 - count} more player(s)` : 'Too many players');
}

socket.on('game_starting', data => {
    pbConsecutiveRejections = 0;
    startGameClock(data.game_started_at);
    acquireWakeLock();
    flash('white', 400);
});

socket.on('role_assigned', data => {
    window._nightInfoPending = data.night_info;
    showRoleCard(data.role, data.team);
    requestAttention('View your role');
});

socket.on('night_phase_start', () => {
    // Handled by role_assigned flow
});

socket.on('night_phase_progress', data => {
    // Could show progress if desired
});

socket.on('night_phase_complete', () => {
    // Will receive round_start next
});

socket.on('round_start', data => {
    window._playerOrder = data.player_order || window._playerOrder || [];
    window._playerNameToId = data.player_name_to_id || window._playerNameToId || {};
    window._currentLeaderName = data.leader_name;
    currentLeaderId = data.leader_id;
    missionRequiredSize = data.mission_size;
    // Board state
    pbMissionSizes    = data.mission_sizes || pbMissionSizes;
    pbMissionResults  = data.mission_results || pbMissionResults;
    pbMissionHistory  = data.mission_history || pbMissionHistory;
    if (data.game_started_at && !gameStartedAt) startGameClock(data.game_started_at);
    pbCurrentMission  = (data.mission_num || 1) - 1;
    pbTotalPlayers    = (data.player_order || []).length || pbTotalPlayers;
    pbConsecutiveRejections = data.reject_count || 0;
    updateTeamCounts(data.team_counts);
    presenceTable.setPlayers(presencePlayers, window._playerOrder || []);
    showPlayerBoard();
    renderPlayerBoard();
    showChat();
});

socket.on('discussion_start', data => {
    window._currentLeaderName = data.leader_name || window._currentLeaderName;
    currentLeaderId = data.leader_id || currentLeaderId;
    discussionTimerMax = data.duration_seconds;
    document.getElementById('discussion-timer-player').textContent = fmtTime(discussionTimerMax);
    const missionInfo = document.getElementById('discussion-mission-info');
    missionInfo.textContent = `Mission ${data.mission_num || ''} — ${missionRequiredSize} member${missionRequiredSize !== 1 ? 's' : ''} needed`;
    document.getElementById('discussion-leader-name').textContent = data.leader_name || window._currentLeaderName || 'Unknown';
    const leaderBanner = document.getElementById('leader-banner');
    leaderBanner.classList.toggle('hidden', myPlayerId !== currentLeaderId);
    document.getElementById('btn-end-discussion').classList.toggle('hidden', myPlayerId !== currentLeaderId);
    presenceTable.show(
        document.getElementById('screen-discussion'),
        'Mission Discussion',
        document.querySelector('#screen-discussion .discussion-info')
    );
    // Bot leaders can advance through proposal and into voting immediately.
    // A delayed transition here would otherwise fire afterward and cover the
    // actionable vote screen with a stale, frozen discussion screen.
    showScreen('screen-discussion');
});

socket.on('discussion_tick', data => {
    const timerEl = document.getElementById('discussion-timer-player');
    timerEl.textContent = fmtTime(data.remaining_seconds);
    timerEl.className = 'timer-small' + (data.remaining_seconds <= 10 ? ' warning' : '');
});

socket.on('proposal_start', data => {
    window._currentLeaderName = data.leader_name;
    currentLeaderId = data.leader_id;
    if (data.player_order) window._playerOrder = data.player_order;
    if (data.player_name_to_id) window._playerNameToId = data.player_name_to_id;
    showProposalScreen(data);
    document.getElementById('proposal-timer-player').textContent = data.duration_seconds ? fmtTime(data.duration_seconds) : 'No timer';
    if (data.leader_id === myPlayerId) requestAttention('Choose the quest party');
});

socket.on('proposal_tick', data => {
    const timer = document.getElementById('proposal-timer-player');
    timer.textContent = fmtTime(data.remaining_seconds);
    timer.classList.toggle('warning', data.remaining_seconds <= 10);
});

socket.on('proposal_timer_expired', () => {
    document.getElementById('proposal-timer-player').textContent = 'Take the time you need';
});

socket.on('team_proposed', data => {
    // Non-leader players see the proposed team
    proposedTeamIds = data.team_ids || [];
});

socket.on('vote_start', data => {
    showVoteScreen(data);
    requestAttention('Vote now');
});

socket.on('vote_cast_ack', () => {
    document.getElementById('vote-buttons').classList.add('hidden');
    document.getElementById('vote-cast-waiting').classList.remove('hidden');
    presenceTable.show(document.getElementById('screen-vote'), 'Awaiting the Court');
});

socket.on('vote_waiting', () => {});

socket.on('vote_reveal', data => {
    showVoteReveal(data);
});

socket.on('rejection_warning', data => {
    window._currentLeaderName = data.leader_name;
    currentLeaderId = data.leader_id;
    pbConsecutiveRejections = data.consecutive || 0;
    updatePlayerProposalTrack();
});

socket.on('evil_wins_by_rejection', () => {
    pbConsecutiveRejections = 5;
    updatePlayerProposalTrack();
    document.getElementById('vote-buttons').classList.add('hidden');
    const waiting = document.getElementById('vote-cast-waiting');
    waiting.classList.remove('hidden');
    const message = waiting.querySelector('.waiting-text');
    if (message) message.textContent = 'Five teams were rejected. Evil wins — revealing the roles…';
    presenceTable.show(document.getElementById('screen-vote'), 'Evil Claims Avalon');
    showScreen('screen-vote');
    clearAttention();
    flash('red', 800);
});

socket.on('mission_start', data => {
    pbConsecutiveRejections = 0;
    updatePlayerProposalTrack();
    showMissionScreen(data);
    const onTeam = (data.team_ids || []).includes(myPlayerId) || (data.team || []).includes(myName);
    if (onTeam) requestAttention('Play your quest card');
});

socket.on('mission_card_ack', () => {
    document.getElementById('mission-on-team').classList.add('hidden');
    document.getElementById('mission-card-played').classList.remove('hidden');
    presenceTable.show(document.getElementById('screen-mission'), 'The Quest is Underway');
});

socket.on('mission_waiting', () => {});

socket.on('mission_reveal', data => {
    showMissionReveal(data, false);
});

socket.on('mission_complete', () => {
    if (latestMissionReveal) showMissionReveal(latestMissionReveal, true);
});

socket.on('mission_tracker_update', data => {
    pbMissionResults = data.mission_results || pbMissionResults;
    pbMissionHistory = data.mission_history || pbMissionHistory;
    if (data.good_wins < 3 && data.evil_wins < 3) pbCurrentMission++;
    renderPlayerBoard();
});

socket.on('assassin_phase_start', data => {
    showAssassinScreen(data);
    if (data.assassin_id === myPlayerId) requestAttention('Choose Merlin');
});

socket.on('assassination_result', () => {});

socket.on('game_over', data => {
    showGameOver(data);
});

socket.on('return_to_lobby', data => {
    stopGameClock();
    myRole = null;
    myTeam = null;
    nightInfo = null;
    pbMissionHistory = [];
    pbConsecutiveRejections = 0;
    document.getElementById('btn-role-reminder').classList.add('hidden');
    document.getElementById('role-overlay').classList.add('hidden');
    document.getElementById('settings-overlay').classList.add('hidden');
    document.getElementById('settings-game-actions').classList.add('hidden');
    hidePlayerBoard();
    hideChat();
    releaseWakeLock();
    clearAttention();
    presenceTable.setRoleReveal(null);
    chatBubbleEls = [];
    chatHistory = [];
    chatHistoryOpen = false;
    document.getElementById('chat-bubbles').innerHTML = '';
    document.getElementById('chat-history-list').innerHTML = '';
    document.getElementById('chat-history-panel').classList.add('hidden');
    document.getElementById('btn-history-toggle').classList.remove('active');
    renderLobbyPlayers(data.players || []);
    showScreen('screen-lobby');
});

socket.on('game_ended', () => {
    stopGameClock();
    clearReconnectSession();
    releaseWakeLock();
    clearAttention();
    myPlayerId = null; myName = null; myRole = null; myTeam = null;
    gameCode = null;
    pbConsecutiveRejections = 0;
    presenceTable.hide();
    presenceTable.setRoomCode('');
    document.getElementById('btn-settings').classList.add('hidden');
    document.getElementById('settings-overlay').classList.add('hidden');
    document.getElementById('settings-game-actions').classList.add('hidden');
    hidePlayerBoard();
    hideChat();
    showScreen('screen-join');
});

socket.on('error', data => {
    // Show error in join screen if visible
    const errEl = document.getElementById('join-error');
    if (errEl && document.getElementById('screen-join').classList.contains('active')) {
        errEl.textContent = data.message;
        const joinButton = document.getElementById('btn-join');
        const createButton = document.getElementById('btn-create-player-game');
        joinButton.disabled = false;
        joinButton.textContent = 'Join Game';
        createButton.disabled = false;
        createButton.textContent = 'Host a New Game';
    } else {
        console.warn('[server error]', data.message);
    }
});

socket.on('connect', () => {
    if (reconnectToken()) showConnectionStatus('Connected — restoring your seat…');
    else hideConnectionStatus();
});
socket.on('disconnect', () => showConnectionStatus('Connection lost — reconnecting…'));
socket.on('connect_error', () => showConnectionStatus('Unable to reach the game server — retrying…'));

// ---------------------------------------------------------------------------
// UI event listeners
// ---------------------------------------------------------------------------

document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('input-room-code').value.trim().toUpperCase();
    const name = document.getElementById('input-name').value.trim();
    document.getElementById('join-error').textContent = '';
    if (!code || code.length !== 4) {
        document.getElementById('join-error').textContent = 'Enter the 4-letter room code.';
        return;
    }
    if (!name) {
        document.getElementById('join-error').textContent = 'Enter your name.';
        return;
    }
    const joinButton = document.getElementById('btn-join');
    joinButton.disabled = true;
    joinButton.textContent = 'Joining…';
    socket.emit('join_game', { room_code: code, player_name: name });
});

document.getElementById('btn-create-player-game').addEventListener('click', event => {
    const name = document.getElementById('input-name').value.trim();
    document.getElementById('join-error').textContent = '';
    if (!name) {
        document.getElementById('join-error').textContent = 'Enter your name first.';
        return;
    }
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Creating…';
    socket.emit('create_player_game', { player_name: name });
});

document.getElementById('input-room-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
});

document.getElementById('input-room-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('input-name').focus();
});

document.getElementById('input-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
});

document.getElementById('btn-show-recovery').addEventListener('click', () => {
    document.getElementById('join-recovery').classList.toggle('hidden');
});

document.getElementById('input-recovery-code').addEventListener('input', event => {
    event.target.value = event.target.value.replace(/\D/g, '');
});

document.getElementById('btn-recover-seat').addEventListener('click', () => {
    const roomCode = document.getElementById('input-room-code').value.trim().toUpperCase();
    const recoveryCode = document.getElementById('input-recovery-code').value.trim();
    const error = document.getElementById('recovery-error');
    error.textContent = '';
    if (roomCode.length !== 4 || recoveryCode.length !== 6) {
        error.textContent = 'Enter the room code and six-digit code shown by the host.';
        return;
    }
    const button = document.getElementById('btn-recover-seat');
    button.disabled = true;
    button.textContent = 'Recovering…';
    socket.emit('claim_player_seat', { room_code: roomCode, recovery_code: recoveryCode });
});

document.getElementById('btn-ready').addEventListener('click', event => {
    const next = event.currentTarget.getAttribute('aria-pressed') !== 'true';
    socket.emit('set_ready', { ready: next });
});

document.getElementById('input-selfie').addEventListener('change', async event => {
    const error = document.getElementById('selfie-error');
    error.textContent = '';
    try {
        const image = await compressSelfie(event.target.files && event.target.files[0]);
        socket.emit('select_selfie', { image });
    } catch (failure) {
        error.textContent = failure.message;
    } finally {
        event.target.value = '';
    }
});

document.getElementById('btn-host-start').addEventListener('click', () => {
    socket.emit('start_game');
});

document.getElementById('btn-phone-beta-mode').addEventListener('click', () => {
    socket.emit('set_beta_test_mode', {
        enabled: !phoneBetaTestMode,
        target_count: phoneBetaPlayerCount,
    });
});

document.getElementById('phone-beta-player-count').addEventListener('change', event => {
    phoneBetaPlayerCount = Number(event.target.value) || 6;
    if (phoneBetaTestMode) {
        socket.emit('set_beta_test_mode', {
            enabled: true,
            target_count: phoneBetaPlayerCount,
        });
    }
});

document.getElementById('btn-end-discussion').addEventListener('click', event => {
    event.currentTarget.disabled = true;
    socket.emit('skip_discussion', { confirmed: true });
});

document.getElementById('btn-player-confirm-vote').addEventListener('click', event => {
    event.currentTarget.disabled = true;
    socket.emit('confirm_vote_reveal');
});

document.getElementById('btn-player-next-round').addEventListener('click', event => {
    event.currentTarget.disabled = true;
    socket.emit('advance_after_mission');
});

document.getElementById('btn-confirm-role').addEventListener('click', () => {
    clearAttention();
    // Show persistent role reminder button
    populateRoleOverlay();
    document.getElementById('btn-role-reminder').classList.remove('hidden');
    // Move to night info screen
    const pending = window._nightInfoPending;
    if (pending) {
        showNightInfo(pending);
    } else {
        showScreen('screen-night');
    }
});

function populateRoleOverlay() {
    const teamBadge = document.getElementById('overlay-team-badge');
    const roleName = document.getElementById('overlay-role-name');
    const roleDesc = document.getElementById('overlay-role-desc');
    const knowledge = document.getElementById('overlay-knowledge');
    teamBadge.className = `role-overlay-team ${myTeam}`;
    teamBadge.textContent = myTeam === 'good' ? 'Forces of Good' : 'Forces of Evil';
    roleName.textContent = myRole || '—';
    roleDesc.textContent = ROLE_DESCRIPTIONS[myRole] || '';
    const info = nightInfo || window._nightInfoPending;
    if (info && info.sees_label) {
        knowledge.textContent = info.sees && info.sees.length
            ? `${info.sees_label}: ${info.sees.join(', ')}`
            : info.sees_label;
    } else {
        knowledge.textContent = '';
    }
}

document.getElementById('btn-role-reminder').addEventListener('click', () => {
    populateRoleOverlay();
    document.getElementById('role-overlay').classList.remove('hidden');
});

document.getElementById('btn-close-overlay').addEventListener('click', () => {
    document.getElementById('role-overlay').classList.add('hidden');
});

// Settings button
document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.remove('hidden');
});
document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
});
document.getElementById('toggle-large-text').addEventListener('change', event => {
    applyLargeTextMode(event.target.checked, false);
});
document.getElementById('toggle-extra-large-text').addEventListener('change', event => {
    applyLargeTextMode(true, event.target.checked);
});
document.getElementById('btn-back-to-lobby').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
    socket.emit('return_to_lobby');
});
document.getElementById('btn-new-game').addEventListener('click', () => {
    document.getElementById('settings-overlay').classList.add('hidden');
    socket.emit('end_game');
});

document.getElementById('btn-confirm-night').addEventListener('click', () => {
    socket.emit('night_phase_ack');
    document.getElementById('btn-confirm-night').disabled = true;
    document.getElementById('night-waiting-text').classList.remove('hidden');
    document.getElementById('btn-confirm-night').classList.add('hidden');
});

document.getElementById('btn-lock-team').addEventListener('click', () => {
    if (selectedTeamIds.length !== missionRequiredSize) return;
    // selectedTeamIds currently holds names; we need IDs
    // Since we use names as keys in the player-select-list, emit names
    // The server expects player_ids; we need a name-to-id map
    // Use window._playerNameToId if available
    const nameToId = window._playerNameToId || {};
    let teamIds = selectedTeamIds.map(n => nameToId[n] || n);
    socket.emit('propose_team', { team: teamIds });
    clearAttention();
    document.getElementById('btn-lock-team').disabled = true;
});

document.getElementById('btn-approve').addEventListener('click', () => {
    document.getElementById('btn-approve').disabled = true;
    document.getElementById('btn-reject').disabled = true;
    socket.emit('cast_vote', { vote: 'approve' });
    clearAttention();
});

document.getElementById('btn-reject').addEventListener('click', () => {
    document.getElementById('btn-approve').disabled = true;
    document.getElementById('btn-reject').disabled = true;
    socket.emit('cast_vote', { vote: 'reject' });
    clearAttention();
});

document.getElementById('btn-success').addEventListener('click', () => {
    document.getElementById('btn-success').disabled = true;
    document.getElementById('btn-fail').disabled = true;
    socket.emit('play_mission_card', { card: 'success' });
    clearAttention();
});

document.getElementById('btn-fail').addEventListener('click', () => {
    document.getElementById('btn-success').disabled = true;
    document.getElementById('btn-fail').disabled = true;
    socket.emit('play_mission_card', { card: 'fail' });
    clearAttention();
});

document.getElementById('btn-assassinate').addEventListener('click', () => {
    if (!assassinTargetId) return;
    socket.emit('assassinate', { target_player_id: assassinTargetId });
    clearAttention();
    document.getElementById('btn-assassinate').disabled = true;
});

// Store name-to-ID mapping when we receive player data
socket.on('join_success', data => {
    if (data.players) {
        window._playerNameToId = {};
        data.players.forEach(p => { window._playerNameToId[p.name] = p.player_id; });
        pbTotalPlayers = data.players.length;
    }
});
socket.on('player_joined', data => {
    if (data.players) {
        window._playerNameToId = window._playerNameToId || {};
        data.players.forEach(p => { window._playerNameToId[p.name] = p.player_id; });
        pbTotalPlayers = data.players.length;
    }
});

// Chat
socket.on('chat_message', data => {
    addChatBubble(data.name, data.message, data.name === myName, data.color_index, data.timestamp);
});

document.getElementById('btn-chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
});
document.getElementById('btn-history-toggle').addEventListener('click', () => toggleChatHistory(!chatHistoryOpen));
document.getElementById('btn-history-close').addEventListener('click', () => toggleChatHistory(false));
document.addEventListener('pointerdown', event => {
    if (chatHistoryOpen && !document.getElementById('chat-container').contains(event.target)) {
        toggleChatHistory(false);
    }
});

const invitedRoom = new URLSearchParams(window.location.search).get('room');
if (invitedRoom && /^[A-Za-z]{4}$/.test(invitedRoom)) {
    document.getElementById('input-room-code').value = invitedRoom.toUpperCase();
    document.getElementById('input-name').focus();
}
