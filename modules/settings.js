 /* global SillyTavern */
import { chat_metadata, saveChatDebounced, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { recalculateAllStats, injectCombinedSocialPrompt, addGlobalLog, bindActivePersonaState, getCurrentPersonaScopeKey, mergeCharacterRecords, resolveCharacterIdentity, exportActivePersonaSnapshot, importActivePersonaSnapshot, clearActivePersonaSnapshot } from './social.js';
import { notifySuccess, notifyInfo, notifyError, showHudToast } from './toasts.js';
import { restoreVNOptions, clearSavedVNOptions } from './generator.js';

function renderMergeSuggestionsList() {
    bindActivePersonaState();
    const container = jQuery('#bb-dbg-merge-suggestions');
    if (container.length === 0) return;

    const suggestions = Array.isArray(chat_metadata['bb_vn_merge_suggestions'])
        ? [...chat_metadata['bb_vn_merge_suggestions']].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6)
        : [];

    if (suggestions.length === 0) {
        container.html('<div style="font-size: 11px; color: #64748b;">Пока подозрительных дублей не найдено.</div>');
        return;
    }

    container.html(suggestions.map(item => {
        const score = Math.round(Number(item.score || 0) * 100);
        return `<button type="button" class="menu_button bb-dbg-merge-suggestion" data-from="${String(item.source || '').replace(/"/g, '&quot;')}" data-to="${String(item.target || '').replace(/"/g, '&quot;')}" style="text-align:left; width:100%; margin-top:6px; border-color: rgba(192, 132, 252, 0.22); color: #ddd6fe;">
            <span style="display:block; font-size:11px; color:#c4b5fd;">Кандидат на объединение · ${score}%</span>
            <strong style="display:block; color:#f8fafc;">${item.source}</strong>
            <span style="display:block; font-size:12px; color:#94a3b8;">→ ${item.target}</span>
        </button>`;
    }).join(''));

    jQuery('.bb-dbg-merge-suggestion').off('click').on('click', function() {
        jQuery('#bb-dbg-merge-from').val(jQuery(this).attr('data-from') || '');
        jQuery('#bb-dbg-merge-to').val(jQuery(this).attr('data-to') || '');
        notifyInfo('Кандидат на объединение подставлен в поля слияния.');
    });
}

window['bbRenderMergeSuggestionsList'] = renderMergeSuggestionsList;

