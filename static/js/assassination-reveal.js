/* Fullscreen finale shown only when the Assassin correctly identifies Merlin. */
(function () {
    'use strict';

    const ART_PATH = '/static/assets/results/assassin-kills-merlin.png?v=20260825';
    const STYLE_ID = 'assassination-merlin-reveal-styles';
    const REVEAL_ID = 'assassination-merlin-reveal';
    let lastRevealKey = null;
    let completionTimer = null;
    window.AVALON_ASSASSINATION_REVEAL_ENABLED = true;

    function installStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .assassination-merlin-reveal {
                position: fixed; z-index: 1400; inset: 0; overflow: hidden;
                background: #020203; color: #d0b8b0; opacity: 1;
                visibility: visible; transition: opacity .85s ease, visibility 0s linear 0s;
            }
            .assassination-merlin-reveal.is-complete {
                opacity: 0; visibility: hidden; pointer-events: none;
                transition: opacity .85s ease, visibility 0s linear .85s;
            }
            .assassination-merlin-reveal-backdrop,
            .assassination-merlin-reveal-art {
                position: absolute; inset: 0; width: 100%; height: 100%; display: block;
                object-position: 50% 48%; opacity: 0;
            }
            .assassination-merlin-reveal-backdrop {
                object-fit: cover; transform: scale(1.1);
                filter: brightness(.46) saturate(.72) blur(12px);
                transition: opacity 1.65s ease, transform 4.6s cubic-bezier(.18,.72,.16,1);
            }
            .assassination-merlin-reveal-art {
                object-fit: cover; transform: scale(1.07);
                filter: brightness(.7) saturate(.78) contrast(1.05);
                transition: opacity 1.95s ease .12s, transform 3.8s cubic-bezier(.18,.72,.16,1) .08s;
            }
            .assassination-merlin-reveal.is-revealed .assassination-merlin-reveal-backdrop {
                opacity: .72; transform: scale(1.025);
            }
            .assassination-merlin-reveal.is-revealed .assassination-merlin-reveal-art {
                opacity: 1; transform: scale(1);
            }
            .assassination-merlin-reveal-scrim {
                position: absolute; z-index: 2; inset: 0; pointer-events: none;
                background: linear-gradient(180deg, rgba(2,2,3,.13), rgba(3,2,3,.04) 42%, rgba(4,2,3,.95) 100%),
                    radial-gradient(circle at 50% 42%, transparent 18%, rgba(7,2,3,.2) 70%, rgba(2,2,3,.58) 100%);
            }
            .assassination-merlin-reveal-copy {
                position: absolute; z-index: 3;
                right: max(clamp(1.35rem, 6vw, 4rem), env(safe-area-inset-right));
                bottom: max(clamp(2.1rem, 8dvh, 5.5rem), calc(1.5rem + env(safe-area-inset-bottom)));
                left: max(clamp(1.35rem, 6vw, 4rem), env(safe-area-inset-left));
                display: grid; justify-items: start; gap: clamp(.38rem, 1.2dvh, .72rem);
                text-align: left; opacity: 0; transform: translateY(20px);
                transition: opacity 1.05s ease 1.02s, transform 1.15s cubic-bezier(.2,.75,.2,1) .94s;
            }
            .assassination-merlin-reveal.is-revealed .assassination-merlin-reveal-copy {
                opacity: 1; transform: translateY(0);
            }
            .assassination-merlin-reveal-copy .eyebrow {
                margin: 0; color: #af948c; font: clamp(.56rem, 1.25vw, .78rem) var(--font-heading);
                letter-spacing: .23em; text-transform: uppercase;
            }
            .assassination-merlin-reveal-copy h1 {
                max-width: 14ch; margin: 0; color: #cba7a1;
                font: 700 clamp(2.55rem, 9vw, 6.8rem)/.98 var(--font-title);
                text-wrap: balance; text-shadow: 0 4px 24px #000, 0 0 44px rgba(155,35,30,.34);
            }
            .assassination-merlin-reveal-copy .detail {
                max-width: 42rem; margin: 0; color: #b9aaa0;
                font-size: clamp(.84rem, 1.75vw, 1.18rem); line-height: 1.38;
                text-wrap: balance; text-shadow: 0 2px 12px #000;
            }
            @media (min-aspect-ratio: 4 / 3) {
                .assassination-merlin-reveal-art { object-fit: contain; }
                .assassination-merlin-reveal-copy { bottom: max(clamp(1.5rem, 5dvh, 3.5rem), env(safe-area-inset-bottom)); }
            }
            @media (prefers-reduced-motion: reduce) {
                .assassination-merlin-reveal,
                .assassination-merlin-reveal-backdrop,
                .assassination-merlin-reveal-art,
                .assassination-merlin-reveal-copy { transition: none !important; }
            }
        `;
        document.head.appendChild(style);
    }

    function revealElement() {
        let reveal = document.getElementById(REVEAL_ID);
        if (reveal) return reveal;
        reveal = document.createElement('section');
        reveal.id = REVEAL_ID;
        reveal.className = 'assassination-merlin-reveal is-complete';
        reveal.setAttribute('role', 'status');
        reveal.setAttribute('aria-live', 'assertive');
        reveal.setAttribute('aria-hidden', 'true');
        reveal.innerHTML = `
            <img class="assassination-merlin-reveal-backdrop" alt="" aria-hidden="true">
            <img class="assassination-merlin-reveal-art" alt="The Assassin standing over the fallen Merlin">
            <div class="assassination-merlin-reveal-scrim" aria-hidden="true"></div>
            <div class="assassination-merlin-reveal-copy">
                <p class="eyebrow">The final blade finds its mark</p>
                <h1>Merlin Has Fallen</h1>
                <p class="detail">The Assassin uncovered the hidden seer. With Merlin silenced, Evil claims Avalon.</p>
            </div>`;
        document.body.appendChild(reveal);
        return reveal;
    }

    function completeReveal() {
        const reveal = document.getElementById(REVEAL_ID);
        if (!reveal) return;
        reveal.classList.add('is-complete');
        reveal.setAttribute('aria-hidden', 'true');
        const content = document.querySelector('#screen-game-over .game-over-content');
        content?.removeAttribute('aria-hidden');
        if (content) content.inert = false;
        document.body.classList.remove('assassination-reveal-active');
        completionTimer = null;
    }

    function showReveal(summary) {
        if (!summary || summary.win_reason !== 'assassination') return;
        const key = JSON.stringify([
            summary.win_reason,
            summary.player_order || [],
            summary.mission_results || [],
        ]);
        if (lastRevealKey === key) return;
        lastRevealKey = key;
        window.clearTimeout(completionTimer);
        const reveal = revealElement();
        const content = document.querySelector('#screen-game-over .game-over-content');
        content?.setAttribute('aria-hidden', 'true');
        if (content) content.inert = true;
        reveal.querySelector('.assassination-merlin-reveal-backdrop').src = ART_PATH;
        reveal.querySelector('.assassination-merlin-reveal-art').src = ART_PATH;
        reveal.className = 'assassination-merlin-reveal';
        reveal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('assassination-reveal-active');
        void reveal.offsetWidth;
        requestAnimationFrame(() => reveal.classList.add('is-revealed'));
        const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1400 : 5600;
        completionTimer = window.setTimeout(completeReveal, duration);
    }

    function resetReveal() {
        window.clearTimeout(completionTimer);
        completionTimer = null;
        lastRevealKey = null;
        completeReveal();
    }

    function wrapRenderer(name) {
        const original = window[name];
        if (typeof original !== 'function' || original.assassinationRevealWrapped) return;
        const wrapped = function (summary) {
            const result = original.apply(this, arguments);
            showReveal(summary);
            return result;
        };
        wrapped.assassinationRevealWrapped = true;
        window[name] = wrapped;
    }

    installStyles();
    revealElement();
    wrapRenderer('showGameOver');
    wrapRenderer('renderGameOver');
    if (typeof socket !== 'undefined') {
        socket.on('return_to_lobby', resetReveal);
        socket.on('game_ended', resetReveal);
    }
})();
