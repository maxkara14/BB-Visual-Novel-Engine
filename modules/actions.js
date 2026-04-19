/* global SillyTavern */
import { callPopup, chat_metadata, saveChatDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import {
    escapeHtml,
    normalizeOptionData,
    getToneClass,
} from './utils.js';
import {
    bbVnGenerateOptionsFlow,
    clearSavedVNOptions,
} from './generator.js';
import { injectCombinedSocialPrompt } from './social.js';
import { notifyInfo } from './toasts.js';
import {
    hasRenderedVnOptions,
    hideVnGenerateButton,
    resetVnOptionsContainer,
    setVnGenerateButtonIdle,
    showVnGenerateButton,
} from './vn-ui.js';

const VN_PANEL_CLOSE_MS = 220;

function buildUtilityRow({ hasOptions = false, hasSavedOptions = false } = {}) {
    const primaryButtonId = hasOptions ? 'bb-vn-btn-reroll' : 'bb-vn-btn-generate-now';
    const primaryButtonTitle = hasOptions ? 'Обычный реролл' : 'Сгенерировать варианты';
    const primaryButtonIcon = hasOptions ? 'fa-rotate-right' : 'fa-clapperboard';
    const primaryButtonLabel = hasOptions ? 'Реролл' : 'Генерация';
    const clearDisabledAttr = hasSavedOptions ? '' : ' disabled';

    return `
        <div class="bb-vn-utility-row">
            <button type="button" class="bb-vn-utility-panel" id="${primaryButtonId}" title="${primaryButtonTitle}">
                <i class="fa-solid ${primaryButtonIcon}"></i>
                <span>${primaryButtonLabel}</span>
            </button>
            <button type="button" class="bb-vn-utility-panel" id="bb-vn-btn-reroll-smart" title="Короткое пожелание к следующим вариантам">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>Запрос</span>
            </button>
            <button type="button" class="bb-vn-utility-panel" id="bb-vn-btn-clear" title="Очистить сохранённые варианты"${clearDisabledAttr}>
                <i class="fa-solid fa-trash-can"></i>
                <span>Сброс</span>
            </button>
            <button type="button" class="bb-vn-utility-panel" id="bb-vn-btn-cancel" title="Свернуть">
                <i class="fa-solid fa-chevron-up"></i>
                <span>Скрыть</span>
            </button>
        </div>
    `;
}

function buildEmptyPanelHtml() {
    return `
        <div class="bb-vn-empty-state">
            <div class="bb-vn-empty-state-title">
                <i class="fa-solid fa-film"></i>
                <span>Панель готова</span>
            </div>
            <div class="bb-vn-empty-state-text">
                Можно сразу запустить первую генерацию или сначала задать пожелание через «Запрос», чтобы получить более точные варианты.
            </div>
        </div>
    `;
}

function stopVnPanelAnimation(container) {
    const scopedContainer = container instanceof jQuery ? container : jQuery(container);
    if (!scopedContainer.length) return;

    const closeTimerId = Number(scopedContainer.data('bbVnCloseTimer') || 0);
    if (closeTimerId) {
        window.clearTimeout(closeTimerId);
        scopedContainer.removeData('bbVnCloseTimer');
    }
}

function openVnPanel(container) {
    const scopedContainer = container instanceof jQuery ? container : jQuery(container);
    if (!scopedContainer.length) return;

    stopVnPanelAnimation(scopedContainer);
    scopedContainer.removeClass('is-closing');
    scopedContainer.addClass('active is-opening');

    window.requestAnimationFrame(() => {
        scopedContainer.removeClass('is-opening');
    });
}

function closeVnPanel(container, onClosed = null) {
    const scopedContainer = container instanceof jQuery ? container : jQuery(container);
    if (!scopedContainer.length) {
        if (typeof onClosed === 'function') onClosed();
        return;
    }

    if (!scopedContainer.hasClass('active')) {
        scopedContainer.removeClass('is-closing is-opening');
        if (typeof onClosed === 'function') onClosed();
        return;
    }

    stopVnPanelAnimation(scopedContainer);
    scopedContainer.removeClass('is-opening').addClass('is-closing');

    const timerId = window.setTimeout(() => {
        scopedContainer.removeData('bbVnCloseTimer');
        scopedContainer.removeClass('active is-closing is-opening');
        if (typeof onClosed === 'function') onClosed();
    }, VN_PANEL_CLOSE_MS);

    scopedContainer.data('bbVnCloseTimer', timerId);
}

function getCurrentRerollState() {
    const cards = jQuery('#bb-vn-options-container .bb-vn-option[data-intent]');
    const intents = cards.map(function() {
        return String(jQuery(this).attr('data-intent') || '').trim();
    }).get().filter(Boolean);
    const tones = cards.map(function() {
        return String(jQuery(this).attr('data-tone') || '').trim();
    }).get().filter(Boolean);

    return {
        intents: [...new Set(intents)],
        tones: [...new Set(tones)],
    };
}

async function requestGuidedGeneration({ hasOptions = false } = {}) {
    const rerollState = hasOptions ? getCurrentRerollState() : { intents: [], tones: [] };
    const popupTitle = hasOptions ? 'Запрос к новым вариантам' : 'Запрос к первой генерации';
    const popupCopy = hasOptions
        ? 'Напиши короткое пожелание к следующим вариантам.<br>Примеры: <code>больше нежности</code>, <code>резче двигай конфликт</code>, <code>меньше повторов по тону</code>, <code>больше инициативы</code>.'
        : 'Напиши короткое пожелание к первой подборке вариантов.<br>Примеры: <code>больше нежности</code>, <code>резче двигай конфликт</code>, <code>меньше повторов по тону</code>, <code>больше инициативы</code>.';

    const guidanceResult = await callPopup(
        `<h3>${popupTitle}</h3><p>${popupCopy}</p>`,
        'input',
        '',
        { okButton: 'Сгенерировать', rows: 3, wide: true },
    );

    if (guidanceResult === false || guidanceResult === null || guidanceResult === undefined) {
        return;
    }

    const guidance = String(guidanceResult || '').trim();
    if (!guidance) {
        notifyInfo(hasOptions
            ? 'Пожелание пустое, запрос к новым вариантам не запущен.'
            : 'Пожелание пустое, запрос к первой генерации не запущен.');
        return;
    }

    await bbVnGenerateOptionsFlow({
        excludedIntents: hasOptions ? rerollState.intents : [],
        excludedTones: hasOptions ? rerollState.tones : [],
        guidance,
        mode: hasOptions ? 'smart-reroll' : 'guided',
    });
}

function bindVnUtilityActions({ hasOptions = false } = {}) {
    const optionsContainer = jQuery('#bb-vn-options-container');

    jQuery('#bb-vn-btn-cancel').off('click').on('click', () => {
        closeVnPanel(optionsContainer, () => {
            showVnGenerateButton();
            setVnGenerateButtonIdle({ hasSaved: hasRenderedVnOptions() });
        });
    });

    jQuery('#bb-vn-btn-generate-now').off('click').on('click', async () => {
        await bbVnGenerateOptionsFlow();
    });

    jQuery('#bb-vn-btn-reroll').off('click').on('click', async () => {
        const rerollState = getCurrentRerollState();
        await bbVnGenerateOptionsFlow({
            excludedIntents: rerollState.intents,
            excludedTones: rerollState.tones,
            mode: 'reroll',
        });
    });

    jQuery('#bb-vn-btn-reroll-smart').off('click').on('click', async () => {
        await requestGuidedGeneration({ hasOptions });
    });

    jQuery('#bb-vn-btn-clear').off('click').on('click', () => {
        clearSavedVNOptions();
    });
}

export function renderVnActionPanel(autoOpen = true) {
    const optionsContainer = resetVnOptionsContainer();
    optionsContainer.html(`${buildEmptyPanelHtml()}${buildUtilityRow({ hasOptions: false, hasSavedOptions: false })}`);
    bindVnUtilityActions({ hasOptions: false });

    if (autoOpen) {
        setVnGenerateButtonIdle({ hasSaved: false });
        openVnPanel(optionsContainer);
        hideVnGenerateButton();
    } else {
        setVnGenerateButtonIdle({ hasSaved: false });
        showVnGenerateButton();
    }
}

export function renderVNOptionsFromData(parsedOptions, autoOpen = false) {
    let optionsHtml = '';
    const useEmotionalChoiceFraming = !!extension_settings[MODULE_NAME].emotionalChoiceFraming;

    parsedOptions.forEach(rawOption => {
        const opt = normalizeOptionData(rawOption);
        let riskClass = 'risk-med';
        const riskValue = (opt.risk || '').toLowerCase();
        if (riskValue.includes('низкий') || riskValue.includes('low')) riskClass = 'risk-low';
        if (riskValue.includes('высокий') || riskValue.includes('high')) riskClass = 'risk-high';
        const toneClass = getToneClass(opt.tone);
        const metaLabel = useEmotionalChoiceFraming
            ? (opt.tone || opt.risk || 'Нейтрально')
            : (opt.risk || opt.tone || 'Средний');
        const targetsText = opt.targets.length > 0
            ? opt.targets.map(target => `<span class="bb-vn-target">${escapeHtml(target)}</span>`).join('')
            : '<span class="bb-vn-target muted">Сцена в целом</span>';

        const forecastHtml = useEmotionalChoiceFraming && opt.forecast
            ? `<div class="bb-vn-forecast-hover" title="${escapeHtml(opt.forecast)}"><div class="bb-vn-forecast-title">Прогноз</div><div class="bb-vn-forecast-text">${escapeHtml(opt.forecast)}</div></div>`
            : '';

        optionsHtml += `
            <div class="bb-vn-option ${riskClass} ${toneClass}" data-intent="${escapeHtml(opt.intent)}" data-message="${encodeURIComponent(opt.message || '')}" data-tone="${escapeHtml(opt.tone || '')}" data-forecast="${escapeHtml(opt.forecast || '')}" data-targets="${encodeURIComponent(JSON.stringify(opt.targets || []))}">
                <div class="bb-vn-op-topline">
                    <div class="bb-vn-op-badges">
                        <span class="bb-vn-op-index">Сцена</span>
                        <div class="bb-vn-op-risk">${useEmotionalChoiceFraming ? 'Тон' : 'Риск'}: ${escapeHtml(metaLabel)}</div>
                    </div>
                    <div class="bb-vn-op-info-btn" title="${escapeHtml(opt.forecast || 'Подробнее')}"><i class="fa-solid fa-info"></i></div>
                </div>
                <div class="bb-vn-op-head" title="${escapeHtml(opt.intent)}">${escapeHtml(opt.intent)}</div>
                ${useEmotionalChoiceFraming ? `<div class="bb-vn-targets">${targetsText}</div>` : ''}
                ${forecastHtml}
            </div>
        `;
    });

    optionsHtml += buildUtilityRow({ hasOptions: true, hasSavedOptions: true });

    const optionsContainer = resetVnOptionsContainer();
    stopVnPanelAnimation(optionsContainer);
    optionsContainer.html(optionsHtml);

    if (autoOpen) {
        setVnGenerateButtonIdle({ hasSaved: true });
        openVnPanel(optionsContainer);
        hideVnGenerateButton();
    } else {
        setVnGenerateButtonIdle({ hasSaved: true });
        showVnGenerateButton();
    }

    jQuery('.bb-vn-option[data-intent]').off('click').on('click', function(e) {
        if (jQuery(e.target).closest('.bb-vn-op-info-btn').length > 0) return;
        const message = decodeURIComponent(jQuery(this).attr('data-message') || '');
        const targetsRaw = decodeURIComponent(jQuery(this).attr('data-targets') || '[]');
        let parsedTargets = [];
        try {
            parsedTargets = JSON.parse(targetsRaw);
        } catch (err) {
            void err;
        }
        const choiceContext = {
            intent: jQuery(this).attr('data-intent') || '',
            tone: jQuery(this).attr('data-tone') || '',
            forecast: jQuery(this).attr('data-forecast') || '',
            targets: Array.isArray(parsedTargets) ? parsedTargets : [],
            at: Date.now(),
            messagePreview: message.slice(0, 140),
        };
        chat_metadata['bb_vn_choice_context'] = choiceContext;
        chat_metadata['bb_vn_pending_choice_context'] = choiceContext;
        saveChatDebounced();
        injectCombinedSocialPrompt();

        const textarea = document.querySelector('#send_textarea');
        if (textarea instanceof HTMLTextAreaElement && message) {
            textarea.value = message;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            if (extension_settings[MODULE_NAME].autoSend) {
                closeVnPanel(optionsContainer, () => {
                    showVnGenerateButton();
                    setVnGenerateButtonIdle({ hasSaved: true });
                });
                document.getElementById('send_but')?.click();
            }
        }
    });

    jQuery('.bb-vn-op-info-btn').off('click').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const card = jQuery(this).closest('.bb-vn-option');
        const wasExpanded = card.hasClass('info-expanded');
        jQuery('.bb-vn-option').removeClass('info-expanded');
        if (!wasExpanded) card.addClass('info-expanded');
    });

    bindVnUtilityActions({ hasOptions: true });
}

