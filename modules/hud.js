/* global SillyTavern */
import { chat_metadata, saveChatDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { currentCalculatedStats, currentStoryMoments, socialParseDebug, setIsVnGenerationCancelled } from './state.js';
import { 
    escapeHtml, 
    getToneClass, 
    formatAffinityPoints, 
    getShiftDescriptor,
    getAffinityNarrative,
    normalizeTraitResponse
} from './utils.js';
import { syncToastContainerWithHud, notifySuccess, notifyInfo, notifyError, showTraitCrystallizedToast } from './toasts.js';
import { 
    getTierInfo, 
    getTrendNarrative, 
    getUnforgettableImpact, 
    getUnforgettableRoleStatus,
    recalculateAllStats,
    getCombinedSocial,
    bindActivePersonaState,
    getCurrentPersonaScopeKey,
    getCharacterProfile,
    updateCharacterProfile
} from './social.js';
import { cancelVnGeneration, crystallizeTraitFromMemories, generateCharacterDescription, isVnGenerationAbortError } from './generator.js';

const HUD_VISIBILITY_RETRY_MS = 120;
let hudVisibilityRetryTimer = null;
const AVATAR_OUTPUT_WIDTH = 432;
const AVATAR_OUTPUT_HEIGHT = 528;
const AVATAR_PREVIEW_WIDTH = 216;
const AVATAR_PREVIEW_HEIGHT = 264;
const AVATAR_PREVIEW_DEBOUNCE_MS = 70;
const CARD_BODY_ANIM_MS = 220;
const CARD_EDITOR_ANIM_MS = 180;

function resetDescriptionGenerationUi(editor) {
    const scopedEditor = editor instanceof jQuery ? editor : jQuery(editor);
    if (!scopedEditor?.length) return;

    const generateButton = scopedEditor.find('.bb-btn-generate-description');
    const cancelButton = scopedEditor.find('.bb-btn-cancel-description-generation');
    const originalHtml = String(generateButton.attr('data-original-html') || '<i class="fa-solid fa-wand-magic-sparkles"></i>&ensp;По шаблону');

    generateButton.prop('disabled', false).html(originalHtml).removeAttr('data-original-html');
    cancelButton.prop('disabled', true).hide().html('<i class="fa-solid fa-xmark"></i>&ensp;Отмена');
    scopedEditor.removeData('bbDescriptionGenerationRequestId');
    scopedEditor.removeData('bbDescriptionGenerationCancelled');
}

function setHudPopupPriority(isPopupActive) {
    document.body.classList.toggle('bb-hud-popup-active', Boolean(isPopupActive));
}

function hasContextInitialized(context) {
    if (!context || typeof context !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(context, 'chatId') || Object.prototype.hasOwnProperty.call(context, 'chat');
}

function hasActiveChatContext(context) {
    const chatId = context?.chatId;
    const hasValidChatId = typeof chatId === 'number'
        || (typeof chatId === 'string' && chatId.trim().length > 0);
    const hasChatMessages = Array.isArray(context?.chat) && context.chat.length > 0;
    return hasValidChatId || hasChatMessages;
}

function isDevModeEnabled() {
    const host = String(globalThis?.location?.hostname || '').toLowerCase();
    return host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || globalThis?.BB_VN_DEV === true;
}

function buildDeepMemoryDisplayItems(memories = []) {
    const orderedMemories = [...memories].reverse();
    const items = [];

    for (let index = 0; index < orderedMemories.length; index++) {
        const current = orderedMemories[index];
        const currentText = String(current?.text || '').trim();
        if (!currentText) continue;

        const next = orderedMemories[index + 1];
        const nextText = String(next?.text || '').trim();
        const currentTone = String(current?.tone || '');
        const nextTone = String(next?.tone || '');
        const isDualTonePair = nextText
            && currentText === nextText
            && ((currentTone === 'positive' && nextTone === 'negative') || (currentTone === 'negative' && nextTone === 'positive'));

        if (isDualTonePair) {
            items.push({ text: currentText, tone: 'dual' });
            index++;
            continue;
        }

        items.push({ text: currentText, tone: currentTone });
    }

    return items;
}

function renderDeepMemoryPill(memory = {}) {
    const text = escapeHtml(memory?.text || '');
    const tone = String(memory?.tone || '');
    if (!text) return '';
    if (tone === 'dual') {
        return `<div class="bb-memory-pill deep dual-tone" title="Противоречивое незабываемое событие"><span>${text}</span></div>`;
    }
    return `<div class="bb-memory-pill deep ${tone}"><span>${text}</span></div>`;
}

function getCharacterInitials(charName = '') {
    const parts = String(charName || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return parts.slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
}

function buildAvatarStyle(profile = {}) {
    const avatar = String(profile?.avatar || '').trim();
    if (!avatar) return '';

    const crop = profile?.avatarCrop && typeof profile.avatarCrop === 'object'
        ? profile.avatarCrop
        : { x: 50, y: 50, zoom: 100 };
    const safeAvatar = avatar.replace(/'/g, "\\'");
    const focusX = Number.isFinite(Number(crop.x)) ? Number(crop.x) : 50;
    const focusY = Number.isFinite(Number(crop.y)) ? Number(crop.y) : 50;
    const zoom = Number.isFinite(Number(crop.zoom)) ? Number(crop.zoom) : 100;

    return `background-image:url('${safeAvatar}'); background-position:${focusX}% ${focusY}%; background-size:${zoom}%;`;
}

function buildFixedAvatarPreviewStyle(avatarDataUrl = '') {
    const safeAvatar = String(avatarDataUrl || '').trim().replace(/'/g, "\\'");
    if (!safeAvatar) return '';
    return `background-image:url('${safeAvatar}'); background-position:center; background-size:cover;`;
}

function renderCharacterAvatar(profile = {}, charName = '', extraClass = '') {
    const avatarStyle = buildAvatarStyle(profile);
    const className = ['bb-char-avatar', extraClass, avatarStyle ? 'has-image' : 'is-empty']
        .filter(Boolean)
        .join(' ');

    if (avatarStyle) {
        return `<div class="${className}" style="${avatarStyle}" aria-hidden="true"></div>`;
    }

    return `<div class="${className}" aria-hidden="true"><span>${escapeHtml(getCharacterInitials(charName))}</span></div>`;
}

function getLatestRelationshipDeltas(history = []) {
    const latestEntry = [...(Array.isArray(history) ? history : [])]
        .reverse()
        .find(entry => {
            const affinityDelta = parseInt(entry?.affinityDelta, 10);
            const romanceDelta = parseInt(entry?.romanceDelta, 10);
            const dominantDelta = parseInt(entry?.delta, 10);
            return (Number.isFinite(affinityDelta) && affinityDelta !== 0)
                || (Number.isFinite(romanceDelta) && romanceDelta !== 0)
                || (Number.isFinite(dominantDelta) && dominantDelta !== 0);
        });

    if (!latestEntry) return { affinity: 0, romance: 0 };

    const dominantDelta = parseInt(latestEntry?.delta, 10);
    const affinityDelta = parseInt(latestEntry?.affinityDelta, 10);
    const romanceDelta = parseInt(latestEntry?.romanceDelta, 10);

    return {
        affinity: Number.isFinite(affinityDelta) ? affinityDelta : (Number.isFinite(dominantDelta) ? dominantDelta : 0),
        romance: Number.isFinite(romanceDelta) ? romanceDelta : 0,
    };
}

function renderScoreDeltaBadge(delta = 0, kind = 'affinity') {
    const numeric = parseInt(delta, 10);
    if (!Number.isFinite(numeric) || numeric === 0) return '';
    const toneClass = numeric > 0 ? 'positive' : 'negative';
    const iconClass = numeric > 0 ? 'fa-solid fa-arrow-up' : 'fa-solid fa-arrow-down';
    const ariaLabel = `${kind === 'romance' ? 'Романтика' : 'Доверие'} ${numeric > 0 ? 'выросла' : 'снизилась'} на ${Math.abs(numeric)}`;
    return `<span class="bb-char-score-delta ${kind} ${toneClass}" title="${escapeHtml(ariaLabel)}" aria-label="${escapeHtml(ariaLabel)}"><i class="${iconClass}"></i></span>`;
}

function buildCharacterDescriptionTemplateStructured({ charName = '', stats = {}, displayStatus = '' } = {}) {
    const affinity = parseInt(stats?.affinity, 10) || 0;
    const romance = parseInt(stats?.romance, 10) || 0;
    const traits = Array.isArray(stats?.core_traits)
        ? stats.core_traits
            .map(item => String(item?.trait || '').split(':')[0].trim())
            .filter(Boolean)
            .slice(0, 3)
        : [];
    const memories = stats?.memories && typeof stats.memories === 'object' ? stats.memories : {};
    const notableMemories = [
        ...(Array.isArray(memories.deep) ? memories.deep : []),
        ...(Array.isArray(memories.soft) ? memories.soft.slice(-2) : []),
    ]
        .map(memory => String(memory?.text || '').trim())
        .filter(Boolean)
        .slice(0, 2);
    const trend = getTrendNarrative(stats?.history || []);

    const fragments = [
        `${charName} сейчас воспринимает пользователя как "${displayStatus || 'неопределённый фактор'}".`,
        `Текущая динамика отношений: ${trend.toLowerCase()}, доверие ${affinity > 0 ? '+' : ''}${affinity}.`,
    ];

    if (romance !== 0) {
        fragments.push(`Романтическое напряжение держится на уровне ${romance > 0 ? '+' : ''}${romance}.`);
    }
    if (traits.length > 0) {
        fragments.push(`В поведении особенно заметны черты: ${traits.join(', ')}.`);
    }
    if (notableMemories.length > 0) {
        fragments.push(`Его особенно формируют события: ${notableMemories.join('; ')}.`);
    }

    return fragments.join(' ').replace(/\s+/g, ' ').trim();
}

async function loadImageFromUrl(dataUrl = '') {
    return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('IMAGE_LOAD_ERROR'));
        img.src = String(dataUrl || '');
    });
}

async function resizeImageFileToDataUrl(file, maxSide = 2200) {
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('FILE_READ_ERROR'));
        reader.readAsDataURL(file);
    });

    const image = await loadImageFromUrl(dataUrl);

    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    if (!width || !height) return dataUrl;

    const scale = Math.min(1, maxSide / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    if (scale === 1) return dataUrl;

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) return dataUrl;
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    try {
        return canvas.toDataURL('image/webp', 0.92);
    } catch (error) {
        void error;
        return canvas.toDataURL('image/png');
    }
}

