/* A small, dependency-free draggable round table shared by host and phones. */
(function () {
    'use strict';

    const NS = 'http://www.w3.org/2000/svg';
    const PALETTES = [
        ['#344f63', '#9fc3dc'], ['#6b3b35', '#d99586'],
        ['#4a5b38', '#adca87'], ['#554267', '#c2a4d4'],
        ['#6a552f', '#e0c26e'], ['#355c59', '#86c7bd'],
        ['#6b4931', '#d7a36f'], ['#3e4869', '#a8b7e1'],
        ['#663f52', '#d99ab9'], ['#4f565c', '#c3ccd3'],
    ];

    function hashText(value) {
        let hash = 2166136261;
        for (const char of String(value)) {
            hash ^= char.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    const AVATAR_NAMES = [
        'Knight', 'King', 'Queen', 'Wizard', 'Archer',
        'Monk', 'Jester', 'Blacksmith', 'Bard', 'Ranger',
    ];
    window.AVALON_AVATAR_NAMES = AVATAR_NAMES;

    function createPortrait(palette, avatarIndex = 0) {
        const variant = Math.abs(Number(avatarIndex) || 0) % AVATAR_NAMES.length;
        const skin = '#d8aa82';
        const skinLight = '#efc49d';
        const ink = '#25272a';
        const steel = '#aeb7bb';
        const silver = '#dce2e3';
        const gold = '#e0c26e';
        const characters = [
            `<!-- Knight -->
             <path d="M13 64c2-15 9-23 19-23s17 8 19 23" fill="${steel}" stroke="${silver}" stroke-width="1.5"/>
             <path d="M19 27v-5c0-10 5-16 13-16s13 6 13 16v5" fill="${steel}" stroke="${silver}" stroke-width="1.5"/>
             <path d="M16 26h32v14c-4 6-9 9-16 9s-12-3-16-9Z" fill="#50575a" stroke="${silver}" stroke-width="1.5"/>
             <path d="M18 29h28v7H18Z" fill="#171a1c"/><path d="M23 29v7m6-7v7m6-7v7m6-7v7" stroke="${palette[1]}" stroke-width="1.5"/>
             <path d="M32 7V2c6 0 10 2 12 6-5-1-9 0-12 3" fill="${palette[1]}" stroke="${palette[1]}" stroke-width="1.5"/>`,
            `<!-- King -->
             <path d="M10 64c3-15 11-22 22-22s19 7 22 22" fill="${palette[0]}" stroke="${gold}" stroke-width="1.5"/>
             <circle cx="32" cy="29" r="14" fill="${skin}"/><path d="M19 27c1-11 6-16 13-16s12 5 13 16c-6-5-20-5-26 0" fill="#6b442f"/>
             <path d="M23 35c2 12 16 12 18 0-2 13-5 17-9 17s-7-4-9-17" fill="#efe1c6"/>
             <path d="m18 15 3-11 7 7 4-9 4 9 7-7 3 11Z" fill="${gold}" stroke="#fff0aa" stroke-width="1.2"/>
             <circle cx="22" cy="8" r="1.5" fill="${palette[1]}"/><circle cx="32" cy="5" r="1.5" fill="${palette[1]}"/><circle cx="42" cy="8" r="1.5" fill="${palette[1]}"/>`,
            `<!-- Queen -->
             <path d="M9 64c4-16 12-23 23-23s19 7 23 23" fill="${palette[0]}" stroke="${gold}" stroke-width="1.5"/>
             <path d="M17 30c0-13 6-20 15-20s15 7 15 20v20c-5-5-10-7-15-7s-10 2-15 7Z" fill="#5b3428"/>
             <ellipse cx="32" cy="29" rx="12" ry="15" fill="${skinLight}"/>
             <path d="m20 15 3-10 6 7 3-10 3 10 6-7 3 10Z" fill="${gold}" stroke="#fff0aa" stroke-width="1.2"/>
             <path d="M25 35c4 3 10 3 14 0" fill="none" stroke="#a85e5e" stroke-width="1.3" stroke-linecap="round"/>
             <path d="m25 51 7 8 7-8" fill="none" stroke="${gold}" stroke-width="2"/>`,
            `<!-- Wizard -->
             <path d="M8 64c4-17 12-24 24-24s20 7 24 24" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <circle cx="32" cy="31" r="13" fill="${skin}"/><path d="M21 33c1 18 21 18 22 0-3 16-7 22-11 22s-8-6-11-22" fill="#d6d1c6"/>
             <path d="M14 22h36L36 2c-2-3-6-3-8 0Z" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <path d="M18 18h28" stroke="${gold}" stroke-width="2"/><circle cx="35" cy="10" r="2" fill="${gold}"/>
             <path d="M24 29c2-2 4-2 6 0m4 0c2-2 4-2 6 0" fill="none" stroke="${ink}" stroke-width="1.4"/>`,
            `<!-- Archer -->
             <path d="M10 64c3-16 10-23 22-23s19 7 22 23" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <path d="M19 31c0-13 5-21 13-21s13 8 13 21l-6 13H25Z" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <ellipse cx="32" cy="31" rx="9" ry="12" fill="${skin}"/>
             <path d="M19 29c4-8 9-12 13-12s9 4 13 12c-8-4-18-4-26 0" fill="${palette[0]}"/>
             <path d="M17 53 7 9m4 4 5-7m-5 7-7-3" stroke="#c89d58" stroke-width="2" stroke-linecap="round"/>
             <path d="M43 12c6 10 6 23 0 33" fill="none" stroke="#c89d58" stroke-width="1.8"/>`,
            `<!-- Monk -->
             <path d="M8 64c4-17 12-24 24-24s20 7 24 24" fill="#6a4a30" stroke="${palette[1]}" stroke-width="1.5"/>
             <circle cx="32" cy="29" r="15" fill="${skin}"/><path d="M19 25c1-10 6-15 13-15s12 5 13 15c-5-4-9-5-13-5s-8 1-13 5" fill="#75503b"/>
             <ellipse cx="32" cy="15" rx="7" ry="5" fill="${skinLight}"/>
             <path d="M21 38c7 6 15 6 22 0" fill="none" stroke="#6d4937" stroke-width="3"/>
             <path d="M17 49c9 5 21 5 30 0M32 45v19" stroke="#b58b58" stroke-width="1.5"/>
             <circle cx="32" cy="54" r="2" fill="none" stroke="${gold}" stroke-width="1.2"/>`,
            `<!-- Jester -->
             <path d="M9 64c3-16 11-23 23-23s20 7 23 23" fill="${palette[0]}" stroke="${gold}" stroke-width="1.5"/>
             <circle cx="32" cy="31" r="13" fill="${skinLight}"/>
             <path d="M17 18c1-9 7-14 15-14 0 7-2 11-5 14M47 18c-1-9-7-14-15-14 0 7 2 11 5 14" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <circle cx="17" cy="18" r="3" fill="${gold}"/><circle cx="47" cy="18" r="3" fill="${gold}"/>
             <path d="M25 35c4 5 10 5 14 0" fill="none" stroke="#a85e5e" stroke-width="1.5"/>
             <path d="m20 48 6 6 6-6 6 6 6-6" fill="none" stroke="${gold}" stroke-width="2"/>`,
            `<!-- Blacksmith -->
             <path d="M8 64c4-16 12-23 24-23s20 7 24 23" fill="#3f4142" stroke="${steel}" stroke-width="1.5"/>
             <circle cx="32" cy="29" r="14" fill="${skin}"/><path d="M18 25c2-11 7-16 14-16s12 5 14 16" fill="#343638"/>
             <path d="M20 36c3 12 21 12 24 0-4 14-8 18-12 18s-8-4-12-18" fill="#3a2922"/>
             <path d="M18 50h28l-3 14H21Z" fill="#7a4e31" stroke="#c3905e" stroke-width="1.3"/>
             <path d="M48 8v31m-7-31h14v8H41Z" fill="${steel}" stroke="${silver}" stroke-width="1.4"/>
             <path d="M22 29h7m6 0h7" stroke="${ink}" stroke-width="1.5"/>`,
            `<!-- Bard -->
             <path d="M9 64c3-16 11-23 23-23s20 7 23 23" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <circle cx="32" cy="30" r="13" fill="${skinLight}"/><path d="M18 26c1-11 6-16 14-16s13 5 14 16c-7-5-21-5-28 0" fill="#5c3526"/>
             <path d="M17 17c8-8 20-10 31-4-7 1-14 4-20 9Z" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.4"/>
             <path d="M41 14c5-8 9-10 14-10-2 6-6 10-14 13" fill="${gold}"/>
             <ellipse cx="47" cy="52" rx="8" ry="11" fill="#a66d37" stroke="#e4b66e" stroke-width="1.5"/><circle cx="47" cy="52" r="3" fill="#3c2417"/>
             <path d="M40 46 25 26" stroke="#e4b66e" stroke-width="2"/>`,
            `<!-- Ranger -->
             <path d="M8 64c3-17 11-24 24-24s21 7 24 24" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <path d="M16 33c0-15 6-24 16-24s16 9 16 24L42 47H22Z" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
             <ellipse cx="32" cy="31" rx="10" ry="13" fill="${skin}"/>
             <path d="M18 28c4-13 9-18 14-18s10 5 14 18c-8-5-20-5-28 0" fill="${palette[0]}"/>
             <path d="M21 32h22l-3 8c-6 4-10 4-16 0Z" fill="#252b28"/>
             <path d="M25 30h5m4 0h5" stroke="${skinLight}" stroke-width="1.6"/>
             <path d="M14 55 6 16m3 1 6-6M50 55l8-39m-3 1-6-6" stroke="#8e6b3d" stroke-width="1.7"/>`,
        ];
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 64 64');
        svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = `
            <circle cx="32" cy="32" r="31" fill="${palette[0]}"/>
            ${characters[variant]}
            <circle cx="32" cy="32" r="30" fill="none" stroke="${palette[1]}" stroke-width="1.25" opacity="0.8"/>
        `;
        return svg;
    }

    class PresenceTable {
        constructor(options = {}) {
            this.mode = options.mode === 'host' ? 'host' : 'player';
            this.roomCode = '';
            this.players = [];
            this.positions = {};
            this.revealedRoles = null;
            this.roleManifest = [];
            this.statusMode = 'lobby';
            this.completedPlayerKeys = new Set();
            this.leaderKey = '';
            this.drag = null;
            this.mountedScreen = null;

            this.element = document.createElement('section');
            this.element.className = `presence-table presence-${this.mode} presence-round-table hidden`;
            this.element.setAttribute('aria-label', 'Draggable Round Table');
            this.element.innerHTML = `
                <div class="presence-controls">
                    <span class="presence-round-table-label">Round Table</span>
                    <button type="button" class="presence-reset" title="Reset avatar positions">Reset</button>
                </div>
                <div class="presence-field">
                    <div class="presence-nodes"></div>
                </div>
                <div class="presence-role-manifest hidden" aria-label="Characters in this game"></div>`;
            this.field = this.element.querySelector('.presence-field');
            this.nodes = this.element.querySelector('.presence-nodes');
            this.manifest = this.element.querySelector('.presence-role-manifest');
            this.element.querySelector('.presence-reset').addEventListener('click', () => this.reset());

            this.roleTooltip = document.createElement('div');
            this.roleTooltip.className = 'presence-character-tooltip hidden';
            this.roleTooltip.setAttribute('role', 'tooltip');
            document.body.appendChild(this.roleTooltip);
            document.addEventListener('pointerdown', event => {
                if (!this.roleTooltip.contains(event.target) && !event.target.closest('.presence-character')) {
                    this.hideRoleTooltip();
                }
            });

            if ('ResizeObserver' in window) {
                this.resizeObserver = new ResizeObserver(() => this.layout());
                this.resizeObserver.observe(this.field);
            } else {
                window.addEventListener('resize', () => this.layout(), { passive: true });
            }
        }

        storageKey() {
            return this.roomCode ? `avalon-round-table:v1:${this.mode}:${this.roomCode}` : '';
        }

        setRoomCode(code) {
            const normalized = String(code || '').toUpperCase();
            if (normalized === this.roomCode) return;
            this.roomCode = normalized;
            this.positions = {};
            const key = this.storageKey();
            if (key) {
                try {
                    const saved = JSON.parse(localStorage.getItem(key) || '{}');
                    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
                        this.positions = this.sanitizePositions(saved);
                    }
                } catch (_) {
                    this.positions = {};
                }
            }
            this.layout();
        }

        setPlayers(playerList, orderedNames = []) {
            const previousPlayers = this.players;
            const previousCount = previousPlayers.length;
            const byName = new Map((playerList || []).map(player => [player.name, player]));
            const ordered = [];
            for (const name of orderedNames || []) {
                if (byName.has(name)) {
                    ordered.push(byName.get(name));
                    byName.delete(name);
                }
            }
            this.players = ordered.concat([...byName.values()]);
            if (previousCount && previousCount !== this.players.length) {
                this.players.forEach((player, newIndex) => {
                    const oldIndex = previousPlayers.findIndex(candidate =>
                        String(candidate.player_id || candidate.name) === String(player.player_id || player.name));
                    const key = String(player.player_id || player.name);
                    const saved = this.positions[key];
                    if (oldIndex < 0 || !saved) return;
                    const oldDefault = this.orderPosition(oldIndex, previousCount);
                    if (Math.abs(saved.x - oldDefault.x) < 0.002 && Math.abs(saved.y - oldDefault.y) < 0.002) {
                        this.positions[key] = this.orderPosition(newIndex, this.players.length);
                    }
                });
            }
            this.prunePositions();
            this.ensurePositions();
            this.render();
            this.save();
        }

        setGameStatus({ mode = 'game', completedIds = [], completedNames = [], leaderId = '', leaderName = '' } = {}) {
            this.statusMode = mode;
            this.completedPlayerKeys = new Set([
                ...completedIds.map(String),
                ...completedNames.map(String),
            ]);
            this.leaderKey = String(leaderId || leaderName || '');
            this.render();
        }

        ensurePositions() {
            this.players.forEach((player, index) => {
                const key = String(player.player_id || player.name);
                if (!this.positions[key]) {
                    this.positions[key] = this.orderPosition(index, this.players.length);
                }
            });
        }

        sanitizePositions(positions) {
            const clean = {};
            Object.entries(positions || {}).forEach(([key, point]) => {
                if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
                clean[String(key)] = {
                    x: Math.min(1, Math.max(0, point.x)),
                    y: Math.min(1, Math.max(0, point.y)),
                };
            });
            return clean;
        }

        prunePositions() {
            const available = new Set(this.players.map(player => String(player.player_id || player.name)));
            Object.keys(this.positions).forEach(key => {
                if (!available.has(key)) delete this.positions[key];
            });
        }

        setRoleManifest(manifest) {
            this.roleManifest = Array.isArray(manifest) ? manifest : [];
            const abbreviations = {
                'Merlin': 'Mer',
                'Percival': 'Per',
                'Loyal Servant': 'Loy',
                'Assassin': 'Asn',
                'Morgana': 'Mor',
                'Mordred': 'Mrd',
                'Oberon': 'Obr',
                'Minion of Mordred': 'Min',
            };
            this.manifest.replaceChildren();
            this.roleManifest.forEach(item => {
                if (!item || !item.role || !['good', 'evil'].includes(item.team)) return;
                const badge = document.createElement('button');
                badge.type = 'button';
                badge.className = `presence-character ${item.team}`;
                badge.textContent = `${item.team === 'good' ? '✦' : '◆'} ${abbreviations[item.role] || item.role.slice(0, 3)}`;
                badge.title = item.role;
                badge.setAttribute('aria-label', `${item.team}, ${item.role}. Tap for role description.`);
                badge.addEventListener('click', event => {
                    event.stopPropagation();
                    this.showRoleTooltip(badge, item);
                });
                this.manifest.appendChild(badge);
            });
            this.manifest.classList.toggle('hidden', !this.manifest.children.length);
        }

        showRoleTooltip(anchor, item) {
            const descriptions = {
                'Merlin': 'Sees most evil players and guides Good without being identified.',
                'Percival': 'Sees Merlin and Morgana, but does not know which is which.',
                'Loyal Servant': 'Has no secret information and must find trustworthy allies.',
                'Assassin': 'Serves Evil and can steal victory by identifying Merlin at the end.',
                'Morgana': 'Serves Evil and appears as Merlin to Percival.',
                'Mordred': 'Serves Evil but is hidden from Merlin.',
                'Oberon': 'Serves Evil but does not know the other evil players, or they him.',
                'Minion of Mordred': 'Serves Evil and works with the other known evil players.',
            };
            this.roleTooltip.replaceChildren();
            const title = document.createElement('strong');
            title.textContent = item.role;
            const team = document.createElement('span');
            team.className = item.team;
            team.textContent = item.team === 'good' ? 'Forces of Good' : 'Forces of Evil';
            const description = document.createElement('p');
            description.textContent = descriptions[item.role] || 'A character in this game of Avalon.';
            this.roleTooltip.append(title, team, description);
            this.roleTooltip.classList.remove('hidden');
            const rect = anchor.getBoundingClientRect();
            const tooltipRect = this.roleTooltip.getBoundingClientRect();
            const left = Math.min(window.innerWidth - tooltipRect.width - 8, Math.max(8, rect.left + rect.width / 2 - tooltipRect.width / 2));
            const above = rect.top - tooltipRect.height - 8;
            const top = above >= 8 ? above : Math.min(window.innerHeight - tooltipRect.height - 8, rect.bottom + 8);
            this.roleTooltip.style.left = `${left}px`;
            this.roleTooltip.style.top = `${top}px`;
        }

        hideRoleTooltip() {
            this.roleTooltip.classList.add('hidden');
        }

        orderPosition(index, count) {
            const angle = -Math.PI / 2 + (index / Math.max(1, count)) * Math.PI * 2;
            return {
                x: 0.5 + Math.cos(angle) * 0.39,
                y: 0.5 + Math.sin(angle) * 0.34,
            };
        }

        setRoleReveal(roles) {
            this.revealedRoles = roles && typeof roles === 'object' ? roles : null;
            this.render();
        }

        createPortraitElement(avatarIndex = 0, colorIndex = 0, avatarImage = null) {
            if (avatarImage) {
                const image = document.createElement('img');
                image.src = avatarImage;
                image.alt = '';
                image.decoding = 'async';
                return image;
            }
            return createPortrait(PALETTES[Math.abs(Number(colorIndex) || 0) % PALETTES.length], avatarIndex);
        }

        paletteFor(player, fallbackSeed = '') {
            const requested = Number(player && player.color_index);
            const index = Number.isInteger(requested) && requested >= 0
                ? requested % PALETTES.length
                : hashText(fallbackSeed || (player && (player.player_id || player.name)) || '') % PALETTES.length;
            return PALETTES[index];
        }

        colorForName(name, colorIndex = null) {
            const player = this.players.find(candidate => candidate.name === name) || { name };
            if (Number.isInteger(Number(colorIndex)) && colorIndex !== null) {
                player.color_index = Number(colorIndex);
            }
            return this.paletteFor(player, name)[1];
        }

        render() {
            this.nodes.replaceChildren();
            this.players.forEach(player => {
                const key = String(player.player_id || player.name);
                const palette = this.paletteFor(player, key);
                const reveal = this.revealedRoles && this.revealedRoles[player.name];
                const team = reveal && String(reveal.team || '').toLowerCase();
                const node = document.createElement('div');
                const isLobbyReady = this.statusMode === 'lobby' && player.ready;
                const hasCompletedAction = this.statusMode !== 'lobby' && (
                    this.completedPlayerKeys.has(key) || this.completedPlayerKeys.has(String(player.name))
                );
                const isLeader = this.statusMode !== 'lobby' && (
                    this.leaderKey === key || this.leaderKey === String(player.name)
                );
                node.className = `presence-node${player.connected === false ? ' disconnected' : ''}${isLobbyReady || hasCompletedAction ? ' ready' : ''}${hasCompletedAction ? ' action-complete' : ''}${isLeader ? ' current-leader' : ''}${reveal ? ` role-revealed team-${team}` : ''}`;
                node.dataset.playerKey = key;
                node.style.setProperty('--player-color-dark', palette[0]);
                node.style.setProperty('--player-color', palette[1]);
                node.tabIndex = 0;
                node.setAttribute('role', 'button');
                node.setAttribute('aria-roledescription', 'draggable player');
                const revealLabel = reveal ? `, ${team}, ${reveal.role}` : '';
                node.setAttribute('aria-label', `${player.name}, turn ${this.players.indexOf(player) + 1}, ${player.connected === false ? 'disconnected' : 'connected'}${revealLabel}. Drag or use arrow keys to reposition.`);

                const portrait = document.createElement('span');
                portrait.className = 'presence-portrait';
                if (player.avatar_image) {
                    portrait.classList.add('selfie-portrait');
                    const image = document.createElement('img');
                    image.src = player.avatar_image;
                    image.alt = '';
                    image.decoding = 'async';
                    portrait.appendChild(image);
                } else {
                    portrait.appendChild(createPortrait(palette, player.avatar_index));
                }
                const status = document.createElement('span');
                status.className = 'presence-status';
                portrait.appendChild(status);
                const order = document.createElement('span');
                order.className = 'presence-order-number';
                order.textContent = String(this.players.indexOf(player) + 1);
                order.setAttribute('aria-hidden', 'true');
                portrait.appendChild(order);
                if ((isLobbyReady || hasCompletedAction) && !reveal) {
                    const ready = document.createElement('span');
                    ready.className = 'presence-ready';
                    ready.textContent = '✓';
                    ready.setAttribute('aria-label', isLobbyReady ? 'ready' : 'decision submitted');
                    portrait.appendChild(ready);
                }
                if (isLeader && !reveal) {
                    const leader = document.createElement('span');
                    leader.className = 'presence-leader';
                    leader.textContent = '♛';
                    leader.setAttribute('aria-label', 'current leader');
                    portrait.appendChild(leader);
                }

                const name = document.createElement('span');
                name.className = 'presence-name';
                name.textContent = player.name;
                node.append(portrait, name);
                if (reveal) {
                    const role = document.createElement('span');
                    role.className = 'presence-role';
                    role.textContent = `${team === 'evil' ? 'EVIL' : 'GOOD'} — ${reveal.role}`;
                    node.appendChild(role);
                }
                node.addEventListener('pointerdown', event => this.startDrag(event, node));
                node.addEventListener('pointermove', event => this.moveDrag(event, node));
                node.addEventListener('pointerup', event => this.endDrag(event, node));
                node.addEventListener('pointercancel', event => this.endDrag(event, node));
                node.addEventListener('keydown', event => this.moveWithKeyboard(event, node));
                this.nodes.appendChild(node);
            });
            requestAnimationFrame(() => this.layout());
        }

        show(screen, label = 'Drag avatars anywhere') {
            if (!screen || !this.players.length) {
                this.hide();
                return;
            }
            if (this.mountedScreen && this.mountedScreen !== screen) {
                this.mountedScreen.classList.remove('presence-active');
            }
            this.mountedScreen = screen;
            screen.classList.add('presence-active');
            let panel = screen.querySelector(':scope > .presence-game-panel');
            if (!panel) {
                panel = document.createElement('div');
                panel.className = `presence-game-panel presence-${this.mode}-panel`;
                [...screen.children]
                    .filter(child => child !== this.element && !child.classList.contains('night-stars'))
                    .forEach(child => panel.appendChild(child));
                screen.appendChild(panel);
            }
            if (panel.nextElementSibling !== this.element) panel.after(this.element);

            this.element.classList.remove('hidden');
            requestAnimationFrame(() => this.layout());
        }

        showInline(container, label = 'Drag avatars anywhere') {
            if (!container || !this.players.length) {
                this.hide();
                return;
            }
            if (this.mountedScreen) this.mountedScreen.classList.remove('presence-active');
            this.mountedScreen = null;
            container.appendChild(this.element);
            this.element.classList.remove('hidden');
            requestAnimationFrame(() => this.layout());
        }

        hide() {
            this.element.classList.add('hidden');
            if (this.mountedScreen) this.mountedScreen.classList.remove('presence-active');
            this.mountedScreen = null;
        }

        layout() {
            if (this.element.classList.contains('hidden')) return;
            const width = this.field.clientWidth;
            const height = this.field.clientHeight;
            if (!width || !height) return;
            const nodeElements = [...this.nodes.children];
            const count = nodeElements.length;
            nodeElements.forEach((node, index) => {
                const saved = this.positions[node.dataset.playerKey] || this.orderPosition(index, count);
                const { x: xRatio, y: yRatio } = saved;
                this.place(node, xRatio * width, yRatio * height, width, height);
            });
        }

        place(node, x, y, width = this.field.clientWidth, height = this.field.clientHeight) {
            const halfW = node.offsetWidth / 2;
            const halfH = node.offsetHeight / 2;
            const safeX = Math.min(Math.max(x, halfW), Math.max(halfW, width - halfW));
            const safeY = Math.min(Math.max(y, halfH), Math.max(halfH, height - halfH));
            node.style.left = `${safeX}px`;
            node.style.top = `${safeY}px`;
            return { x: safeX, y: safeY };
        }

        startDrag(event, node) {
            if (event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            node.focus({ preventScroll: true });
            node.setPointerCapture(event.pointerId);
            node.classList.add('dragging');
            this.drag = { pointerId: event.pointerId, key: node.dataset.playerKey };
            this.moveDrag(event, node);
        }

        moveDrag(event, node) {
            if (!this.drag || this.drag.pointerId !== event.pointerId || this.drag.key !== node.dataset.playerKey) return;
            event.preventDefault();
            const rect = this.field.getBoundingClientRect();
            const point = this.place(
                node,
                event.clientX - rect.left,
                event.clientY - rect.top,
                rect.width,
                rect.height,
            );
            this.positions[node.dataset.playerKey] = {
                x: point.x / rect.width,
                y: point.y / rect.height,
            };
        }

        endDrag(event, node) {
            if (!this.drag || this.drag.pointerId !== event.pointerId || this.drag.key !== node.dataset.playerKey) return;
            node.classList.remove('dragging');
            this.drag = null;
            this.save();
        }

        moveWithKeyboard(event, node) {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const positions = this.positions;
            const current = positions[node.dataset.playerKey] || { x: 0.5, y: 0.58 };
            const step = 0.035;
            positions[node.dataset.playerKey] = {
                x: Math.min(1, Math.max(0, current.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0))),
                y: Math.min(1, Math.max(0, current.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))),
            };
            this.layout();
            this.save();
        }

        save() {
            const key = this.storageKey();
            if (!key) return;
            try {
                localStorage.setItem(key, JSON.stringify(this.positions));
            } catch (_) {
                // The round table still works if browser storage is unavailable.
            }
        }

        reset() {
            this.positions = {};
            this.ensurePositions();
            const key = this.storageKey();
            if (key) {
                try { localStorage.removeItem(key); } catch (_) { /* no-op */ }
            }
            this.save();
            this.layout();
        }

    }

    window.AvalonPresenceTable = PresenceTable;

    let missionTooltip = null;
    function hideMissionTooltip() {
        if (missionTooltip) missionTooltip.classList.add('hidden');
    }
    function showMissionTooltip(anchor, mission) {
        if (!mission || !anchor) return;
        if (!missionTooltip) {
            missionTooltip = document.createElement('div');
            missionTooltip.className = 'mission-history-tooltip hidden';
            missionTooltip.setAttribute('role', 'dialog');
            document.body.appendChild(missionTooltip);
            missionTooltip.addEventListener('click', event => event.stopPropagation());
        }
        missionTooltip.replaceChildren();
        const title = document.createElement('strong');
        title.textContent = `Mission ${mission.mission_num} · ${mission.passed ? 'Succeeded' : 'Failed'}`;
        const leader = document.createElement('span');
        leader.textContent = `Leader: ${mission.leader_name}`;
        const team = document.createElement('span');
        team.textContent = `Party: ${(mission.team || []).join(', ')}`;
        const cards = document.createElement('span');
        cards.textContent = `${mission.success_count} success · ${mission.fail_count} failure${mission.fail_count === 1 ? '' : 's'}`;
        missionTooltip.append(title, leader, team, cards);
        missionTooltip.classList.remove('hidden');
        const rect = anchor.getBoundingClientRect();
        const width = missionTooltip.offsetWidth;
        missionTooltip.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8)}px`;
        missionTooltip.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - missionTooltip.offsetHeight - 8)}px`;
    }
    document.addEventListener('click', hideMissionTooltip);
    window.AvalonMissionTooltip = { show: showMissionTooltip, hide: hideMissionTooltip };
})();
