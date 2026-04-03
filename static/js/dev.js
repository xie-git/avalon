/* ============================================================
   AVALON — Dev Panel
   One host socket + N virtual player sockets (no player iframes).
   Player iframes caused duplicate join attempts ("name already taken").
   ============================================================ */

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(msg, type = 'info') {
    const logEl = document.getElementById('status-log');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.insertBefore(entry, logEl.firstChild);
    if (logEl.children.length > 200) logEl.removeChild(logEl.lastChild);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let gameCode = null;
let hostSocket = null;
let vps = [];  // array of VirtualPlayer objects

// Per-round state updated via events
let currentLeaderId = null;
let currentMissionSize = 0;
let currentPlayerNameToId = {};
let currentPlayerOrder = [];
let currentMissionTeamIds = [];

// ---------------------------------------------------------------------------
// VirtualPlayer
// ---------------------------------------------------------------------------
class VirtualPlayer {
    constructor(name, index) {
        this.name = name;
        this.index = index;
        this.socket = io();
        this.playerId = null;
        this.role = null;
        this.team = null;
        this.nightInfo = null;
        this.phase = 'CONNECTING';
        this.voted = false;
        this.playedCard = false;

        this.socket.on('connect', () => {
            this.phase = 'CONNECTED';
            this.socket.emit('join_game', { room_code: gameCode, player_name: name });
        });

        this.socket.on('join_success', d => {
            this.playerId = d.player_id;
            this.phase = 'LOBBY';
            log(`${name} joined`, 'info');
            this.render();
        });

        this.socket.on('role_assigned', d => {
            this.role = d.role;
            this.team = d.team;
            this.nightInfo = d.night_info;
            this.phase = 'ROLE_REVEAL';
            // Auto-ack after a short delay so it feels natural
            setTimeout(() => {
                this.socket.emit('night_phase_ack');
                this.phase = 'NIGHT_ACK';
                this.render();
            }, 600 + this.index * 150);
            this.render();
        });

        this.socket.on('discussion_start', () => {
            this.phase = 'DISCUSSION';
            this.voted = false;
            this.playedCard = false;
            this.render();
        });

        this.socket.on('proposal_start', d => {
            this.phase = 'PROPOSAL';
            this._selectedTeam = [];
            this.render();
        });

        this.socket.on('vote_start', () => {
            this.phase = 'VOTING';
            // Leader is auto-approved server-side — mark as already voted
            this.voted = (this.playerId === currentLeaderId);
            this.render();
        });

        this.socket.on('vote_cast_ack', () => {
            this.voted = true;
            this.render();
        });

        this.socket.on('mission_start', d => {
            this.phase = 'MISSION';
            this.playedCard = false;
            this.render();
        });

        this.socket.on('mission_card_ack', () => {
            this.playedCard = true;
            this.render();
        });

        this.socket.on('assassin_phase_start', d => {
            this.phase = 'ASSASSIN';
            this.render();
        });

        this.socket.on('game_over', () => {
            this.phase = 'GAME_OVER';
            this.render();
        });

        this.socket.on('return_to_lobby', () => {
            this.phase = 'LOBBY';
            this.role = null;
            this.team = null;
            this.nightInfo = null;
            this.render();
        });

        this.socket.on('error', d => {
            log(`${name}: ${d.message}`, 'error');
        });

        // Re-render on any round state changes
        this.socket.on('round_start', () => { this.render(); });
        this.socket.on('rejection_warning', () => { this.render(); });
        this.socket.on('night_phase_complete', () => { this.phase = 'WAIT'; this.render(); });
    }

    isOnMissionTeam() {
        return currentMissionTeamIds.includes(this.playerId);
    }

    isLeader() {
        return this.playerId === currentLeaderId;
    }

    isAssassin() {
        return this.role === 'Assassin';
    }

    castVote(vote) {
        if (this.phase !== 'VOTING' || this.voted) return;
        this.socket.emit('cast_vote', { vote });
    }

    playCard(card) {
        if (this.phase !== 'MISSION' || this.playedCard) return;
        if (this.team === 'good' && card === 'fail') card = 'success'; // server enforces too
        this.socket.emit('play_mission_card', { card });
    }

    propose(teamIds) {
        this.socket.emit('propose_team', { team: teamIds });
    }

    assassinate(targetId) {
        this.socket.emit('assassinate', { target_player_id: targetId });
    }

    render() {
        const el = document.getElementById(`vp-card-${this.index}`);
        if (!el) return;

        const isLeader = this.isLeader();
        el.className = `vp-card${this.team ? ' ' + this.team : ''}${isLeader ? ' leader' : ''}`;

        const badge = el.querySelector('.vp-role-badge');
        badge.className = `vp-role-badge${this.team ? ' ' + this.team : ''}`;
        badge.textContent = this.role || '—';

        el.querySelector('.vp-crown').style.display = isLeader ? 'inline' : 'none';
        el.querySelector('.vp-phase').textContent = this.phase;

        // Night info
        const seesEl = el.querySelector('.vp-sees');
        if (this.nightInfo && this.nightInfo.sees && this.nightInfo.sees.length > 0) {
            seesEl.textContent = `${this.nightInfo.sees_label}: ${this.nightInfo.sees.join(', ')}`;
            seesEl.style.display = '';
        } else if (this.nightInfo) {
            seesEl.textContent = this.nightInfo.sees_label || '';
            seesEl.style.display = '';
        } else {
            seesEl.style.display = 'none';
        }

        // Actions
        const actionsEl = el.querySelector('.vp-actions');
        actionsEl.innerHTML = '';

        if (this.phase === 'VOTING' && !this.voted) {
            const aBtn = btn('Approve', 'approve', () => this.castVote('approve'));
            const rBtn = btn('Reject', 'reject', () => this.castVote('reject'));
            actionsEl.append(aBtn, rBtn);
        } else if (this.phase === 'VOTING' && this.voted) {
            actionsEl.innerHTML = `<span class="vp-voted done">✓ voted</span>`;
        }

        if (this.phase === 'MISSION') {
            if (this.isOnMissionTeam()) {
                if (!this.playedCard) {
                    const sBtn = btn('Success', 'success-c', () => this.playCard('success'));
                    actionsEl.appendChild(sBtn);
                    if (this.team === 'evil') {
                        const fBtn = btn('Fail', 'fail-c', () => this.playCard('fail'));
                        actionsEl.appendChild(fBtn);
                    }
                } else {
                    actionsEl.innerHTML = `<span class="vp-played done">✓ played</span>`;
                }
            } else {
                actionsEl.innerHTML = `<span class="vp-phase">Not on team</span>`;
            }
        }

        if (this.phase === 'PROPOSAL' && isLeader) {
            this._selectedTeam = this._selectedTeam || [];
            const needed = currentMissionSize;

            // Player toggle buttons (everyone except self)
            const others = currentPlayerOrder.filter(n => n !== this.name);
            others.forEach(name => {
                const sel = this._selectedTeam.includes(name);
                const b = document.createElement('button');
                b.className = `vp-btn ${sel ? 'propose' : ''}`;
                b.style.cssText = sel
                    ? 'border-color:var(--gold);color:var(--gold-light);background:rgba(201,168,76,0.1)'
                    : 'border-color:var(--border-gold);color:var(--text-secondary)';
                b.textContent = name;
                b.addEventListener('click', () => {
                    if (sel) {
                        this._selectedTeam = this._selectedTeam.filter(n => n !== name);
                    } else if (this._selectedTeam.length < needed) {
                        this._selectedTeam.push(name);
                    }
                    this.render();
                });
                actionsEl.appendChild(b);
            });

            // Count + propose button
            const count = this._selectedTeam.length;
            const propBtn = document.createElement('button');
            propBtn.className = 'vp-btn propose';
            propBtn.style.cssText = 'width:100%;margin-top:4px;';
            propBtn.disabled = count !== needed;
            propBtn.style.opacity = count === needed ? '1' : '0.4';
            propBtn.textContent = `Propose (${count}/${needed})`;
            propBtn.addEventListener('click', () => {
                if (count !== needed) return;
                const ids = this._selectedTeam.map(n => currentPlayerNameToId[n]).filter(Boolean);
                this.propose(ids);
                this._selectedTeam = [];
            });
            actionsEl.appendChild(propBtn);

            // Auto-propose shortcut
            const autoBtn = btn('Auto', 'propose', () => { autoPropose(); this._selectedTeam = []; });
            autoBtn.title = 'Auto-select first N players';
            actionsEl.appendChild(autoBtn);
        }

        if (this.phase === 'PROPOSAL' && !isLeader) {
            actionsEl.innerHTML = `<span class="vp-phase">Waiting for leader...</span>`;
        }

        if (this.phase === 'ASSASSIN') {
            if (this.isAssassin()) {
                this._assassinTarget = this._assassinTarget || null;
                // Show all other players as target options
                const others = currentPlayerOrder.filter(n => n !== this.name);
                others.forEach(name => {
                    const sel = this._assassinTarget === name;
                    const b = document.createElement('button');
                    b.className = 'vp-btn assassin';
                    b.style.opacity = sel ? '1' : '0.5';
                    b.style.background = sel ? 'rgba(192,57,43,0.2)' : '';
                    b.textContent = name;
                    b.addEventListener('click', () => {
                        this._assassinTarget = name;
                        this.render();
                    });
                    actionsEl.appendChild(b);
                });
                const killBtn = document.createElement('button');
                killBtn.className = 'vp-btn assassin';
                killBtn.style.cssText = 'width:100%;margin-top:4px;';
                killBtn.disabled = !this._assassinTarget;
                killBtn.style.opacity = this._assassinTarget ? '1' : '0.4';
                killBtn.textContent = this._assassinTarget ? `Assassinate ${this._assassinTarget}` : 'Select target';
                killBtn.addEventListener('click', () => {
                    const id = currentPlayerNameToId[this._assassinTarget];
                    if (id) { this.assassinate(id); this._assassinTarget = null; }
                });
                actionsEl.appendChild(killBtn);
            } else {
                actionsEl.innerHTML = `<span class="vp-phase">Waiting for Assassin...</span>`;
            }
        }
    }
}

function btn(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = `vp-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
}

// ---------------------------------------------------------------------------
// Build player cards in DOM
// ---------------------------------------------------------------------------
function buildPlayerCards(count) {
    const grid = document.getElementById('players-grid');
    grid.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const card = document.createElement('div');
        card.className = 'vp-card';
        card.id = `vp-card-${i}`;
        card.innerHTML = `
            <div class="vp-header">
                <span class="vp-name">Dev${i + 1}</span>
                <span class="vp-crown" style="display:none">♔</span>
                <span class="vp-role-badge">—</span>
            </div>
            <div class="vp-body">
                <span class="vp-phase">CONNECTING</span>
                <span class="vp-sees" style="display:none"></span>
                <div class="vp-actions"></div>
            </div>`;
        grid.appendChild(card);
    }
}

// ---------------------------------------------------------------------------
// Create game
// ---------------------------------------------------------------------------
document.getElementById('btn-dev-create').addEventListener('click', () => {
    const count = parseInt(document.getElementById('player-count-select').value);

    // Clean up previous session
    if (hostSocket) hostSocket.disconnect();
    vps.forEach(vp => vp.socket.disconnect());
    vps = [];
    currentLeaderId = null;

    buildPlayerCards(count);

    // Host socket
    hostSocket = io();
    hostSocket.on('connect', () => {
        log('Host socket connected', 'info');
        hostSocket.emit('create_game');
    });

    hostSocket.on('game_created', data => {
        gameCode = data.room_code;
        document.getElementById('game-code-display').textContent = gameCode;
        log(`Game created: ${gameCode} — joining ${count} virtual players`, 'event');

        // Load host iframe
        document.getElementById('host-frame').src = `/host#auto_code=${gameCode}`;

        // Spawn virtual players — staggered so names don't conflict on server
        for (let i = 0; i < count; i++) {
            setTimeout(() => {
                const vp = new VirtualPlayer(`Dev${i + 1}`, i);
                vps.push(vp);
            }, i * 80);
        }

        document.getElementById('btn-dev-start').disabled = false;
        enableBulkButtons(false);
    });

    wireHostEvents(hostSocket);
});

