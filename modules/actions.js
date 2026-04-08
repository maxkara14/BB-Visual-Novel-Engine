/* global SillyTavern */
import { chat_metadata, saveChatDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { 
    escapeHtml, 
    normalizeOptionData, 
    getToneClass 
} from './utils.js';
import { 
    bbVnGenerateOptionsFlow,
    clearSavedVNOptions
} from './generator.js';
import { injectCombinedSocialPrompt } from './social.js';

export function renderVNOptionsFromData(parsedOptions, autoOpen = false) {
    let optionsHtml = '';
    const useEmotionalChoiceFraming = !!extension_settings[MODULE_NAME].emotionalChoiceFraming;
    parsedOptions.forEach(rawOption => {
        const opt = normalizeOptionData(rawOption);
        let riskClass = 'risk-med';
        const r = (opt.risk || '').toLowerCase();
        if (r.includes('низкий') || r.includes('low')) riskClass = 'risk-low';
        if (r.includes('высокий') || r.includes('high')) riskClass = 'risk-high';
        const toneClass = getToneClass(opt.tone);
        const metaLabel = useEmotionalChoiceFraming ? (opt.tone || opt.risk || 'Нейтрально') : (opt.risk || opt.tone || 'Средний');
        const targetsText = opt.targets.length > 0
            ? opt.targets.map(target => `<span class="bb-vn-target">${escapeHtml(target)}</span>`).join('')
            : `<span class="bb-vn-target muted">Сцена в целом</span>`;
        
        const forecastHtml = useEmotionalChoiceFraming && opt.forecast
            ? `<div class="bb-vn-forecast-hover"><div class="bb-vn-forecast-title">Прогноз</div><div class="bb-vn-forecast-text">${escapeHtml(opt.forecast)}</div></div>`
            : '';

        optionsHtml += `
            <div class="bb-vn-option ${riskClass} ${toneClass}" data-intent="${escapeHtml(opt.intent)}" data-message="${encodeURIComponent(opt.message || '')}" data-tone="${escapeHtml(opt.tone || '')}" data-forecast="${escapeHtml(opt.forecast || '')}" data-targets="${encodeURIComponent(JSON.stringify(opt.targets ||[]))}">
                <div class="bb-vn-op-topline"><span class="bb-vn-op-index">Сцена</span><div class="bb-vn-op-risk">${useEmotionalChoiceFraming ? 'Тон' : 'Риск'}: ${escapeHtml(metaLabel)}</div><div class="bb-vn-op-info-btn" title="Подробнее"><i class="fa-solid fa-info"></i></div></div>
                <div class="bb-vn-op-head">${escapeHtml(opt.intent)}</div>
                ${useEmotionalChoiceFraming ? `<div class="bb-vn-targets">${targetsText}</div>` : ''}
                ${forecastHtml}
            </div>
        `;
    });
    
    optionsHtml += `
        <div class="bb-vn-utility-row">
            <div class="bb-vn-option risk-med bb-vn-utility-card bb-vn-utility-compact" id="bb-vn-btn-reroll" title="Реролл"><i class="fa-solid fa-rotate-right"></i></div>
            <div class="bb-vn-option risk-med bb-vn-utility-card bb-vn-utility-compact" id="bb-vn-btn-clear" title="Очистить сохранённые варианты"><i class="fa-solid fa-trash-can"></i></div>
            <div class="bb-vn-option risk-med bb-vn-utility-card bb-vn-utility-compact" id="bb-vn-btn-cancel" title="Свернуть"><i class="fa-solid fa-chevron-up"></i></div>
        </div>
    `;

    jQuery('#bb-vn-options-container').html(optionsHtml);

    if (autoOpen) {
        jQuery('#bb-vn-options-container').addClass('active');
        jQuery('#bb-vn-btn-generate').removeClass('loading').hide();
    } else {
        jQuery('#bb-vn-options-container').removeClass('active');
        jQuery('#bb-vn-btn-generate').removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> VN · сохранено').show();
    }

    jQuery('.bb-vn-option[data-intent]').off('click').on('click', function(e) {
        if (jQuery(e.target).closest('.bb-vn-op-info-btn').length > 0) return;
        const message = decodeURIComponent(jQuery(this).attr('data-message') || '');
        const targetsRaw = decodeURIComponent(jQuery(this).attr('data-targets') || '[]');
        let parsedTargets = []; try { parsedTargets = JSON.parse(targetsRaw); } catch (err) {}
        const choiceContext = {
            intent: jQuery(this).attr('data-intent') || '',
            tone: jQuery(this).attr('data-tone') || '',
            forecast: jQuery(this).attr('data-forecast') || '',
            targets: Array.isArray(parsedTargets) ? parsedTargets :[],
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
                jQuery('#bb-vn-options-container').removeClass('active');
                jQuery('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия VN');
                document.getElementById('send_but')?.click();
            }
        }
    });

    jQuery('.bb-vn-op-info-btn').off('click').on('click', function(e) {
        e.preventDefault(); e.stopPropagation();
        const card = jQuery(this).closest('.bb-vn-option');
        const wasExpanded = card.hasClass('info-expanded');
        jQuery('.bb-vn-option').removeClass('info-expanded');
        if (!wasExpanded) card.addClass('info-expanded');
    });

    jQuery('#bb-vn-btn-cancel').off('click').on('click', () => {
        jQuery('#bb-vn-options-container').removeClass('active');
        jQuery('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия VN');
    });

    jQuery('#bb-vn-btn-reroll').off('click').on('click', async () => {
        const prev = jQuery('#bb-vn-options-container .bb-vn-option[data-intent]').map(function() { return jQuery(this).attr('data-intent'); }).get().filter(Boolean);
        await bbVnGenerateOptionsFlow(prev);
    });

    jQuery('#bb-vn-btn-clear').off('click').on('click', () => {
        clearSavedVNOptions();
    });
}

window['renderVNOptionsFromData'] = renderVNOptionsFromData;

export function injectVNActionsUI() {
    if (document.getElementById('bb-vn-action-bar')) return;
    const barHtml = `<div id="bb-vn-action-bar" style="display: flex;"><div id="bb-vn-btn-generate" class="bb-vn-main-btn"><i class="fa-solid fa-clapperboard"></i> Действия VN</div><div id="bb-vn-options-container"></div></div>`;
    jQuery('#send_form').prepend(barHtml);

    const ta = document.querySelector('#send_textarea');
    if (ta instanceof HTMLTextAreaElement) {
        ta.addEventListener('input', () => {
            const btn = document.getElementById('bb-vn-btn-generate'), opts = document.getElementById('bb-vn-options-container');
            if (ta.value.trim().length > 0) { if(btn) btn.style.display = 'none'; } 
            else if (opts && !opts.classList.contains('active')) { if(btn) btn.style.display = 'block'; }
        });
    }

    jQuery('#bb-vn-btn-generate').on('click', async function() {
        const container = jQuery('#bb-vn-options-container');
        if (container.children('.bb-vn-option[data-intent]').length > 0) {
            container.addClass('active'); jQuery(this).hide();
        } else { await bbVnGenerateOptionsFlow(); }
    });
}
