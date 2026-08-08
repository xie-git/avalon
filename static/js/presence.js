/* A small, dependency-free draggable player table shared by host and phones. */
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

    const AVATAR_MARKS = ['◆', '✦', '▲', '●', '✚', '♜', '☾', '⚜'];

    function createPortrait(palette, avatarIndex = 0) {
        const variant = Math.abs(Number(avatarIndex) || 0) % AVATAR_MARKS.length;
        const mark = AVATAR_MARKS[variant];
        const crests = [
            `<path d="M32 9V3m0 0c5 0 9 2 11 5-5-1-8 0-11 3" fill="${palette[1]}" stroke="${palette[1]}" stroke-width="2" stroke-linecap="round"/>`,
            `<path d="M25 11 20 5m19 6 5-6" fill="none" stroke="${palette[1]}" stroke-width="3" stroke-linecap="round"/>`,
            `<path d="m24 10 2-7 6 5 6-5 2 7" fill="${palette[1]}" stroke="#e1e4e4" stroke-width="1"/>`,
            `<path d="M24 10c0-6 4-9 8-9s8 3 8 9c-5-3-11-3-16 0Z" fill="${palette[1]}"/>`,
            `<path d="M32 10 26 1h12Z" fill="${palette[1]}" stroke="#e1e4e4" stroke-width="1"/>`,
            `<path d="M23 10c3-7 15-7 18 0" fill="none" stroke="${palette[1]}" stroke-width="4"/>`,
            `<path d="M27 10c-1-6 2-9 5-9s6 3 5 9" fill="${palette[1]}"/>`,
            `<path d="M24 9 28 2l4 6 4-6 4 7" fill="none" stroke="${palette[1]}" stroke-width="2.5" stroke-linejoin="round"/>`,
        ];
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 64 64');
        svg.setAttribute('aria-hidden', 'true');
        svg.innerHTML = `
            <circle cx="32" cy="32" r="31" fill="${palette[0]}"/>
            <path d="M6 64c2-16 11-24 26-24s24 8 26 24" fill="#25272a"/>
            <path d="M15 64c2-12 8-19 17-19s15 7 17 19" fill="${palette[0]}" stroke="${palette[1]}" stroke-width="1.5"/>
            <path d="M20 44h24l-3 20H23Z" fill="#777d80"/>
            <path d="M27 46h10v18H27Z" fill="${palette[0]}"/>
            <path d="M18 29v-5c0-10 6-17 14-17s14 7 14 17v5Z" fill="#b9bec0" stroke="#e1e4e4" stroke-width="1.5"/>
            <path d="M16 27h32v13c-4 5-9 8-16 8s-12-3-16-8Z" fill="#4b5053" stroke="#c9cdce" stroke-width="1.5"/>
            <path d="M18 30h28v6H18Z" fill="#181b1d"/>
            <path d="M23 30v6m6-6v6m6-6v6m6-6v6" stroke="${palette[1]}" stroke-width="1.6"/>
            ${crests[variant]}
            <path d="M25 56l7 5 7-5" fill="none" stroke="${palette[1]}" stroke-width="2"/>
            <text x="32" y="59" text-anchor="middle" font-size="9" font-weight="bold" fill="${palette[1]}">${mark}</text>
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
            this.drag = null;
            this.mountedScreen = null;

            this.element = document.createElement('section');
            this.element.className = `presence-table presence-${this.mode} hidden`;
            this.element.setAttribute('aria-label', 'Players at the round table');
            this.element.innerHTML = `
                <div class="presence-heading">
                    <span class="presence-title">The Fellowship</span>
                    <span class="presence-count" aria-live="polite"></span>
                    <button type="button" class="presence-reset" title="Return avatars to the circle">Reset avatars</button>
                </div>
                <div class="presence-field">
                    <div class="presence-table-center" aria-hidden="true">
                        <span class="presence-center-mark">⚔</span>
                        <span class="presence-center-label">Round Table</span>
                        <div class="presence-center-content"></div>
                    </div>
                    <div class="presence-nodes"></div>
                </div>`;
            this.field = this.element.querySelector('.presence-field');
            this.nodes = this.element.querySelector('.presence-nodes');
            this.center = this.element.querySelector('.presence-table-center');
            this.count = this.element.querySelector('.presence-count');
            this.centerLabel = this.element.querySelector('.presence-center-label');
            this.centerContent = this.element.querySelector('.presence-center-content');
            this.centerItemHome = null;
            this.element.querySelector('.presence-reset').addEventListener('click', () => this.reset());

            if ('ResizeObserver' in window) {
                this.resizeObserver = new ResizeObserver(() => this.layout());
                this.resizeObserver.observe(this.field);
            } else {
                window.addEventListener('resize', () => this.layout(), { passive: true });
            }
        }

        storageKey() {
            return this.roomCode ? `avalon-avatar-layout:${this.mode}:${this.roomCode}` : '';
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
                        this.positions = saved;
                    }
                } catch (_) {
                    this.positions = {};
                }
            }
            this.layout();
        }

        setPlayers(playerList, orderedNames = []) {
            const byName = new Map((playerList || []).map(player => [player.name, player]));
            const ordered = [];
            for (const name of orderedNames || []) {
                if (byName.has(name)) {
                    ordered.push(byName.get(name));
                    byName.delete(name);
                }
            }
            this.players = ordered.concat([...byName.values()]);
            this.render();
        }

        setRoleReveal(roles) {
            this.revealedRoles = roles && typeof roles === 'object' ? roles : null;
            this.render();
        }

        createPortraitElement(avatarIndex = 0, colorIndex = 0) {
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
            const connected = this.players.filter(player => player.connected !== false).length;
            this.count.textContent = `${connected} of ${this.players.length} connected`;

            this.players.forEach(player => {
                const key = String(player.player_id || player.name);
                const palette = this.paletteFor(player, key);
                const reveal = this.revealedRoles && this.revealedRoles[player.name];
                const team = reveal && String(reveal.team || '').toLowerCase();
                const node = document.createElement('div');
                node.className = `presence-node${player.connected === false ? ' disconnected' : ''}${player.ready ? ' ready' : ''}${reveal ? ` role-revealed team-${team}` : ''}`;
                node.dataset.playerKey = key;
                node.style.setProperty('--player-color-dark', palette[0]);
                node.style.setProperty('--player-color', palette[1]);
                node.tabIndex = 0;
                node.setAttribute('role', 'img');
                const revealLabel = reveal ? `, ${team}, ${reveal.role}` : '';
                node.setAttribute('aria-label', `${player.name}, ${player.connected === false ? 'disconnected' : 'connected'}${revealLabel}`);

                const portrait = document.createElement('span');
                portrait.className = 'presence-portrait';
                portrait.appendChild(createPortrait(palette, player.avatar_index));
                const status = document.createElement('span');
                status.className = 'presence-status';
                portrait.appendChild(status);
                if (player.ready && !reveal) {
                    const ready = document.createElement('span');
                    ready.className = 'presence-ready';
                    ready.textContent = '✓';
                    ready.setAttribute('aria-label', 'ready');
                    portrait.appendChild(ready);
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
                this.nodes.appendChild(node);
            });
            requestAnimationFrame(() => this.layout());
        }

        show(screen, label = 'Round Table', anchor = null) {
            if (!screen || !this.players.length) {
                this.hide();
                return;
            }
            this.releaseCenterContent();
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

            const timer = this.mode === 'host' && screen.id === 'screen-round'
                ? panel.querySelector('#discussion-timer-container')
                : this.mode === 'host' && screen.id === 'screen-proposal'
                    ? panel.querySelector('#proposal-timer-host')
                    : this.mode === 'player' && screen.id === 'screen-discussion'
                        ? panel.querySelector('#discussion-timer-player')
                        : this.mode === 'player' && screen.id === 'screen-proposal'
                            ? panel.querySelector('#proposal-timer-player')
                            : null;
            if (timer) this.mountCenterContent(timer);
            this.centerLabel.textContent = label;
            this.element.classList.remove('hidden');
            requestAnimationFrame(() => this.layout());
        }

        hide() {
            this.releaseCenterContent();
            this.element.classList.add('hidden');
            if (this.mountedScreen) this.mountedScreen.classList.remove('presence-active');
            this.mountedScreen = null;
        }

        mountCenterContent(element) {
            this.centerItemHome = {
                element,
                parent: element.parentElement,
                nextSibling: element.nextSibling,
            };
            this.centerContent.appendChild(element);
            this.element.classList.add('presence-has-center-content');
            this.center.setAttribute('aria-hidden', 'false');
        }

        releaseCenterContent() {
            if (this.centerItemHome) {
                const { element, parent, nextSibling } = this.centerItemHome;
                if (parent) parent.insertBefore(element, nextSibling && nextSibling.parentElement === parent ? nextSibling : null);
                this.centerItemHome = null;
            }
            this.element.classList.remove('presence-has-center-content');
            this.center.setAttribute('aria-hidden', 'true');
        }

        layout() {
            if (this.element.classList.contains('hidden')) return;
            const width = this.field.clientWidth;
            const height = this.field.clientHeight;
            if (!width || !height) return;
            const nodeElements = [...this.nodes.children];
            const count = nodeElements.length;
            nodeElements.forEach((node, index) => {
                const key = node.dataset.playerKey;
                const saved = this.positions[key];
                let x;
                let y;
                if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
                    x = saved.x * width;
                    y = saved.y * height;
                } else {
                    const angle = (Math.PI * 2 * index / Math.max(1, count)) - Math.PI / 2;
                    const rx = Math.max(0, (width - node.offsetWidth) / 2 - 6);
                    const ry = Math.max(0, (height - node.offsetHeight) / 2 - 6);
                    x = width / 2 + rx * Math.cos(angle);
                    y = height / 2 + ry * Math.sin(angle);
                }
                this.place(node, x, y, width, height);
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
            node.setPointerCapture(event.pointerId);
            node.classList.add('dragging');
            this.drag = { pointerId: event.pointerId, key: node.dataset.playerKey };
            this.moveDrag(event, node);
        }

        moveDrag(event, node) {
            if (!this.drag || this.drag.pointerId !== event.pointerId || this.drag.key !== node.dataset.playerKey) return;
            event.preventDefault();
            const rect = this.field.getBoundingClientRect();
            const point = this.place(node, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
            this.positions[node.dataset.playerKey] = { x: point.x / rect.width, y: point.y / rect.height };
        }

        endDrag(event, node) {
            if (!this.drag || this.drag.pointerId !== event.pointerId || this.drag.key !== node.dataset.playerKey) return;
            node.classList.remove('dragging');
            this.drag = null;
            this.save();
        }

        save() {
            const key = this.storageKey();
            if (!key) return;
            try {
                localStorage.setItem(key, JSON.stringify(this.positions));
            } catch (_) {
                // The table still works if browser storage is unavailable.
            }
        }

        reset() {
            this.positions = {};
            const key = this.storageKey();
            if (key) {
                try { localStorage.removeItem(key); } catch (_) { /* no-op */ }
            }
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