async function createCroppedAvatarDataUrl(sourceDataUrl = '', crop = {}, options = {}) {
    if (!String(sourceDataUrl || '').trim()) return '';

    const image = await loadImageFromUrl(sourceDataUrl);
    const naturalWidth = image.naturalWidth || image.width || 0;
    const naturalHeight = image.naturalHeight || image.height || 0;
    if (!naturalWidth || !naturalHeight) return String(sourceDataUrl || '');

    const outputWidth = Math.max(180, parseInt(options.outputWidth, 10) || 360);
    const outputHeight = Math.max(220, parseInt(options.outputHeight, 10) || 440);
    const focusX = Math.max(0, Math.min(100, Number(crop?.x) || 50)) / 100;
    const focusY = Math.max(0, Math.min(100, Number(crop?.y) || 50)) / 100;
    const zoom = Math.max(80, Math.min(240, Number(crop?.zoom) || 100)) / 100;

    const baseScale = Math.max(outputWidth / naturalWidth, outputHeight / naturalHeight);
    const effectiveScale = baseScale * zoom;
    const visibleWidth = outputWidth / effectiveScale;
    const visibleHeight = outputHeight / effectiveScale;

    const centerX = naturalWidth * focusX;
    const centerY = naturalHeight * focusY;
    const maxLeft = Math.max(0, naturalWidth - visibleWidth);
    const maxTop = Math.max(0, naturalHeight - visibleHeight);
    const cropLeft = Math.min(maxLeft, Math.max(0, centerX - (visibleWidth / 2)));
    const cropTop = Math.min(maxTop, Math.max(0, centerY - (visibleHeight / 2)));
    const cropWidth = Math.max(1, Math.min(visibleWidth, naturalWidth));
    const cropHeight = Math.max(1, Math.min(visibleHeight, naturalHeight));

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) return String(sourceDataUrl || '');

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
        image,
        cropLeft,
        cropTop,
        cropWidth,
        cropHeight,
        0,
        0,
        outputWidth,
        outputHeight,
    );

    try {
        return canvas.toDataURL('image/webp', 0.88);
    } catch (error) {
        void error;
        return canvas.toDataURL('image/jpeg', 0.9);
    }
}

function syncCharacterEditorAvatarPreview(editor) {
    const preview = editor.find('.bb-avatar-preview');
    if (preview.length === 0) return;

    const avatar = String(editor.find('.bb-edit-avatar-source').val() || editor.find('.bb-edit-avatar-data').val() || '').trim();
    const crop = {
        x: parseFloat(String(editor.find('.bb-avatar-focus-x').val() || '50')),
        y: parseFloat(String(editor.find('.bb-avatar-focus-y').val() || '50')),
        zoom: parseFloat(String(editor.find('.bb-avatar-focus-zoom').val() || '100')),
    };
    const charName = String(editor.closest('.bb-char-card').attr('data-char') || '').trim();
    const requestId = Number(editor.data('bbAvatarPreviewRequestId') || 0) + 1;

    editor.data('bbAvatarPreviewRequestId', requestId);
    preview.find('.bb-avatar-preview-initials').text(getCharacterInitials(charName));
    editor.find('.bb-btn-clear-avatar').prop('disabled', !avatar);

    if (!avatar) {
        preview.removeAttr('style');
        preview.removeClass('has-image').addClass('is-empty');
        return;
    }

    preview.removeClass('is-empty');
    createCroppedAvatarDataUrl(avatar, crop, {
        outputWidth: AVATAR_PREVIEW_WIDTH,
        outputHeight: AVATAR_PREVIEW_HEIGHT,
    }).then((previewDataUrl) => {
        if (Number(editor.data('bbAvatarPreviewRequestId') || 0) !== requestId) return;
        const previewStyle = buildFixedAvatarPreviewStyle(previewDataUrl);
        if (!previewStyle) {
            preview.addClass('is-empty');
            return;
        }
        preview.addClass('has-image').attr('style', previewStyle);
    }).catch((error) => {
        if (Number(editor.data('bbAvatarPreviewRequestId') || 0) !== requestId) return;
        console.error('[BB VN] Avatar preview sync failed:', error);
        preview.addClass('is-empty');
    });
}

function queueCharacterEditorAvatarPreview(editor, immediate = false) {
    const activeTimer = Number(editor.data('bbAvatarPreviewTimer') || 0);
    if (activeTimer) {
        window.clearTimeout(activeTimer);
        editor.removeData('bbAvatarPreviewTimer');
    }

    if (immediate) {
        syncCharacterEditorAvatarPreview(editor);
        return;
    }

    const timerId = window.setTimeout(() => {
        if (!editor.closest('body').length) return;
        editor.removeData('bbAvatarPreviewTimer');
        syncCharacterEditorAvatarPreview(editor);
    }, AVATAR_PREVIEW_DEBOUNCE_MS);

    editor.data('bbAvatarPreviewTimer', timerId);
}

function setCharacterCardExpanded(card, shouldExpand, options = {}) {
    void options;
    card.toggleClass('expanded', Boolean(shouldExpand));
    if (!shouldExpand) {
        card.removeClass('editor-open');
    }
}

function setCharacterEditorOpen(card, shouldOpen, options = {}) {
    void options;
    if (shouldOpen) {
        setCharacterCardExpanded(card, true, options);
        card.addClass('editor-open');
        queueCharacterEditorAvatarPreview(card.children('.bb-char-editor'), true);
        return;
    }

    card.removeClass('editor-open');
}

function buildCharacterDescriptionTemplate({ charName = '', stats = {}, displayStatus = '' } = {}) {
    const affinity = parseInt(stats?.affinity, 10) || 0;
    const romance = parseInt(stats?.romance, 10) || 0;
    const traits = Array.isArray(stats?.core_traits)
        ? stats.core_traits
            .map(item => String(item?.trait || '').split(':')[0].trim())
            .filter(Boolean)
            .slice(0, 4)
        : [];
    const memories = stats?.memories && typeof stats.memories === 'object' ? stats.memories : {};
    const notableMemories = [
        ...(Array.isArray(memories.deep) ? memories.deep : []),
        ...(Array.isArray(memories.soft) ? memories.soft.slice(-2) : []),
    ]
        .map(memory => String(memory?.text || '').trim())
        .filter(Boolean)
        .slice(0, 3);
    const trend = getTrendNarrative(stats?.history || []);

    const personalityLine = traits.length > 0
        ? `Характер и манера: ${traits.join(', ')}.`
        : 'Характер и манера: явных устойчивых черт пока мало, образ ещё достраивается по сценам.';
    const biographyLine = notableMemories.length > 0
        ? `Биография и контекст: ${notableMemories.join('; ')}.`
        : 'Биография и контекст: в чате пока мало надёжно подтверждённых фактов.';
    const relationshipLine = `Отношение к пользователю: ${trend.toLowerCase()}, доверие ${affinity > 0 ? '+' : ''}${affinity}${romance !== 0 ? `, романтическая линия ${romance > 0 ? '+' : ''}${romance}` : ''}.`;
    const memoryLine = notableMemories.length > 0
        ? `Что важно учитывать в сценах: ${notableMemories.join('; ')}.`
        : 'Что важно учитывать в сценах: персонажу пока не хватает крупных закреплённых событий и биографических якорей.';

    return [
        `Имя: ${charName}.`,
        'Возраст / этап жизни: не указан напрямую, без жёстких уточнений.',
        `Статус и роль: ${displayStatus || 'неопределённый фактор'}.`,
        personalityLine,
        biographyLine,
        relationshipLine,
        memoryLine,
    ].join('\n');
}

