/* global SillyTavern, toastr */
import { TOAST_LIFETIME_MS, TOAST_MAX_VISIBLE } from './constants.js';
import { escapeHtml, getShiftDescriptor } from './utils.js';

let toastSequence = 0;

export function notifySuccess(message, title) {
    /** @type {any} */ (toastr).success(message, title);
}

export function notifyInfo(message, title) {
    /** @type {any} */ (toastr).info(message, title);
}

export function notifyError(message, title) {
    /** @type {any} */ (toastr).error(message, title);
}

export function ensureToastContainer() {
    if (!document.getElementById('bb-social-toast-container')) {
        jQuery('body').append('<div id="bb-social-toast-container" aria-live="polite" aria-atomic="false"></div>');
    }
    syncToastContainerWithHud();
}

export function syncToastContainerWithHud() {
    const container = document.getElementById('bb-social-toast-container');
    if (!container) return;

    const hud = document.getElementById('bb-social-hud');
    const hudIsOpen = !!hud && hud.classList.contains('open');
    container.classList.toggle('hud-open', hudIsOpen);

    if (!hudIsOpen) {
        container.style.removeProperty('--bb-toast-open-top');
        return;
    }

    const liveBadge = hud.querySelector('.bb-hud-live-dot');
    if (!liveBadge) return;

    const badgeRect = liveBadge.getBoundingClientRect();
    container.style.setProperty('--bb-toast-open-top', `${Math.max(12, Math.round(badgeRect.bottom + 8))}px`);
}

export function removeToast(toastElement) {
    if (!toastElement || toastElement.dataset.state === 'closing') return;
    toastElement.dataset.state = 'closing';
    toastElement.classList.remove('is-visible');
    window.setTimeout(() => {
        if (toastElement.parentNode) toastElement.parentNode.removeChild(toastElement);
    }, 260);
}

export function enforceToastLimit() {
    const activeToasts = Array.from(document.querySelectorAll('#bb-social-toast-container .bb-social-toast'));
    if (activeToasts.length < TOAST_MAX_VISIBLE) return;

    const excess = activeToasts.length - TOAST_MAX_VISIBLE + 1;
    activeToasts.slice(0, excess).forEach(removeToast);
}

export function showHudToast({ title, text, badge = 'Система', variant = 'system', icon = 'fa-solid fa-sparkles', accent = '', meta = '' }) {
    ensureToastContainer();
    enforceToastLimit();
    const toastId = `bb-social-toast-${++toastSequence}`;
    const accentStyle = accent ? `style="--bb-toast-accent:${accent};"` : '';
    const toastHtml = `
        <article id="${toastId}" class="bb-social-toast ${variant}" ${accentStyle}>
            <div class="bb-st-glow"></div>
            <div class="bb-st-icon"><i class="${icon}"></i></div>
            <div class="bb-st-content">
                <div class="bb-st-topline">
                    <span class="bb-st-badge">${escapeHtml(badge)}</span>
                    ${meta ? `<span class="bb-st-meta">${escapeHtml(meta)}</span>` : ''}
                </div>
                <div class="bb-st-header">
                    <span class="bb-st-name">${escapeHtml(title)}</span>
                </div>
                <span class="bb-st-reason">${escapeHtml(text)}</span>
                <span class="bb-st-progress"></span>
            </div>
        </article>
    `;
    const toastContainer = document.getElementById('bb-social-toast-container');
    if (!toastContainer) return;
    toastContainer.insertAdjacentHTML('beforeend', toastHtml);
    const toastElement = document.getElementById(toastId);
    if (!toastElement) return;

    window.requestAnimationFrame(() => toastElement.classList.add('is-visible'));
    window.setTimeout(() => removeToast(toastElement), TOAST_LIFETIME_MS);
}

function hashToastSeed(value = '') {
    let hash = 0;
    const source = String(value || '');
    for (let index = 0; index < source.length; index++) {
        hash = ((hash << 5) - hash) + source.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash);
}

function pickToastVariant(seed = '', variants = []) {
    if (!Array.isArray(variants) || variants.length === 0) return { title: '', text: '' };
    return variants[hashToastSeed(seed) % variants.length] || variants[0];
}

function fillToastTemplate(template = '', values = {}) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ''));
}

