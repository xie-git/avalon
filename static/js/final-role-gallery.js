/* Portrait-first full role reveal shared by phones and paired displays. */
(function () {
    'use strict';

    const STYLE_ID = 'final-role-gallery-styles';

    function installStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .final-role-gallery-section {
                width: min(100%, 1000px); display: grid; gap: .85rem; margin-top: .5rem;
            }
            .final-role-gallery-section > h3 {
                margin: 0; color: #b9ad95; font: .72rem var(--font-heading);
                letter-spacing: .18em; text-align: center; text-transform: uppercase;
            }
            .final-role-gallery {
                width: 100%; display: grid;
                grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
                gap: clamp(.55rem, 1.5vw, .9rem);
            }
            .final-role-card {
                --role-accent: #91aebb; min-width: 0; display: grid; justify-items: center;
                gap: .34rem; padding: .7rem .45rem .65rem;
                border: 1px solid color-mix(in srgb, var(--role-accent) 42%, transparent);
                border-radius: var(--radius-md);
                background: linear-gradient(155deg, color-mix(in srgb, var(--role-accent) 10%, rgba(14,14,16,.94)), rgba(7,7,9,.96));
                box-shadow: 0 10px 28px rgba(0,0,0,.28);
                animation: final-role-card-in .55s cubic-bezier(.2,.75,.2,1) var(--role-delay, 0s) both;
            }
            .final-role-card.evil { --role-accent: #ba817b; }
            .final-role-portrait {
                width: clamp(70px, 17vw, 104px); aspect-ratio: 1; overflow: hidden;
                display: grid; place-items: center; border: 2px solid var(--role-accent);
                border-radius: 50%; background: #111319;
                box-shadow: 0 0 22px color-mix(in srgb, var(--role-accent) 18%, transparent);
            }
            .final-role-portrait > img,
            .final-role-portrait > svg { width: 100%; height: 100%; display: block; object-fit: cover; }
            .final-role-player {
                max-width: 100%; overflow: hidden; color: #ddd4c2;
                font: 700 clamp(.66rem, 2.5vw, .82rem)/1.2 var(--font-heading);
                text-overflow: ellipsis; white-space: nowrap;
            }
            .final-role-name {
                max-width: 100%; overflow: hidden; color: var(--role-accent);
                font: 600 clamp(.56rem, 2vw, .7rem)/1.2 var(--font-heading);
                letter-spacing: .035em; text-align: center; text-overflow: ellipsis; white-space: nowrap;
            }
            @keyframes final-role-card-in {
                from { opacity: 0; transform: translateY(10px) scale(.96); }
                to { opacity: 1; transform: none; }
            }
            @media (max-width: 520px) {
                .final-role-gallery { grid-template-columns: repeat(2, minmax(0, 1fr)); }
                .final-role-card { padding-block: .65rem; }
                .final-role-portrait { width: clamp(76px, 24vw, 98px); }
            }
            @media (min-width: 900px) {
                .final-role-gallery[data-count="5"],
                .final-role-gallery[data-count="6"] { grid-template-columns: repeat(3, minmax(140px, 1fr)); }
                .final-role-gallery[data-count="7"],
                .final-role-gallery[data-count="8"] { grid-template-columns: repeat(4, minmax(130px, 1fr)); }
                .final-role-gallery[data-count="9"],
                .final-role-gallery[data-count="10"] { grid-template-columns: repeat(5, minmax(120px, 1fr)); }
            }
            @media (prefers-reduced-motion: reduce) {
                .final-role-card { animation: none; }
            }
        `;
        document.head.appendChild(style);
    }

    function portraitFor(player) {
        const portrait = document.createElement('div');
        portrait.className = 'final-role-portrait';
        if (player.avatar_image) {
            const image = document.createElement('img');
            image.src = player.avatar_image;
            image.alt = '';
            image.decoding = 'async';
            portrait.appendChild(image);
        } else if (typeof presenceTable !== 'undefined') {
            portrait.appendChild(presenceTable.createPortraitElement(
                player.avatar_index,
                player.color_index
            ));
        }
        return portrait;
    }

    function roleCard(name, player, roleInfo, index) {
        const team = roleInfo.team === 'evil' ? 'evil' : 'good';
        const card = document.createElement('article');
        card.className = `final-role-card ${team}`;
        card.style.setProperty('--role-delay', `${index * 0.07}s`);
        card.setAttribute('aria-label', `${name} was ${roleInfo.role}`);
        const playerName = document.createElement('strong');
        playerName.className = 'final-role-player';
        playerName.textContent = name;
        const roleName = document.createElement('span');
        roleName.className = 'final-role-name';
        roleName.textContent = roleInfo.role || 'Unknown role';
        card.append(portraitFor(player), playerName, roleName);
        return card;
    }

    function orderedNames(summary) {
        const roles = summary.roles || {};
        const order = Array.isArray(summary.player_order) ? summary.player_order : [];
        return [...order, ...Object.keys(roles).filter(name => !order.includes(name))];
    }

    function renderGallery(container, summary) {
        const roles = summary.roles || {};
        const players = new Map((summary.players || []).map(player => [player.name, player]));
        container.replaceChildren();
        container.className = 'final-role-gallery';
        const names = orderedNames(summary);
        container.dataset.count = String(names.length);
        names.forEach((name, index) => {
            const roleInfo = roles[name] || {};
            const player = players.get(name) || { name };
            container.appendChild(roleCard(name, player, roleInfo, index));
        });
    }

    function renderPlayerGallery(summary) {
        const container = document.getElementById('roles-list-player');
        const section = container?.closest('.game-over-roles');
        const chronicle = document.querySelector('#screen-game-over .game-chronicle:not(.host-chronicle)');
        if (!container || !section) return;
        section.classList.add('final-role-gallery-section');
        section.classList.remove('hidden');
        if (chronicle) chronicle.after(section);
        renderGallery(container, summary);
    }

    function renderHostGallery(summary) {
        const container = document.getElementById('roles-reveal-grid');
        const chronicle = document.querySelector('#screen-game-over .host-chronicle');
        if (!container || !chronicle) return;
        let section = document.getElementById('host-full-role-reveal');
        if (!section) {
            section = document.createElement('section');
            section.id = 'host-full-role-reveal';
            section.className = 'final-role-gallery-section';
            const heading = document.createElement('h3');
            heading.textContent = 'Full Role Reveal';
            section.append(heading, container);
        }
        chronicle.after(section);
        renderGallery(container, summary);
    }

    function wrapRenderer(name, renderer) {
        const original = window[name];
        if (typeof original !== 'function' || original.finalRoleGalleryWrapped) return;
        const wrapped = function (summary) {
            const result = original.apply(this, arguments);
            renderer(summary || {});
            return result;
        };
        wrapped.finalRoleGalleryWrapped = true;
        window[name] = wrapped;
    }

    installStyles();
    wrapRenderer('showGameOver', renderPlayerGallery);
    wrapRenderer('renderGameOver', renderHostGallery);
})();