function wireHostEvents(sock) {
    sock.on('game_starting', () => log('Game starting...', 'event'));

    sock.on('round_start', d => {
        currentLeaderId = d.leader_id;
        currentMissionSize = d.mission_size;
        currentPlayerNameToId = d.player_name_to_id || {};
        currentPlayerOrder = d.player_order || [];
        currentMissionTeamIds = [];
        log(`Mission ${d.mission_num} — Leader: ${d.leader_name} — Team size: ${d.mission_size}`, 'event');
        renderAllCards();
    });

    sock.on('proposal_start', d => {
        currentLeaderId = d.leader_id;
        currentMissionSize = d.mission_size;
        currentPlayerNameToId = d.player_name_to_id || {};
        currentPlayerOrder = d.player_order || [];
        renderAllCards();
    });

    sock.on('team_proposed', d => {
        log(`Team: ${d.team.join(', ')}`, 'event');
    });

    sock.on('vote_start', d => {
        currentMissionTeamIds = d.team_ids || [];
    });

    sock.on('vote_reveal', d => {
        const summary = Object.entries(d.votes).map(([n,v]) => `${n}:${v[0].toUpperCase()}`).join(' ');
        log(`Votes: ${summary} → ${d.approved ? 'APPROVED ✓' : 'REJECTED ✗'}`, 'event');
    });

    sock.on('rejection_warning', d => {
        log(`Rejection ${d.consecutive}/5 — New leader: ${d.leader_name}`, 'event');
        currentLeaderId = d.leader_id;
        renderAllCards();
    });

    sock.on('evil_wins_by_rejection', () => log('EVIL WINS by rejection!', 'error'));

    sock.on('mission_start', d => {
        currentMissionTeamIds = d.team_ids || [];
        log(`Mission: ${d.team.join(', ')}`, 'event');
        renderAllCards();
    });

    sock.on('mission_reveal', d => {
        log(`Mission ${d.mission_num}: ${d.passed ? 'PASS ✓' : 'FAIL ✗'} (${d.fail_count} fail${d.fail_count !== 1 ? 's' : ''})`, 'event');
    });

    sock.on('assassin_phase_start', d => {
        log(`Assassin phase — ${d.assassin_name} choosing`, 'event');
        renderAllCards();
    });

    sock.on('game_over', d => {
        log(`GAME OVER — ${d.winner.toUpperCase()} wins (${d.win_reason})`, 'event');
        enableBulkButtons(false);
    });

    sock.on('return_to_lobby', () => {
        currentMissionTeamIds = [];
        currentLeaderId = null;
        renderAllCards();
    });

    sock.on('error', d => log(`Host err: ${d.message}`, 'error'));
}