function splitTraitLabel(trait = '') {
    const raw = String(trait || '').trim();
    if (!raw) return { title: 'Новая грань', detail: '' };
    const separatorIndex = raw.indexOf(':');
    if (separatorIndex === -1) return { title: raw, detail: '' };
    return {
        title: raw.slice(0, separatorIndex).trim() || raw,
        detail: raw.slice(separatorIndex + 1).trim(),
    };
}

function buildToastBodyFromPool(seed = '', templates = [], values = {}, fallback = '') {
    const picked = pickToastVariant(seed, templates);
    const template = picked?.text || fallback || '';
    return fillToastTemplate(template, values).trim();
}

export function showRelationshipToast(name, delta, reason, moodlet = '') {
    if (delta === 0) return;
    const shift = getShiftDescriptor(delta, moodlet);
    const isPositive = delta > 0;
    const cleanName = String(name || 'Связь').trim() || 'Связь';
    const cleanReason = String(reason || '').trim();
    const magnitude = Math.abs(delta);
    const intensity = magnitude >= 8 ? 'major' : magnitude >= 4 ? 'notable' : 'minor';
    const variantKey = `${isPositive ? 'positive' : 'negative'}:${intensity}`;
    const titlePools = {
        'positive:minor': [
            'Между вами стало чуть теплее',
            'В контакте с {char} появился мягкий сдвиг',
            'Этот эпизод слегка сблизил вас',
            'Небольшой шаг навстречу',
        ],
        'positive:notable': [
            'Связь с {char} окрепла',
            'Контакт с {char} стал заметно ближе',
            'В глазах {char} вы поднялись выше',
            'Между вами закрепился хороший знак',
        ],
        'positive:major': [
            'Маршрут с {char} сделал сильный шаг вперёд',
            'Доверие {char} ощутимо укрепилось',
            'Для {char} это стало важным поворотом к вам',
            'Контакт с {char} вышел на новый уровень',
        ],
        'negative:minor': [
            'Между вами пробежала тень',
            'Связь слегка дрогнула',
            'В контакте с {char} появилась осторожность',
            'Этот эпизод оставил неловкий след',
        ],
        'negative:notable': [
            'Дистанция с {char} стала заметнее',
            'В контакте с {char} возникла трещина',
            'В памяти {char} остался неприятный след',
            'Маршрут с {char} дал трещину',
        ],
        'negative:major': [
            'Связь с {char} получила тяжёлый удар',
            'Для {char} это стало серьёзным надломом',
            'Между вами ощутимо похолодало',
            'Контакт с {char} резко отдалился',
        ],
    };
    const textPools = {
        positive: [
            { text: '{char}: {reason}' },
            { text: '{char}: {shift}' },
            { text: 'Этот эпизод стал шагом к сближению с {char}.' },
            { text: 'Теперь {char} воспринимает вас немного теплее.' },
        ],
        negative: [
            { text: '{char}: {reason}' },
            { text: '{char}: {shift}' },
            { text: 'От этой сцены у {char} остался неприятный осадок.' },
            { text: 'Теперь {char} смотрит на вас осторожнее.' },
        ],
    };
    const fallbackReason = cleanReason || shift.full;
    const title = fillToastTemplate(
        pickToastVariant(`${cleanName}|${delta}|title`, titlePools[variantKey] || titlePools[`${isPositive ? 'positive' : 'negative'}:minor`]),
        { char: cleanName, reason: fallbackReason, shift: shift.full },
    );
    const text = buildToastBodyFromPool(
        `${cleanName}|${delta}|text|${fallbackReason}`,
        textPools[isPositive ? 'positive' : 'negative'],
        { char: cleanName, reason: fallbackReason, shift: shift.full },
        fallbackReason,
    );
    showHudToast({
        title,
        text,
        badge: isPositive ? 'Связь' : 'Разлад',
        variant: isPositive ? 'bond' : 'fracture',
        icon: isPositive ? 'fa-solid fa-handshake-angle' : 'fa-solid fa-link-slash',
        accent: shift.color,
        meta: delta > 0 ? `+${Math.abs(delta)}` : `−${Math.abs(delta)}`,
    });
}

export function getMomentToastPriority(type = '') {
    const priorityMap = {
        'deep-positive': 5,
        'deep-negative': 5,
        'status-shift': 4,
        'tier-shift': 3,
        'romance-positive': 3,
        'romance-negative': 3,
        'soft-positive': 2,
        'soft-negative': 2,
        'intro': 1,
    };
    return priorityMap[type] || 0;
}