window['renderVNOptionsFromData'] = renderVNOptionsFromData;

export function injectVNActionsUI() {
    if (document.getElementById('bb-vn-action-bar')) return;
    const barHtml = '<div id="bb-vn-action-bar" style="display: flex;"><div id="bb-vn-btn-generate" class="bb-vn-main-btn" title="Открыть панель действий VN"></div><div id="bb-vn-options-container"></div></div>';
    jQuery('#send_form').prepend(barHtml);
    setVnGenerateButtonIdle();

    const ta = document.querySelector('#send_textarea');
    if (ta instanceof HTMLTextAreaElement) {
        ta.addEventListener('input', () => {
            const btn = document.getElementById('bb-vn-btn-generate');
            const opts = document.getElementById('bb-vn-options-container');
            if (ta.value.trim().length > 0) {
                if (btn) btn.style.display = 'none';
            } else if (opts && !opts.classList.contains('active')) {
                if (btn) btn.style.display = 'block';
            }
        });
    }

    jQuery('#bb-vn-btn-generate').on('click', function() {
        const container = jQuery('#bb-vn-options-container');
        if (container.children('.bb-vn-option[data-intent]').length > 0) {
            openVnPanel(container);
            hideVnGenerateButton();
        } else {
            renderVnActionPanel(true);
        }
    });
}
