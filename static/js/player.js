/* ============================================================
   AVALON — Player Screen JS
   ============================================================ */

const socket = io();

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

// Mission board state
let pbMissionSizes = [];
let pbMissionResults = [];
let pbRejections = 0;
let pbCurrentMission = 0;
let pbTotalPlayers = 0;

// Chat state
let chatBubbleEls = [];
let chatHistory = [];
let chatHistoryOpen = false;

// ---------------------------------------------------------------------------
// Screen management
// ---------------------------------------------------------------------------
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
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
    const dotsEl = document.getElementById('pb-dots');
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
        shieldsEl.innerHTML += `<div class="pb-shield ${stateClass}">
            ${isDouble ? '<span class="pb-double">×2</span>' : ''}
            ${icon ? `<span class="pb-icon">${icon}</span>` : `<span class="pb-num">${i + 1}</span>`}
            <span class="pb-size">${size}p</span>
        </div>`;
    }

    dotsEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        dotsEl.innerHTML += `<div class="pb-dot${i < pbRejections ? ' filled' : ''}"></div>`;
    }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function showChat() {
    document.getElementById('chat-container').classList.remove('hidden');
    document.body.classList.add('chat-visible');
}
function hideChat() {
    document.getElementById('chat-container').classList.add('hidden');
    document.body.classList.remove('chat-visible');
}

