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

export function showRelationshipToast(name, delta, reason, moodlet = '') {
    if (delta === 0) return;
    const shift = getShiftDescriptor(delta, moodlet);
    showHudToast({
        title: `${name} · ${shift.short}`,
        text: reason || shift.full,
        badge: 'Связи',
        variant: delta > 0 ? 'positive' : 'negative',
        icon: delta > 0 ? 'fa-solid fa-heart' : 'fa-solid fa-heart-crack',
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
        'deep-positive': { badge: 'Дневник', variant: 'milestone', icon: 'fa-solid fa-sparkles', accent: '#c084fc' },
        'deep-negative': { badge: 'Дневник', variant: 'alert', icon: 'fa-solid fa-bolt', accent: '#fb7185' },
        'soft-positive': { badge: 'Дневник', variant: 'positive', icon: 'fa-solid fa-book-open-reader', accent: '#4ade80' },
        'soft-negative': { badge: 'Дневник', variant: 'negative', icon: 'fa-solid fa-feather-pointed', accent: '#f87171' },
        'tier-shift': { badge: 'Маршрут', variant: 'system', icon: 'fa-solid fa-arrow-trend-up', accent: '#60a5fa' },
        'status-shift': { badge: 'Маршрут', variant: 'milestone', icon: 'fa-solid fa-user-pen', accent: '#f59e0b' },
        'intro': { badge: 'Трекер', variant: 'system', icon: 'fa-solid fa-user-plus', accent: '#93c5fd' },
        'romance-positive': { badge: 'Влечение', variant: 'milestone', icon: 'fa-solid fa-heart', accent: '#f472b6' },
        'romance-negative': { badge: 'Отторжение', variant: 'alert', icon: 'fa-solid fa-heart-crack', accent: '#e11d48' },
    };
    const toastConfig = toastMap[moment.type] || toastMap['soft-positive'];
    const rawText = String(moment.text || '');
    const prefix = moment.char ? `${moment.char}: ` : '';
    const text = prefix && rawText.startsWith(prefix) ? rawText : `${moment.char || 'Сцена'}: ${rawText}`;
    showHudToast({
        title: moment.title || 'Новая запись',
        text,
        badge: toastConfig.badge,
        variant: toastConfig.variant,
        icon: toastConfig.icon,
        accent: toastConfig.accent,
    });
}