function renderAllCards() {
    vps.forEach(vp => vp.render());
}

function enableBulkButtons(on) {
    ['btn-auto-approve','btn-auto-reject','btn-auto-success','btn-auto-fail','btn-auto-round'].forEach(id => {
        document.getElementById(id).disabled = !on;
    });
}

// ---------------------------------------------------------------------------
// Start game
// ---------------------------------------------------------------------------
document.getElementById('btn-dev-start').addEventListener('click', () => {
    if (!hostSocket) return;
    hostSocket.emit('start_game');
    log('Start game emitted', 'event');
    document.getElementById('btn-dev-start').disabled = true;
    enableBulkButtons(true);
});

// ---------------------------------------------------------------------------
// Bulk action buttons
// ---------------------------------------------------------------------------
document.getElementById('btn-auto-approve').addEventListener('click', () => {
    let count = 0;
    vps.forEach(vp => { if (vp.phase === 'VOTING' && !vp.voted) { vp.castVote('approve'); count++; } });
    log(`Approve all (${count} votes)`, 'event');
});

document.getElementById('btn-auto-reject').addEventListener('click', () => {
    let count = 0;
    vps.forEach(vp => { if (vp.phase === 'VOTING' && !vp.voted) { vp.castVote('reject'); count++; } });
    log(`Reject all (${count} votes)`, 'event');
});

