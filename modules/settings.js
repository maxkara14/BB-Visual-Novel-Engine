import { mountPortraitSettings } from './portrait-ui.js';
import { mountSettingsAnimations } from './settings-animation.js';
import { refreshSnapshotControls, snapshotRemovalPrompt } from './snapshot-controls.js';
import { t, ui, normalizeUiLanguage } from './i18n.js';
 /* global SillyTavern */
import { chat_metadata, saveChatDebounced, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME, normalizeVnContextMessages, normalizeImpactSettings, normalizeImpactValue, normalizeVnReplyLength, resolveImpactScaleSettings } from './constants.js';
import { recalculateAllStats, injectCombinedSocialPrompt, addGlobalLog, bindActivePersonaState, getCurrentPersonaScopeKey, mergeCharacterRecords, resolveCharacterIdentity, exportActivePersonaSnapshot, importActivePersonaSnapshot, clearActivePersonaSnapshot, markSnapshotReplayMessage, getLatestAssistantMessageEntry } from './social.js';
import { notifySuccess, notifyInfo, notifyError, showHudToast } from './toasts.js';
import { restoreVNOptions, setVnOptionsEnabled, clearSavedVNOptions, invalidateVnOptionsGeneration } from './generator.js';
import { normalizeRequestTimeout, normalizeCustomApiMaxTokens, normalizeRequestError, getCustomApiIdentity } from './requests.js';
import { escapeHtml, createTextOption } from './utils.js';
import { resolveVnGenerationSource } from './connections.js';
import { normalizeOutputLanguage } from './language.js';
import { confirmSnapshotFile, confirmSnapshotRemoval } from './snapshot.js';
import { mountVnConnectionControls } from './connection-ui.js';
import { normalizeJsonMode, normalizeAdditionalRequests } from './structured-output.js';

const IMPACT_SETTING_FIELDS = [
    { key: 'unforgivable', token: 'unforgivable', title: t('Критический минус'), hint: t('Тяжёлый удар по доверию или влечению') },
    { key: 'major_negative', token: 'major_negative', title: t('Сильный минус'), hint: t('Заметное ухудшение за один ход') },
    { key: 'minor_negative', token: 'minor_negative', title: t('Слабый минус'), hint: t('Небольшая негативная реакция') },
    { key: 'minor_positive', token: 'minor_positive', title: t('Слабый плюс'), hint: t('Лёгкое улучшение отношения') },
    { key: 'major_positive', token: 'major_positive', title: t('Сильный плюс'), hint: t('Хорошо заметный рост') },
    { key: 'life_changing', token: 'life_changing', title: t('Судьбоносный плюс'), hint: t('Крупный переломный сдвиг') },
];
const IMPACT_SCALE_GROUPS = [
    {
        key: 'friendshipImpactValues',
        title: t('🤝 Шкала дружбы'),
        note: t('Меняет только доверие, лояльность, тепло и социальную дистанцию.'),
    },
    {
        key: 'romanceImpactValues',
        title: t('💖 Шкала романтики'),
        note: t('Меняет только влечение, искру, личную тягу и романтическое охлаждение.'),
    },
];

function renderMergeSuggestionsList() {
    bindActivePersonaState();
    const container = jQuery('#bb-dbg-merge-suggestions');
    if (container.length === 0) return;

    const suggestions = Array.isArray(chat_metadata['bb_vn_merge_suggestions'])
        ? [...chat_metadata['bb_vn_merge_suggestions']].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6)
        : [];

    if (suggestions.length === 0) {
        container.html(t('<div style="font-size: 11px; color: #64748b;">Пока подозрительных дублей не найдено.</div>'));
        return;
    }

    container.html(suggestions.map(item => {
        const score = Math.round(Number(item.score || 0) * 100);
        return ui`<button type="button" class="menu_button bb-dbg-merge-suggestion" data-from="${escapeHtml(item.source)}" data-to="${escapeHtml(item.target)}" style="text-align:left; width:100%; margin-top:6px; border-color: rgba(192, 132, 252, 0.22); color: #ddd6fe;">
            <span style="display:block; font-size:11px; color:#c4b5fd;">Кандидат на объединение · ${score}%</span>
            <strong style="display:block; color:#f8fafc;">${escapeHtml(item.source)}</strong>
            <span style="display:block; font-size:12px; color:#94a3b8;">→ ${escapeHtml(item.target)}</span>
        </button>`;
    }).join(''));

    jQuery('.bb-dbg-merge-suggestion').off('click').on('click', function() {
        jQuery('#bb-dbg-merge-from').val(jQuery(this).attr('data-from') || '');
        jQuery('#bb-dbg-merge-to').val(jQuery(this).attr('data-to') || '');
        notifyInfo(t('Кандидат на объединение подставлен в поля слияния.'));
    });
}

window['bbRenderMergeSuggestionsList'] = renderMergeSuggestionsList;

function normalizeDebugTraitText(raw = '', fallbackLabel = t('Черта')) {
    const text = String(raw || '').trim();
    if (!text) return '';
    return text.includes(':') ? text : `${fallbackLabel}: ${text}`;
}

function makeDebugEventId(prefix = 'debug') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeDebugEventTimestamp() {
    return new Date().toISOString();
}

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
    if(!charName) return notifyError(t("Укажите имя!"));
    const chat = SillyTavern.getContext().chat;
    if (!chat?.length) return;
    const targetMessage = getLatestAssistantMessageEntry(chat);
    if (!targetMessage) return notifyError(t("Нет сообщения персонажа для привязки debug-события."));
    const lastMsg = targetMessage.message;
    if (!lastMsg.extra) lastMsg.extra = {};
    if (!lastMsg.extra.bb_social_swipes) lastMsg.extra.bb_social_swipes = {};
    const sId = lastMsg.swipe_id || 0;
    if (!lastMsg.extra.bb_social_swipes[sId]) lastMsg.extra.bb_social_swipes[sId] = [];
    const reason = String(jQuery('#bb-debug-reason').val() || '').trim() || (isRomance ? t('Дебаг-романтика') : t('Дебаг-доверие'));
    lastMsg.extra.bb_social_swipes[sId].push({ name: charName, friendship_impact: isRomance ? "none" : impact, romance_impact: isRomance ? impact : "none", role_dynamic: "", reason, emotion: t("тест"), debug_event: true, debug_id: makeDebugEventId('impact'), event_created_at: makeDebugEventTimestamp(), scope: getCurrentPersonaScopeKey() });
    markSnapshotReplayMessage(targetMessage.messageId, sId, 'debug-impact');
    saveChatDebounced(); recalculateAllStats(false); notifySuccess(t("Данные внедрены."));
}