function buildCharacterCardHtml(charName = '') {
    const stats = currentCalculatedStats[charName];
    if (!stats) return '';

    const affinity = stats.affinity;
    const romance = stats.romance || 0;
    const tier = getTierInfo(affinity);
    const memories = stats.memories || { soft: [], deep: [], archive: [] };
    const displayStatus = stats.status || getUnforgettableRoleStatus(memories.deep) || tier.label;
    const unforgettableImpact = getUnforgettableImpact(memories.deep);
    const latestDeltas = getLatestRelationshipDeltas(stats.history || []);
    const lastHistory = [...(stats.history || [])].reverse().find(item => item.delta !== 0);
    const lastShift = lastHistory ? getShiftDescriptor(lastHistory.delta, lastHistory.moodlet || '') : null;
    const baseAffinity = chat_metadata['bb_vn_char_bases']?.[charName] ?? 0;
    const baseRomance = chat_metadata['bb_vn_char_bases_romance']?.[charName] ?? 0;
    const isPlatonic = (chat_metadata['bb_vn_platonic_chars'] || []).includes(charName);
    const profile = getCharacterProfile(charName);
    const avatarHtml = renderCharacterAvatar(profile, charName);

    let barStyle = '';
    if (affinity >= 0) {
        const width = Math.min(100, affinity);
        barStyle = `left: 50%; width: ${width / 2}%; background: linear-gradient(90deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
    } else {
        const width = Math.min(100, Math.abs(affinity));
        barStyle = `right: 50%; width: ${width / 2}%; background: linear-gradient(270deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
    }

    let romanceBarStyle = '';
    if (romance >= 0) {
        romanceBarStyle = `left: 50%; width: ${Math.min(100, romance) / 2}%; background: linear-gradient(90deg, rgba(255,255,255,0.0), #ec4899); box-shadow: 0 0 18px #ec4899;`;
    } else {
        romanceBarStyle = `right: 50%; width: ${Math.min(100, Math.abs(romance)) / 2}%; background: linear-gradient(270deg, rgba(255,255,255,0.0), #ec4899); box-shadow: 0 0 18px #ec4899;`;
    }

    const romanceHtml = romance !== 0 ? `
        <div class="bb-progress-wrapper bb-progress-wrapper-romance">
            <div class="bb-progress-labels" style="color:#f472b6; position: relative; display: flex; justify-content: space-between; align-items: center;">
                <span>Неприязнь</span>
                <span class="bb-label-center" style="position: absolute; left: 50%; transform: translateX(-50%); display: flex; align-items: center; white-space: nowrap;">
                    <i class="fa-solid fa-heart" style="font-size:12px; margin-right: 4px;"></i>Влечение
                </span>
                <span>Любовь</span>
            </div>
            <div class="bb-progress-bg">
                <div class="bb-progress-center-line"></div>
                <div class="bb-progress-fill" style="${romanceBarStyle}"></div>
            </div>
        </div>
    ` : '';

    const allDeepMemories = [...(memories.archive || []), ...(memories.deep || [])];
    const softMemoriesHtml = (memories.soft || []).length > 0
        ? [...memories.soft].reverse().map(memory => `<div class="bb-memory-pill ${memory.tone}"><span>${escapeHtml(memory.text)}</span></div>`).join('')
        : '<i style="color:#64748b; font-size: 11px;">Пока нет мягких следов</i>';
    const deepMemoriesHtml = allDeepMemories.length > 0
        ? buildDeepMemoryDisplayItems(allDeepMemories).map(renderDeepMemoryPill).join('')
        : '<i style="color:#64748b; font-size: 11px;">Ничего незабываемого</i>';

    const coreTraits = stats.core_traits || [];
    let posTraitsCount = 0;
    let negTraitsCount = 0;
    const traitsHtml = coreTraits.length > 0
        ? coreTraits.map(traitItem => {
            if (traitItem.type === 'positive') posTraitsCount++;
            else if (traitItem.type === 'negative') negTraitsCount++;

            const color = traitItem.type === 'positive'
                ? '#4ade80'
                : (traitItem.type === 'negative' ? '#fb7185' : '#fbbf24');
            const background = traitItem.type === 'positive'
                ? 'rgba(74, 222, 128, 0.12)'
                : (traitItem.type === 'negative' ? 'rgba(244, 63, 94, 0.12)' : 'rgba(251, 191, 36, 0.12)');

            let traitText = escapeHtml(traitItem.trait);
            const separatorIndex = traitText.indexOf(':');
            if (separatorIndex !== -1 && separatorIndex < 50) {
                const name = traitText.substring(0, separatorIndex).trim();
                const description = traitText.substring(separatorIndex + 1).trim();
                traitText = `<b style="color:inherit; filter:brightness(1.5); text-transform:uppercase; font-size:10px; margin-right:4px; letter-spacing:0.5px;">${name}:</b> ${description}`;
            }

            return `<div class="bb-memory-pill deep" style="border-color:${color}; color:${color}; background:${background};"><i class="fa-solid fa-gem"></i> <span>${traitText}</span></div>`;
        }).join('')
        : '';

    const deepPosCount = (memories.deep || []).filter(memory => memory.tone === 'positive').length;
    const deepNegCount = (memories.deep || []).filter(memory => memory.tone === 'negative').length;

    let crystalTrackerHtml = '';
    if (deepPosCount > 0 || posTraitsCount > 0 || deepNegCount > 0 || negTraitsCount > 0) {
        const buildRow = (count, type) => {
            const isPositive = type === 'positive';
            let gems = '';
            for (let i = 0; i < 5; i++) {
                gems += `<i class="${i < Math.min(5, count) ? 'fa-solid' : 'fa-regular'} fa-gem"></i>`;
            }

            return count >= 5
                ? `<button type="button" class="bb-crystal-row-btn ${type} bb-btn-crystallize-${isPositive ? 'pos' : 'neg'}" data-char="${escapeHtml(charName)}"><div class="bb-cr-gems">${gems}</div><span class="bb-cr-text"><i class="fa-solid fa-wand-magic-sparkles"></i> Создать ${isPositive ? 'светлую' : 'мрачную'} черту</span></button>`
                : `<div class="bb-crystal-row-static ${type}"><div class="bb-cr-gems">${gems}</div><span class="bb-cr-text">${count} / 5</span></div>`;
        };

        crystalTrackerHtml = `<div class="bb-crystal-tracker compact">${(deepPosCount > 0 || posTraitsCount > 0) ? buildRow(deepPosCount, 'positive') : ''}${(deepNegCount > 0 || negTraitsCount > 0) ? buildRow(deepNegCount, 'negative') : ''}</div>`;
    }

    const generatedDescription = buildCharacterDescriptionTemplateStructured({
        charName,
        stats,
        displayStatus,
    });
    const showAffinityMetric = affinity !== 0 || latestDeltas.affinity !== 0;
    const showRomanceMetric = romance !== 0 || latestDeltas.romance !== 0;
    const hasRomanceMetric = showRomanceMetric;
    const isNeutralScoreline = affinity === 0
        && !hasRomanceMetric
        && latestDeltas.affinity === 0
        && latestDeltas.romance === 0;
    const scorelineClass = [
        'bb-char-summary-scoreline',
        hasRomanceMetric ? 'has-romance' : 'is-single',
        isNeutralScoreline ? 'is-neutral' : '',
    ].filter(Boolean).join(' ');

    return `
        <div class="bb-char-card" data-char="${escapeHtml(charName)}">
            <div class="bb-char-card-shell">
                <div class="bb-char-summary">
                    <div class="bb-char-avatar-column">
                        ${avatarHtml}
                        <div class="bb-char-avatar-ornament" aria-hidden="true"><span></span></div>
                    </div>
                    <div class="bb-char-summary-main">
                        <div class="bb-char-summary-headline">
                            <div class="bb-char-name bb-char-name-compact">${escapeHtml(charName)}</div>
                            <button type="button" class="bb-char-edit-btn" data-char="${escapeHtml(charName)}" title="Настройки персонажа"><i class="fa-solid fa-sliders"></i></button>
                        </div>
                        <div class="bb-char-summary-status-row">
                            <span class="bb-char-direction bb-char-direction-compact"><i class="fa-solid fa-eye"></i> отношение к вам</span>
                            <span class="bb-char-tier ${tier.class}" title="${escapeHtml(displayStatus)}">${escapeHtml(displayStatus)}</span>
                            ${memories.deep.length > 0 ? `<span class="bb-unforgettable-impact compact">${escapeHtml(unforgettableImpact.label)}</span>` : ''}
                        </div>
                        <div class="${scorelineClass}">
                            ${showAffinityMetric ? `
                                <div class="bb-char-score-stack">
                                    ${renderScoreDeltaBadge(latestDeltas.affinity, 'affinity')}
                                    <span class="bb-char-score bb-char-score-compact" style="color:${tier.color};">${affinity > 0 ? '+' : ''}${affinity}</span>
                                </div>
                            ` : ''}
                            ${showRomanceMetric ? `
                                <div class="bb-char-score-stack romance">
                                    ${renderScoreDeltaBadge(latestDeltas.romance, 'romance')}
                                    <span class="bb-char-score bb-char-score-compact bb-char-score-romance">${romance > 0 ? '+' : ''}${romance}</span>
                                </div>
                            ` : ''}
                            <div class="bb-char-scoreline-ornament" aria-hidden="true"><span></span></div>
                        </div>
                        <div class="bb-char-summary-footer">
                            ${profile.description ? `<span class="bb-char-mini-chip info"><i class="fa-solid fa-scroll"></i> профиль</span>` : ''}
                            <span class="bb-char-expand-indicator"><i class="fa-solid fa-chevron-down"></i></span>
                        </div>
                        ${crystalTrackerHtml}
                    </div>
                </div>
            </div>
            <div class="bb-char-body">
                <div class="bb-char-route-meta">
                    <div class="bb-char-meta-card"><span class="bb-char-meta-label">Последний сдвиг</span><strong style="color: ${lastShift ? lastShift.color : '#f8fafc'};">${escapeHtml(lastShift ? lastShift.full : 'Без сдвига')}</strong></div>
                    <div class="bb-char-meta-card"><span class="bb-char-meta-label">Динамика</span><strong style="color: #cbd5e1;">${escapeHtml(getTrendNarrative(stats.history || []))}</strong></div>
                </div>
                <div class="bb-char-detail-block">
                    <div class="bb-progress-wrapper"><div class="bb-progress-labels" style="position: relative; display: flex; justify-content: space-between; align-items: center;"><span>Ненависть</span><span style="position: absolute; left: 50%; transform: translateX(-50%); white-space: nowrap;">Равнодушие</span><span>Семья</span></div><div class="bb-progress-bg"><div class="bb-progress-center-line"></div><div class="bb-progress-fill" style="${barStyle}"></div></div></div>
                    ${romanceHtml}
                </div>
                <div class="bb-char-insight-grid">
                    <div class="bb-char-insight-tile"><span class="bb-char-insight-label">Мягкие следы</span><strong>${(memories.soft || []).length}</strong></div>
                    <div class="bb-char-insight-tile"><span class="bb-char-insight-label">Глубокие следы</span><strong>${allDeepMemories.length}</strong></div>
                </div>
                ${(memories.soft.length > 0 || allDeepMemories.length > 0 || coreTraits.length > 0) ? `<div class="bb-char-log">
                    ${coreTraits.length > 0 ? `<div class="bb-memory-section" style="padding-top: 4px; margin-bottom: 8px;"><div class="bb-memory-title" style="color:#fbbf24;">Черты характера</div><div class="bb-memory-list bb-memory-list-deep">${traitsHtml}</div></div>` : ''}
                    ${memories.soft.length > 0 ? `<div class="bb-memory-section" style="padding-top: 4px;"><div class="bb-memory-title">Мягкие следы</div><div class="bb-memory-list">${softMemoriesHtml}</div></div>` : ''}
                    ${allDeepMemories.length > 0 ? `<div class="bb-memory-section"><div class="bb-memory-title">Незабываемые события</div><div class="bb-memory-list bb-memory-list-deep">${deepMemoriesHtml}</div></div>` : ''}
                </div>` : ''}
            </div>
            <div class="bb-char-editor" style="cursor: default; border-top: 1px solid rgba(255,255,255,0.06); border-radius: 0 0 22px 22px; margin: 0; background: rgba(0,0,0,0.2);">
                <div class="bb-editor-title">Настройки персонажа</div>
                <div class="bb-editor-hint">Здесь можно задать стартовые значения, аватар и дополнительный профиль для prompt.</div>
                <div class="bb-avatar-editor-grid">
                    <div class="bb-avatar-editor-panel">
                        <div class="bb-avatar-preview ${profile.avatar ? 'has-image' : 'is-empty'}" style="${buildAvatarStyle(profile)}">
                            <span class="bb-avatar-preview-initials">${escapeHtml(getCharacterInitials(charName))}</span>
                        </div>
                        <input type="hidden" class="bb-edit-avatar-source" value="${escapeHtml(profile.avatar)}">
                        <input type="hidden" class="bb-edit-avatar-data" value="${escapeHtml(profile.avatar)}">
                        <input type="file" class="bb-avatar-upload-input" accept="image/*" style="display:none;">
                        <div class="bb-editor-actions bb-editor-actions-tight">
                            <button type="button" class="menu_button bb-btn-upload-avatar" data-char="${escapeHtml(charName)}"><i class="fa-solid fa-image"></i>&ensp;Аватар</button>
                            <button type="button" class="menu_button bb-btn-clear-avatar" ${profile.avatar ? '' : 'disabled'}><i class="fa-solid fa-trash"></i>&ensp;Очистить</button>
                        </div>
                    </div>
                    <div class="bb-avatar-editor-panel">
                        <div class="bb-editor-hint" style="margin-bottom: 8px;">Выберите, какая часть изображения видна на карточке.</div>
                        <label class="bb-slider-field"><span>Фокус по X</span><input type="range" min="0" max="100" step="1" class="bb-avatar-focus-x" value="${Number(profile.avatarCrop?.x ?? 50)}"></label>
                        <label class="bb-slider-field"><span>Фокус по Y</span><input type="range" min="0" max="100" step="1" class="bb-avatar-focus-y" value="${Number(profile.avatarCrop?.y ?? 50)}"></label>
                        <label class="bb-slider-field"><span>Масштаб</span><input type="range" min="80" max="240" step="1" class="bb-avatar-focus-zoom" value="${Number(profile.avatarCrop?.zoom ?? 100)}"></label>
                    </div>
                </div>
                <div style="display:flex; gap: 8px; margin-bottom: 10px;"><div style="flex:1;"><span style="font-size: 9px; color:#94a3b8; text-transform:uppercase;">База доверия:</span><input type="number" class="text_pole bb-edit-base-input" value="${baseAffinity}" style="width:100%; box-sizing:border-box;"></div><div style="flex:1;"><span style="font-size: 9px; color:#f472b6; text-transform:uppercase;">База романтики:</span><input type="number" class="text_pole bb-edit-romance-input" value="${baseRomance}" style="width:100%; box-sizing:border-box;"></div></div>
                <label class="checkbox_label" style="margin-bottom: 10px;"><input type="checkbox" class="bb-edit-platonic-cb" ${isPlatonic ? 'checked' : ''}><span style="font-size: 11px; color:#fca5a5;">Строго платонически (блокирует флирт)</span></label>
                <div class="bb-editor-section">
                    <div class="bb-editor-title">Описание персонажа для prompt</div>
                    <div class="bb-editor-hint">По умолчанию оно пустое. Если заполнить вручную или собрать по шаблону, описание будет добавляться в инжект.</div>
                    <textarea class="text_pole bb-edit-description-input" rows="4" style="width:100%; min-height: 92px; resize: vertical;">${escapeHtml(profile.description)}</textarea>
                    <div class="bb-editor-hint" style="margin-top: 8px; margin-bottom: 0;">Описание видно только в настройках, чтобы не забивать блок со следами и незабываемыми событиями.</div>
                    <input type="hidden" class="bb-edit-generated-description" value="${escapeHtml(generatedDescription)}">
                    <div class="bb-editor-actions bb-editor-actions-tight" style="margin-top: 8px;">
                        <button type="button" class="menu_button bb-btn-generate-description" data-char="${escapeHtml(charName)}"><i class="fa-solid fa-wand-magic-sparkles"></i>&ensp;По шаблону</button>
                        <button type="button" class="menu_button bb-btn-cancel-description-generation" style="display:none;"><i class="fa-solid fa-xmark"></i>&ensp;Отмена</button>
                        <button type="button" class="menu_button bb-btn-clear-description"><i class="fa-solid fa-eraser"></i>&ensp;Очистить</button>
                    </div>
                </div>
                <div class="bb-editor-actions"><button class="menu_button bb-btn-save-char" data-char="${escapeHtml(charName)}" style="flex:1;"><i class="fa-solid fa-check"></i>&ensp;Сохранить</button><button class="menu_button bb-btn-hide-char" data-char="${escapeHtml(charName)}" style="flex:1; background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.35);"><i class="fa-solid fa-eye-slash"></i>&ensp;Скрыть</button></div>
            </div>
        </div>
    `;
}

export function renderSocialHud() {
    bindActivePersonaState();
    const context = SillyTavern.getContext?.();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const lastChatMessage = chat.length > 0 ? chat[chat.length - 1] : null;
    const shouldShowLastUsedTone = !lastChatMessage || !lastChatMessage.is_user;
    const characterEntries = Object.keys(currentCalculatedStats)
        .sort((a, b) => currentCalculatedStats[b].affinity - currentCalculatedStats[a].affinity);
    const visibleCharacters = characterEntries.length;
    const topCharacterName = visibleCharacters > 0 ? characterEntries[0] : '';
    const topAffinity = topCharacterName ? currentCalculatedStats[topCharacterName].affinity : 0;
    const deepMomentsCount = currentStoryMoments.filter(moment => String(moment.type || '').includes('deep')).length;
    const activeChoiceTone = extension_settings[MODULE_NAME].emotionalChoiceFraming
        ? ((shouldShowLastUsedTone
            ? chat_metadata['bb_vn_last_used_choice_context']?.tone
            : chat_metadata['bb_vn_choice_context']?.tone) || 'не активен')
        : 'выключен';
    const latestMoment = currentStoryMoments.length > 0 ? currentStoryMoments[currentStoryMoments.length - 1] : null;
    const socialDebugStatus = socialParseDebug?.status || 'idle';
    const socialDebugText = socialParseDebug?.details || 'Нет данных';
    const socialDebugLabel = socialDebugStatus === 'parsed'
        ? 'HTML найден'
        : socialDebugStatus === 'injecting'
            ? 'Макрос внедрён'
        : socialDebugStatus === 'stored'
            ? 'HTML сохранён'
        : socialDebugStatus === 'checking'
            ? 'Проверка'
        : socialDebugStatus === 'error'
            ? 'HTML не распознан'
        : socialDebugStatus === 'missing'
            ? 'HTML не найден'
            : 'Ожидание';

    const charsBox = document.getElementById('bb-hud-chars');
    if (charsBox) {
        if (visibleCharacters === 0) {
            charsBox.innerHTML = `
                <div class="bb-panel-hero bb-panel-hero-route">
                    <div class="bb-panel-kicker">Связи</div>
                    <div class="bb-panel-headline">Пока нет активных связей</div>
                    <div class="bb-panel-subtitle">Появится после сообщений, где есть взаимодействия с персонажами.</div>
                </div>
                <div class="bb-empty-hud">Здесь пока пусто.<br>Взаимодействуйте с персонажами.</div>
            `;
        } else {
            const cardsHtml = characterEntries.map(charName => buildCharacterCardHtml(charName)).join('');
            if (false) {
            characterEntries.forEach((charName, index) => {
                const stats = currentCalculatedStats[charName];
                const affinity = stats.affinity;
                const tier = getTierInfo(affinity);
                const baseAffinity = chat_metadata['bb_vn_char_bases']?.[charName] ?? 0;
                const memories = stats.memories || { soft: [], deep: [] };
                const displayStatus = stats.status || getUnforgettableRoleStatus(memories.deep) || tier.label;
                const unforgettableImpact = getUnforgettableImpact(memories.deep);
                const lastHistory = [...(stats.history || [])].reverse().find(h => h.delta !== 0);
                const lastShift = lastHistory ? getShiftDescriptor(lastHistory.delta, lastHistory.moodlet || '') : null;
                const lastShiftPoints = lastHistory ? formatAffinityPoints(lastHistory.delta) : '0';
                
                let barStyle = '';
                if (affinity >= 0) {
                    const w = Math.min(100, affinity);
                    barStyle = `left: 50%; width: ${w / 2}%; background: linear-gradient(90deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
                } else {
                    const w = Math.min(100, Math.abs(affinity));
                    barStyle = `right: 50%; width: ${w / 2}%; background: linear-gradient(270deg, rgba(255,255,255,0.0), ${tier.color}); box-shadow: 0 0 18px ${tier.color};`;
                }

                const romance = stats.romance || 0;
                let romanceBarStyle = '';
                if (romance >= 0) {
                    romanceBarStyle = `left: 50%; width: ${Math.min(100, romance) / 2}%; background: linear-gradient(90deg, rgba(255,255,255,0.0), #ec4899); box-shadow: 0 0 18px #ec4899;`;
                } else {
                    romanceBarStyle = `right: 50%; width: ${Math.min(100, Math.abs(romance)) / 2}%; background: linear-gradient(270deg, rgba(255,255,255,0.0), #ec4899); box-shadow: 0 0 18px #ec4899;`;
                }

                const romanceHtml = romance !== 0 ? `
    <div class="bb-progress-wrapper bb-progress-wrapper-romance">
        <div class="bb-progress-labels" style="color:#f472b6; position: relative; display: flex; justify-content: space-between; align-items: center;">
            <span>Неприязнь</span>
            <span class="bb-label-center" style="position: absolute; left: 50%; transform: translateX(-50%); display: flex; align-items: center; white-space: nowrap;">
                <i class="fa-solid fa-heart" style="font-size:12px; margin-right: 4px;"></i>Влечение
            </span>
            <span>Любовь</span>
        </div>
        <div class="bb-progress-bg">
            <div class="bb-progress-center-line"></div>
            <div class="bb-progress-fill" style="${romanceBarStyle}"></div>
        </div>
    </div>
` : '';

                const baseRomance = chat_metadata['bb_vn_char_bases_romance']?.[charName] ?? 0;
                const isPlatonic = (chat_metadata['bb_vn_platonic_chars'] || []).includes(charName);

                const allDeepMemories = [...(memories.archive || []), ...memories.deep];
                const softMemoriesHtml = memories.soft.length > 0
                    ? [...memories.soft].reverse().map(memory => `<div class="bb-memory-pill ${memory.tone}">${escapeHtml(memory.text)}</div>`).join('')
                    : '<i style="color:#64748b; font-size: 11px;">Пока нет мягких следов</i>';

                const deepMemoriesHtml = allDeepMemories.length > 0
                    ? buildDeepMemoryDisplayItems(allDeepMemories).map(renderDeepMemoryPill).join('')
                    : '<i style="color:#64748b; font-size: 11px;">Ничего незабываемого</i>';

                const coreTraits = stats.core_traits || [];
                let posTraitsCount = 0, negTraitsCount = 0;
                
                const traitsHtml = coreTraits.length > 0 
                    ? coreTraits.map(t => {
                        if (t.type === 'positive') posTraitsCount++;
                        else if (t.type === 'negative') negTraitsCount++;
                        const color = t.type === 'positive' ? '#4ade80' : (t.type === 'negative' ? '#fb7185' : '#fbbf24');
                        const bg = t.type === 'positive' ? 'rgba(74, 222, 128, 0.12)' : (t.type === 'negative' ? 'rgba(244, 63, 94, 0.12)' : 'rgba(251, 191, 36, 0.12)');
                        let traitText = escapeHtml(t.trait);
                        const colonIdx = traitText.indexOf(':');
                        if (colonIdx !== -1 && colonIdx < 50) { 
                            const boldName = traitText.substring(0, colonIdx).trim();
                            const restDesc = traitText.substring(colonIdx + 1).trim();
                            traitText = `<b style="color:inherit; filter:brightness(1.5); text-transform:uppercase; font-size:10px; margin-right:4px; letter-spacing:0.5px;">${boldName}:</b> ${restDesc}`;
                        }
                        return `<div class="bb-memory-pill deep" style="border-color:${color}; color:${color}; background:${bg};"><i class="fa-solid fa-gem"></i> <span>${traitText}</span></div>`;
                    }).join('') : '';

                const deepPosCount = memories.deep.filter(m => m.tone === 'positive').length;
                const deepNegCount = memories.deep.filter(m => m.tone === 'negative').length;
                
                let crystalTrackerHtml = '';
                if (deepPosCount > 0 || posTraitsCount > 0 || deepNegCount > 0 || negTraitsCount > 0) {
                    const buildRow = (count, type) => {
                        const isPos = type === 'positive';
                        let gems = '';
                        for(let i=0; i<5; i++) gems += `<i class="${i < Math.min(5, count) ? 'fa-solid' : 'fa-regular'} fa-gem"></i>`;
                        return count >= 5 
                            ? `<button type="button" class="bb-crystal-row-btn ${type} bb-btn-crystallize-${isPos ? 'pos' : 'neg'}" data-char="${escapeHtml(charName)}"><div class="bb-cr-gems">${gems}</div><span class="bb-cr-text"><i class="fa-solid fa-wand-magic-sparkles"></i> Создать ${isPos ? 'светлую' : 'мрачную'} черту</span></button>`
                            : `<div class="bb-crystal-row-static ${type}"><div class="bb-cr-gems">${gems}</div><span class="bb-cr-text">${count} / 5</span></div>`;
                    };
                    crystalTrackerHtml = `<div class="bb-crystal-tracker">${(deepPosCount > 0 || posTraitsCount > 0) ? buildRow(deepPosCount, 'positive') : ''}${(deepNegCount > 0 || negTraitsCount > 0) ? buildRow(deepNegCount, 'negative') : ''}</div>`;
                }

                cardsHtml += `
                    <div class="bb-char-card" data-char="${escapeHtml(charName)}">
                        <div class="bb-char-card-shell">
                            <div class="bb-char-hero">
                                <div class="bb-char-identity" style="display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;">
                                    <div style="display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0;">
                                        <div class="bb-char-name" style="font-size: 16px; line-height: 1.15; word-break: keep-all; overflow-wrap: break-word;">${escapeHtml(charName)}</div>
                                        <div style="display: flex; align-items: baseline; gap: 12px; margin-top: 2px; flex-wrap: wrap;">
                                            <span class="bb-char-score" style="color:${tier.color}; line-height: 1; font-size: 20px;">${affinity > 0 ? '+' : ''}${affinity}</span>
                                            ${romance !== 0 ? `<span style="font-size: 13px; font-weight: 700; color: #f472b6; display: flex; align-items: center; gap: 4px;"><i class="fa-solid fa-heart" style="font-size:10px;"></i>${romance > 0 ? '+' : ''}${romance}</span>` : ''}
                                        </div>
                                    </div>
                                    <div style="display: flex; align-items: flex-start; gap: 10px; text-align: right; flex-shrink: 0;">
                                        <div class="bb-char-subtitle" style="display: flex; flex-direction: column; align-items: flex-end; gap: 6px; margin: 0; padding-top: 2px;">
                                            <span class="bb-char-direction" style="margin-bottom: 0;"><i class="fa-solid fa-eye"></i> отношение к вам:</span>
                                            <div class="bb-char-signals" style="display: flex; flex-direction: column; align-items: flex-end; gap: 5px;">
                                                <span class="bb-char-tier ${tier.class}" style="text-align: center; max-width: 130px; line-height: 1.3;" title="${escapeHtml(displayStatus)}">${escapeHtml(displayStatus)}</span>
                                                ${memories.deep.length > 0 ? `<span class="bb-unforgettable-impact" style="text-align: center; max-width: 130px; line-height: 1.3;">${escapeHtml(unforgettableImpact.label)}</span>` : ''}
                                            </div>
                                        </div>
                                        <button type="button" class="bb-char-edit-btn" data-char="${escapeHtml(charName)}" title="Настройки персонажа" style="background: none; border: none; color: #64748b; cursor: pointer; padding: 0; font-size: 14px; min-width: auto; margin-top: -2px;"><i class="fa-solid fa-sliders"></i></button>
                                    </div>
                                </div>
                                <div class="bb-char-route-meta">
                                    <div class="bb-char-meta-card"><span class="bb-char-meta-label">Последний сдвиг</span><strong style="color: ${lastShift ? lastShift.color : '#f8fafc'};">${escapeHtml(lastShiftPoints)}</strong></div>
                                    <div class="bb-char-meta-card"><span class="bb-char-meta-label">Динамика</span><strong style="color: #cbd5e1;">${escapeHtml(getTrendNarrative(stats.history || []))}</strong></div>
                                </div>
                            </div>
                            <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 6px; min-height: 30px;">
                                <div class="bb-progress-wrapper"><div class="bb-progress-labels" style="position: relative; display: flex; justify-content: space-between; align-items: center;"><span>Ненависть</span><span style="position: absolute; left: 50%; transform: translateX(-50%); white-space: nowrap;">Равнодушие</span><span>Семья</span></div><div class="bb-progress-bg"><div class="bb-progress-center-line"></div><div class="bb-progress-fill" style="${barStyle}"></div></div></div>
                                ${romanceHtml}
                            </div>
                            <div class="bb-char-insight-grid" style="margin-top: 6px;">
                                <div class="bb-char-insight-tile"><span class="bb-char-insight-label">Мягкие следы</span><strong>${memories.soft.length}</strong></div>
                                <div class="bb-char-insight-tile"><span class="bb-char-insight-label">Глубокие следы</span><strong>${allDeepMemories.length}</strong></div>
                            </div>
                            ${crystalTrackerHtml}
                        </div>
                        ${(memories.soft.length > 0 || allDeepMemories.length > 0) ? `
                        <div class="bb-char-log" style="border-radius: 0;">
                            ${coreTraits.length > 0 ? `<div class="bb-memory-section" style="padding-top: 4px; margin-bottom: 8px;"><div class="bb-memory-title" style="color:#fbbf24;">Черты Характера</div><div class="bb-memory-list bb-memory-list-deep">${traitsHtml}</div></div>` : ''}
                            ${memories.soft.length > 0 ? `<div class="bb-memory-section" style="padding-top: 4px;"><div class="bb-memory-title">Мягкие следы</div><div class="bb-memory-list">${softMemoriesHtml}</div></div>` : ''}
                            ${allDeepMemories.length > 0 ? `<div class="bb-memory-section"><div class="bb-memory-title">Незабываемые события</div><div class="bb-memory-list bb-memory-list-deep">${deepMemoriesHtml}</div></div>` : ''}
                        </div>` : ''}
                        <div class="bb-char-editor" style="display:none; cursor: default; border-top: 1px solid rgba(255,255,255,0.06); border-radius: 0 0 22px 22px; margin: 0; background: rgba(0,0,0,0.2);">
                            <div class="bb-editor-title">Настройки связи</div><div class="bb-editor-hint">Измените стартовые очки или заблокируйте романтику.</div>
                            <div style="display:flex; gap: 8px; margin-bottom: 8px;"><div style="flex:1;"><span style="font-size: 9px; color:#94a3b8; text-transform:uppercase;">База Доверия:</span><input type="number" class="text_pole bb-edit-base-input" value="${baseAffinity}" style="width:100%; box-sizing:border-box;"></div><div style="flex:1;"><span style="font-size: 9px; color:#f472b6; text-transform:uppercase;">База Романтики:</span><input type="number" class="text_pole bb-edit-romance-input" value="${baseRomance}" style="width:100%; box-sizing:border-box;"></div></div>
                            <label class="checkbox_label" style="margin-bottom: 10px;"><input type="checkbox" class="bb-edit-platonic-cb" ${isPlatonic ? 'checked' : ''}><span style="font-size: 11px; color:#fca5a5;">Строго платонически (Блокирует флирт)</span></label>
                            <div class="bb-editor-actions"><button class="menu_button bb-btn-save-char" data-char="${escapeHtml(charName)}" style="flex:1;"><i class="fa-solid fa-check"></i>&ensp;Сохранить</button><button class="menu_button bb-btn-hide-char" data-char="${escapeHtml(charName)}" style="flex:1; background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.35);"><i class="fa-solid fa-eye-slash"></i>&ensp;Скрыть</button></div>
                        </div>
                    </div>
                `;
            });
            }

            charsBox.innerHTML = `
                <div class="bb-panel-hero bb-panel-hero-route">
                    <div class="bb-panel-kicker">Связи</div><div class="bb-panel-headline">Состояние отношений</div><div class="bb-panel-subtitle">Здесь показаны текущие связи, изменения и важные воспоминания по персонажам.</div>
                    <div class="bb-panel-stat-grid"><div class="bb-panel-stat"><span class="bb-panel-stat-label">Связей</span><strong>${visibleCharacters}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Главный фокус</span><strong>${escapeHtml(topCharacterName || '—')}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Макс. значение</span><strong>${topCharacterName ? (topAffinity > 0 ? '+' : '') + topAffinity : '—'}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Глубоких следов</span><strong>${deepMomentsCount}</strong></div></div>
                </div>
                <div class="bb-route-card-stack">${cardsHtml}</div>
            `;

            jQuery('.bb-char-card').off('click').on('click', function(e) {
                if (jQuery(e.target).closest('.bb-char-edit-btn, .bb-char-editor, .bb-char-body, .bb-btn-crystallize-pos, .bb-btn-crystallize-neg').length) return;
                const card = jQuery(this);
                setCharacterCardExpanded(card, !card.hasClass('expanded'));
            });

            jQuery('.bb-char-edit-btn').off('click').on('click', function(e) {
                e.stopPropagation();
                const card = jQuery(this).closest('.bb-char-card');
                setCharacterEditorOpen(card, !card.hasClass('editor-open'));
            });

            jQuery('.bb-btn-upload-avatar').off('click').on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                jQuery(this).closest('.bb-char-editor').find('.bb-avatar-upload-input').trigger('click');
            });

            jQuery('.bb-btn-clear-avatar').off('click').on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const editor = jQuery(this).closest('.bb-char-editor');
                editor.find('.bb-edit-avatar-source').val('');
                editor.find('.bb-edit-avatar-data').val('');
                queueCharacterEditorAvatarPreview(editor, true);
            });

            jQuery('.bb-avatar-upload-input').off('change').on('change', async function(e) {
                e.stopPropagation();
                const file = this.files?.[0];
                if (!file) return;
                if (!String(file.type || '').startsWith('image/')) {
                    notifyError('Нужен именно файл изображения.');
                    jQuery(this).val('');
                    return;
                }

                const editor = jQuery(this).closest('.bb-char-editor');
                try {
                    const dataUrl = await resizeImageFileToDataUrl(file);
                    editor.find('.bb-edit-avatar-source').val(dataUrl);
                    editor.find('.bb-edit-avatar-data').val('');
                    queueCharacterEditorAvatarPreview(editor, true);
                    notifyInfo('Аватар загружен. При необходимости подстройте кадр перед сохранением.');
                } catch (error) {
                    console.error('[BB VN] Avatar upload failed:', error);
                    notifyError('Не удалось обработать изображение.');
                } finally {
                    jQuery(this).val('');
                }
            });

            jQuery('.bb-avatar-focus-x, .bb-avatar-focus-y, .bb-avatar-focus-zoom')
                .off('input change')
                .on('input change', function(e) {
                    e.stopPropagation();
                    queueCharacterEditorAvatarPreview(jQuery(this).closest('.bb-char-editor'));
                });

            jQuery('.bb-btn-generate-description').off('click').on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const editor = jQuery(this).closest('.bb-char-editor');
                const button = jQuery(this);
                const cancelButton = editor.find('.bb-btn-cancel-description-generation');
                const charName = String(button.attr('data-char') || '').trim();
                const generatedFallback = String(editor.find('.bb-edit-generated-description').val() || '').trim();
                const originalHtml = button.html();
                const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

                setIsVnGenerationCancelled(false);
                editor.data('bbDescriptionGenerationRequestId', requestId);
                editor.data('bbDescriptionGenerationCancelled', false);
                button.attr('data-original-html', originalHtml);
                button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>&ensp;Генерация...');
                cancelButton.prop('disabled', false).show().html('<i class="fa-solid fa-xmark"></i>&ensp;Отмена');
                generateCharacterDescription({
                    charName,
                    stats: currentCalculatedStats[charName] || {},
                    currentDescription: String(editor.find('.bb-edit-description-input').val() || '').trim(),
                }).then((generated) => {
                    if (String(editor.data('bbDescriptionGenerationRequestId') || '') !== requestId) return;
                    if (editor.data('bbDescriptionGenerationCancelled') === true) return;

                    const finalText = String(generated || '').trim() || generatedFallback;
                    if (!finalText) {
                        notifyError('Не удалось собрать описание персонажа.');
                        return;
                    }
                    editor.find('.bb-edit-description-input').val(finalText);
                    notifyInfo('Описание персонажа обновлено. При желании его можно подправить вручную.');
                }).catch((error) => {
                    if (String(editor.data('bbDescriptionGenerationRequestId') || '') !== requestId) return;
                    console.error('[BB VN] Character description generation failed:', error);
                    if (editor.data('bbDescriptionGenerationCancelled') === true || isVnGenerationAbortError(error)) {
                        notifyInfo('Генерация описания отменена.');
                        return;
                    }
                    if (generatedFallback) {
                        editor.find('.bb-edit-description-input').val(generatedFallback);
                        notifyInfo('Модель не ответила, поэтому подставлен локальный шаблон описания.');
                    } else {
                        notifyError('Не удалось сгенерировать описание персонажа.');
                    }
                }).finally(() => {
                    if (String(editor.data('bbDescriptionGenerationRequestId') || '') !== requestId) return;
                    resetDescriptionGenerationUi(editor);
                });
            });

            jQuery('.bb-btn-cancel-description-generation').off('click').on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                const editor = jQuery(this).closest('.bb-char-editor');
                if (!String(editor.data('bbDescriptionGenerationRequestId') || '').trim()) return;

                editor.data('bbDescriptionGenerationCancelled', true);
                editor.find('.bb-btn-generate-description')
                    .prop('disabled', true)
                    .html('<i class="fa-solid fa-spinner fa-spin"></i>&ensp;Останавливаем...');
                jQuery(this)
                    .prop('disabled', true)
                    .html('<i class="fa-solid fa-spinner fa-spin"></i>&ensp;Отмена...');

                cancelVnGeneration();
            });

            jQuery('.bb-btn-clear-description').off('click').on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                jQuery(this).closest('.bb-char-editor').find('.bb-edit-description-input').val('');
            });

            jQuery('.bb-btn-save-char').off('click').on('click', function() {
                bindActivePersonaState();
                const charName = jQuery(this).attr('data-char');
                const editor = jQuery(this).closest('.bb-char-editor');
                const newBase = parseInt(String(editor.find('.bb-edit-base-input').val()), 10);
                const newRomance = parseInt(String(editor.find('.bb-edit-romance-input').val()), 10);
                const isPlatonic = editor.find('.bb-edit-platonic-cb').is(':checked');
                const description = String(editor.find('.bb-edit-description-input').val() || '').trim();
                const avatar = String(editor.find('.bb-edit-avatar-data').val() || '').trim();
                const avatarCrop = {
                    x: parseFloat(String(editor.find('.bb-avatar-focus-x').val() || '50')),
                    y: parseFloat(String(editor.find('.bb-avatar-focus-y').val() || '50')),
                    zoom: parseFloat(String(editor.find('.bb-avatar-focus-zoom').val() || '100')),
                };
                
                if (!isNaN(newBase)) { if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {}; chat_metadata['bb_vn_char_bases'][charName] = newBase; }
                if (!isNaN(newRomance)) { if (!chat_metadata['bb_vn_char_bases_romance']) chat_metadata['bb_vn_char_bases_romance'] = {}; chat_metadata['bb_vn_char_bases_romance'][charName] = newRomance; }
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (isPlatonic) { if (!chat_metadata['bb_vn_platonic_chars'].includes(charName)) chat_metadata['bb_vn_platonic_chars'].push(charName); }
                else { chat_metadata['bb_vn_platonic_chars'] = chat_metadata['bb_vn_platonic_chars'].filter(c => c !== charName); }
                saveChatDebounced(); recalculateAllStats(); notifySuccess("Настройки сохранены!");
            });

            jQuery('.bb-btn-save-char').off('click').on('click', async function() {
                bindActivePersonaState();
                const charName = jQuery(this).attr('data-char');
                const editor = jQuery(this).closest('.bb-char-editor');
                const newBase = parseInt(String(editor.find('.bb-edit-base-input').val()), 10);
                const newRomance = parseInt(String(editor.find('.bb-edit-romance-input').val()), 10);
                const isPlatonic = editor.find('.bb-edit-platonic-cb').is(':checked');
                const description = String(editor.find('.bb-edit-description-input').val() || '').trim();
                const avatarSource = String(editor.find('.bb-edit-avatar-source').val() || editor.find('.bb-edit-avatar-data').val() || '').trim();
                const avatarCrop = {
                    x: parseFloat(String(editor.find('.bb-avatar-focus-x').val() || '50')),
                    y: parseFloat(String(editor.find('.bb-avatar-focus-y').val() || '50')),
                    zoom: parseFloat(String(editor.find('.bb-avatar-focus-zoom').val() || '100')),
                };

                if (!isNaN(newBase)) { if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {}; chat_metadata['bb_vn_char_bases'][charName] = newBase; }
                if (!isNaN(newRomance)) { if (!chat_metadata['bb_vn_char_bases_romance']) chat_metadata['bb_vn_char_bases_romance'] = {}; chat_metadata['bb_vn_char_bases_romance'][charName] = newRomance; }
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (isPlatonic) { if (!chat_metadata['bb_vn_platonic_chars'].includes(charName)) chat_metadata['bb_vn_platonic_chars'].push(charName); }
                else { chat_metadata['bb_vn_platonic_chars'] = chat_metadata['bb_vn_platonic_chars'].filter(c => c !== charName); }
                const finalAvatar = avatarSource
                    ? await createCroppedAvatarDataUrl(avatarSource, avatarCrop, {
                        outputWidth: AVATAR_OUTPUT_WIDTH,
                        outputHeight: AVATAR_OUTPUT_HEIGHT,
                    })
                    : '';
                updateCharacterProfile(charName, {
                    description,
                    avatar: finalAvatar,
                    avatarCrop: finalAvatar ? { x: 50, y: 50, zoom: 100 } : avatarCrop,
                });
                saveChatDebounced();
                recalculateAllStats();
                notifySuccess(finalAvatar ? 'Карточка и аватар персонажа сохранены!' : 'Настройки персонажа сохранены!');
            });

            jQuery('.bb-btn-crystallize-pos, .bb-btn-crystallize-neg').off('click').on('click', async function(e) {
                bindActivePersonaState();
                e.preventDefault(); e.stopPropagation();
                const charName = jQuery(this).attr('data-char');
                const isPositive = jQuery(this).hasClass('bb-btn-crystallize-pos');
                const stats = currentCalculatedStats[charName];
                const targetMemories = stats.memories.deep.filter(m => m.tone === (isPositive ? 'positive' : 'negative'));
                if (targetMemories.length < 5) return;
                const btn = jQuery(this); const originalHtml = btn.html();
                btn.html('<i class="fa-solid fa-spinner fa-spin"></i> Анализ воспоминаний...').css('pointer-events', 'none');
                const userName = SillyTavern.getContext().substituteParams('{{user}}');
                try {
                    const result = normalizeTraitResponse(await crystallizeTraitFromMemories({
                        charName,
                        userName,
                        memories: targetMemories,
                        isPositive,
                    }));
                    if (!result || result.length > 240) throw new Error('INVALID_TRAIT_OUTPUT');
                    const chat = SillyTavern.getContext().chat;
                    const lastMsg = chat[chat.length - 1];
                    const sId = lastMsg.swipe_id || 0;
                    if (!lastMsg.extra) lastMsg.extra = {};
                    if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
                    if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
                    lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName: charName, trait: result, type: isPositive ? 'positive' : 'negative', scope: getCurrentPersonaScopeKey() });
                    saveChatDebounced();
                    recalculateAllStats();
                    showTraitCrystallizedToast({
                        charName,
                        trait: result,
                        isPositive,
                    });
                } catch (e) {
                    console.warn('[BB VN] Trait crystallization failed:', e);
                } finally {
                    btn.html(originalHtml).css('pointer-events', 'auto');
                }
            });

            jQuery('.bb-btn-hide-char').off('click').on('click', async function() {
                bindActivePersonaState();
                const charName = jQuery(this).attr('data-char');
                let confirmed = false;
                setHudPopupPriority(true);
                try {
                    confirmed = await SillyTavern.getContext().callPopup(`<h3>Скрыть персонажа?</h3><p>Персонаж <strong>${charName}</strong> пропадёт из трекера.</p>`, 'confirm');
                } finally {
                    setHudPopupPriority(false);
                }
                if (!confirmed) return;
                if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];
                if (!chat_metadata['bb_vn_ignored_chars'].includes(charName)) chat_metadata['bb_vn_ignored_chars'].push(charName);
                saveChatDebounced(); recalculateAllStats(); notifyInfo(`${charName} скрыт.`);
            });
        }
    }

    const logBox = document.getElementById('bb-hud-log');
    if (logBox) {
        const logs = chat_metadata['bb_vn_global_log'] || [];
        const promptPreviewHtml = `
            <div class="bb-panel-hero bb-panel-hero-system"><div class="bb-panel-kicker">Журнал</div><div class="bb-panel-headline">Системный журнал</div><div class="bb-panel-subtitle">Здесь показаны изменения отношений и текущий инжектируемый prompt.</div>
            <div class="bb-panel-stat-grid"><div class="bb-panel-stat"><span class="bb-panel-stat-label">Событий</span><strong>${logs.length}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Активный тон</span><strong>${escapeHtml(activeChoiceTone)}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Последнее событие</span><strong>${escapeHtml(latestMoment?.title || '—')}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Social HTML</span><strong>${escapeHtml(socialDebugLabel)}</strong></div></div><div class="bb-panel-subtitle" style="margin-top:8px;">${escapeHtml(socialDebugText)}</div></div>
            <details class="bb-prompt-card"><summary class="bb-prompt-summary"><span>🧠 Inject Prompt</span><button type="button" class="menu_button bb-copy-prompt-btn"><i class="fa-solid fa-copy"></i>&nbsp; Копировать</button></summary><div class="bb-prompt-hint">Это текущий инжект, собранный из актуального состояния чата. После нового выбора VN или следующего хода он может измениться.</div><pre class="bb-prompt-pre">${escapeHtml(getCombinedSocial())}</pre></details>
        `;
        if (logs.length === 0) logBox.innerHTML = `${promptPreviewHtml}<div class="bb-empty-hud">Журнал событий пуст.</div>`;
        else {
            let logHtml = '<div class="bb-system-log-list">';
            [...logs].reverse().forEach(log => { logHtml += `<div class="bb-glog-item ${log.type}"><span class="bb-glog-time">[${log.time}]</span><span class="bb-glog-text">${log.text}</span></div>`; });
            logHtml += '</div>'; logBox.innerHTML = promptPreviewHtml + logHtml;
        }
        const copyBtn = logBox.querySelector('.bb-copy-prompt-btn');
        if (copyBtn) copyBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(getCombinedSocial()); notifySuccess("Prompt скопирован!"); } catch (e) { notifyError("Ошибка копирования."); } });
    }

    const momentsBox = document.getElementById('bb-hud-moments');
    if (momentsBox) {
        if (currentStoryMoments.length === 0) momentsBox.innerHTML = `<div class="bb-panel-hero bb-panel-hero-diary"><div class="bb-panel-kicker">Дневник событий</div><div class="bb-panel-headline">Дневник ещё пуст</div><div class="bb-panel-subtitle">Здесь будут сохраняться важные изменения.</div></div><div class="bb-empty-hud">Памятные моменты пока не накопились.</div>`;
        else {
            let momentsHtml = `<div class="bb-panel-hero bb-panel-hero-diary"><div class="bb-panel-kicker">Дневник событий</div><div class="bb-panel-headline">События</div><div class="bb-panel-subtitle">Важные события, зафиксированные по ходу чата.</div><div class="bb-panel-stat-grid"><div class="bb-panel-stat"><span class="bb-panel-stat-label">Записей</span><strong>${currentStoryMoments.length}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Последняя</span><strong>${escapeHtml(currentStoryMoments[currentStoryMoments.length - 1]?.title || '—')}</strong></div></div></div><div class="bb-diary-stack">`;
            [...currentStoryMoments].reverse().forEach((moment, index) => { momentsHtml += `<div class="bb-moment-card ${escapeHtml(moment.type || 'neutral')}"><div class="bb-moment-pin"></div><div class="bb-moment-header"><div class="bb-moment-meta"><span class="bb-moment-stamp">Запись ${currentStoryMoments.length - index}</span><span class="bb-moment-char">${escapeHtml(moment.char || 'Сцена')}</span></div><span class="bb-moment-title">${escapeHtml(moment.title)}</span></div><div class="bb-moment-divider"></div><div class="bb-moment-body"><div class="bb-moment-text">${escapeHtml(moment.text)}</div></div></div>`; });
            momentsHtml += '</div>'; momentsBox.innerHTML = momentsHtml;
        }
    }
    syncToastContainerWithHud();
}