document.getElementById('btn-auto-success').addEventListener('click', () => {
    let count = 0;
    vps.forEach(vp => { if (vp.phase === 'MISSION' && vp.isOnMissionTeam() && !vp.playedCard) { vp.playCard('success'); count++; } });
    log(`Success all (${count} cards)`, 'event');
});

document.getElementById('btn-auto-fail').addEventListener('click', () => {
    let count = 0;
    vps.forEach(vp => {
        if (vp.phase === 'MISSION' && vp.isOnMissionTeam() && !vp.playedCard) {
            vp.playCard(vp.team === 'evil' ? 'fail' : 'success');
            count++;
        }
    });
    log(`Auto-play (evil=fail, good=success) — ${count} cards`, 'event');
});

document.getElementById('btn-auto-round').addEventListener('click', () => {
    autoPropose();
    setTimeout(() => {
        vps.forEach(vp => { if (vp.phase === 'VOTING' && !vp.voted) vp.castVote('approve'); });
    }, 700);
    setTimeout(() => {
        vps.forEach(vp => { if (vp.phase === 'MISSION' && vp.isOnMissionTeam() && !vp.playedCard) vp.playCard('success'); });
    }, 1500);
    log('Auto-round: propose → approve → success', 'event');
});

// ---------------------------------------------------------------------------
// Auto-propose: leader picks first N players in seat order
// ---------------------------------------------------------------------------
function autoPropose() {
    const leader = vps.find(vp => vp.isLeader() && vp.phase === 'PROPOSAL');
    if (!leader) {
        log('No leader in PROPOSAL phase yet', 'error');
        return;
    }
    const allIds = currentPlayerOrder.map(n => currentPlayerNameToId[n]).filter(Boolean);
    const team = allIds.slice(0, currentMissionSize);
    if (team.length !== currentMissionSize) {
        log(`Could not build team (need ${currentMissionSize}, got ${team.length})`, 'error');
        return;
    }
    leader.propose(team);
    const names = currentPlayerOrder.slice(0, currentMissionSize).join(', ');
    log(`Propose: ${names}`, 'event');
}