function makeSnapshotFilename() {
    const scopeKey = getCurrentPersonaScopeKey().replace(/[^\w-]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `bb-vne-snapshot-${scopeKey}-${stamp}.json`;
}

function downloadSnapshotFile(snapshot) {
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = makeSnapshotFilename();
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function injectDebugData(impact, isRomance = false) {
    bindActivePersonaState();
    const charName = String(jQuery('#bb-debug-char-name').val()).trim();
    if(!charName) return notifyError("Укажите имя!");
    const chat = SillyTavern.getContext().chat;
    if (!chat?.length) return;
    const lastMsg = chat[chat.length - 1];
    if (!lastMsg.extra) lastMsg.extra = {};
    if (!lastMsg.extra.bb_social_swipes) lastMsg.extra.bb_social_swipes = {};
    const sId = lastMsg.swipe_id || 0;
    if (!lastMsg.extra.bb_social_swipes[sId]) lastMsg.extra.bb_social_swipes[sId] = [];
    lastMsg.extra.bb_social_swipes[sId].push({ name: charName, friendship_impact: isRomance ? "none" : impact, romance_impact: isRomance ? impact : "none", role_dynamic: "Дебаг", reason: jQuery('#bb-debug-reason').val(), emotion: "тест", scope: getCurrentPersonaScopeKey() });
    saveChatDebounced(); recalculateAllStats(false); notifySuccess("Данные внедрены.");
}

export function injectMixedDeepDebugData() {
    bindActivePersonaState();
    const charName = String(jQuery('#bb-debug-char-name').val()).trim();
    if(!charName) return notifyError("Укажите имя!");
    const chat = SillyTavern.getContext().chat;
    if (!chat?.length) return;
    const lastMsg = chat[chat.length - 1];
    if (!lastMsg.extra) lastMsg.extra = {};
    if (!lastMsg.extra.bb_social_swipes) lastMsg.extra.bb_social_swipes = {};
    const sId = lastMsg.swipe_id || 0;
    if (!lastMsg.extra.bb_social_swipes[sId]) lastMsg.extra.bb_social_swipes[sId] = [];
    const customReason = String(jQuery('#bb-debug-reason').val() || '').trim();
    lastMsg.extra.bb_social_swipes[sId].push({
        name: charName,
        friendship_impact: "unforgivable",
        romance_impact: "life_changing",
        role_dynamic: "",
        reason: customReason || "Тянет вопреки опасности",
        emotion: "опасное влечение",
        scope: getCurrentPersonaScopeKey(),
    });
    saveChatDebounced();
    recalculateAllStats(false);
    notifySuccess("Смешанное незабываемое событие внедрено.");
}

export function wipeGlobalLog() {
    const { scopeState } = bindActivePersonaState();
    const chat = SillyTavern.getContext().chat || [];
    scopeState.global_log = [];
    chat_metadata['bb_vn_global_log'] = scopeState.global_log;
    chat_metadata['bb_vn_log_cutoff_index'] = chat.length;
    saveChatDebounced();
    recalculateAllStats();
    notifySuccess("Журнал событий очищен!");
}

export function wipeAllSocialData() {
    const scopeKey = getCurrentPersonaScopeKey();
    const { scopeState } = bindActivePersonaState();
    const chat = SillyTavern.getContext().chat;
    if (!chat) return;
    chat.forEach(msg => {
        if (msg.extra && msg.extra.bb_social_swipes) {
            for (const sId in msg.extra.bb_social_swipes) {
                if (!Array.isArray(msg.extra.bb_social_swipes[sId])) continue;
                msg.extra.bb_social_swipes[sId] = msg.extra.bb_social_swipes[sId].filter(update => update?.scope && update.scope !== scopeKey);
            }
        }
        if (msg.extra && msg.extra.bb_vn_options_swipes) delete msg.extra.bb_vn_options_swipes;
        if (msg.extra && msg.extra.bb_vn_char_traits_swipes) {
            for (const sId in msg.extra.bb_vn_char_traits_swipes) {
                if (!Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) continue;
                msg.extra.bb_vn_char_traits_swipes[sId] = msg.extra.bb_vn_char_traits_swipes[sId].filter(trait => trait?.scope && trait.scope !== scopeKey);
            }
        }
    });
    scopeState.global_log = [];
    scopeState.char_bases = {};
    scopeState.ignored_chars = [];
    scopeState.char_bases_romance = {};
    scopeState.platonic_chars = [];
    scopeState.char_registry = {};
    scopeState.merge_suggestions = [];
    scopeState.log_cutoff_index = 0;
    scopeState.snapshot_baseline = null;
    scopeState.snapshot_cutoff_index = 0;
    scopeState.snapshot_restore_state = null;
    chat_metadata['bb_vn_global_log'] = scopeState.global_log;
    chat_metadata['bb_vn_char_bases'] = scopeState.char_bases;
    chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars;
    chat_metadata['bb_vn_char_bases_romance'] = scopeState.char_bases_romance;
    chat_metadata['bb_vn_platonic_chars'] = scopeState.platonic_chars;
    chat_metadata['bb_vn_char_registry'] = scopeState.char_registry;
    chat_metadata['bb_vn_merge_suggestions'] = scopeState.merge_suggestions;
    delete chat_metadata['bb_vn_log_cutoff_index'];
    delete chat_metadata['bb_vn_char_traits'];
    delete chat_metadata['bb_vn_choice_context'];
    delete chat_metadata['bb_vn_pending_choice_context'];
    delete chat_metadata['bb_vn_last_used_choice_context'];
    addGlobalLog('system', 'Все отношения сброшены до нуля.');
    saveChatDebounced();
    recalculateAllStats();
    notifySuccess("История отношений в этом чате полностью сброшена!");
}

export function setupExtensionSettings() {
    bindActivePersonaState();
    if (document.getElementById('bb-social-settings-wrapper')) return;
    
    const s = extension_settings[MODULE_NAME];
    const settingsHtml = `
        <div id="bb-social-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>💖 BB Visual Novel Engine</b><div class="inline-drawer-icon fa-solid fa-chevron-down down"></div></div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">Настройки Интерактивного Кино:</span>
                <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
                    <label class="checkbox_label"><input type="checkbox" id="bb-vn-cfg-autosend" ${s.autoSend ? 'checked' : ''}><span>Авто-отправка при выборе</span></label>
                    <label class="checkbox_label"><input type="checkbox" id="bb-vn-cfg-autogen" ${s.autoGen ? 'checked' : ''}><span>Авто-показ вариантов действий</span></label>
                    <label class="checkbox_label"><input type="checkbox" id="bb-vn-cfg-emotional-choice" ${s.emotionalChoiceFraming ? 'checked' : ''}><span>Emotional Choice Framing</span></label>
                </div>
                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">⚡ Custom API:</span>
                <label class="checkbox_label" style="margin-top: 5px;"><input type="checkbox" id="bb-vn-cfg-usecustom" ${s.useCustomApi ? 'checked' : ''}><span>Использовать свой API-ключ</span></label>
                <div id="bb-vn-custom-api-block" style="display: ${s.useCustomApi ? 'flex' : 'none'}; flex-direction: column; gap: 8px; margin-top: 8px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px;">
                    <input type="text" id="bb-vn-cfg-url" class="text_pole" placeholder="URL" value="${s.customApiUrl || ''}">
                    <input type="password" id="bb-vn-cfg-key" class="text_pole" placeholder="API Ключ" value="${s.customApiKey || ''}">
                    <button id="bb-vn-btn-connect" class="menu_button"><i class="fa-solid fa-plug"></i>&nbsp; Подключиться</button>
                    <select id="bb-vn-cfg-model" class="text_pole" ${!s.customApiModel ? 'disabled' : ''}><option value="${s.customApiModel || ''}">${s.customApiModel || 'Модели не загружены'}</option></select>
                </div>
                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                <label class="checkbox_label"><input type="checkbox" id="bb-vn-cfg-usemacro" ${s.useMacro ? 'checked' : ''}><span>Использовать макрос {{bb_vn}}</span></label>
                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                
                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header" onclick="$(this).parent().toggleClass('open'); $(this).find('.fa-chevron-down').toggleClass('up down');">
                        <b>🛠️ Консоль Разработчика</b>
                        <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content" style="padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; margin-top: 8px; display: none; flex-direction: column; gap: 8px;">
                        <input type="text" id="bb-debug-char-name" class="text_pole" placeholder="Имя персонажа">
                        <input type="text" id="bb-debug-reason" class="text_pole" placeholder="Текст причины" value="Дебаг-действие">
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                            <button id="bb-dbg-add-pts" class="menu_button">➕ Дружба</button>
                            <button id="bb-dbg-sub-pts" class="menu_button">➖ Дружба</button>
                            <button id="bb-dbg-add-romance" class="menu_button" style="color:#f472b6; border-color:rgba(244,114,182,0.3);">💖 Романтика</button>
                            <button id="bb-dbg-sub-romance" class="menu_button" style="color:#e11d48; border-color:rgba(225,29,72,0.3);">💔 Романтика</button>
                            <button id="bb-dbg-add-deep-pos" class="menu_button" style="color:#86efac; border-color:rgba(74,222,128,0.3);">🟢 Глубокий светлый</button>
                            <button id="bb-dbg-add-deep-neg" class="menu_button" style="color:#fca5a5; border-color:rgba(251,113,133,0.3);">🔴 Глубокий мрачный</button>
                            <button id="bb-dbg-add-deep-mixed" class="menu_button" style="grid-column:1 / -1; color:#f9a8d4; border-color:rgba(244,114,182,0.28);">🌓 Смешанное +20/-20</button>
                            <button id="bb-dbg-add-trait-pos" class="menu_button" style="color:#86efac; border-color:rgba(74,222,128,0.3);">💎 Светлая черта</button>
                            <button id="bb-dbg-add-trait-neg" class="menu_button" style="color:#fca5a5; border-color:rgba(251,113,133,0.3);">💎 Мрачная черта</button>
                        </div>
                        <button id="bb-dbg-set-status" class="menu_button" style="color:#93c5fd; border-color:rgba(147,197,253,0.3);">🔄 Изменить статус к вам</button>
                        <hr style="border-color: rgba(255,255,255,0.05); margin: 4px 0;">
                        <span style="font-size: 11px; color: #cbd5e1; font-weight:bold;">🧬 Слияние дубликатов:</span>
                        <div style="display: flex; gap: 6px;"><input type="text" id="bb-dbg-merge-from" class="text_pole" placeholder="Кого" style="flex:1;"><input type="text" id="bb-dbg-merge-to" class="text_pole" placeholder="В кого" style="flex:1;"></div>
                        <button id="bb-dbg-btn-merge" class="menu_button" style="color:#c084fc; border-color:rgba(192, 132, 252, 0.3);"><i class="fa-solid fa-code-merge"></i>&ensp; Слить в одного</button>
                        <div id="bb-dbg-merge-suggestions" style="display:flex; flex-direction:column; gap: 0; margin-top: 4px;"></div>
                        <hr style="border-color: rgba(255,255,255,0.05); margin: 4px 0;">
                        <button id="bb-dbg-reset-char" class="menu_button" style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;">💀 Полностью обнулить персонажа</button>
                        <button id="bb-dbg-toast" class="menu_button"><i class="fa-solid fa-bell"></i>&ensp; Рандомное уведомление</button>
                    </div>
                </div>

                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                <div style="display:flex; flex-direction:column; gap: 6px; margin-bottom: 10px; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.18); border: 1px solid rgba(255,255,255,0.05);">
                    <span style="font-size: 12px; color: #cbd5e1; font-weight:bold;">Снимок базы связей</span>
                    <span style="font-size: 11px; color: #94a3b8; line-height: 1.45;">Экспорт сохраняет текущие связи, воспоминания, черты, журнал и дневник. Импорт подключает этот снимок как базу текущей персоны и продолжает считать только новые события.</span>
                    <input type="file" id="bb-social-snapshot-file" accept=".json,application/json" style="display:none;">
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 6px;">
                        <button id="bb-social-export-btn" class="menu_button"><i class="fa-solid fa-file-export"></i>&ensp; Экспорт</button>
                        <button id="bb-social-import-btn" class="menu_button"><i class="fa-solid fa-file-import"></i>&ensp; Импорт</button>
                    </div>
                    <button id="bb-social-clear-snapshot-btn" class="menu_button" style="width:100%; color:#fda4af; border-color:rgba(244,114,182,0.22);">Очистить snapshot-базу</button>
                </div>
                <button id="bb-social-restore-chars-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;">Вернуть скрытых персонажей</button>
                <button id="bb-social-clear-log-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;">Очистить журнал</button>
                <button id="bb-social-wipe-btn" class="menu_button" style="width: 100%; background: rgba(239, 68, 68, 0.2); color: #ef4444;">Сбросить историю</button>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.insertAdjacentHTML('beforeend', settingsHtml);

    const applyModelOptions = (models = [], preferredModel = '') => {
        const select = jQuery('#bb-vn-cfg-model').empty();
        const safeModels = Array.isArray(models)
            ? models.map(m => String(m || '').trim()).filter(Boolean)
            : [];

        if (safeModels.length === 0) {
            select.append('<option value="">Модели не загружены</option>');
            select.prop('disabled', true);
            extension_settings[MODULE_NAME].customApiModel = '';
            return;
        }

        safeModels.forEach(modelId => {
            select.append(`<option value="${modelId}">${modelId}</option>`);
        });

        const initialModel = safeModels.includes(preferredModel)
            ? preferredModel
            : (extension_settings[MODULE_NAME].customApiModel && safeModels.includes(extension_settings[MODULE_NAME].customApiModel)
                ? extension_settings[MODULE_NAME].customApiModel
                : safeModels[0]);

        select.val(initialModel);
        select.prop('disabled', false);
        extension_settings[MODULE_NAME].customApiModel = initialModel;
    };

    jQuery('#bb-vn-cfg-autosend').on('change', function() { extension_settings[MODULE_NAME].autoSend = jQuery(this).is(':checked'); saveSettingsDebounced(); });
    jQuery('#bb-vn-cfg-autogen').on('change', function() { extension_settings[MODULE_NAME].autoGen = jQuery(this).is(':checked'); saveSettingsDebounced(); });
    jQuery('#bb-vn-cfg-emotional-choice').on('change', function() {
        extension_settings[MODULE_NAME].emotionalChoiceFraming = jQuery(this).is(':checked');
        saveSettingsDebounced();
        clearSavedVNOptions();
        restoreVNOptions(false);
        injectCombinedSocialPrompt();
    });
    jQuery('#bb-vn-cfg-usecustom').on('change', function() { 
        const isChecked = jQuery(this).is(':checked'); extension_settings[MODULE_NAME].useCustomApi = isChecked;
        if (isChecked) jQuery('#bb-vn-custom-api-block').slideDown(200); else jQuery('#bb-vn-custom-api-block').slideUp(200);
        saveSettingsDebounced(); 
    });
    jQuery('#bb-vn-cfg-url, #bb-vn-cfg-key').on('change input', () => { extension_settings[MODULE_NAME].customApiUrl = jQuery('#bb-vn-cfg-url').val(); extension_settings[MODULE_NAME].customApiKey = jQuery('#bb-vn-cfg-key').val(); saveSettingsDebounced(); });
    jQuery(document).on('change', '#bb-vn-cfg-model', function() { extension_settings[MODULE_NAME].customApiModel = jQuery(this).val(); saveSettingsDebounced(); });
    jQuery('#bb-vn-cfg-usemacro').on('change', function() { extension_settings[MODULE_NAME].useMacro = jQuery(this).is(':checked'); saveSettingsDebounced(); injectCombinedSocialPrompt(); });

    jQuery('#bb-vn-btn-connect').on('click', async function() {
        const btn = jQuery(this); btn.html('...');
        try {
            const rawUrl = String(jQuery('#bb-vn-cfg-url').val() || '').trim();
            const rawKey = String(jQuery('#bb-vn-cfg-key').val() || '').trim();
            if (!rawUrl) throw new Error('URL пустой');

            extension_settings[MODULE_NAME].customApiUrl = rawUrl;
            extension_settings[MODULE_NAME].customApiKey = rawKey;

            // @ts-ignore
            const response = await fetch(rawUrl.replace(/\/$/, '') + '/models', { headers: { 'Authorization': `Bearer ${rawKey}` } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data?.data) {
                const modelIds = data.data.map(m => m?.id).filter(Boolean);
                applyModelOptions(modelIds, extension_settings[MODULE_NAME].customApiModel || '');
                extension_settings[MODULE_NAME].useCustomApi = true;
                jQuery('#bb-vn-cfg-usecustom').prop('checked', true);
                saveSettingsDebounced();
                notifySuccess("Модели загружены!");
            } else {
                throw new Error('Список моделей пустой');
            }
        } catch (e) {
            console.error('[BB VN] Ошибка подключения custom API:', e);
            notifyError("Ошибка подключения или пустой список моделей.");
        } finally { btn.html('Подключиться'); }
    });

    jQuery('#bb-dbg-add-pts').on('click', () => injectDebugData('major_positive'));
    jQuery('#bb-dbg-sub-pts').on('click', () => injectDebugData('major_negative'));
    jQuery('#bb-dbg-add-romance').on('click', () => injectDebugData('major_positive', true));
    jQuery('#bb-dbg-sub-romance').on('click', () => injectDebugData('major_negative', true));
    jQuery('#bb-dbg-add-deep-pos').on('click', () => injectDebugData('life_changing', false));
    jQuery('#bb-dbg-add-deep-neg').on('click', () => injectDebugData('unforgivable', false));
    jQuery('#bb-dbg-add-deep-mixed').on('click', () => injectMixedDeepDebugData());

    jQuery('#bb-dbg-add-trait-pos').on('click', function() {
        const charName = String(jQuery('#bb-debug-char-name').val()).trim();
        const trait = String(jQuery('#bb-debug-reason').val()).trim();
        if(!charName || !trait) return notifyError("Укажите имя и текст черты!");
        const chat = SillyTavern.getContext().chat; if (!chat?.length) return;
        const lastMsg = chat[chat.length - 1]; const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {}; if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
        lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName, trait, type: 'positive', scope: getCurrentPersonaScopeKey() });
        saveChatDebounced(); recalculateAllStats(false); notifySuccess("Черта внедрена.");
    });

    jQuery('#bb-dbg-add-trait-neg').on('click', function() {
        const charName = String(jQuery('#bb-debug-char-name').val()).trim();
        const trait = String(jQuery('#bb-debug-reason').val()).trim();
        if(!charName || !trait) return notifyError("Укажите имя и текст черты!");
        const chat = SillyTavern.getContext().chat; if (!chat?.length) return;
        const lastMsg = chat[chat.length - 1]; const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {}; if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
        lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName, trait, type: 'negative', scope: getCurrentPersonaScopeKey() });
        saveChatDebounced(); recalculateAllStats(false); notifySuccess("Черта внедрена.");
    });

    jQuery('#bb-dbg-set-status').on('click', function() {
        const charName = String(jQuery('#bb-debug-char-name').val()).trim();
        const status = String(jQuery('#bb-debug-reason').val()).trim();
        if(!charName || !status) return notifyError("Укажите имя и статус!");
        const chat = SillyTavern.getContext().chat; if (!chat?.length) return;
        const lastMsg = chat[chat.length - 1]; const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {}; if (!lastMsg.extra.bb_social_swipes) lastMsg.extra.bb_social_swipes = {};
        if (!lastMsg.extra.bb_social_swipes[sId]) lastMsg.extra.bb_social_swipes[sId] = [];
        lastMsg.extra.bb_social_swipes[sId].push({ name: charName, impact_level: "none", role_dynamic: status, reason: "Ручная смена статуса", emotion: "дебаг", scope: getCurrentPersonaScopeKey() });
        saveChatDebounced(); recalculateAllStats(false); notifySuccess("Статус изменен.");
    });

    jQuery('#bb-dbg-btn-merge').on('click', function() {
        bindActivePersonaState();
        const from = String(jQuery('#bb-dbg-merge-from').val()).trim(), to = String(jQuery('#bb-dbg-merge-to').val()).trim();
        if(!from || !to || from === to) return notifyError("Некорректные имена!");
        const result = mergeCharacterRecords(from, to);
        if(result.ok) { saveChatDebounced(); recalculateAllStats(false); renderMergeSuggestionsList(); notifySuccess(result.same ? `Это уже один и тот же персонаж: ${result.targetName}` : `Слито записей: ${result.count}`); } else notifyError("Персонаж не найден.");
    });

    jQuery('#bb-dbg-reset-char').on('click', () => {
        const scopeKey = getCurrentPersonaScopeKey();
        const { scopeState } = bindActivePersonaState();
        const name = String(jQuery('#bb-debug-char-name').val()).trim();
        if(!name) return notifyError("Укажите имя!");
        const resolved = resolveCharacterIdentity(name, { allowCreate: false, allowSuggestions: false });
        const canonicalName = resolved?.primaryName || name;
        if(chat_metadata['bb_vn_char_bases']) delete chat_metadata['bb_vn_char_bases'][canonicalName];
        if(chat_metadata['bb_vn_char_bases_romance']) delete chat_metadata['bb_vn_char_bases_romance'][canonicalName];
        if (resolved?.id && chat_metadata['bb_vn_char_registry']) delete chat_metadata['bb_vn_char_registry'][resolved.id];
        if (scopeState.snapshot_baseline?.characters) delete scopeState.snapshot_baseline.characters[canonicalName];
        if (scopeState.snapshot_baseline?.char_bases) delete scopeState.snapshot_baseline.char_bases[canonicalName];
        if (scopeState.snapshot_baseline?.char_bases_romance) delete scopeState.snapshot_baseline.char_bases_romance[canonicalName];
        const chat = SillyTavern.getContext().chat;
        if(chat) {
            chat.forEach(msg => {
                if(msg.extra?.bb_social_swipes) { for(const sId in msg.extra.bb_social_swipes) { if(Array.isArray(msg.extra.bb_social_swipes[sId])) msg.extra.bb_social_swipes[sId] = msg.extra.bb_social_swipes[sId].filter(u => (u?.scope && u.scope !== scopeKey) || u.name !== canonicalName); } }
                if(msg.extra?.bb_vn_char_traits_swipes) { for(const sId in msg.extra.bb_vn_char_traits_swipes) { if(Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) msg.extra.bb_vn_char_traits_swipes[sId] = msg.extra.bb_vn_char_traits_swipes[sId].filter(t => (t?.scope && t.scope !== scopeKey) || t.charName !== canonicalName); } }
            });
        }
        saveChatDebounced(); recalculateAllStats(false); notifySuccess("Персонаж обнулен.");
    });

    jQuery('#bb-dbg-toast').on('click', () => {
        const types = ['system', 'positive', 'negative', 'milestone', 'alert'];
        showHudToast({ title: 'Тест', text: 'Проверка уведомлений', badge: 'Дебаг', variant: types[Math.floor(Math.random()*types.length)], icon: 'fa-solid fa-bug' });
    });

    jQuery('#bb-social-export-btn').on('click', () => {
        bindActivePersonaState();
        recalculateAllStats(false);
        const snapshot = exportActivePersonaSnapshot();
        downloadSnapshotFile(snapshot);
        const characterCount = Object.keys(snapshot?.data?.characters || {}).length;
        notifySuccess(`Snapshot экспортирован: ${characterCount} персонажей.`);
    });

    jQuery('#bb-social-import-btn').on('click', () => {
        const input = jQuery('#bb-social-snapshot-file');
        input.val('');
        input.trigger('click');
    });

    jQuery('#bb-social-snapshot-file').on('change', async function() {
        const file = this.files?.[0];
        if (!file) return;
        try {
            const raw = await file.text();
            const result = importActivePersonaSnapshot(raw);
            saveChatDebounced();
            recalculateAllStats(false);
            notifySuccess(`Snapshot импортирован: ${result.characters} персонажей. Старые события до точки импорта больше не наслаиваются повторно.`);
        } catch (error) {
            console.error('[BB VN] Snapshot import failed:', error);
            notifyError("Не удалось импортировать snapshot. Проверьте JSON-файл.");
        } finally {
            jQuery(this).val('');
        }
    });

    jQuery('#bb-social-clear-snapshot-btn').on('click', () => {
        const hadSnapshot = clearActivePersonaSnapshot();
        saveChatDebounced();
        recalculateAllStats(false);
        if (hadSnapshot) notifyInfo("Snapshot-база очищена. Состояние до импорта восстановлено, расчёт снова идёт от данных чата.");
        else notifyInfo("Активной snapshot-базы не было.");
    });

    jQuery('#bb-social-restore-chars-btn').on('click', () => { const { scopeState } = bindActivePersonaState(); scopeState.ignored_chars = []; chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars; saveChatDebounced(); recalculateAllStats(); notifySuccess("Скрытые персонажи восстановлены!"); });
    jQuery('#bb-social-clear-log-btn').on('click', wipeGlobalLog);
    jQuery('#bb-social-wipe-btn').on('click', wipeAllSocialData);
    renderMergeSuggestionsList();
}
