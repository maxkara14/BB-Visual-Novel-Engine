/* global SillyTavern */
import { callPopup, characters, chat_metadata, getThumbnailUrl, saveChatDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { currentCalculatedStats, currentStoryMoments, socialParseDebug } from './state.js';
import { escapeHtml, formatAffinityPoints, getShiftDescriptor, normalizeTraitResponse } from './utils.js';
import { syncToastContainerWithHud, notifySuccess, notifyInfo, notifyError } from './toasts.js';
import { getTierInfo, getTrendNarrative, getUnforgettableImpact, getUnforgettableRoleStatus, recalculateAllStats, getCombinedSocial, bindActivePersonaState, getCurrentPersonaScopeKey } from './social.js';
import { crystallizeTraitFromMemories } from './generator.js';

const HUD_VISIBILITY_RETRY_MS = 120;
const CUSTOM_AVATAR_MAX_SIDE = 192;
const CUSTOM_AVATAR_QUALITY = 0.82;
const CROPPER_SCRIPT_SRC = '/lib/cropper.min.js';
const CROPPER_STYLE_SRC = '/css/cropper.min.css';
const CROPPER_STYLE_ID = 'bb-vne-cropper-style';
let hudVisibilityRetryTimer = null;
let cropperAssetsPromise = null;
let activeAvatarCropper = null;

function setHudPopupPriority(active) { document.body.classList.toggle('bb-hud-popup-active', Boolean(active)); }
function hasContextInitialized(context) { return !!context && (Object.prototype.hasOwnProperty.call(context, 'chatId') || Object.prototype.hasOwnProperty.call(context, 'chat')); }
function hasActiveChatContext(context) { const chatId = context?.chatId; return typeof chatId === 'number' || (typeof chatId === 'string' && chatId.trim()) || (Array.isArray(context?.chat) && context.chat.length > 0); }
function isDevModeEnabled() { const host = String(globalThis?.location?.hostname || '').toLowerCase(); return host === 'localhost' || host === '127.0.0.1' || host === '::1' || globalThis?.BB_VN_DEV === true; }
function normalizeName(value = '') { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function initials(name = '') { const words = String(name || '').trim().split(/\s+/).filter(Boolean); return words.length ? words.slice(0, 2).map(it => it[0].toUpperCase()).join('') : '?'; }
function customAvatarUrl(charName = '') { return String(chat_metadata['bb_vn_char_custom_avatars']?.[charName] || '').trim(); }
function customAvatarThumbUrl() { return ''; }
function avatarUrl(charName = '') { const custom = customAvatarUrl(charName); if (custom) return custom; const key = normalizeName(charName); const item = characters.find(c => normalizeName(c?.name) === key) || characters.find(c => { const n = normalizeName(c?.name); return n && (n.includes(key) || key.includes(n)); }); return item?.avatar && item.avatar !== 'none' ? getThumbnailUrl('avatar', item.avatar) : ''; }
function renderAvatar(charName = '') { const src = avatarUrl(charName); return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(charName)}" class="bb-char-avatar-image">` : `<div class="bb-char-avatar-fallback">${escapeHtml(initials(charName))}</div>`; }
function relationCueSvg() { return `<svg class="bb-relation-cue" viewBox="0 0 52 24" aria-hidden="true"><path d="M4 4c16 0 24 7 24 15m0 0l-6-5m6 5l6-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }
function deepItems(memories = []) { const ordered = [...memories].reverse(); const items = []; for (let i = 0; i < ordered.length; i++) { const current = ordered[i]; const next = ordered[i + 1]; const text = String(current?.text || '').trim(); if (!text) continue; const isDual = next && String(next?.text || '').trim() === text && ((current?.tone === 'positive' && next?.tone === 'negative') || (current?.tone === 'negative' && next?.tone === 'positive')); if (isDual) { items.push({ text, tone: 'dual' }); i++; continue; } items.push({ text, tone: String(current?.tone || '') }); } return items; }
function renderMemoryEntry(text = '', tone = 'neutral', meta = '') { const safeText = escapeHtml(text); if (!safeText) return ''; return `<div class="bb-char-memory-entry ${escapeHtml(tone)}"><div class="bb-char-memory-entry-mark"></div><div class="bb-char-memory-entry-body"><div class="bb-char-memory-entry-text">${safeText}</div>${meta ? `<div class="bb-char-memory-entry-meta">${escapeHtml(meta)}</div>` : ''}</div></div>`; }
function renderSoft(memory = {}) { return renderMemoryEntry(memory?.text || '', String(memory?.tone || 'neutral'), memory?.tone === 'positive' ? 'Мягкий положительный след' : memory?.tone === 'negative' ? 'Мягкий отрицательный след' : 'Мягкий след'); }
function renderDeep(memory = {}) { const text = String(memory?.text || '').trim(); if (!text) return ''; return memory?.tone === 'dual' ? renderMemoryEntry(text, 'dual', 'Противоречивое незабываемое событие') : renderMemoryEntry(text, String(memory?.tone || 'neutral'), 'Незабываемое событие'); }
function barStyle(value = 0, color = '#93c5fd') { const num = Math.max(-100, Math.min(100, parseInt(value, 10) || 0)); return num >= 0 ? `left:50%;width:${Math.abs(num) / 2}%;background:linear-gradient(90deg,rgba(255,255,255,0),${color});box-shadow:0 0 18px ${color};` : `right:50%;width:${Math.abs(num) / 2}%;background:linear-gradient(270deg,rgba(255,255,255,0),${color});box-shadow:0 0 18px ${color};`; }
function progress(left, center, right, fill, accent = '', icon = '') { const style = accent ? ` style="color:${accent};position:relative;display:flex;justify-content:space-between;align-items:center;"` : ' style="position:relative;display:flex;justify-content:space-between;align-items:center;"'; return `<div class="bb-progress-wrapper"><div class="bb-progress-labels"${style}><span>${escapeHtml(left)}</span><span class="bb-label-center" style="position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;white-space:nowrap;">${icon}${escapeHtml(center)}</span><span>${escapeHtml(right)}</span></div><div class="bb-progress-bg"><div class="bb-progress-center-line"></div><div class="bb-progress-fill" style="${fill}"></div></div></div>`; }
function avatarPreviewMarkup(charName = '') { return `<div class="bb-popup-avatar-preview-inner">${renderAvatar(charName)}</div>`; }
function ensureCustomAvatarMap() { if (!chat_metadata['bb_vn_char_custom_avatars'] || typeof chat_metadata['bb_vn_char_custom_avatars'] !== 'object') chat_metadata['bb_vn_char_custom_avatars'] = {}; return chat_metadata['bb_vn_char_custom_avatars']; }
function ensureCropperAssets() {
    if (globalThis.Cropper) return Promise.resolve(globalThis.Cropper);
    if (cropperAssetsPromise) return cropperAssetsPromise;

    if (!document.getElementById(CROPPER_STYLE_ID)) {
        const link = document.createElement('link');
        link.id = CROPPER_STYLE_ID;
        link.rel = 'stylesheet';
        link.href = CROPPER_STYLE_SRC;
        document.head.appendChild(link);
    }

    cropperAssetsPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${CROPPER_SCRIPT_SRC}"]`);
        if (existing) {
            existing.addEventListener('load', () => resolve(globalThis.Cropper), { once: true });
            existing.addEventListener('error', () => reject(new Error('cropper_load_failed')), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.src = CROPPER_SCRIPT_SRC;
        script.async = true;
        script.onload = () => resolve(globalThis.Cropper);
        script.onerror = () => reject(new Error('cropper_load_failed'));
        document.head.appendChild(script);
    }).finally(() => {
        if (!globalThis.Cropper) cropperAssetsPromise = null;
    });

    return cropperAssetsPromise;
}
function readFileAsDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('read_failed')); reader.onload = () => resolve(String(reader.result || '')); reader.readAsDataURL(file); }); }
function waitForImageReady(image, src) { return new Promise((resolve, reject) => { image.onload = () => { image.onload = null; image.onerror = null; resolve(); }; image.onerror = () => { image.onload = null; image.onerror = null; reject(new Error('decode_failed')); }; image.src = src; }); }
function canvasToAvatarDataUrl(canvas) { const webp = canvas.toDataURL('image/webp', CUSTOM_AVATAR_QUALITY); return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', CUSTOM_AVATAR_QUALITY); }
function destroyAvatarCropper() { if (activeAvatarCropper?.destroy) activeAvatarCropper.destroy(); activeAvatarCropper = null; }
function closeAvatarCropSession(root) {
    destroyAvatarCropper();
    const shell = root.querySelector('.bb-char-popup-avatar-cropper-shell');
    const image = root.querySelector('.bb-char-popup-avatar-cropper-image');
    if (shell) shell.hidden = true;
    if (image) image.removeAttribute('src');
}
async function openAvatarCropSession(root, file) {
    const cropShell = root.querySelector('.bb-char-popup-avatar-cropper-shell');
    const cropImage = root.querySelector('.bb-char-popup-avatar-cropper-image');
    if (!cropShell || !cropImage || !file) return;
    const Cropper = await ensureCropperAssets();
    if (!Cropper) throw new Error('cropper_missing');
    const dataUrl = await readFileAsDataUrl(file);
    closeAvatarCropSession(root);
    cropShell.hidden = false;
    await waitForImageReady(cropImage, dataUrl);
    activeAvatarCropper = new Cropper(cropImage, {
        aspectRatio: 1,
        viewMode: 1,
        dragMode: 'move',
        autoCropArea: 1,
        background: false,
        guides: false,
        center: false,
        highlight: false,
        movable: true,
        zoomable: true,
        scalable: false,
        rotatable: false,
        responsive: true,
        checkOrientation: false,
    });
}
function refreshPopupAvatar(root, charName) {
    root.querySelectorAll('.bb-char-popup-avatar').forEach(node => { node.innerHTML = renderAvatar(charName); });
    root.querySelectorAll('.bb-char-popup-avatar-preview-main').forEach(node => { node.innerHTML = avatarPreviewMarkup(charName); });
    root.querySelector('.bb-popup-avatar-clear')?.toggleAttribute('disabled', !customAvatarUrl(charName));
}
function renderTraitEntry(entry = {}) {
    const tone = entry?.type === 'positive' ? 'positive' : entry?.type === 'negative' ? 'negative' : 'neutral';
    const raw = String(entry?.trait || '').trim();
    if (!raw) return '';
    const colonIndex = raw.indexOf(':');
    const hasHeadline = colonIndex !== -1 && colonIndex < 60;
    const title = hasHeadline ? raw.slice(0, colonIndex).trim() : '';
    const description = hasHeadline ? raw.slice(colonIndex + 1).trim() : raw;
    return `<div class="bb-char-trait-entry ${escapeHtml(tone)}"><div class="bb-char-trait-icon"><i class="fa-solid fa-gem"></i></div><div class="bb-char-trait-body">${title ? `<div class="bb-char-trait-name">${escapeHtml(title)}</div>` : ''}<div class="bb-char-trait-text">${escapeHtml(description)}</div></div></div>`;
}
function crystalRowMarkup(count = 0, type = 'positive', charName = '') {
    const safeCount = Math.max(0, Math.min(5, Number(count) || 0));
    const isPositive = type === 'positive';
    let gems = '';
    for (let i = 0; i < 5; i++) gems += `<i class="${i < safeCount ? 'fa-solid' : 'fa-regular'} fa-gem"></i>`;
    const label = isPositive ? 'Светлая черта' : 'Мрачная черта';
    return safeCount >= 5
        ? `<button type="button" class="bb-crystal-row-btn ${type} bb-popup-crystallize-btn" data-char="${escapeHtml(charName)}" data-crystal-tone="${escapeHtml(type)}"><div class="bb-cr-gems">${gems}</div><span class="bb-cr-text"><i class="fa-solid fa-wand-magic-sparkles"></i> Кристаллизовать: ${label}</span></button>`
        : `<div class="bb-crystal-row-static ${type}"><div class="bb-cr-gems">${gems}</div><span class="bb-cr-text">${label}: ${safeCount} / 5</span></div>`;
}
function rerenderCharacterPopup(charName, activeTab = 'overview') {
    const current = document.querySelector('#dialogue_popup_text .bb-char-popup');
    const nextModel = model(charName);
    if (!current || !nextModel) return null;
    destroyAvatarCropper();
    current.outerHTML = popupHtml(nextModel);
    const nextRoot = document.querySelector('#dialogue_popup_text .bb-char-popup');
    if (!nextRoot) return null;
    nextRoot.querySelectorAll('.bb-char-popup-tab').forEach(tab => tab.classList.toggle('active', tab.getAttribute('data-popup-tab') === activeTab));
    nextRoot.querySelectorAll('.bb-char-popup-pane').forEach(pane => pane.classList.toggle('active', pane.getAttribute('data-popup-pane') === activeTab));
    bindPopupActions(charName);
    return nextRoot;
}
function model(charName) {
    const stats = currentCalculatedStats[charName];
    if (!stats) return null;

    const affinity = stats.affinity;
    const tier = getTierInfo(affinity);
    const romance = stats.romance || 0;
    const memories = stats.memories || { soft: [], deep: [] };
    const deep = [...(memories.archive || []), ...memories.deep];
    const coreTraits = Array.isArray(stats.core_traits) ? stats.core_traits.filter(trait => String(trait?.trait || '').trim()) : [];
    const last = [...(stats.history || [])].reverse().find(entry => entry.delta !== 0);
    const shift = last ? getShiftDescriptor(last.delta, last.moodlet || '') : null;
    const deepPositiveCount = memories.deep.filter(memory => memory?.tone === 'positive').length;
    const deepNegativeCount = memories.deep.filter(memory => memory?.tone === 'negative').length;
    const positiveTraitCount = coreTraits.filter(trait => trait?.type === 'positive').length;
    const negativeTraitCount = coreTraits.filter(trait => trait?.type === 'negative').length;
    const crystalRows = [];
    if (deepPositiveCount > 0 || positiveTraitCount > 0) crystalRows.push(crystalRowMarkup(deepPositiveCount, 'positive', charName));
    if (deepNegativeCount > 0 || negativeTraitCount > 0) crystalRows.push(crystalRowMarkup(deepNegativeCount, 'negative', charName));

    return {
        charName,
        tier,
        affinity,
        romance,
        memories,
        deep,
        coreTraits,
        displayStatus: stats.status || getUnforgettableRoleStatus(memories.deep) || tier.label,
        unforgettableImpact: getUnforgettableImpact(memories.deep),
        lastShift: shift,
        lastShiftPoints: last ? formatAffinityPoints(last.delta) : '0',
        trend: getTrendNarrative(stats.history || []),
        baseAffinity: chat_metadata['bb_vn_char_bases']?.[charName] ?? 0,
        baseRomance: chat_metadata['bb_vn_char_bases_romance']?.[charName] ?? 0,
        isPlatonic: (chat_metadata['bb_vn_platonic_chars'] || []).includes(charName),
        softHtml: memories.soft.length
            ? [...memories.soft].reverse().map(renderSoft).join('')
            : '<div class="bb-char-popup-empty">Пока нет мягких следов</div>',
        deepHtml: deep.length
            ? deepItems(deep).map(renderDeep).join('')
            : '<div class="bb-char-popup-empty">Ничего незабываемого</div>',
        traitsHtml: coreTraits.length
            ? coreTraits.map(renderTraitEntry).join('')
            : '<div class="bb-char-popup-empty">Черты характера пока не кристаллизованы.</div>',
        crystalHtml: crystalRows.length
            ? `<div class="bb-crystal-tracker bb-crystal-tracker-popup">${crystalRows.join('')}</div>`
            : '<div class="bb-char-popup-empty">Кристаллы для новой черты пока не собраны.</div>',
        affinityBar: barStyle(affinity, tier.color),
        romanceBar: barStyle(romance, '#b54e85'),
    };
}
function closePopup() { document.getElementById('dialogue_popup_ok')?.click(); }
function popupHtml(m) {
    return `<div class="bb-char-popup" data-char="${escapeHtml(m.charName)}">
        <div class="bb-char-popup-shell">
            <div class="bb-char-popup-topline">
                <div class="bb-char-popup-headnote">
                    <div class="bb-char-popup-kicker">Карточка персонажа</div>
                    <div class="bb-char-popup-caption">Связь, память и настройки персонажа.</div>
                </div>
                <div class="bb-char-popup-score-wrap">
                    <span class="bb-char-score" style="color:${m.tier.color};">${m.affinity > 0 ? '+' : ''}${m.affinity}</span>
                    ${m.romance !== 0 ? `<span class="bb-char-popup-romance"><i class="fa-solid fa-heart"></i>${m.romance > 0 ? '+' : ''}${m.romance}</span>` : ''}
                </div>
            </div>

            <div class="bb-char-popup-hero">
                <div class="bb-char-popup-avatar-frame">
                    <div class="bb-char-popup-avatar">${renderAvatar(m.charName)}</div>
                </div>
                <div class="bb-char-popup-heading">
                    <div class="bb-char-popup-name">${escapeHtml(m.charName)}</div>
                    <div class="bb-char-popup-badges">
                        <span class="bb-char-popup-status-label">Статус связи</span>
                        <span class="bb-char-tier ${m.tier.class}" title="${escapeHtml(m.displayStatus)}">${escapeHtml(m.displayStatus)}</span>
                        ${m.memories.deep.length ? `<span class="bb-unforgettable-impact">${escapeHtml(m.unforgettableImpact.label)}</span>` : ''}
                    </div>
                </div>
            </div>

            <div class="bb-char-popup-tabs" role="tablist" aria-label="Разделы карточки персонажа">
                <button type="button" class="bb-char-popup-tab active" data-popup-tab="overview">Обзор</button>
                <button type="button" class="bb-char-popup-tab" data-popup-tab="memory">Память</button>
                <button type="button" class="bb-char-popup-tab" data-popup-tab="settings">Настройки</button>
            </div>

            <div class="bb-char-popup-pane active" data-popup-pane="overview">
                <div class="bb-char-popup-overview-grid">
                    <div class="bb-char-popup-stat-card bb-char-popup-stat-card-shift">
                        <span class="bb-char-popup-stat-label">Последний сдвиг</span>
                        <strong style="color:${m.lastShift ? m.lastShift.color : 'var(--bb-theme-body)'};">${escapeHtml(m.lastShiftPoints)}</strong>
                        <small>${escapeHtml(m.lastShift?.short || 'Сдвигов пока не было')}</small>
                    </div>
                    <div class="bb-char-popup-stat-card bb-char-popup-stat-card-trend">
                        <span class="bb-char-popup-stat-label">Динамика</span>
                        <strong>${escapeHtml(m.trend)}</strong>
                        <small>Последние изменения связи с вами</small>
                    </div>
                    <div class="bb-char-popup-stat-card bb-char-popup-stat-card-soft">
                        <span class="bb-char-popup-stat-label">Мягкие следы</span>
                        <strong>${m.memories.soft.length}</strong>
                        <small>Текущие впечатления и отклики</small>
                    </div>
                    <div class="bb-char-popup-stat-card bb-char-popup-stat-card-deep">
                        <span class="bb-char-popup-stat-label">Глубокие следы</span>
                        <strong>${m.deep.length}</strong>
                        <small>Незабываемые события истории</small>
                    </div>
                </div>

                <div class="bb-char-popup-section bb-char-popup-section-plain bb-char-popup-traits-section">
                    <div class="bb-char-popup-section-title">Черты характера</div>
                    <div class="bb-char-popup-section-body">
                        <div class="bb-char-traits-list">${m.traitsHtml}</div>
                        <div class="bb-char-popup-subsection-title">Кристаллизация черт</div>
                        ${m.crystalHtml}
                    </div>
                </div>

                <div class="bb-char-popup-section bb-char-popup-section-plain">
                    <div class="bb-char-popup-section-title">Шкалы отношений</div>
                    <div class="bb-char-popup-section-body">
                        ${progress('Ненависть', 'Равнодушие', 'Семья', m.affinityBar)}
                        ${m.romance !== 0 ? progress('Неприязнь', 'Влечение', 'Любовь', m.romanceBar, '#b54e85', '<i class="fa-solid fa-heart" style="font-size:12px;margin-right:4px;"></i>') : '<div class="bb-char-popup-empty">Романтическая шкала пока не активна.</div>'}
                    </div>
                </div>
            </div>

            <div class="bb-char-popup-pane" data-popup-pane="memory">
                <div class="bb-char-popup-memory-layout">
                    <div class="bb-char-popup-section">
                        <div class="bb-char-popup-section-title">Мягкие следы</div>
                        <div class="bb-char-popup-section-body">
                            <div class="bb-char-memory-list">${m.softHtml}</div>
                        </div>
                    </div>

                    <div class="bb-char-popup-section">
                        <div class="bb-char-popup-section-title">Незабываемые события</div>
                        <div class="bb-char-popup-section-body">
                            <div class="bb-char-memory-list">${m.deepHtml}</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="bb-char-popup-pane" data-popup-pane="settings">
                <div class="bb-char-popup-section bb-char-popup-avatar-section">
                    <div class="bb-char-popup-section-title">Аватар персонажа</div>
                    <div class="bb-char-popup-section-body">
                        <div class="bb-char-popup-avatar-tools">
                            <div class="bb-char-popup-avatar-slot bb-char-popup-avatar-slot-single">
                                <div class="bb-char-popup-avatar-preview bb-char-popup-avatar-preview-main">${avatarPreviewMarkup(m.charName)}</div>
                                <div class="bb-char-popup-avatar-copy">
                                    <div class="bb-char-popup-avatar-title">Большой аватар</div>
                                    <div class="bb-char-popup-avatar-hint">Показывается в подробной карточке персонажа.</div>
                                    <input type="file" class="bb-popup-avatar-input" accept="image/*" hidden>
                                    <div class="bb-char-popup-avatar-actions">
                                        <button type="button" class="menu_button bb-popup-avatar-pick"><i class="fa-solid fa-image"></i>&ensp;Выбрать</button>
                                        <button type="button" class="menu_button bb-popup-avatar-clear" ${customAvatarUrl(m.charName) ? '' : 'disabled'}><i class="fa-solid fa-trash"></i>&ensp;Убрать</button>
                                    </div>
                                </div>
                            </div>
                            <div class="bb-char-popup-avatar-slot">
                                <div class="bb-char-popup-avatar-preview bb-char-popup-avatar-preview-thumb">${avatarPreviewMarkup(m.charName, { thumbnail: true })}</div>
                                <div class="bb-char-popup-avatar-copy">
                                    <div class="bb-char-popup-avatar-title">Миниатюра</div>
                                    <div class="bb-char-popup-avatar-hint">Используется в маленьких карточках списка персонажей.</div>
                                    <input type="file" class="bb-popup-avatar-thumb-input" accept="image/*" hidden>
                                    <div class="bb-char-popup-avatar-actions">
                                        <button type="button" class="menu_button bb-popup-avatar-thumb-pick"><i class="fa-solid fa-image"></i>&ensp;Выбрать</button>
                                        <button type="button" class="menu_button bb-popup-avatar-thumb-clear" ${customAvatarThumbUrl(m.charName) ? '' : 'disabled'}><i class="fa-solid fa-trash"></i>&ensp;Убрать</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="bb-char-popup-editor">
                    <div class="bb-editor-title">Настройки связи</div>
                    <div class="bb-editor-hint">Можно поправить стартовые значения или выключить романтическую ветку для этого персонажа.</div>
                    <div class="bb-char-popup-editor-grid">
                        <label class="bb-char-popup-field">
                            <span>База доверия</span>
                            <input type="number" class="text_pole bb-popup-edit-base-input" value="${m.baseAffinity}">
                        </label>
                        <label class="bb-char-popup-field">
                            <span>База романтики</span>
                            <input type="number" class="text_pole bb-popup-edit-romance-input" value="${m.baseRomance}">
                        </label>
                    </div>
                    <label class="checkbox_label bb-char-popup-checkbox">
                        <input type="checkbox" class="bb-popup-edit-platonic-cb" ${m.isPlatonic ? 'checked' : ''}>
                        <span>Строго платонически</span>
                    </label>
                    <div class="bb-char-popup-actions">
                        <button type="button" class="menu_button bb-popup-save-char" data-char="${escapeHtml(m.charName)}"><i class="fa-solid fa-check"></i>&ensp;Сохранить</button>
                        <button type="button" class="menu_button bb-popup-hide-char" data-char="${escapeHtml(m.charName)}"><i class="fa-solid fa-eye-slash"></i>&ensp;Скрыть</button>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}
function bindPopupActions(charName) {
    const root = document.querySelector('#dialogue_popup_text .bb-char-popup');
    if (!root) return;

    root.querySelectorAll('.bb-char-popup-tab').forEach(button => {
        button.addEventListener('click', () => {
            const tab = button.getAttribute('data-popup-tab') || 'overview';
            root.querySelectorAll('.bb-char-popup-tab').forEach(item => item.classList.toggle('active', item === button));
            root.querySelectorAll('.bb-char-popup-pane').forEach(pane => pane.classList.toggle('active', pane.getAttribute('data-popup-pane') === tab));
        });
    });

    const avatarInput = root.querySelector('.bb-popup-avatar-input');
    root.querySelector('.bb-char-popup-avatar-slot-single .bb-char-popup-avatar-title')?.replaceChildren(document.createTextNode('Единый аватар'));
    root.querySelector('.bb-char-popup-avatar-slot-single .bb-char-popup-avatar-hint')?.replaceChildren(document.createTextNode('Используется и в маленькой карточке, и в полном профиле. После выбора можно сразу указать нужную область кадра.'));
    const cropSlot = root.querySelector('.bb-char-popup-avatar-preview-thumb')?.closest('.bb-char-popup-avatar-slot');
    if (cropSlot instanceof HTMLElement) {
        cropSlot.classList.add('bb-char-popup-avatar-cropper-shell');
        cropSlot.hidden = true;
        cropSlot.querySelector('.bb-char-popup-avatar-title')?.replaceChildren(document.createTextNode('Кадрирование'));
        cropSlot.querySelector('.bb-char-popup-avatar-hint')?.replaceChildren(document.createTextNode('Подвиньте изображение и масштаб, чтобы выбрать квадратный фрагмент для аватарки.'));
        cropSlot.querySelector('.bb-popup-avatar-thumb-input')?.remove();
        const preview = cropSlot.querySelector('.bb-char-popup-avatar-preview');
        if (preview) preview.outerHTML = '<div class="bb-char-popup-avatar-cropper-stage"><img class="bb-char-popup-avatar-cropper-image" alt="Avatar crop area"></div>';
        const actions = cropSlot.querySelector('.bb-char-popup-avatar-actions');
        if (actions) actions.innerHTML = '<button type="button" class="menu_button bb-popup-avatar-apply"><i class="fa-solid fa-crop-simple"></i>&ensp;Применить</button><button type="button" class="menu_button bb-popup-avatar-cancel"><i class="fa-solid fa-xmark"></i>&ensp;Отмена</button>';
    }
    const avatarThumbInput = null;
    root.querySelector('.bb-popup-avatar-pick')?.addEventListener('click', () => avatarInput?.click());
    root.querySelector('.bb-popup-avatar-thumb-pick')?.addEventListener('click', () => avatarThumbInput?.click());
    avatarInput?.addEventListener('change', async () => {
        const file = avatarInput.files?.[0];
        if (!file) return;
        try {
            await openAvatarCropSession(root, file);
            notifyInfo('Выберите нужную область и нажмите «Применить».');
            return;
            const avatarMap = ensureCustomAvatarMap();
            avatarMap[charName] = dataUrl;
            saveChatDebounced();
            renderSocialHud();
            refreshPopupAvatar(root, charName);
            notifySuccess('Аватар персонажа сохранён и сжат.');
        } catch (error) {
            void error;
            notifyError('Не удалось обработать изображение.');
        } finally {
            avatarInput.value = '';
        }
    });
    avatarThumbInput?.addEventListener('change', async () => {
        const file = avatarThumbInput.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await compressAvatarFile(file);
            if (!chat_metadata['bb_vn_char_custom_avatar_thumbs'] || typeof chat_metadata['bb_vn_char_custom_avatar_thumbs'] !== 'object') chat_metadata['bb_vn_char_custom_avatar_thumbs'] = {};
            chat_metadata['bb_vn_char_custom_avatar_thumbs'][charName] = dataUrl;
            saveChatDebounced();
            renderSocialHud();
            refreshPopupAvatar(root, charName);
            notifySuccess('Миниатюра персонажа сохранена.');
        } catch (error) {
            void error;
            notifyError('Не удалось обработать миниатюру.');
        } finally {
            avatarThumbInput.value = '';
        }
    });
    root.querySelector('.bb-popup-avatar-apply')?.addEventListener('click', () => {
        try {
            if (!activeAvatarCropper) {
                notifyInfo('Сначала выберите изображение.');
                return;
            }
            const canvas = activeAvatarCropper.getCroppedCanvas({
                width: CUSTOM_AVATAR_MAX_SIDE,
                height: CUSTOM_AVATAR_MAX_SIDE,
                imageSmoothingEnabled: true,
                imageSmoothingQuality: 'high',
            });
            if (!canvas) throw new Error('canvas_failed');
            const avatarMap = ensureCustomAvatarMap();
            avatarMap[charName] = canvasToAvatarDataUrl(canvas);
            saveChatDebounced();
            renderSocialHud();
            refreshPopupAvatar(root, charName);
            closeAvatarCropSession(root);
            notifySuccess('Аватар персонажа сохранён и аккуратно обрезан.');
        } catch (error) {
            void error;
            notifyError('Не удалось сохранить обрезанную аватарку.');
        }
    });
    root.querySelector('.bb-popup-avatar-cancel')?.addEventListener('click', () => closeAvatarCropSession(root));
    root.querySelector('.bb-popup-avatar-clear')?.addEventListener('click', () => {
        closeAvatarCropSession(root);
        if (!chat_metadata['bb_vn_char_custom_avatars']) return;
        delete chat_metadata['bb_vn_char_custom_avatars'][charName];
        saveChatDebounced();
        renderSocialHud();
        refreshPopupAvatar(root, charName);
        notifyInfo('Кастомный аватар удалён.');
    });
    root.querySelector('.bb-popup-avatar-thumb-clear')?.addEventListener('click', () => {
        if (!chat_metadata['bb_vn_char_custom_avatar_thumbs']) return;
        delete chat_metadata['bb_vn_char_custom_avatar_thumbs'][charName];
        saveChatDebounced();
        renderSocialHud();
        refreshPopupAvatar(root, charName);
        notifyInfo('Миниатюра персонажа удалена.');
    });

    root.querySelectorAll('.bb-popup-crystallize-btn').forEach(button => {
        button.addEventListener('click', async () => {
            bindActivePersonaState();
            const tone = button.getAttribute('data-crystal-tone') === 'negative' ? 'negative' : 'positive';
            const stats = currentCalculatedStats[charName];
            const targetMemories = Array.isArray(stats?.memories?.deep) ? stats.memories.deep.filter(memory => memory?.tone === tone) : [];
            if (targetMemories.length < 5) {
                notifyInfo('Пока недостаточно глубоких следов для кристаллизации.');
                return;
            }

            const context = SillyTavern.getContext?.();
            const chat = Array.isArray(context?.chat) ? context.chat : [];
            const lastMessage = chat.length ? chat[chat.length - 1] : null;
            if (!lastMessage) {
                notifyError('Не удалось найти сообщение для сохранения черты.');
                return;
            }

            const originalHtml = button.innerHTML;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Анализ воспоминаний...';
            button.disabled = true;
            try {
                const result = normalizeTraitResponse(await crystallizeTraitFromMemories({
                    charName,
                    userName: context?.substituteParams?.('{{user}}') || '',
                    memories: targetMemories,
                    isPositive: tone === 'positive',
                }));
                if (!result || result.length > 240) throw new Error('INVALID_TRAIT_OUTPUT');
                const swipeId = lastMessage.swipe_id || 0;
                if (!lastMessage.extra) lastMessage.extra = {};
                if (!lastMessage.extra.bb_vn_char_traits_swipes) lastMessage.extra.bb_vn_char_traits_swipes = {};
                if (!Array.isArray(lastMessage.extra.bb_vn_char_traits_swipes[swipeId])) lastMessage.extra.bb_vn_char_traits_swipes[swipeId] = [];
                lastMessage.extra.bb_vn_char_traits_swipes[swipeId].push({
                    charName,
                    trait: result,
                    type: tone,
                    scope: getCurrentPersonaScopeKey(),
                });
                saveChatDebounced();
                recalculateAllStats();
                renderSocialHud();
                rerenderCharacterPopup(charName, 'overview');
                notifySuccess('Черта характера кристаллизована.');
            } catch (error) {
                void error;
                button.innerHTML = originalHtml;
                button.disabled = false;
                notifyError('Не удалось кристаллизовать черту.');
            }
        });
    });
    root.querySelector('.bb-popup-save-char')?.addEventListener('click', () => { bindActivePersonaState(); const newBase = parseInt(String(root.querySelector('.bb-popup-edit-base-input')?.value || ''), 10); const newRomance = parseInt(String(root.querySelector('.bb-popup-edit-romance-input')?.value || ''), 10); const isPlatonic = root.querySelector('.bb-popup-edit-platonic-cb')?.checked === true; if (!Number.isNaN(newBase)) { if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {}; chat_metadata['bb_vn_char_bases'][charName] = newBase; } if (!Number.isNaN(newRomance)) { if (!chat_metadata['bb_vn_char_bases_romance']) chat_metadata['bb_vn_char_bases_romance'] = {}; chat_metadata['bb_vn_char_bases_romance'][charName] = newRomance; } if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = []; chat_metadata['bb_vn_platonic_chars'] = isPlatonic ? [...new Set([...chat_metadata['bb_vn_platonic_chars'], charName])] : chat_metadata['bb_vn_platonic_chars'].filter(name => name !== charName); saveChatDebounced(); recalculateAllStats(); renderSocialHud(); closePopup(); notifySuccess('Настройки сохранены!'); });
    root.querySelector('.bb-popup-hide-char')?.addEventListener('click', () => { if (!window.confirm(`Скрыть персонажа "${charName}" из трекера?`)) return; bindActivePersonaState(); if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = []; if (!chat_metadata['bb_vn_ignored_chars'].includes(charName)) chat_metadata['bb_vn_ignored_chars'].push(charName); saveChatDebounced(); recalculateAllStats(); renderSocialHud(); closePopup(); notifyInfo(`${charName} скрыт.`); });
}
async function openCharacterDetailsPopup(charName) { const m = model(charName); if (!m) return; setHudPopupPriority(true); const promise = callPopup(popupHtml(m), 'text', '', { okButton: 'Закрыть', wider: true, large: true, allowVerticalScrolling: true }); bindPopupActions(charName); try { await promise; } finally { destroyAvatarCropper(); setHudPopupPriority(false); } }

export function renderSocialHud() {
    bindActivePersonaState();
    const context = SillyTavern.getContext?.();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const lastChatMessage = chat.length ? chat[chat.length - 1] : null;
    const shouldShowLastUsedTone = !lastChatMessage || !lastChatMessage.is_user;
    const names = Object.keys(currentCalculatedStats).sort((a, b) => currentCalculatedStats[b].affinity - currentCalculatedStats[a].affinity);
    const visibleCharacters = names.length;
    const topCharacterName = visibleCharacters ? names[0] : '';
    const topAffinity = topCharacterName ? currentCalculatedStats[topCharacterName].affinity : 0;
    const deepMomentsCount = currentStoryMoments.filter(moment => String(moment.type || '').includes('deep')).length;
    const activeChoiceTone = extension_settings[MODULE_NAME].emotionalChoiceFraming ? ((shouldShowLastUsedTone ? chat_metadata['bb_vn_last_used_choice_context']?.tone : chat_metadata['bb_vn_choice_context']?.tone) || 'не активен') : 'выключен';
    const latestMoment = currentStoryMoments.length ? currentStoryMoments[currentStoryMoments.length - 1] : null;
    const debugStatus = socialParseDebug?.status || 'idle';
    const debugText = socialParseDebug?.details || 'Нет данных';
    const debugLabel = debugStatus === 'parsed' ? 'HTML найден' : debugStatus === 'injecting' ? 'Макрос внедрён' : debugStatus === 'stored' ? 'HTML сохранён' : debugStatus === 'checking' ? 'Проверка' : debugStatus === 'error' ? 'HTML не распознан' : debugStatus === 'missing' ? 'HTML не найден' : 'Ожидание';
    const charsBox = document.getElementById('bb-hud-chars');
    if (charsBox) {
        if (!visibleCharacters) charsBox.innerHTML = `<div class="bb-panel-hero bb-panel-hero-route"><div class="bb-panel-kicker">Персонажи</div><div class="bb-panel-headline">Пока нет активных связей</div><div class="bb-panel-subtitle">Список появится после сцен, где есть взаимодействия с персонажами.</div></div><div class="bb-empty-hud">Здесь пока пусто.<br>Взаимодействуйте с персонажами.</div>`;
        else {
            let cardsHtml = '';
            names.forEach(charName => { const m = model(charName); if (!m) return; cardsHtml += `<div class="bb-char-card" data-char="${escapeHtml(charName)}"><div class="bb-char-card-shell bb-char-card-shell-compact"><div class="bb-char-summary bb-char-summary-minimal"><div class="bb-char-avatar">${renderAvatar(charName, { thumbnail: true })}</div><div class="bb-char-summary-main"><div class="bb-char-summary-top"><div class="bb-char-summary-heading"><div class="bb-char-name bb-char-name-compact">${escapeHtml(charName)}</div><div class="bb-char-summary-signpost"><div class="bb-char-summary-caption">Отношение к вам</div>${relationCueSvg()}</div></div><button type="button" class="bb-char-edit-btn" data-char="${escapeHtml(charName)}" title="Открыть карточку персонажа"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button></div><div class="bb-char-summary-badges"><span class="bb-char-tier ${m.tier.class}" title="${escapeHtml(m.displayStatus)}">${escapeHtml(m.displayStatus)}</span></div><div class="bb-char-score-row"><div class="bb-char-score-chip"><span>Связь</span><strong style="color:${m.tier.color};">${m.affinity > 0 ? '+' : ''}${m.affinity}</strong></div>${m.romance !== 0 ? `<div class="bb-char-score-chip bb-char-score-chip-romance"><span>Романтика</span><strong>${m.romance > 0 ? '+' : ''}${m.romance}</strong></div>` : ''}</div></div></div><div class="bb-char-open-hint"><i class="fa-solid fa-book-open"></i><span>Открыть карточку персонажа</span></div></div></div>`; });
            charsBox.innerHTML = `<div class="bb-panel-hero bb-panel-hero-route"><div class="bb-panel-kicker">Персонажи</div><div class="bb-panel-headline">Состояние отношений</div><div class="bb-panel-subtitle">Текущие связи, сдвиги и важные воспоминания по каждому персонажу.</div></div><div class="bb-route-card-stack">${cardsHtml}</div>`;
            jQuery('.bb-char-card').off('click').on('click', function(e) { if (jQuery(e.target).closest('.bb-char-edit-btn').length) return; void openCharacterDetailsPopup(jQuery(this).attr('data-char')); });
            jQuery('.bb-char-edit-btn').off('click').on('click', function(e) { e.preventDefault(); e.stopPropagation(); void openCharacterDetailsPopup(jQuery(this).attr('data-char')); });
        }
    }
    const logBox = document.getElementById('bb-hud-log');
    if (logBox) {
        const logs = chat_metadata['bb_vn_global_log'] || [];
        const preview = `<div class="bb-panel-hero bb-panel-hero-system"><div class="bb-panel-kicker">Журнал</div><div class="bb-panel-headline">Системный журнал</div><div class="bb-panel-subtitle">Здесь показаны изменения отношений и текущий инжектируемый prompt.</div><div class="bb-panel-stat-grid"><div class="bb-panel-stat"><span class="bb-panel-stat-label">Событий</span><strong>${logs.length}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Активный тон</span><strong>${escapeHtml(activeChoiceTone)}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Последнее событие</span><strong>${escapeHtml(latestMoment?.title || '—')}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Social HTML</span><strong>${escapeHtml(debugLabel)}</strong></div></div><div class="bb-panel-subtitle" style="margin-top:8px;">${escapeHtml(debugText)}</div></div><details class="bb-prompt-card"><summary class="bb-prompt-summary"><span>🧠 Inject Prompt</span><button type="button" class="menu_button bb-copy-prompt-btn"><i class="fa-solid fa-copy"></i>&nbsp; Копировать</button></summary><div class="bb-prompt-hint">Это текущий инжект, собранный из актуального состояния чата. После нового выбора VN или следующего хода он может измениться.</div><pre class="bb-prompt-pre">${escapeHtml(getCombinedSocial())}</pre></details>`;
        if (!logs.length) logBox.innerHTML = `${preview}<div class="bb-empty-hud">Журнал событий пуст.</div>`; else { let logHtml = '<div class="bb-system-log-list">'; [...logs].reverse().forEach(log => { logHtml += `<div class="bb-glog-item ${log.type}"><span class="bb-glog-time">[${log.time}]</span><span class="bb-glog-text">${log.text}</span></div>`; }); logHtml += '</div>'; logBox.innerHTML = preview + logHtml; }
        logBox.querySelector('.bb-copy-prompt-btn')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(getCombinedSocial()); notifySuccess('Prompt скопирован!'); } catch (error) { void error; notifyError('Ошибка копирования.'); } });
    }
    const momentsBox = document.getElementById('bb-hud-moments');
    if (momentsBox) {
        if (!currentStoryMoments.length) momentsBox.innerHTML = `<div class="bb-panel-hero bb-panel-hero-diary"><div class="bb-panel-kicker">Дневник событий</div><div class="bb-panel-headline">Дневник ещё пуст</div><div class="bb-panel-subtitle">Здесь будут сохраняться важные изменения.</div></div><div class="bb-empty-hud">Памятные моменты пока не накопились.</div>`;
        else { let html = `<div class="bb-panel-hero bb-panel-hero-diary"><div class="bb-panel-kicker">Дневник событий</div><div class="bb-panel-headline">События</div><div class="bb-panel-subtitle">Важные события, зафиксированные по ходу чата.</div><div class="bb-panel-stat-grid"><div class="bb-panel-stat"><span class="bb-panel-stat-label">Записей</span><strong>${currentStoryMoments.length}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Последняя</span><strong>${escapeHtml(currentStoryMoments[currentStoryMoments.length - 1]?.title || '—')}</strong></div></div></div><div class="bb-diary-stack">`; [...currentStoryMoments].reverse().forEach((moment, index) => { html += `<div class="bb-moment-card ${escapeHtml(moment.type || 'neutral')}"><div class="bb-moment-pin"></div><div class="bb-moment-header"><div class="bb-moment-meta"><span class="bb-moment-stamp">Запись ${currentStoryMoments.length - index}</span><span class="bb-moment-char">${escapeHtml(moment.char || 'Сцена')}</span></div><span class="bb-moment-title">${escapeHtml(moment.title)}</span></div><div class="bb-moment-divider"></div><div class="bb-moment-body"><div class="bb-moment-text">${escapeHtml(moment.text)}</div></div></div>`; }); momentsBox.innerHTML = `${html}</div>`; }
    }
    syncToastContainerWithHud();
}

export function updateHudVisibility() {
    const context = SillyTavern.getContext();
    if (!hasContextInitialized(context)) { if (!hudVisibilityRetryTimer) hudVisibilityRetryTimer = setTimeout(() => { hudVisibilityRetryTimer = null; updateHudVisibility(); }, HUD_VISIBILITY_RETRY_MS); return; }
    if (hudVisibilityRetryTimer) { clearTimeout(hudVisibilityRetryTimer); hudVisibilityRetryTimer = null; }
    const chatId = context?.chatId; const chatLength = Array.isArray(context?.chat) ? context.chat.length : 0; const isGroup = typeof context?.is_group === 'boolean' ? context.is_group : typeof context?.groupId !== 'undefined' ? Boolean(context.groupId) : undefined; const chatType = typeof context?.chat_type === 'string' ? context.chat_type : isGroup === true ? 'group' : 'direct'; const shouldShowHud = hasActiveChatContext(context);
    if (shouldShowHud) jQuery('#bb-social-hud-toggle, #bb-social-hud-mobile-launcher').show(); else { jQuery('#bb-social-hud-toggle, #bb-social-hud-mobile-launcher').hide(); closeSocialHud(); }
    if (isDevModeEnabled()) console.debug('[BB VN][debug] HUD visibility updated', { action: shouldShowHud ? 'show' : 'hide', chatId, chatLength, isGroup, chatType });
    syncToastContainerWithHud();
}

export function openSocialHud() { jQuery('#bb-social-hud').addClass('open'); jQuery('#bb-social-hud-backdrop').addClass('open'); jQuery('body').addClass('bb-social-hud-active'); jQuery('#bb-social-toast-container').addClass('hud-open'); jQuery('#bb-hud-arrow').removeClass('fa-chevron-left').addClass('fa-chevron-right'); renderSocialHud(); syncToastContainerWithHud(); }
export function closeSocialHud() { jQuery('#bb-social-hud').removeClass('open'); jQuery('#bb-social-hud-backdrop').removeClass('open'); jQuery('body').removeClass('bb-social-hud-active'); jQuery('#bb-social-toast-container').removeClass('hud-open'); jQuery('#bb-hud-arrow').removeClass('fa-chevron-right').addClass('fa-chevron-left'); syncToastContainerWithHud(); }

export function ensureHudContainer() {
    if (document.getElementById('bb-social-hud')) return;
    jQuery('body').append(`<button type="button" id="bb-social-hud-backdrop" aria-label="Закрыть HUD"></button><button type="button" id="bb-social-hud-mobile-launcher" aria-label="Открыть HUD"><i class="fa-solid fa-users-viewfinder"></i><span>VNE</span></button><div id="bb-social-hud"><div id="bb-social-hud-toggle" title="VNE HUD"><i class="fa-solid fa-users-viewfinder"></i><span class="bb-toggle-label">VNE</span><i class="fa-solid fa-chevron-left" id="bb-hud-arrow"></i></div><div class="bb-hud-header"><div class="bb-hud-header-top"><span class="bb-hud-badge">Visual Novel Engine</span><div class="bb-hud-status-row"><span class="bb-hud-live-dot"><i class="fa-solid fa-circle"></i> активно</span><button type="button" class="bb-hud-mobile-close" aria-label="Закрыть HUD"><i class="fa-solid fa-xmark"></i></button></div></div><div class="bb-hud-title">VNE</div><div class="bb-hud-subtitle">персонажи · журнал · дневник событий</div></div><div class="bb-hud-tabs"><div class="bb-hud-tab active" data-tab="chars"><i class="fa-solid fa-heart-pulse"></i><span>Персонажи</span></div><div class="bb-hud-tab" data-tab="log"><i class="fa-solid fa-terminal"></i><span>Система</span></div><div class="bb-hud-tab" data-tab="moments"><i class="fa-solid fa-book-open"></i><span>Дневник</span></div></div><div class="bb-hud-content active" id="bb-hud-chars"></div><div class="bb-hud-content" id="bb-hud-log"></div><div class="bb-hud-content" id="bb-hud-moments"></div></div>`);
    jQuery('.bb-hud-tab').on('click', function() { jQuery('.bb-hud-tab').removeClass('active'); jQuery('.bb-hud-content').removeClass('active'); jQuery(this).addClass('active'); jQuery(`#bb-hud-${jQuery(this).data('tab')}`).addClass('active'); });
    jQuery('#bb-social-hud-toggle, #bb-social-hud-mobile-launcher').on('click', () => { if (jQuery('#bb-social-hud').hasClass('open')) closeSocialHud(); else openSocialHud(); });
    jQuery('#bb-social-hud-backdrop, .bb-hud-mobile-close').on('click', closeSocialHud);
    const toggle = document.getElementById('bb-social-hud-toggle'); let timer = null; const scheduleIdle = () => { if (!toggle) return; clearTimeout(timer); toggle.classList.remove('bb-toggle-idle'); if (window.innerWidth <= 760) timer = setTimeout(() => toggle.classList.add('bb-toggle-idle'), 1500); }; scheduleIdle(); if (toggle) ['pointerdown', 'touchstart', 'mouseenter', 'focus'].forEach(eventName => toggle.addEventListener(eventName, scheduleIdle));
    window.addEventListener('resize', () => { if (window.innerWidth > 760) jQuery('#bb-social-hud-backdrop').removeClass('open'); syncToastContainerWithHud(); scheduleIdle(); });
}