// ---------------------------------------------------------------------------
// Auto-assassinate: pick random target
// ---------------------------------------------------------------------------
function autoAssassinate() {
    const assassin = vps.find(vp => vp.phase === 'ASSASSIN' && vp.isAssassin());
    if (!assassin) { log('No assassin found', 'error'); return; }
    // Ask server for targets via the debug endpoint
    fetch(`/debug/state/${gameCode}`).then(r => r.json()).then(state => {
        const evilIds = state.players.filter(p => p.team === 'evil').map(p => {
            return vps.find(v => v.name === p.name)?.playerId;
        }).filter(Boolean);
        const allIds = vps.map(v => v.playerId).filter(id => id && id !== assassin.playerId);
        const targets = allIds.filter(id => !evilIds.includes(id)); // prefer good targets
        const pick = targets[Math.floor(Math.random() * targets.length)] || allIds[0];
        if (pick) {
            assassin.assassinate(pick);
            const targetName = vps.find(v => v.playerId === pick)?.name || pick;
            log(`Assassinate: ${targetName}`, 'event');
        }
    });
}

// ---------------------------------------------------------------------------
// Music volume (controls the host iframe's audio manager)
// ---------------------------------------------------------------------------
function getHostWindow() {
    const frame = document.getElementById('host-frame');
    try { return frame && frame.contentWindow && frame.contentWindow.setMusicVolume ? frame.contentWindow : null; }
    catch(e) { return null; }
}

let _devMuted = false;
let _devLastVol = 0.55;

document.getElementById('dev-music-vol').addEventListener('input', e => {
    const vol = parseInt(e.target.value) / 100;
    _devLastVol = vol;
    _devMuted = vol === 0;
    document.getElementById('btn-dev-mute').textContent = _devMuted ? 'Unmute' : 'Mute';
    const hw = getHostWindow();
    if (hw) hw.setMusicVolume(vol);
});

document.getElementById('btn-dev-mute').addEventListener('click', () => {
    _devMuted = !_devMuted;
    const vol = _devMuted ? 0 : _devLastVol;
    document.getElementById('dev-music-vol').value = Math.round(vol * 100);
    document.getElementById('btn-dev-mute').textContent = _devMuted ? 'Unmute' : 'Mute';
    const hw = getHostWindow();
    if (hw) hw.setMusicVolume(vol);
});

// ---------------------------------------------------------------------------
// Debug state
// ---------------------------------------------------------------------------
document.getElementById('btn-dev-state').addEventListener('click', async () => {
    if (!gameCode) { log('No game', 'error'); return; }
    const r = await fetch(`/debug/state/${gameCode}`);
    const d = await r.json();
    log(`Phase: ${d.phase} | Mission: ${d.current_mission + 1} | Leader: ${d.current_leader} | Rejections: ${d.consecutive_rejections}`, 'event');
    const roles = d.players.map(p => `${p.name}(${(p.role||'?').split(' ')[0]}/${p.team?.[0]||'?'})`).join(' ');
    log(roles, 'info');
    console.log('[DEV]', d);
});