function fmtChatTime() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function addChatBubble(name, message, isSelf) {
    const timestamp = fmtChatTime();

    // Add to history
    chatHistory.push({ name, message, isSelf, timestamp });
    const histList = document.getElementById('chat-history-list');
    if (histList) {
        const entry = document.createElement('div');
        entry.className = 'chat-history-entry';
        entry.innerHTML = `<span class="chat-name">${escapeHtml(name)}</span>${escapeHtml(message)}<span class="chat-time">${timestamp}</span>`;
        histList.appendChild(entry);
        // Auto-scroll to bottom if history panel is open
        if (chatHistoryOpen) {
            const panel = document.getElementById('chat-history-panel');
            if (panel) panel.scrollTop = panel.scrollHeight;
        }
    }

    // Show ephemeral bubble only if history panel is closed
    if (chatHistoryOpen) return;

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

const ROLE_PORTRAITS = {
    'Merlin':           'merlin',
    'Percival':         'percival',
    'Loyal Servant':    'loyal-servant',
    'Assassin':         'assassin',
    'Morgana':          'morgana',
    'Mordred':          'mordred',
    'Oberon':           'oberon',
    'Minion of Mordred':'minion',
};

// ---------------------------------------------------------------------------
// Audio Manager
// ---------------------------------------------------------------------------
const TRACKS = {
    tavern:         '/static/sounds/dummy_daniel-party-at-the-tavern-468489.mp3',
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
let _masterVolume = 0.45;

function _getAudio(key) {
    if (!_audioCache[key]) _audioCache[key] = new Audio(TRACKS[key]);
    return _audioCache[key];
}

function playTrack(key, { loop = true } = {}) {
    if (_currentTrackKey === key) return;
    _currentTrackKey = key;
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

function setPlayerMusicVolume(vol) {
    _masterVolume = vol;
    if (_currentAudio) _currentAudio.volume = vol;
    const slider = document.getElementById('settings-music-slider');
    const display = document.getElementById('settings-music-display');
    if (slider) slider.value = Math.round(vol * 100);
    if (display) display.textContent = Math.round(vol * 100) + '%';
    const btn = document.getElementById('btn-settings-mute');
    if (btn) btn.textContent = vol === 0 ? '🔇 Unmute' : '🔊 Mute';
}

// ---------------------------------------------------------------------------
// Auto-join via URL param (for dev panel)
// ---------------------------------------------------------------------------
(function checkAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const devName = params.get('dev_name');
    const devCode = params.get('room_code');
    if (devName && devCode) {
        // Wait for socket connect
        socket.on('connect', () => {
            socket.emit('join_game', { room_code: devCode, player_name: devName });
        });
    } else {
        // Try session storage reconnect
        const token = sessionStorage.getItem('session_token');
        if (token) {
            socket.on('connect', () => {
                socket.emit('reconnect_game', { session_token: token });
            });
        }
    }
})();

// ---------------------------------------------------------------------------
// Lobby rendering
// ---------------------------------------------------------------------------
function renderLobbyPlayers(playerList) {
    const ul = document.getElementById('lobby-player-list');
    ul.innerHTML = '';
    playerList.forEach(p => {
        const li = document.createElement('div');
        li.className = 'player-list-item' + (p.name === myName ? ' me' : '');
        li.innerHTML = `
            ${p.name === myName ? '<span style="color:var(--gold)">▶</span>' : ''}
            ${escapeHtml(p.name)}
            ${!p.connected ? '<span class="disconnected-dot"></span>' : ''}
        `;
        ul.appendChild(li);
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

    // Portrait
    const portrait = document.getElementById('role-portrait-card');
    if (portrait) {
        const slug = ROLE_PORTRAITS[role] || role.toLowerCase().replace(/\s+/g, '-');
        portrait.src = `/static/img/portraits/${slug}.png`;
        portrait.style.display = '';
        portrait.onerror = () => { portrait.style.display = 'none'; };
    }

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
    const leaderBanner = document.getElementById('leader-banner');
    const amLeader = myPlayerId === data.leader_id || myPlayerId === currentLeaderId;
    leaderBanner.classList.toggle('hidden', !amLeader);
    discussionTimerMax = data.duration_seconds || discussionTimerMax;
    document.getElementById('discussion-timer-player').textContent = fmtTime(discussionTimerMax);
    showScreen('screen-discussion');
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
    // Leader is auto-approved — skip vote buttons
    const amLeader = myPlayerId && (myPlayerId === currentLeaderId);
    document.getElementById('vote-buttons').classList.toggle('hidden', amLeader);
    document.getElementById('vote-cast-waiting').classList.toggle('hidden', !amLeader);
    if (!amLeader) {
        document.getElementById('btn-approve').disabled = false;
        document.getElementById('btn-reject').disabled = false;
    }
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
    }
    showScreen('screen-assassin');
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------
function showGameOver(summary) {
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
    window._currentLeaderName = snap.current_leader;
    currentLeaderId = snap.current_leader_id;

    if (snap.my_role) {
        myRole = snap.my_role;
        myTeam = snap.my_team;
    }

    document.getElementById('lobby-code-display').textContent = gameCode;
    document.getElementById('lobby-host-controls').classList.toggle('hidden', !isHost);

    switch (snap.phase) {
        case 'LOBBY':
            renderLobbyPlayers(snap.players || []);
            showScreen('screen-lobby'); break;
        case 'ROLE_ASSIGNMENT':
        case 'NIGHT_PHASE':
            if (snap.my_role) {
                if (snap.night_info) showNightInfo(snap.night_info);
                else showScreen('screen-role');
            }
            break;
        case 'DISCUSSION':
            showScreen('screen-discussion'); break;
        case 'TEAM_PROPOSAL':
            showScreen('screen-proposal'); break;
        case 'TEAM_VOTE':
        case 'VOTE_REVEAL':
            if (snap.my_vote) {
                document.getElementById('vote-buttons').classList.add('hidden');
                document.getElementById('vote-cast-waiting').classList.remove('hidden');
            }
            showScreen('screen-vote'); break;
        case 'MISSION':
        case 'MISSION_REVEAL':
            showScreen('screen-mission'); break;
        case 'ASSASSIN_PHASE':
            showScreen('screen-assassin'); break;
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
    playTrack('tavern');
    document.getElementById('btn-settings').classList.remove('hidden');
    myPlayerId = data.player_id;
    myName = data.player_name;
    isHost = data.is_host;
    gameCode = data.room_code;
    sessionStorage.setItem('session_token', data.session_token);
    sessionStorage.setItem('player_id', myPlayerId);

    document.getElementById('lobby-code-display').textContent = gameCode;
    document.getElementById('lobby-host-controls').classList.toggle('hidden', !isHost);
    renderLobbyPlayers(data.players || []);
    showScreen('screen-lobby');
});

socket.on('state_snapshot', data => {
    applyStateSnapshot(data);
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
});

function updateHostStartButton(count) {
    const btn = document.getElementById('btn-host-start');
    const hint = document.getElementById('host-start-hint');
    if (!btn) return;
    const valid = count >= 6 && count <= 10;
    btn.disabled = !valid;
    hint.textContent = valid ? '' : (count < 6 ? `Need ${6 - count} more player(s)` : 'Too many players');
}

socket.on('game_starting', () => {
    flash('white', 400);
});

socket.on('role_assigned', data => {
    playTrack('night');
    window._nightInfoPending = data.night_info;
    showRoleCard(data.role, data.team);
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
    playTrack('round_fanfare');
    window._playerOrder = data.player_order || window._playerOrder || [];
    window._playerNameToId = data.player_name_to_id || window._playerNameToId || {};
    window._currentLeaderName = data.leader_name;
    currentLeaderId = data.leader_id;
    missionRequiredSize = data.mission_size;
    // Board state
    pbMissionSizes    = data.mission_sizes || pbMissionSizes;
    pbMissionResults  = data.mission_results || pbMissionResults;
    pbRejections      = data.reject_count || 0;
    pbCurrentMission  = (data.mission_num || 1) - 1;
    pbTotalPlayers    = (data.player_order || []).length || pbTotalPlayers;
    showPlayerBoard();
    renderPlayerBoard();
    showChat();
});

socket.on('discussion_start', data => {
    playTrack('discussion');
    discussionTimerMax = data.duration_seconds;
    document.getElementById('discussion-timer-player').textContent = fmtTime(discussionTimerMax);
    const missionInfo = document.getElementById('discussion-mission-info');
    missionInfo.textContent = `Mission ${data.mission_num || ''} — ${missionRequiredSize} member${missionRequiredSize !== 1 ? 's' : ''} needed`;
    const leaderBanner = document.getElementById('leader-banner');
    leaderBanner.classList.toggle('hidden', myPlayerId !== currentLeaderId);
    transition('screen-discussion');
});

socket.on('discussion_tick', data => {
    const timerEl = document.getElementById('discussion-timer-player');
    timerEl.textContent = fmtTime(data.remaining_seconds);
    timerEl.className = 'timer-small' + (data.remaining_seconds <= 10 ? ' warning' : '');
});

socket.on('proposal_start', data => {
    playTrack('proposal');
    window._currentLeaderName = data.leader_name;
    currentLeaderId = data.leader_id;
    if (data.player_order) window._playerOrder = data.player_order;
    if (data.player_name_to_id) window._playerNameToId = data.player_name_to_id;
    showProposalScreen(data);
});

socket.on('team_proposed', data => {
    // Non-leader players see the proposed team
    proposedTeamIds = data.team_ids || [];
});

socket.on('vote_start', data => {
    playTrack('tension');
    showVoteScreen(data);
});

socket.on('vote_cast_ack', () => {
    document.getElementById('vote-buttons').classList.add('hidden');
    document.getElementById('vote-cast-waiting').classList.remove('hidden');
});

socket.on('vote_waiting', () => {});

socket.on('vote_reveal', data => {
    // Host shows the reveal; players wait
    document.getElementById('vote-cast-waiting').classList.remove('hidden');
});

socket.on('rejection_warning', data => {
    window._currentLeaderName = data.leader_name;
    currentLeaderId = data.leader_id;
    pbRejections = data.consecutive || pbRejections;
    renderPlayerBoard();
});

socket.on('evil_wins_by_rejection', () => {
    flash('red', 800);
});

socket.on('mission_start', data => {
    playTrack('tension');
    showMissionScreen(data);
});

socket.on('mission_card_ack', () => {
    document.getElementById('mission-on-team').classList.add('hidden');
    document.getElementById('mission-card-played').classList.remove('hidden');
});

socket.on('mission_waiting', () => {});

socket.on('mission_reveal', () => {
    // Brief wait screen
});

socket.on('mission_tracker_update', data => {
    pbMissionResults = data.mission_results || pbMissionResults;
    if (data.good_wins < 3 && data.evil_wins < 3) pbCurrentMission++;
    pbRejections = 0; // new mission resets consecutive rejections
    renderPlayerBoard();
});

socket.on('assassin_phase_start', data => {
    playTrack('assassin');
    showAssassinScreen(data);
});

socket.on('assassination_result', () => {});

socket.on('game_over', data => {
    playTrack(data.winner === 'good' ? 'good_wins' : 'evil_wins', { loop: true });
    showGameOver(data);
});

socket.on('return_to_lobby', data => {
    playTrack('tavern');
    myRole = null;
    myTeam = null;
    nightInfo = null;
    document.getElementById('btn-role-reminder').classList.add('hidden');
    document.getElementById('role-overlay').classList.add('hidden');
    document.getElementById('settings-overlay').classList.add('hidden');
    hidePlayerBoard();
    hideChat();
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

socket.on('error', data => {
    // Show error in join screen if visible
    const errEl = document.getElementById('join-error');
    if (errEl && document.getElementById('screen-join').classList.contains('active')) {
        errEl.textContent = data.message;
    } else {
        console.warn('[server error]', data.message);
    }
});

// ---------------------------------------------------------------------------
// UI event listeners
// ---------------------------------------------------------------------------

document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('input-room-code').value.trim().toUpperCase();
    const name = document.getElementById('input-name').value.trim();
    document.getElementById('join-error').textContent = '';
    if (!code || code.length < 4) {
        document.getElementById('join-error').textContent = 'Enter the 4-letter room code.';
        return;
    }
    if (!name) {
        document.getElementById('join-error').textContent = 'Enter your name.';
        return;
    }
    socket.emit('join_game', { room_code: code, player_name: name });
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

document.getElementById('btn-host-start').addEventListener('click', () => {
    socket.emit('start_game');
});

document.getElementById('btn-confirm-role').addEventListener('click', () => {
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
    const portrait = document.getElementById('overlay-portrait');
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
    if (portrait && myRole) {
        const slug = ROLE_PORTRAITS[myRole] || myRole.toLowerCase().replace(/\s+/g, '-');
        portrait.src = `/static/img/portraits/${slug}.png`;
        portrait.style.display = '';
        portrait.onerror = () => { portrait.style.display = 'none'; };
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
document.getElementById('settings-music-slider').addEventListener('input', e => {
    setPlayerMusicVolume(parseInt(e.target.value) / 100);
});
document.getElementById('btn-settings-mute').addEventListener('click', () => {
    setPlayerMusicVolume(_masterVolume > 0 ? 0 : 0.45);
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
    document.getElementById('btn-lock-team').disabled = true;
});

document.getElementById('btn-approve').addEventListener('click', () => {
    socket.emit('cast_vote', { vote: 'approve' });
});

document.getElementById('btn-reject').addEventListener('click', () => {
    socket.emit('cast_vote', { vote: 'reject' });
});

document.getElementById('btn-success').addEventListener('click', () => {
    socket.emit('play_mission_card', { card: 'success' });
});

document.getElementById('btn-fail').addEventListener('click', () => {
    socket.emit('play_mission_card', { card: 'fail' });
});

document.getElementById('btn-assassinate').addEventListener('click', () => {
    if (!assassinTargetId) return;
    socket.emit('assassinate', { target_player_id: assassinTargetId });
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
    addChatBubble(data.name, data.message, data.name === myName);
});

document.getElementById('btn-chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
});
document.getElementById('btn-history-toggle').addEventListener('click', () => toggleChatHistory(!chatHistoryOpen));
document.getElementById('btn-history-close').addEventListener('click', () => toggleChatHistory(false));