export function pickToastMoment(currentMoment, nextMoment) {
    if (!nextMoment) return currentMoment;
    if (!currentMoment) return nextMoment;
    return getMomentToastPriority(nextMoment.type) >= getMomentToastPriority(currentMoment.type)
        ? nextMoment
        : currentMoment;
}

export function showStoryMomentToast(moment) {
    if (!moment) return;

    const toastMap = {
        'deep-positive': { badge: 'Память', variant: 'memory', icon: 'fa-solid fa-star', accent: '#c084fc' },
        'deep-negative': { badge: 'Шрам', variant: 'fracture', icon: 'fa-solid fa-bolt', accent: '#fb7185' },
        'soft-positive': { badge: 'Отголосок', variant: 'bond', icon: 'fa-solid fa-book-open-reader', accent: '#4ade80' },
        'soft-negative': { badge: 'Осадок', variant: 'negative', icon: 'fa-solid fa-feather-pointed', accent: '#f87171' },
        'tier-shift': { badge: 'Маршрут', variant: 'system', icon: 'fa-solid fa-arrow-trend-up', accent: '#60a5fa' },
        'status-shift': { badge: 'Поворот', variant: 'milestone', icon: 'fa-solid fa-user-pen', accent: '#f59e0b' },
        'intro': { badge: 'Трекер', variant: 'system', icon: 'fa-solid fa-user-plus', accent: '#93c5fd' },
        'romance-positive': { badge: 'Искра', variant: 'romance', icon: 'fa-solid fa-heart', accent: '#f472b6' },
        'romance-negative': { badge: 'Надлом', variant: 'fracture', icon: 'fa-solid fa-heart-crack', accent: '#e11d48' },
    };
    const toastConfig = toastMap[moment.type] || toastMap['soft-positive'];
    const charName = String(moment.char || 'Сцена').trim() || 'Сцена';
    const variantsByType = {
        'deep-positive': [
            { title: '{char} это никогда не забудет', text: '{char}: {base}' },
            { title: 'Память о сцене закрепилась', text: '{char}: {base}' },
            { title: 'Между вами остался яркий след', text: '{char}: {base}' },
            { title: 'Этот момент лёг в основу новой близости', text: '{char}: {base}' },
            { title: 'Для {char} сцена стала знаковой', text: '{char}: {base}' },
        ],
        'deep-negative': [
            { title: '{char} это не простит', text: '{char}: {base}' },
            { title: 'Шрам в памяти только углубился', text: '{char}: {base}' },
            { title: 'Сцена оставила тяжёлый след', text: '{char}: {base}' },
            { title: 'Этот момент застрял в памяти занозой', text: '{char}: {base}' },
            { title: 'Для {char} всё это стало болезненной вехой', text: '{char}: {base}' },
        ],
        'soft-positive': [
            { title: 'Между вами стало теплее', text: '{char}: {base}' },
            { title: 'Сцена сыграла вам на руку', text: '{char}: {base}' },
            { title: 'В отношениях мелькнул свет', text: '{char}: {base}' },
            { title: 'От сцены остался хороший отголосок', text: '{char}: {base}' },
            { title: 'После этого отношение {char} стало мягче', text: '{char}: {base}' },
        ],
        'soft-negative': [
            { title: 'В контакте с {char} появилась настороженность', text: '{char}: {base}' },
            { title: 'Сцена оставила неприятный осадок', text: '{char}: {base}' },
            { title: 'Доверие слегка дрогнуло', text: '{char}: {base}' },
            { title: 'Эта сцена не прошла для {char} бесследно', text: '{char}: {base}' },
            { title: 'Небольшая тень легла на маршрут с {char}', text: '{char}: {base}' },
        ],
        'tier-shift': [
            { title: 'Маршрут с {char} сменил тон', text: '{char}: {base}' },
            { title: 'Статус связи обновился', text: '{char}: {base}' },
            { title: 'Баланс отношений сдвинулся', text: '{char}: {base}' },
            { title: 'Линия с {char} вошла в новую фазу', text: '{char}: {base}' },
        ],
        'status-shift': [
            { title: '{char} смотрит на вас иначе', text: '{char}: {base}' },
            { title: 'Роль в глазах {char} изменилась', text: '{char}: {base}' },
            { title: 'Ветка с {char} пошла по новому пути', text: '{char}: {base}' },
            { title: 'После этой сцены образ вас для {char} изменился', text: '{char}: {base}' },
        ],
        'intro': [
            { title: 'В трекере появился новый контакт', text: '{char}: {base}' },
            { title: '{char} появился в сцене', text: '{char}: {base}' },
            { title: 'Новая линия открыта', text: '{char}: {base}' },
            { title: 'Сюжет вывел на сцену {char}', text: '{char}: {base}' },
        ],
        'romance-positive': [
            { title: 'Искра между вами стала ярче', text: '{char}: {base}' },
            { title: '{char} всё сильнее тянется к вам', text: '{char}: {base}' },
            { title: 'Романтическая линия стала теплее', text: '{char}: {base}' },
            { title: 'Сердце {char} качнулось в вашу сторону', text: '{char}: {base}' },
            { title: 'Между вами стало чуть более личное напряжение', text: '{char}: {base}' },
        ],
        'romance-negative': [
            { title: 'Сердце {char} захлопнулось', text: '{char}: {base}' },
            { title: 'Романтическая линия дала трещину', text: '{char}: {base}' },
            { title: 'Между вами стало холоднее', text: '{char}: {base}' },
            { title: 'Эта искра пошла на спад', text: '{char}: {base}' },
            { title: 'Личная близость с {char} дала сбой', text: '{char}: {base}' },
        ],
    };
    const picked = pickToastVariant(
        `${moment.type}|${charName}|${moment.title || ''}|${moment.text || ''}`,
        variantsByType[moment.type] || [{ title: moment.title || 'Новая запись', text: '{char}: {base}' }],
    );
    const baseText = String(moment.text || '').replace(/^\s*[^:]+:\s*/, '').trim() || String(moment.text || '').trim();
    const titleText = fillToastTemplate(picked.title, { char: charName, base: baseText });
    const bodyText = fillToastTemplate(picked.text, { char: charName, base: baseText });
    const rawText = String(bodyText || '');
    const prefix = moment.char ? `${moment.char}: ` : '';
    const text = prefix && rawText.startsWith(prefix) ? rawText : `${moment.char || 'Сцена'}: ${rawText}`;
    showHudToast({
        title: titleText || moment.title || 'Новая запись',
        text,
        badge: toastConfig.badge,
        variant: toastConfig.variant,
        icon: toastConfig.icon,
        accent: toastConfig.accent,
    });
}