export function updateHudVisibility() {
    const context = SillyTavern.getContext();
    if (!hasContextInitialized(context)) {
        if (!hudVisibilityRetryTimer) {
            hudVisibilityRetryTimer = setTimeout(() => {
                hudVisibilityRetryTimer = null;
                updateHudVisibility();
            }, HUD_VISIBILITY_RETRY_MS);
        }
        return;
    }

    if (hudVisibilityRetryTimer) {
        clearTimeout(hudVisibilityRetryTimer);
        hudVisibilityRetryTimer = null;
    }

    const chatId = context?.chatId;
    const chatLength = Array.isArray(context?.chat) ? context.chat.length : 0;
    const isGroup = typeof context?.is_group === 'boolean'
        ? context.is_group
        : typeof context?.groupId !== 'undefined'
            ? Boolean(context.groupId)
            : undefined;
    const chatType = typeof context?.chat_type === 'string'
        ? context.chat_type
        : isGroup === true
            ? 'group'
            : 'direct';
    const shouldShowHud = hasActiveChatContext(context);

    if (shouldShowHud) { jQuery('#bb-social-hud-toggle, #bb-social-hud-mobile-launcher').show(); } 
    else { jQuery('#bb-social-hud-toggle, #bb-social-hud-mobile-launcher').hide(); closeSocialHud(); }

    if (isDevModeEnabled()) {
        console.debug('[BB VN][debug] HUD visibility updated', {
            action: shouldShowHud ? 'show' : 'hide',
            chatId,
            chatLength,
            isGroup,
            chatType,
        });
    }
    syncToastContainerWithHud();
}

