/* Device-local presentation only: never changes room state, roles, or wire values.
 * The authored English remains the source; remember it per DOM node so a language
 * change can restore it without reconnecting or losing an in-progress action.
 */
(() => {
    'use strict';
    const catalog = window.AVALON_ZH_CN;
    const key = location.pathname === '/host' ? 'avalon-display-language' : 'avalon-player-language';
    let language = 'en';
    try { if (localStorage.getItem(key) === 'zh-CN') language = 'zh-CN'; } catch (_) { /* Session-only preference. */ }
    document.documentElement.lang = language;
    const originals = new WeakMap();
    const attributes = ['title', 'alt', 'placeholder', 'aria-label', 'aria-valuetext', 'aria-roledescription'];
    const skip = 'script,style,code,textarea,input,[data-i18n-skip],.presence-player-name,.final-role-player,.r-name,.cinematic-vote-name,.identity-avatar-name,.leader-identity-name';
    const cache = new Map();
    const normalize = value => String(value).replace(/\s+/g, ' ').trim();
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only authored templates are matched. Captures (names, codes, party lists)
    // remain verbatim unless the slot explicitly represents an application label.
    const labelSlots = {
        'Mission {0} · {1}': [1], 'Mission {0} — {1}': [1],
        '{0} was {1}': [1], '{0} knight{1}{2}': [2],
        '{0} Success · {1} {2}': [2], '{0} — {1}': [0, 1],
        '{0}, {1}. Tap for role description.': [0, 1],
        '{0}, turn {1}, {2}{3}. Drag or use arrow keys to reposition.': [2, 3],
    };
    const patterns = Object.entries(catalog).filter(([source]) => /\{\w+\}/.test(source))
        .sort(([a], [b]) => b.replace(/\{\w+\}/g, '').length - a.replace(/\{\w+\}/g, '').length)
        .map(([source, target]) => {
            const slots = [];
            const pieces = source.split(/(\{\w+\})/).map(piece => {
                if (/^\{\w+\}$/.test(piece)) { slots.push(piece.slice(1, -1)); return '(.*?)'; }
                return escape(piece);
            });
            return { source, target, slots, regex: new RegExp('^' + pieces.join('') + '$', 'u') };
        });
    const deliveries = Object.keys(catalog).filter(source => source.startsWith('The court records this') || [
        'Do sit with that.', 'No refunds on certainty.', 'The minutes will be unkind.',
        'A perfectly normal kingdom.', 'Proceed with undeserved confidence.',
        'I have sharpened the footnote.', 'History is already smirking.',
        'Nothing ominous there.', 'The tavern odds just moved.', 'Your dignity remains optional.',
        'Please continue incriminating yourselves.', 'Camelot deserves better gossip.',
        'An adult has not been located.', 'This will age beautifully.', 'The crown accepts no liability.',
        'Someone pour the evidence another drink.', 'I adore a preventable crisis.',
        'The confidence is exquisite.', 'And scene.',
    ].includes(source));
    function chinese(source) {
        if (Object.hasOwn(catalog, source)) return catalog[source];
        if (cache.has(source)) return cache.get(source);
        let translated = source;
        for (const suffix of deliveries) {
            if (source.endsWith(' ' + suffix)) {
                const premise = source.slice(0, -suffix.length - 1);
                const result = chinese(premise);
                if (result !== premise) translated = result + catalog[suffix];
                break;
            }
        }
        if (translated === source) for (const rule of patterns) {
            const match = source.match(rule.regex);
            if (!match) continue;
            const values = Object.fromEntries(rule.slots.map((slot, index) => [slot, match[index + 1]]));
            translated = rule.target.replace(/\{(\w+)\}/g, (_, slot) => {
                const value = values[slot] || '';
                return labelSlots[rule.source]?.includes(Number(slot)) ? chinese(value) : value;
            });
            break;
        }
        if (cache.size > 2048) cache.clear();
        cache.set(source, translated);
        return translated;
    }
    function translate(value) {
        if (language !== 'zh-CN') return String(value);
        const raw = String(value);
        const source = normalize(raw);
        if (!source) return raw;
        return raw.match(/^\s*/)[0] + chinese(source) + raw.match(/\s*$/)[0];
    }
    function update(node, attribute = null) {
        const current = attribute ? node.getAttribute(attribute) : node.data;
        if (!current) return;
        let state = originals.get(node);
        if (!state) { state = new Map(); originals.set(node, state); }
        const id = attribute || 'text';
        const previous = state.get(id);
        const source = previous && previous.rendered === current ? previous.source : current;
        const rendered = translate(source);
        state.set(id, { source, rendered });
        if (current !== rendered) {
            if (attribute) node.setAttribute(attribute, rendered);
            else node.data = rendered;
        }
    }
    function visit(root) {
        if (root.nodeType === Node.TEXT_NODE) {
            if (!root.parentElement?.closest(skip)) update(root);
            return;
        }
        if (root.nodeType !== Node.ELEMENT_NODE && root !== document) return;
        if (root.matches?.('script,style,code')) return;
        if (root.nodeType === Node.ELEMENT_NODE) for (const name of attributes) {
            // Inputs contain user data, but their instructional attributes translate.
            if (root.hasAttribute(name)) update(root, name);
        }
        if (!root.matches?.(skip)) for (const child of root.childNodes) visit(child);
    }
    let observer;
    const observe = () => observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: attributes,
    });
    function refresh(roots = [document]) {
        observer?.disconnect();
        roots.forEach(visit);
        if (observer) observe();
    }
    function setLanguage(value) {
        language = value === 'zh-CN' ? 'zh-CN' : 'en';
        try { localStorage.setItem(key, language); } catch (_) { /* Works with blocked storage. */ }
        document.documentElement.lang = language;
        document.querySelectorAll('[data-language-select]').forEach(select => { select.value = language; });
        refresh();
        document.dispatchEvent(new CustomEvent('avalon-language-change', { detail: language }));
    }
    // Native dialogs are outside the DOM; translate only application confirmation copy.
    const confirm = window.confirm.bind(window);
    window.confirm = message => confirm(translate(message));
    window.AvalonI18n = Object.freeze({ t: translate, setLanguage, getLanguage: () => language, refresh });
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-language-select]').forEach(select => {
            select.value = language;
            select.addEventListener('change', () => setLanguage(select.value));
        });
        const button = document.getElementById('btn-display-settings');
        const panel = document.getElementById('display-settings');
        if (button && panel) {
            button.addEventListener('click', () => { panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); });
            document.getElementById('btn-close-display-settings').addEventListener('click', () => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); });
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !panel.hidden) document.getElementById('btn-close-display-settings').click();
            });
        }
        refresh();
        observer = new MutationObserver(records => {
            const roots = new Set();
            for (const record of records) {
                if (record.type === 'childList') record.addedNodes.forEach(node => roots.add(node));
                else roots.add(record.target);
            }
            refresh([...roots]);
        });
        observe();
    });
})();