export function injectMixedDeepDebugData() {
    bindActivePersonaState();
    const charName = String(jQuery('#bb-debug-char-name').val()).trim();
    if(!charName) return notifyError(t("Укажите имя!"));
    const chat = SillyTavern.getContext().chat;
    if (!chat?.length) return;
    const targetMessage = getLatestAssistantMessageEntry(chat);
    if (!targetMessage) return notifyError(t("Нет сообщения персонажа для привязки debug-события."));
    const lastMsg = targetMessage.message;
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
        reason: customReason || t("Тянет вопреки опасности"),
        emotion: t("опасное влечение"),
        debug_event: true,
        debug_id: makeDebugEventId('mixed'),
        event_created_at: makeDebugEventTimestamp(),
        scope: getCurrentPersonaScopeKey(),
    });
    markSnapshotReplayMessage(targetMessage.messageId, sId, 'debug-mixed');
    saveChatDebounced();
    recalculateAllStats(false);
    notifySuccess(t("Смешанное незабываемое событие внедрено."));
}

export function wipeGlobalLog() {
    const { scopeState } = bindActivePersonaState();
    const chat = SillyTavern.getContext().chat || [];
    scopeState.global_log = [];
    chat_metadata['bb_vn_global_log'] = scopeState.global_log;
    chat_metadata['bb_vn_log_cutoff_index'] = chat.length;
    saveChatDebounced();
    recalculateAllStats();
    notifySuccess(t("Журнал событий очищен!"));
}