export function openSocialHud() {
    jQuery('#bb-social-hud').addClass('open');
    jQuery('#bb-social-hud-backdrop').addClass('open');
    jQuery('body').addClass('bb-social-hud-active');
    jQuery('#bb-social-toast-container').addClass('hud-open');
    jQuery('#bb-hud-arrow').removeClass('fa-chevron-left').addClass('fa-chevron-right');
    renderSocialHud();
    syncToastContainerWithHud();
}

export function closeSocialHud() {
    jQuery('#bb-social-hud').removeClass('open');
    jQuery('#bb-social-hud-backdrop').removeClass('open');
    jQuery('body').removeClass('bb-social-hud-active');
    jQuery('#bb-social-toast-container').removeClass('hud-open');
    jQuery('#bb-hud-arrow').removeClass('fa-chevron-right').addClass('fa-chevron-left');
    syncToastContainerWithHud();
}

export function ensureHudContainer() {
    if (document.getElementById('bb-social-hud')) return;
    const hudHtml = `
        <button type="button" id="bb-social-hud-backdrop" aria-label="Закрыть HUD"></button>
        <button type="button" id="bb-social-hud-mobile-launcher" aria-label="Открыть HUD"><i class="fa-solid fa-users-viewfinder"></i><span>VNE</span></button>
        <div id="bb-social-hud">
            <div id="bb-social-hud-toggle" title="VNE HUD"><i class="fa-solid fa-users-viewfinder"></i><span class="bb-toggle-label">VNE</span><i class="fa-solid fa-chevron-left" id="bb-hud-arrow"></i></div>
            <div class="bb-hud-header"><div class="bb-hud-header-top"><span class="bb-hud-badge">Visual Novel Engine</span><div class="bb-hud-status-row"><span class="bb-hud-live-dot"><i class="fa-solid fa-circle"></i> активно</span><button type="button" class="bb-hud-mobile-close" aria-label="Закрыть HUD"><i class="fa-solid fa-xmark"></i></button></div></div><div class="bb-hud-title">VNE</div><div class="bb-hud-subtitle">связи · журнал · дневник событий</div></div>
            <div class="bb-hud-tabs"><div class="bb-hud-tab active" data-tab="chars"><i class="fa-solid fa-heart-pulse"></i><span>Связи</span></div><div class="bb-hud-tab" data-tab="log"><i class="fa-solid fa-terminal"></i><span>Система</span></div><div class="bb-hud-tab" data-tab="moments"><i class="fa-solid fa-book-open"></i><span>Дневник</span></div></div>
            <div class="bb-hud-content active" id="bb-hud-chars"></div><div class="bb-hud-content" id="bb-hud-log"></div><div class="bb-hud-content" id="bb-hud-moments"></div>
        </div>
    `;
    jQuery('body').append(hudHtml);

    jQuery('.bb-hud-tab').on('click', function() {
        jQuery('.bb-hud-tab').removeClass('active'); jQuery('.bb-hud-content').removeClass('active');
        jQuery(this).addClass('active'); jQuery(`#bb-hud-${jQuery(this).data('tab')}`).addClass('active');
    });

    jQuery('#bb-social-hud-toggle, #bb-social-hud-mobile-launcher').on('click', () => {
        if (jQuery('#bb-social-hud').hasClass('open')) closeSocialHud(); else openSocialHud();
    });

    jQuery('#bb-social-hud-backdrop, .bb-hud-mobile-close').on('click', closeSocialHud);

    const toggle = document.getElementById('bb-social-hud-toggle');
    let timer = null;
    const scheduleIdle = () => {
        if (!toggle) return; clearTimeout(timer); toggle.classList.remove('bb-toggle-idle');
        if (window.innerWidth <= 760) timer = setTimeout(() => toggle.classList.add('bb-toggle-idle'), 1500);
    };
    scheduleIdle();
    if (toggle) ['pointerdown', 'touchstart', 'mouseenter', 'focus'].forEach(ev => toggle.addEventListener(ev, scheduleIdle));

    window.addEventListener('resize', () => {
        if (window.innerWidth > 760) jQuery('#bb-social-hud-backdrop').removeClass('open');
        syncToastContainerWithHud(); scheduleIdle();
    });
}
