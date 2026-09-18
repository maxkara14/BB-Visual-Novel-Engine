import { t, ui } from './i18n.js';
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

export function showHudToast({ title, text, badge = t('Система'), variant = 'system', icon = 'fa-solid fa-sparkles', accent = '', meta = '' }) {
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
    if (!raw) return { title: t('Новая грань'), detail: '' };
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
    const cleanName = String(name || t('Связь')).trim() || t('Связь');
    const cleanReason = String(reason || '').trim();
    const magnitude = Math.abs(delta);
    const intensity = magnitude >= 8 ? 'major' : magnitude >= 4 ? 'notable' : 'minor';
    const variantKey = `${isPositive ? 'positive' : 'negative'}:${intensity}`;
    const titlePools = {
        'positive:minor': [
            t('Между вами стало чуть теплее'),
            t('В контакте с {char} появился мягкий сдвиг'),
            t('Этот эпизод слегка сблизил вас'),
            t('Небольшой шаг навстречу'),
        ],
        'positive:notable': [
            t('Связь с {char} окрепла'),
            t('Контакт с {char} стал заметно ближе'),
            t('В глазах {char} вы поднялись выше'),
            t('Между вами закрепился хороший знак'),
        ],
        'positive:major': [
            t('Маршрут с {char} сделал сильный шаг вперёд'),
            t('Доверие {char} ощутимо укрепилось'),
            t('Для {char} это стало важным поворотом к вам'),
            t('Контакт с {char} вышел на новый уровень'),
        ],
        'negative:minor': [
            t('Между вами пробежала тень'),
            t('Связь слегка дрогнула'),
            t('В контакте с {char} появилась осторожность'),
            t('Этот эпизод оставил неловкий след'),
        ],
        'negative:notable': [
            t('Дистанция с {char} стала заметнее'),
            t('В контакте с {char} возникла трещина'),
            t('В памяти {char} остался неприятный след'),
            t('Маршрут с {char} дал трещину'),
        ],
        'negative:major': [
            t('Связь с {char} получила тяжёлый удар'),
            t('Для {char} это стало серьёзным надломом'),
            t('Между вами ощутимо похолодало'),
            t('Контакт с {char} резко отдалился'),
        ],
    };
    const textPools = {
        positive: [
            { text: '{char}: {reason}' },
            { text: '{char}: {shift}' },
            { text: t('Этот эпизод стал шагом к сближению с {char}.') },
            { text: t('Теперь {char} воспринимает вас немного теплее.') },
        ],
        negative: [
            { text: '{char}: {reason}' },
            { text: '{char}: {shift}' },
            { text: t('От этой сцены у {char} остался неприятный осадок.') },
            { text: t('Теперь {char} смотрит на вас осторожнее.') },
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
        badge: isPositive ? t('Связь') : t('Разлад'),
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
        'deep-positive': { badge: t('Память'), variant: 'memory', icon: 'fa-solid fa-star', accent: '#c084fc' },
        'deep-negative': { badge: t('Шрам'), variant: 'fracture', icon: 'fa-solid fa-bolt', accent: '#fb7185' },
        'soft-positive': { badge: t('Отголосок'), variant: 'bond', icon: 'fa-solid fa-book-open-reader', accent: '#4ade80' },
        'soft-negative': { badge: t('Осадок'), variant: 'negative', icon: 'fa-solid fa-feather-pointed', accent: '#f87171' },
        'tier-shift': { badge: t('Маршрут'), variant: 'system', icon: 'fa-solid fa-arrow-trend-up', accent: '#60a5fa' },
        'status-shift': { badge: t('Поворот'), variant: 'milestone', icon: 'fa-solid fa-user-pen', accent: '#f59e0b' },
        'intro': { badge: t('Трекер'), variant: 'system', icon: 'fa-solid fa-user-plus', accent: '#93c5fd' },
        'romance-positive': { badge: t('Искра'), variant: 'romance', icon: 'fa-solid fa-heart', accent: '#f472b6' },
        'romance-negative': { badge: t('Надлом'), variant: 'fracture', icon: 'fa-solid fa-heart-crack', accent: '#e11d48' },
    };
    const toastConfig = toastMap[moment.type] || toastMap['soft-positive'];
    const charName = String(moment.char || t('Сцена')).trim() || t('Сцена');
    const variantsByType = {
        'deep-positive': [
            { title: t('{char} это никогда не забудет'), text: '{char}: {base}' },
            { title: t('Память о сцене закрепилась'), text: '{char}: {base}' },
            { title: t('Между вами остался яркий след'), text: '{char}: {base}' },
            { title: t('Этот момент лёг в основу новой близости'), text: '{char}: {base}' },
            { title: t('Для {char} сцена стала знаковой'), text: '{char}: {base}' },
        ],
        'deep-negative': [
            { title: t('{char} это не простит'), text: '{char}: {base}' },
            { title: t('Шрам в памяти только углубился'), text: '{char}: {base}' },
            { title: t('Сцена оставила тяжёлый след'), text: '{char}: {base}' },
            { title: t('Этот момент застрял в памяти занозой'), text: '{char}: {base}' },
            { title: t('Для {char} всё это стало болезненной вехой'), text: '{char}: {base}' },
        ],
        'soft-positive': [
            { title: t('Между вами стало теплее'), text: '{char}: {base}' },
            { title: t('Сцена сыграла вам на руку'), text: '{char}: {base}' },
            { title: t('В отношениях мелькнул свет'), text: '{char}: {base}' },
            { title: t('От сцены остался хороший отголосок'), text: '{char}: {base}' },
            { title: t('После этого отношение {char} стало мягче'), text: '{char}: {base}' },
        ],
        'soft-negative': [
            { title: t('В контакте с {char} появилась настороженность'), text: '{char}: {base}' },
            { title: t('Сцена оставила неприятный осадок'), text: '{char}: {base}' },
            { title: t('Доверие слегка дрогнуло'), text: '{char}: {base}' },
            { title: t('Эта сцена не прошла для {char} бесследно'), text: '{char}: {base}' },
            { title: t('Небольшая тень легла на маршрут с {char}'), text: '{char}: {base}' },
        ],
        'tier-shift': [
            { title: t('Маршрут с {char} сменил тон'), text: '{char}: {base}' },
            { title: t('Статус связи обновился'), text: '{char}: {base}' },
            { title: t('Баланс отношений сдвинулся'), text: '{char}: {base}' },
            { title: t('Линия с {char} вошла в новую фазу'), text: '{char}: {base}' },
        ],
        'status-shift': [
            { title: t('{char} смотрит на вас иначе'), text: '{char}: {base}' },
            { title: t('Роль в глазах {char} изменилась'), text: '{char}: {base}' },
            { title: t('Ветка с {char} пошла по новому пути'), text: '{char}: {base}' },
            { title: t('После этой сцены образ вас для {char} изменился'), text: '{char}: {base}' },
        ],
        'intro': [
            { title: t('В трекере появился новый контакт'), text: '{char}: {base}' },
            { title: t('{char} появился в сцене'), text: '{char}: {base}' },
            { title: t('Новая линия открыта'), text: '{char}: {base}' },
            { title: t('Сюжет вывел на сцену {char}'), text: '{char}: {base}' },
        ],
        'romance-positive': [
            { title: t('Искра между вами стала ярче'), text: '{char}: {base}' },
            { title: t('{char} всё сильнее тянется к вам'), text: '{char}: {base}' },
            { title: t('Романтическая линия стала теплее'), text: '{char}: {base}' },
            { title: t('Сердце {char} качнулось в вашу сторону'), text: '{char}: {base}' },
            { title: t('Между вами стало чуть более личное напряжение'), text: '{char}: {base}' },
        ],
        'romance-negative': [
            { title: t('Сердце {char} захлопнулось'), text: '{char}: {base}' },
            { title: t('Романтическая линия дала трещину'), text: '{char}: {base}' },
            { title: t('Между вами стало холоднее'), text: '{char}: {base}' },
            { title: t('Эта искра пошла на спад'), text: '{char}: {base}' },
            { title: t('Личная близость с {char} дала сбой'), text: '{char}: {base}' },
        ],
    };
    const picked = pickToastVariant(
        `${moment.type}|${charName}|${moment.title || ''}|${moment.text || ''}`,
        variantsByType[moment.type] || [{ title: moment.title || t('Новая запись'), text: '{char}: {base}' }],
    );
    const baseText = String(moment.text || '').replace(/^\s*[^:]+:\s*/, '').trim() || String(moment.text || '').trim();
    const titleText = fillToastTemplate(picked.title, { char: charName, base: baseText });
    const bodyText = fillToastTemplate(picked.text, { char: charName, base: baseText });
    const rawText = String(bodyText || '');
    const prefix = moment.char ? `${moment.char}: ` : '';
    const text = prefix && rawText.startsWith(prefix) ? rawText : `${moment.char || t('Сцена')}: ${rawText}`;
    showHudToast({
        title: titleText || moment.title || t('Новая запись'),
        text,
        badge: toastConfig.badge,
        variant: toastConfig.variant,
        icon: toastConfig.icon,
        accent: toastConfig.accent,
    });
}

export function showTraitCrystallizedToast({ charName = '', trait = '', isPositive = true } = {}) {
    const cleanName = String(charName || t('Персонаж')).trim() || t('Персонаж');
    const normalized = splitTraitLabel(trait);
    const titlePools = isPositive
        ? [
            t('У {char} закрепилась новая светлая грань'),
            t('Опыт {char} кристаллизовался в черту'),
            t('В характере {char} оформилась новая опора'),
            t('Память {char} закрепилась в светлой черте'),
        ]
        : [
            t('У {char} оформилась новая мрачная грань'),
            t('Опыт {char} кристаллизовался в шрам характера'),
            t('Внутри {char} закрепился тяжёлый излом'),
            t('Память {char} закрепилась в мрачной черте'),
        ];
    const textPools = isPositive
        ? [
            { text: '{char}: {traitTitle}. {traitDetail}' },
            { text: t('Черта «{traitTitle}» теперь закреплена в характере {char}.') },
            { text: t('Образ {char} теперь заметно опирается на черту «{traitTitle}».') },
        ]
        : [
            { text: '{char}: {traitTitle}. {traitDetail}' },
            { text: t('Черта «{traitTitle}» теперь закреплена в надломе {char}.') },
            { text: t('В образе {char} теперь заметна мрачная грань «{traitTitle}».') },
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
            traitDetail: normalized.detail || t('Теперь это будет заметно в сценах.'),
        },
        `${cleanName}: ${trait}`,
    );

    showHudToast({
        title,
        text,
        badge: isPositive ? t('Кристалл') : t('Излом'),
        variant: isPositive ? 'legendary' : 'fracture',
        icon: 'fa-solid fa-gem',
        accent: isPositive ? '#fbbf24' : '#fb7185',
        meta: normalized.title,
    });
}