export function wipeAllSocialData() {
    const { scopeState, aliasSet } = bindActivePersonaState();
    const chat = SillyTavern.getContext().chat;
    if (!chat) return;
    chat.forEach(msg => {
        if (msg.extra && msg.extra.bb_social_swipes) {
            for (const sId in msg.extra.bb_social_swipes) {
                if (!Array.isArray(msg.extra.bb_social_swipes[sId])) continue;
                msg.extra.bb_social_swipes[sId] = msg.extra.bb_social_swipes[sId].filter(update => update?.scope && !aliasSet.has(update.scope));
            }
        }
        if (msg.extra && msg.extra.bb_vn_options_swipes) delete msg.extra.bb_vn_options_swipes;
        if (msg.extra && msg.extra.bb_vn_char_traits_swipes) {
            for (const sId in msg.extra.bb_vn_char_traits_swipes) {
                if (!Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) continue;
                msg.extra.bb_vn_char_traits_swipes[sId] = msg.extra.bb_vn_char_traits_swipes[sId].filter(trait => trait?.scope && !aliasSet.has(trait.scope));
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
    refreshSnapshotControls(scopeState);
    scopeState.snapshot_cutoff_index = 0;
    scopeState.snapshot_restore_state = null;
    scopeState.snapshot_post_import_replay_keys = {};
    scopeState.snapshot_post_import_pending_swipes = {};
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
    addGlobalLog('system', t('Все отношения сброшены до нуля.'));
    saveChatDebounced();
    recalculateAllStats();
    notifySuccess(t("История отношений в этом чате полностью сброшена!"));
}

export function setupExtensionSettings() {
    bindActivePersonaState();
    if (document.getElementById('bb-social-settings-wrapper')) return;
    
    const s = extension_settings[MODULE_NAME];
    const selectedReplyLength = normalizeVnReplyLength(s.vnReplyLength);
    Object.assign(s, resolveImpactScaleSettings(s));
    const buildImpactFieldsHtml = (scaleKey, values) => IMPACT_SETTING_FIELDS.map(field => `
        <div class="bb-vn-impact-row">
            <div class="bb-vn-impact-copy">
                <span class="bb-vn-impact-title">${field.title}</span>
                <span class="bb-vn-impact-token">${field.token}</span>
                <span class="bb-vn-impact-hint">${field.hint}</span>
            </div>
            <input
                type="number"
                inputmode="numeric"
                class="text_pole bb-vn-impact-input"
                data-impact-scale="${scaleKey}"
                data-impact-key="${field.key}"
                min="-100"
                max="100"
                step="1"
                value="${values[field.key]}"
            >
        </div>
    `).join('');
    const impactGroupsHtml = IMPACT_SCALE_GROUPS.map(group => `
        <div class="inline-drawer bb-vn-settings-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${group.title}</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content bb-vn-settings-drawer-content">
                <span class="bb-vn-settings-note">${group.note}</span>
                <div class="bb-vn-impact-list">
                    ${buildImpactFieldsHtml(group.key, normalizeImpactSettings(s[group.key]))}
                </div>
            </div>
        </div>
    `).join('');
    const settingsHtml = ui`
        <div id="bb-social-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>💖 BB Visual Novel Engine</b><div class="inline-drawer-icon fa-solid fa-chevron-down down"></div></div>
            <div class="inline-drawer-content bb-vn-settings-shell">
                <span class="bb-vn-settings-intro">Настройки Интерактивного Кино</span>
                <details class="bb-vn-settings-section" data-section="game" open>
                    <summary><i class="fa-solid fa-gamepad bb-vn-section-icon" aria-hidden="true"></i><span>Игра</span></summary>
                    <div class="bb-vn-settings-section-body">
                        <div class="bb-vn-settings-toggle-grid">
                            <label class="checkbox_label bb-vn-setting-pill"><input type="checkbox" id="bb-vn-cfg-options-enabled" ${s.vnOptionsEnabled !== false ? 'checked' : ''}><span>Варианты VN</span></label>
                            <label class="checkbox_label bb-vn-setting-pill"><input type="checkbox" id="bb-vn-cfg-autosend" ${s.autoSend ? 'checked' : ''}><span>Авто-отправка при выборе</span></label>
                            <label class="checkbox_label bb-vn-setting-pill"><input type="checkbox" id="bb-vn-cfg-autogen" ${s.autoGen ? 'checked' : ''}><span>Авто-показ вариантов действий</span></label>
                            <label class="checkbox_label bb-vn-setting-pill"><input type="checkbox" id="bb-vn-cfg-emotional-choice" ${s.emotionalChoiceFraming ? 'checked' : ''}><span>Тон и прогноз вариантов</span></label>
                        </div>
                    </div>
                </details>
                <details class="bb-vn-settings-section" data-section="answers">
                    <summary><i class="fa-solid fa-comment-dots bb-vn-section-icon" aria-hidden="true"></i><span>Язык и ответы</span></summary>
                    <div class="bb-vn-settings-section-body">
                        <div class="bb-vn-settings-panel">
                            <label for="bb-vn-cfg-ui-language">Язык интерфейса</label>
                            <select id="bb-vn-cfg-ui-language" class="text_pole"><option value="auto">Auto</option><option value="ru">Русский</option><option value="en">English</option></select>
                            <span class="bb-vn-settings-note">Auto использует язык SillyTavern или браузера. После смены языка интерфейса обновите страницу.</span>
                            <label for="bb-vn-cfg-output-language">Язык новых ответов</label>
                            <select id="bb-vn-cfg-output-language" class="text_pole"><option value="chat">Как в чате</option><option value="ru">Русский</option><option value="en">English</option></select>
                            <span class="bb-vn-settings-note">Для новых вариантов, профилей, черт и записей об отношениях. Сохранённые данные не переводятся.</span>
                            <label for="bb-vn-cfg-context-messages">Сообщений в контексте вариантов</label>
                            <input type="number" id="bb-vn-cfg-context-messages" class="text_pole" min="1" max="100" step="1" value="${normalizeVnContextMessages(s.vnContextMessages)}">
                            <span class="bb-vn-settings-note">Последние 1–100 сообщений, по умолчанию 10. Последний ответ остаётся ориентиром сцены. Это объём истории для вариантов, а не лимит токенов ответа; основное подключение может добавлять контекст SillyTavern.</span>
                            <label for="bb-vn-cfg-instructions">Постоянные пожелания к вариантам</label>
                            <textarea id="bb-vn-cfg-instructions" class="text_pole" rows="4" maxlength="4000"></textarea>
                            <span class="bb-vn-settings-note">Для вариантов во всех чатах, до 4000 символов. Разовая подсказка уточняет пожелания; язык и формат ответа сохраняются. Не применяется к профилям и чертам.</span>
                            <button type="button" id="bb-vn-cfg-instructions-clear" class="menu_button" style="width: 100%; white-space: normal;">Очистить пожелания</button>
                            <label for="bb-vn-cfg-reply-length" class="bb-vn-settings-panel-label">Длина VN-ответа</label>
                            <select id="bb-vn-cfg-reply-length" class="text_pole">
                                <option value="short" ${selectedReplyLength === 'short' ? 'selected' : ''}>Короткий - быстрый темп</option>
                                <option value="medium" ${selectedReplyLength === 'medium' ? 'selected' : ''}>Средний - баланс</option>
                                <option value="long" ${selectedReplyLength === 'long' ? 'selected' : ''}>Длинный - больше сцены</option>
                            </select>
                            <span class="bb-vn-settings-note">Влияет и на длину вариантов действий, и на то, насколько активно VN продвигает следующий ответ.</span>
                        </div>
                    </div>
                </details>
                <details class="bb-vn-settings-section" data-section="connection">
                    <summary><i class="fa-solid fa-plug bb-vn-section-icon" aria-hidden="true"></i><span>Подключения</span></summary>
                    <div class="bb-vn-settings-section-body">
                        <div class="bb-vn-settings-card bb-vn-settings-card--accent">
                            <div id="bb-vn-connection-controls" class="bb-vn-settings-stack"></div>
                            <span class="bb-vn-settings-note">Используется для вариантов ответа, описаний персонажей и черт характера.</span>
                            <div id="bb-vn-custom-api-block" class="bb-vn-settings-stack" style="display: ${resolveVnGenerationSource(s) === 'custom' ? 'flex' : 'none'};">
                                <input type="text" id="bb-vn-cfg-url" class="text_pole" placeholder="URL">
                                <input type="password" id="bb-vn-cfg-key" class="text_pole" placeholder="API Ключ">
                                <div id="bb-vn-custom-api-status" class="bb-custom-api-status is-idle">
                                    <span class="bb-custom-api-status-dot"></span>
                                    <span class="bb-custom-api-status-text">Подключение не проверено</span>
                                </div>
                                <button id="bb-vn-btn-connect" class="menu_button bb-vn-settings-button"><i class="fa-solid fa-plug"></i>&nbsp; Подключиться</button>
                                <select id="bb-vn-cfg-model" class="text_pole" ${!s.customApiModel ? 'disabled' : ''}></select>
                                <label class="checkbox_label bb-vn-setting-pill"><input type="checkbox" id="bb-vn-cfg-fallback" ${s.allowMainFallback === true ? 'checked' : ''}><span>Разрешить резервную основную модель при сбое Custom API</span></label>
                                <span class="bb-vn-settings-note">Может вызвать дополнительный запрос к другой модели. Не применяется при отмене, ошибке ключа, квоте или блокировке провайдером.</span>
                            </div>
                            <details id="bb-vn-advanced-settings">
                                <summary>Дополнительно</summary>
                                <div class="bb-vn-settings-stack">
                                    <span class="bb-vn-settings-note">Обычно менять эти настройки не нужно. Оставьте формат Auto: расширение само выберет способ получения вариантов.</span>
                                    <label for="bb-vn-cfg-max-tokens">Лимит токенов ответа (своё API)</label>
                                    <input type="number" id="bb-vn-cfg-max-tokens" class="text_pole" min="0" max="131072" step="1" value="${normalizeCustomApiMaxTokens(s.customApiMaxTokens)}">
                                    <span class="bb-vn-settings-note">0 — автоматически, как раньше. Вручную: 256–131072 токена на запрос. Рассуждения могут входить в этот бюджет. Предел зависит от модели и провайдера; настройка общая для вариантов, описаний и черт и не меняет лимиты основного подключения или профиля.</span>
                                    <label for="bb-vn-cfg-timeout">Тайм-аут одного запроса (секунды)</label>
                                    <input type="number" id="bb-vn-cfg-timeout" class="text_pole" min="15" max="600" value="${normalizeRequestTimeout(s.requestTimeout)}">
                                    <label for="bb-vn-cfg-json-mode">Формат VN-ответа</label>
                                    <select id="bb-vn-cfg-json-mode" class="text_pole">
                                        <option value="auto">Auto</option><option value="schema">JSON Schema</option>
                                        <option value="json">JSON mode (Custom API)</option><option value="prompt">Только инструкции</option>
                                    </select>
                                    <span class="bb-vn-settings-note">Auto: основное подключение и профиль — инструкции; Custom API — схема с переходом к JSON mode и инструкциям только при подтверждённой несовместимости.</span>
                                    <label for="bb-vn-cfg-extra-requests">Дополнительные запросы VN (0–5)</label>
                                    <input id="bb-vn-cfg-extra-requests" type="number" class="text_pole" min="0" max="5" value="${normalizeAdditionalRequests(s.vnMaxAdditionalRequests)}">
                                    <span class="bb-vn-settings-note">Общий лимит на повтор формата, резервную модель, исправление, дополнение и разнообразие вариантов.</span>
                                </div>
                                <label class="checkbox_label bb-vn-setting-pill"><input type="checkbox" id="bb-vn-cfg-debug" ${s.debugGeneration === true ? 'checked' : ''}><span>Подробная диагностика ответов</span></label>
                                <span class="bb-vn-settings-note">Включает фрагменты ответа модели в консоли браузера. Выключайте после диагностики и проверяйте текст перед отправкой отчёта.</span>
                            </details>
                            <span id="bb-vn-generation-stage" class="bb-vn-settings-note" aria-live="polite"></span>
                            <span id="bb-vn-generation-source" class="bb-vn-settings-note" aria-live="polite">Источник последнего результата: запросов ещё не было.</span>
                        </div>
                    </div>
                </details>
                <details class="bb-vn-settings-section" data-section="relationships">
                    <summary><i class="fa-solid fa-heart bb-vn-section-icon" aria-hidden="true"></i><span>Отношения</span></summary>
                    <div class="bb-vn-settings-section-body">
                        <label class="checkbox_label bb-vn-setting-pill"><input type="checkbox" id="bb-vn-cfg-disable-tracker" ${s.disableRelationshipTracker ? 'checked' : ''}><span>Отключить трекер отношений</span></label>
                        <label class="checkbox_label bb-vn-setting-pill bb-vn-setting-pill--single"><input type="checkbox" id="bb-vn-cfg-usemacro" ${s.useMacro ? 'checked' : ''}><span>Использовать макрос {{bb_vn}}</span></label>

                        <span class="bb-vn-settings-note">Здесь вы можете задать свои значения для шкал дружбы и романтики. После изменения отношения сразу пересчитываются по всей истории.</span>
                        ${impactGroupsHtml}
                        <button id="bb-vn-impact-reset" class="menu_button bb-vn-settings-button bb-vn-settings-button--ghost">
                            <i class="fa-solid fa-rotate-left"></i>&ensp; Сбросить обе шкалы
                        </button>
                    </div>
                </details>
                <details class="bb-vn-settings-section" data-section="data">
                    <summary><i class="fa-solid fa-database bb-vn-section-icon" aria-hidden="true"></i><span>Данные</span></summary>
                    <div class="bb-vn-settings-section-body">
                        <div class="bb-vn-settings-card bb-vn-settings-card--snapshot">
                            <span class="bb-vn-settings-section-title">Снимки состояния</span>
                            <span class="bb-vn-settings-note">Экспорт скачивает текущее состояние и не меняет точку восстановления. Импорт заменяет основу активной персоны, а не складывает два набора отношений. Сообщения чата остаются.</span>
                            <span id="bb-social-snapshot-status" class="bb-vn-settings-note" aria-live="polite"></span>
                            <input type="file" id="bb-social-snapshot-file" accept=".json,application/json" style="display:none;">
                            <div class="bb-vn-settings-actions-grid">
                                <button id="bb-social-export-btn" class="menu_button bb-vn-settings-button"><i class="fa-solid fa-file-export" aria-hidden="true"></i><span>Экспорт</span></button>
                                <button id="bb-social-import-btn" class="menu_button bb-vn-settings-button"><i class="fa-solid fa-file-import" aria-hidden="true"></i><span>Импорт</span></button>
                            </div>
                            <button id="bb-social-clear-snapshot-btn" class="menu_button bb-vn-settings-button" style="color:#fda4af; border-color:rgba(244,114,182,0.22);">Убрать импортированную основу</button>
                        </div>
                        <div class="bb-vn-settings-stack">
                            <button id="bb-social-restore-chars-btn" class="menu_button bb-vn-settings-button">Вернуть скрытых персонажей</button>
                            <button id="bb-social-clear-log-btn" class="menu_button bb-vn-settings-button">Очистить журнал</button>
                            <button id="bb-social-wipe-btn" class="menu_button bb-vn-settings-button bb-vn-settings-button--danger">Сбросить историю</button>
                        </div>
                    </div>
                </details>
                <details class="bb-vn-settings-section" data-section="images">
                    <summary><i class="fa-solid fa-image bb-vn-section-icon" aria-hidden="true"></i><span>Изображения</span></summary>
                    <div id="bb-vn-portrait-settings" class="bb-vn-settings-section-body"></div>
                </details>
                <details class="bb-vn-settings-section" data-section="debug">
                    <summary><i class="fa-solid fa-wrench bb-vn-section-icon" aria-hidden="true"></i><span>Отладка</span></summary>
                    <div class="bb-vn-settings-section-body">
                        <input type="text" id="bb-debug-char-name" class="text_pole" placeholder="Имя персонажа">
                        <input type="text" id="bb-debug-reason" class="text_pole" placeholder="Текст причины" value="Дебаг-действие">
                        <div class="bb-vn-settings-actions-grid">
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
                        <button id="bb-dbg-set-status" class="menu_button bb-vn-settings-button" style="color:#93c5fd; border-color:rgba(147,197,253,0.3);">🔄 Изменить статус к вам</button>
                        <hr class="bb-vn-settings-divider">
                        <span class="bb-vn-settings-section-title bb-vn-settings-section-title--small">🧬 Слияние дубликатов</span>
                        <div class="bb-vn-settings-split"><input type="text" id="bb-dbg-merge-from" class="text_pole" placeholder="Кого"><input type="text" id="bb-dbg-merge-to" class="text_pole" placeholder="В кого"></div>
                        <button id="bb-dbg-btn-merge" class="menu_button bb-vn-settings-button" style="color:#c084fc; border-color:rgba(192, 132, 252, 0.3);"><i class="fa-solid fa-code-merge"></i>&ensp; Слить в одного</button>
                        <div id="bb-dbg-merge-suggestions" style="display:flex; flex-direction:column; gap: 0; margin-top: 4px;"></div>
                        <hr class="bb-vn-settings-divider">
                        <button id="bb-dbg-reset-char" class="menu_button bb-vn-settings-button" style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;">💀 Полностью обнулить персонажа</button>
                        <button id="bb-dbg-toast" class="menu_button bb-vn-settings-button"><i class="fa-solid fa-bell"></i>&ensp; Рандомное уведомление</button>
                    </div>
                </details>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.insertAdjacentHTML('beforeend', settingsHtml);
    mountPortraitSettings(document.getElementById('bb-vn-portrait-settings'));
    mountSettingsAnimations(document.getElementById('bb-social-settings-wrapper'));
    refreshSnapshotControls(bindActivePersonaState().scopeState);
    const snapshotContext = SillyTavern.getContext();
    for (const name of ['CHAT_CHANGED', 'PERSONA_CHANGED']) {
        const event = snapshotContext.event_types?.[name];
        if (event) snapshotContext.eventSource?.on(event, () => refreshSnapshotControls(bindActivePersonaState().scopeState));
    }
    jQuery('#bb-vn-cfg-options-enabled').on('change', function() {
        setVnOptionsEnabled(this.checked);
    });
    jQuery('#bb-vn-cfg-context-messages').on('change', function() {
        const value = normalizeVnContextMessages(jQuery(this).val());
        extension_settings[MODULE_NAME].vnContextMessages = value;
        jQuery(this).val(value);
        saveSettingsDebounced();
    });
    jQuery('#bb-vn-cfg-instructions').val(s.vnUserInstructions || '');
    jQuery('#bb-vn-cfg-instructions').on('input', function() {
        extension_settings[MODULE_NAME].vnUserInstructions = String(jQuery(this).val() || '').slice(0, 4000);
        saveSettingsDebounced();
    });
    jQuery('#bb-vn-cfg-instructions-clear').on('click', function() {
        jQuery('#bb-vn-cfg-instructions').val('').trigger('input');
    });
    jQuery('#bb-vn-cfg-url').val(s.customApiUrl || '');
    jQuery('#bb-vn-cfg-key').val(s.customApiKey || '');
    jQuery('#bb-vn-cfg-model').append(createTextOption(s.customApiModel || t('Модели не загружены'), s.customApiModel || ''));

    let lastVerifiedCustomApiFingerprint = '';
    let customApiRuntimeState = '';
    let customApiRuntimeMessage = '';
    const customApiStatusClasses = ['is-idle', 'is-pending', 'is-saved', 'is-connected', 'is-error', 'is-disabled'];

    const buildCustomApiFingerprint = (url = '', key = '') => `${String(url || '').trim()}::${String(key || '').trim()}`;
    const clearCustomApiRuntimeState = () => {
        customApiRuntimeState = '';
        customApiRuntimeMessage = '';
    };

    const setCustomApiStatus = (state = 'idle', text = '') => {
        const status = jQuery('#bb-vn-custom-api-status');
        if (!status.length) return;
        status.removeClass(customApiStatusClasses.join(' ')).addClass(`is-${state}`);
        status.find('.bb-custom-api-status-text').text(text);
    };

    const setCustomApiModelPlaceholder = (label = t('Модели не загружены'), value = '') => {
        const select = jQuery('#bb-vn-cfg-model').empty();
        select.append(createTextOption(label, value));
        select.prop('disabled', true);
    };

    const syncCustomApiVisualState = () => {
        const useCustomApi = resolveVnGenerationSource(s) === 'custom';
        const rawUrl = String(jQuery('#bb-vn-cfg-url').val() || '').trim();
        const rawKey = String(jQuery('#bb-vn-cfg-key').val() || '').trim();
        const selectedModel = String(extension_settings[MODULE_NAME].customApiModel || jQuery('#bb-vn-cfg-model').val() || '').trim();
        const currentFingerprint = buildCustomApiFingerprint(rawUrl, rawKey);

        if (!useCustomApi) {
            setCustomApiStatus('disabled', t('Кастомное подключение выключено.'));
            return;
        }
        if (!rawUrl) {
            clearCustomApiRuntimeState();
            setCustomApiStatus('idle', t('Укажите URL для проверки подключения.'));
            setCustomApiModelPlaceholder(t('Сначала укажите URL'));
            return;
        }
        if (!rawKey) {
            clearCustomApiRuntimeState();
            setCustomApiStatus('idle', t('Добавьте API-ключ для проверки подключения.'));
            setCustomApiModelPlaceholder(t('Нужен API-ключ'));
            return;
        }
        if (currentFingerprint && currentFingerprint === lastVerifiedCustomApiFingerprint) {
            if (customApiRuntimeState === 'error') {
                setCustomApiStatus('error', customApiRuntimeMessage || t('Последний запрос к кастомной модели сорвался. Генерация ушла на основную модель.'));
                return;
            }
            setCustomApiStatus('connected', selectedModel ? ui`Подключено: ${selectedModel}` : t('Подключение подтверждено.'));
            return;
        }

        clearCustomApiRuntimeState();
        if (selectedModel) {
            setCustomApiModelPlaceholder(ui`${selectedModel} · требуется переподключение`, selectedModel);
            setCustomApiStatus('saved', ui`Сохранена модель ${selectedModel}. Нажмите «Подключиться», чтобы проверить соединение.`);
            return;
        }

        setCustomApiModelPlaceholder(t('Подключение не проверено'));
        setCustomApiStatus('idle', t('Подключение не проверено. Нажмите «Подключиться».'));
    };

    const customApiHealthHandler = (event) => {
        const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
        const currentIdentity = getCustomApiIdentity(jQuery('#bb-vn-cfg-url').val(), jQuery('#bb-vn-cfg-key').val());
        if (detail.connectionId !== currentIdentity) return;
        customApiRuntimeState = detail.state === 'error' ? 'error' : 'connected';
        customApiRuntimeMessage = String(detail.message || '').trim();
        syncCustomApiVisualState();
    };

    if (window.bbVnCustomApiHealthHandler) {
        window.removeEventListener('bb-vn-custom-api-health', window.bbVnCustomApiHealthHandler);
    }
    window.bbVnCustomApiHealthHandler = customApiHealthHandler;
    window.addEventListener('bb-vn-custom-api-health', customApiHealthHandler);

    const applyModelOptions = (models = [], preferredModel = '') => {
        const select = jQuery('#bb-vn-cfg-model').empty();
        const safeModels = Array.isArray(models)
            ? models.map(m => String(m || '').trim()).filter(Boolean)
            : [];

        if (safeModels.length === 0) {
            select.append(t('<option value="">Модели не загружены</option>'));
            select.prop('disabled', true);
            extension_settings[MODULE_NAME].customApiModel = '';
            return;
        }

        safeModels.forEach(modelId => {
            select.append(createTextOption(modelId, modelId));
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
    jQuery('#bb-vn-cfg-disable-tracker').on('change', function() {
        extension_settings[MODULE_NAME].disableRelationshipTracker = jQuery(this).is(':checked');
        saveSettingsDebounced();
        clearSavedVNOptions();
        restoreVNOptions(false);
        injectCombinedSocialPrompt();
        recalculateAllStats(false);
        if (typeof window.updateHudVisibility === 'function') window.updateHudVisibility();
        if (typeof window.renderSocialHud === 'function') window.renderSocialHud();
    });
    jQuery('#bb-vn-cfg-reply-length').on('change', function() {
        extension_settings[MODULE_NAME].vnReplyLength = normalizeVnReplyLength(jQuery(this).val());
        saveSettingsDebounced();
        clearSavedVNOptions();
        restoreVNOptions(false);
        injectCombinedSocialPrompt();
    });
    jQuery('#bb-vn-cfg-max-tokens').on('change', function() {
        const value = normalizeCustomApiMaxTokens(jQuery(this).val());
        extension_settings[MODULE_NAME].customApiMaxTokens = value;
        jQuery(this).val(value);
        saveSettingsDebounced();
    });
    jQuery('#bb-vn-cfg-timeout').on('change', function() {
        const value = normalizeRequestTimeout(jQuery(this).val());
        extension_settings[MODULE_NAME].requestTimeout = value;
        jQuery(this).val(value);
        saveSettingsDebounced();
    });
    jQuery('#bb-vn-cfg-fallback').on('change', function() {
        extension_settings[MODULE_NAME].allowMainFallback = jQuery(this).is(':checked');
        saveSettingsDebounced();
    });
    jQuery('#bb-vn-cfg-debug').on('change', function() {
        extension_settings[MODULE_NAME].debugGeneration = jQuery(this).is(':checked');
        saveSettingsDebounced();
    });
    jQuery('#bb-vn-cfg-ui-language').val(normalizeUiLanguage(s.uiLanguage)).on('change', function () {
        extension_settings[MODULE_NAME].uiLanguage = normalizeUiLanguage(jQuery(this).val());
        saveSettingsDebounced();
        notifyInfo(t('Язык интерфейса сохранён. Обновите страницу, чтобы применить его ко всем панелям.'));
    });
    jQuery('#bb-vn-cfg-output-language').val(normalizeOutputLanguage(s.outputLanguage)).on('change', function () {
        extension_settings[MODULE_NAME].outputLanguage = normalizeOutputLanguage(jQuery(this).val());
        invalidateVnOptionsGeneration();
        saveSettingsDebounced();
        injectCombinedSocialPrompt();
    });
    jQuery('#bb-vn-cfg-json-mode').val(normalizeJsonMode(s.vnJsonMode)).on('change', function () {
        extension_settings[MODULE_NAME].vnJsonMode = normalizeJsonMode(jQuery(this).val());
        invalidateVnOptionsGeneration();
        saveSettingsDebounced();
    });
    jQuery('#bb-vn-cfg-extra-requests').on('change', function () {
        const value = normalizeAdditionalRequests(jQuery(this).val());
        jQuery(this).val(value);
        extension_settings[MODULE_NAME].vnMaxAdditionalRequests = value;
        invalidateVnOptionsGeneration();
        saveSettingsDebounced();
    });
    if (window.bbVnGenerationStageHandler) window.removeEventListener('bb-vn-generation-stage', window.bbVnGenerationStageHandler);
    window.bbVnGenerationStageHandler = event => {
        jQuery('#bb-vn-generation-stage').text(ui`${event.detail.stage} · запросов: ${event.detail.requestNumber}`);
    };
    window.addEventListener('bb-vn-generation-stage', window.bbVnGenerationStageHandler);
    if (window.bbVnGenerationSourceHandler) window.removeEventListener('bb-vn-generation-source', window.bbVnGenerationSourceHandler);
    window.bbVnGenerationSourceHandler = event => {
        jQuery('#bb-vn-generation-source').text(ui`Источник последнего результата: ${String(event.detail?.source || '')}`);
    };
    window.addEventListener('bb-vn-generation-source', window.bbVnGenerationSourceHandler);
    const syncConnectionVisibility = () => {
        jQuery('#bb-vn-custom-api-block').css('display', resolveVnGenerationSource(s) === 'custom' ? 'flex' : 'none');
        syncCustomApiVisualState();
    };
    mountVnConnectionControls(document.getElementById('bb-vn-connection-controls'), s, () => {
        invalidateVnOptionsGeneration();
        saveSettingsDebounced();
        syncConnectionVisibility();
    });
    jQuery('#bb-vn-cfg-url, #bb-vn-cfg-key').on('change input', () => {
        extension_settings[MODULE_NAME].customApiUrl = jQuery('#bb-vn-cfg-url').val();
        extension_settings[MODULE_NAME].customApiKey = jQuery('#bb-vn-cfg-key').val();
        if (buildCustomApiFingerprint(extension_settings[MODULE_NAME].customApiUrl, extension_settings[MODULE_NAME].customApiKey) !== lastVerifiedCustomApiFingerprint) {
            lastVerifiedCustomApiFingerprint = '';
        }
        clearCustomApiRuntimeState();
        saveSettingsDebounced();
        syncCustomApiVisualState();
    });
    jQuery(document).on('change', '#bb-vn-cfg-model', function() {
        extension_settings[MODULE_NAME].customApiModel = jQuery(this).val();
        clearCustomApiRuntimeState();
        saveSettingsDebounced();
        syncCustomApiVisualState();
    });
    jQuery('#bb-vn-cfg-usemacro').on('change', function() { extension_settings[MODULE_NAME].useMacro = jQuery(this).is(':checked'); saveSettingsDebounced(); injectCombinedSocialPrompt(); });
    jQuery('.bb-vn-impact-input').on('change', function() {
        const scaleKey = String(jQuery(this).data('impact-scale') || '').trim();
        const key = String(jQuery(this).data('impact-key') || '').trim();
        if (!scaleKey || !key) return;
        const currentImpactValues = normalizeImpactSettings(extension_settings[MODULE_NAME][scaleKey]);
        const fallback = currentImpactValues[key];
        const normalized = normalizeImpactValue(jQuery(this).val(), fallback);
        extension_settings[MODULE_NAME][scaleKey] = {
            ...currentImpactValues,
            [key]: normalized,
        };
        jQuery(this).val(normalized);
        saveSettingsDebounced();
        recalculateAllStats(false);
    });
    jQuery('#bb-vn-impact-reset').on('click', function() {
        const defaults = resolveImpactScaleSettings();
        extension_settings[MODULE_NAME].friendshipImpactValues = defaults.friendshipImpactValues;
        extension_settings[MODULE_NAME].romanceImpactValues = defaults.romanceImpactValues;
        IMPACT_SCALE_GROUPS.forEach(group => {
            IMPACT_SETTING_FIELDS.forEach(field => {
                jQuery(`.bb-vn-impact-input[data-impact-scale="${group.key}"][data-impact-key="${field.key}"]`).val(defaults[group.key][field.key]);
            });
        });
        saveSettingsDebounced();
        recalculateAllStats(false);
        notifySuccess(t("Обе шкалы сброшены."));
    });

    jQuery('#bb-vn-btn-connect').on('click', async function() {
        const btn = jQuery(this); btn.html('...');
        clearCustomApiRuntimeState();
        setCustomApiStatus('pending', t('Проверяем подключение и загружаем модели...'));
        try {
            const rawUrl = String(jQuery('#bb-vn-cfg-url').val() || '').trim();
            const rawKey = String(jQuery('#bb-vn-cfg-key').val() || '').trim();
            if (!rawUrl) throw new Error(t('URL пустой'));

            extension_settings[MODULE_NAME].customApiUrl = rawUrl;
            extension_settings[MODULE_NAME].customApiKey = rawKey;

            // @ts-ignore
            const response = await fetch(rawUrl.replace(/\/$/, '') + '/models', { headers: { 'Authorization': `Bearer ${rawKey}` } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data?.data) {
                const modelIds = data.data.map(m => m?.id).filter(Boolean);
                applyModelOptions(modelIds, extension_settings[MODULE_NAME].customApiModel || '');
                lastVerifiedCustomApiFingerprint = buildCustomApiFingerprint(rawUrl, rawKey);
                clearCustomApiRuntimeState();
                const activeModel = String(extension_settings[MODULE_NAME].customApiModel || jQuery('#bb-vn-cfg-model').val() || '').trim();
                setCustomApiStatus('connected', activeModel
                    ? ui`Подключено: ${activeModel}. Найдено моделей: ${modelIds.length}.`
                    : ui`Подключено. Найдено моделей: ${modelIds.length}.`);
                saveSettingsDebounced();
                notifySuccess(t("Модели загружены!"));
            } else {
                throw new Error(t('Список моделей пустой'));
            }
        } catch (e) {
            lastVerifiedCustomApiFingerprint = '';
            clearCustomApiRuntimeState();
            const savedModel = String(extension_settings[MODULE_NAME].customApiModel || '').trim();
            if (savedModel) setCustomApiModelPlaceholder(ui`${savedModel} · подключение не подтверждено`, savedModel);
            else setCustomApiModelPlaceholder(t('Подключение не удалось'));
            setCustomApiStatus('error', t('Ошибка подключения. Проверьте URL, ключ и доступность API.'));
            console.error('[BB VN] Custom API connection failed:', normalizeRequestError(e).code);
            notifyError(t("Ошибка подключения или пустой список моделей."));
        } finally { btn.html(t('Подключиться')); }
    });

    syncCustomApiVisualState();

    jQuery('#bb-dbg-add-pts').on('click', () => injectDebugData('major_positive'));
    jQuery('#bb-dbg-sub-pts').on('click', () => injectDebugData('major_negative'));
    jQuery('#bb-dbg-add-romance').on('click', () => injectDebugData('major_positive', true));
    jQuery('#bb-dbg-sub-romance').on('click', () => injectDebugData('major_negative', true));
    jQuery('#bb-dbg-add-deep-pos').on('click', () => injectDebugData('life_changing', false));
    jQuery('#bb-dbg-add-deep-neg').on('click', () => injectDebugData('unforgivable', false));
    jQuery('#bb-dbg-add-deep-mixed').on('click', () => injectMixedDeepDebugData());

    jQuery('#bb-dbg-add-trait-pos').on('click', function() {
        const charName = String(jQuery('#bb-debug-char-name').val()).trim();
        const trait = normalizeDebugTraitText(jQuery('#bb-debug-reason').val(), t('Светлая черта'));
        if(!charName || !trait) return notifyError(t("Укажите имя и текст черты!"));
        const chat = SillyTavern.getContext().chat; if (!chat?.length) return;
        const targetMessage = getLatestAssistantMessageEntry(chat);
        if (!targetMessage) return notifyError(t("Нет сообщения персонажа для привязки черты."));
        const lastMsg = targetMessage.message; const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {}; if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
        lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName, trait, type: 'positive', scope: getCurrentPersonaScopeKey() });
        markSnapshotReplayMessage(targetMessage.messageId, sId, 'debug-trait');
        saveChatDebounced(); recalculateAllStats(false); notifySuccess(t("Черта внедрена."));
    });

    jQuery('#bb-dbg-add-trait-neg').on('click', function() {
        const charName = String(jQuery('#bb-debug-char-name').val()).trim();
        const trait = normalizeDebugTraitText(jQuery('#bb-debug-reason').val(), t('Мрачная черта'));
        if(!charName || !trait) return notifyError(t("Укажите имя и текст черты!"));
        const chat = SillyTavern.getContext().chat; if (!chat?.length) return;
        const targetMessage = getLatestAssistantMessageEntry(chat);
        if (!targetMessage) return notifyError(t("Нет сообщения персонажа для привязки черты."));
        const lastMsg = targetMessage.message; const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {}; if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
        lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName, trait, type: 'negative', scope: getCurrentPersonaScopeKey() });
        markSnapshotReplayMessage(targetMessage.messageId, sId, 'debug-trait');
        saveChatDebounced(); recalculateAllStats(false); notifySuccess(t("Черта внедрена."));
    });

    jQuery('#bb-dbg-set-status').on('click', function() {
        const charName = String(jQuery('#bb-debug-char-name').val()).trim();
        const status = String(jQuery('#bb-debug-reason').val()).trim();
        if(!charName || !status) return notifyError(t("Укажите имя и статус!"));
        const chat = SillyTavern.getContext().chat; if (!chat?.length) return;
        const targetMessage = getLatestAssistantMessageEntry(chat);
        if (!targetMessage) return notifyError(t("Нет сообщения персонажа для привязки статуса."));
        const lastMsg = targetMessage.message; const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {}; if (!lastMsg.extra.bb_social_swipes) lastMsg.extra.bb_social_swipes = {};
        if (!lastMsg.extra.bb_social_swipes[sId]) lastMsg.extra.bb_social_swipes[sId] = [];
        lastMsg.extra.bb_social_swipes[sId].push({ name: charName, friendship_impact: "none", romance_impact: "none", status, manual_status: true, reason: t("Ручная смена статуса"), emotion: t("дебаг"), event_created_at: makeDebugEventTimestamp(), scope: getCurrentPersonaScopeKey() });
        markSnapshotReplayMessage(targetMessage.messageId, sId, 'debug-status');
        saveChatDebounced(); recalculateAllStats(false); notifySuccess(t("Статус изменен."));
    });

    jQuery('#bb-dbg-btn-merge').on('click', async function() {
        bindActivePersonaState();
        const from = String(jQuery('#bb-dbg-merge-from').val()).trim(), to = String(jQuery('#bb-dbg-merge-to').val()).trim();
        if(!from || !to || from === to) return notifyError(t("Некорректные имена!"));

        let confirmed = false;
        try {
            confirmed = await SillyTavern.getContext().callPopup(
                ui`<h3>Подтвердить слияние?</h3><p><strong>${from}</strong> будет объединён с <strong>${to}</strong>.</p><p><span style="font-size:12px; color:#94a3b8;">Это затронет журнал, память, связи и алиасы. Перед слиянием лучше сделать снапшот.</span></p>`,
                'confirm'
            );
        } catch (error) {
            console.warn('[BB VN] Failed to show merge confirmation popup', error);
            confirmed = false;
        }

        if (!confirmed) {
            notifyInfo(t('Слияние отменено.'));
            return;
        }

        const result = mergeCharacterRecords(from, to);
        if(result.ok) { saveChatDebounced(); recalculateAllStats(false); renderMergeSuggestionsList(); notifySuccess(result.same ? ui`Это уже один и тот же персонаж: ${result.targetName}` : ui`Слито записей: ${result.count}`); } else notifyError(t("Персонаж не найден."));
    });

    jQuery('#bb-dbg-reset-char').on('click', () => {
        const { scopeState, aliasSet } = bindActivePersonaState();
        const name = String(jQuery('#bb-debug-char-name').val()).trim();
        if(!name) return notifyError(t("Укажите имя!"));
        const resolved = resolveCharacterIdentity(name, { allowCreate: false, allowSuggestions: false });
        const canonicalName = resolved?.primaryName || name;
        if(chat_metadata['bb_vn_char_bases']) delete chat_metadata['bb_vn_char_bases'][canonicalName];
        if(chat_metadata['bb_vn_char_bases_romance']) delete chat_metadata['bb_vn_char_bases_romance'][canonicalName];
        if (resolved?.id && chat_metadata['bb_vn_char_registry']) delete chat_metadata['bb_vn_char_registry'][resolved.id];
        if (scopeState.snapshot_baseline?.characters) delete scopeState.snapshot_baseline.characters[canonicalName];
        if (scopeState.snapshot_baseline?.char_bases) delete scopeState.snapshot_baseline.char_bases[canonicalName];
        if (scopeState.snapshot_baseline?.char_bases_romance) delete scopeState.snapshot_baseline.char_bases_romance[canonicalName];
        const matchesTargetCharacter = (value = '') => {
            const raw = String(value || '').trim();
            if (!raw) return false;
            if (raw === name || raw === canonicalName) return true;
            const resolvedTarget = resolveCharacterIdentity(raw, { allowCreate: false, allowSuggestions: false });
            return (resolvedTarget?.primaryName || raw) === canonicalName;
        };
        const chat = SillyTavern.getContext().chat;
        if(chat) {
            chat.forEach(msg => {
                if(msg.extra?.bb_social_swipes) { for(const sId in msg.extra.bb_social_swipes) { if(Array.isArray(msg.extra.bb_social_swipes[sId])) msg.extra.bb_social_swipes[sId] = msg.extra.bb_social_swipes[sId].filter(u => (u?.scope && !aliasSet.has(u.scope)) || !matchesTargetCharacter(u.name)); } }
                if(msg.extra?.bb_vn_char_traits_swipes) { for(const sId in msg.extra.bb_vn_char_traits_swipes) { if(Array.isArray(msg.extra.bb_vn_char_traits_swipes[sId])) msg.extra.bb_vn_char_traits_swipes[sId] = msg.extra.bb_vn_char_traits_swipes[sId].filter(t => (t?.scope && !aliasSet.has(t.scope)) || !matchesTargetCharacter(t.charName)); } }
            });
        }
        saveChatDebounced(); recalculateAllStats(false); notifySuccess(t("Персонаж обнулен."));
    });

    jQuery('#bb-dbg-toast').on('click', () => {
        const sample = [
            { title: t('Тестовый сигнал'), text: t('Проверка системного уведомления.'), badge: t('Дебаг'), variant: 'system', icon: 'fa-solid fa-bug' },
            { title: t('Память отозвалась'), text: t('Так выглядит тематический toast памяти.'), badge: t('Дебаг'), variant: 'memory', icon: 'fa-solid fa-book-open-reader' },
            { title: t('Связь потеплела'), text: t('Так выглядит toast сближения.'), badge: t('Дебаг'), variant: 'bond', icon: 'fa-solid fa-handshake-angle' },
            { title: t('Искра сработала'), text: t('Так выглядит романтический toast.'), badge: t('Дебаг'), variant: 'romance', icon: 'fa-solid fa-heart' },
            { title: t('Надлом маршрута'), text: t('Так выглядит тревожный toast разлада.'), badge: t('Дебаг'), variant: 'fracture', icon: 'fa-solid fa-heart-crack' },
            { title: t('Редкий момент'), text: t('Так выглядит усиленный toast крупного события.'), badge: t('Дебаг'), variant: 'legendary', icon: 'fa-solid fa-gem' },
        ][Math.floor(Math.random() * 6)];
        const types = ['system', 'memory', 'bond', 'romance', 'fracture', 'legendary'];
        showHudToast(sample);
    });

    jQuery('#bb-social-export-btn').on('click', () => {
        bindActivePersonaState();
        recalculateAllStats(false);
        const snapshot = exportActivePersonaSnapshot();
        downloadSnapshotFile(snapshot);
        const characterCount = Object.keys(snapshot?.data?.characters || {}).length;
        notifySuccess(ui`Snapshot экспортирован: ${characterCount} персонажей.`);
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
            const result = await confirmSnapshotFile(file, {
                getContext: () => SillyTavern.getContext(),
                getPersonaKey: getCurrentPersonaScopeKey,
                confirm: summary => SillyTavern.getContext().callPopup(ui`
                    <h3>Импорт снимка состояния</h3>
                    <p>Файл: <strong>${escapeHtml(file.name)}</strong></p>
                    <p>Персона в файле: ${escapeHtml(summary.persona || t('Не указана'))}</p>
                    <p>Активная персона: ${escapeHtml(SillyTavern.getContext().substituteParams('{{user}}'))}</p>
                    <p>Формат: ${escapeHtml(summary.format)} · Экспорт: ${escapeHtml(summary.exportedAt || t('Не указан'))}</p>
                    <p>Персонажей: ${summary.characters} · Записей журнала: ${summary.logs} · Событий дневника: ${summary.moments}</p>
                    <p>Будут заменены текущая база отношений, память, черты, профили, скрытые и платонические персонажи, журнал и дневник активной персоны. Это замена, а не объединение.</p>
                    <p>Сообщения чата не меняются. Для возврата к состоянию до первого импорта используйте «Убрать импортированную основу». Старые события до точки импорта повторно не учитываются; новые события продолжают считаться.</p>
                    <p>Продолжить импорт?</p>`, 'confirm'),
                apply: importActivePersonaSnapshot,
            });
            if (!result) return;
            refreshSnapshotControls(bindActivePersonaState().scopeState);
            saveChatDebounced();
            recalculateAllStats(false);
            notifySuccess(ui`Snapshot импортирован: ${result.characters} персонажей. Старые события до точки импорта больше не наслаиваются повторно.`);
        } catch (error) {
            console.error('[BB VN] Snapshot import failed.');
            const messages = {
                SNAPSHOT_TOO_LARGE: 'Снимок слишком большой. Максимальный размер — 20 МиБ.',
                SNAPSHOT_WRONG_MODULE: 'Этот снимок создан не Visual Novel Engine.',
                SNAPSHOT_UNSUPPORTED_VERSION: 'Версия снимка не поддерживается. Импорт отменён.',
                SNAPSHOT_CONTEXT_CHANGED: 'Чат или персона изменились во время импорта. Выберите файл заново.',
            };
            notifyError(t(messages[error.message] || 'Не удалось импортировать snapshot. Проверьте JSON-файл.'));
        } finally {
            jQuery(this).val('');
        }
    });

    jQuery('#bb-social-clear-snapshot-btn').on('click', async () => {
        try {
            const removed = await confirmSnapshotRemoval({
                getContext: () => SillyTavern.getContext(),
                getPersonaKey: getCurrentPersonaScopeKey,
                getScope: () => bindActivePersonaState().scopeState,
                confirm: hasRestore => SillyTavern.getContext().callPopup(snapshotRemovalPrompt(hasRestore), 'confirm'),
                clear: clearActivePersonaSnapshot,
            });
            if (!removed) return;
            saveChatDebounced();
            recalculateAllStats(false);
            notifyInfo(t('Импортированная основа убрана. Отношения пересчитаны по данным чата.'));
        } catch (error) {
            notifyError(t(error.message === 'SNAPSHOT_CONTEXT_CHANGED'
                ? 'Чат, персона или импорт изменились. Действие отменено; проверьте текущее состояние и повторите.'
                : 'Не удалось убрать импортированную основу.'));
        } finally {
            refreshSnapshotControls(bindActivePersonaState().scopeState);
        }
    });

    jQuery('#bb-social-restore-chars-btn').on('click', () => { const { scopeState } = bindActivePersonaState(); scopeState.ignored_chars = []; chat_metadata['bb_vn_ignored_chars'] = scopeState.ignored_chars; saveChatDebounced(); recalculateAllStats(); notifySuccess(t("Скрытые персонажи восстановлены!")); });
    jQuery('#bb-social-clear-log-btn').on('click', wipeGlobalLog);
    jQuery('#bb-social-wipe-btn').on('click', wipeAllSocialData);
    renderMergeSuggestionsList();
}