export function showTraitCrystallizedToast({ charName = '', trait = '', isPositive = true } = {}) {
    const cleanName = String(charName || 'Персонаж').trim() || 'Персонаж';
    const normalized = splitTraitLabel(trait);
    const titlePools = isPositive
        ? [
            'У {char} закрепилась новая светлая грань',
            'Опыт {char} кристаллизовался в черту',
            'В характере {char} оформилась новая опора',
            'Память {char} закрепилась в светлой черте',
        ]
        : [
            'У {char} оформилась новая мрачная грань',
            'Опыт {char} кристаллизовался в шрам характера',
            'Внутри {char} закрепился тяжёлый излом',
            'Память {char} закрепилась в мрачной черте',
        ];
    const textPools = isPositive
        ? [
            { text: '{char}: {traitTitle}. {traitDetail}' },
            { text: 'Черта «{traitTitle}» теперь закреплена в характере {char}.' },
            { text: 'Образ {char} теперь заметно опирается на черту «{traitTitle}».' },
        ]
        : [
            { text: '{char}: {traitTitle}. {traitDetail}' },
            { text: 'Черта «{traitTitle}» теперь закреплена в надломе {char}.' },
            { text: 'В образе {char} теперь заметна мрачная грань «{traitTitle}».' },
        ];
    const title = fillToastTemplate(
        pickToastVariant(`${cleanName}|${trait}|trait-title`, titlePools),
        { char: cleanName, traitTitle: normalized.title, traitDetail: normalized.detail },
    );
    const text = buildToastBodyFromPool(
        `${cleanName}|${trait}|trait-text`,
        textPools,
        {
            char: cleanName,
            traitTitle: normalized.title,
            traitDetail: normalized.detail || 'Теперь это будет заметно в сценах.',
        },
        `${cleanName}: ${trait}`,
    );

    showHudToast({
        title,
        text,
        badge: isPositive ? 'Кристалл' : 'Излом',
        variant: isPositive ? 'legendary' : 'fracture',
        icon: 'fa-solid fa-gem',
        accent: isPositive ? '#fbbf24' : '#fb7185',
        meta: normalized.title,
    });
}
