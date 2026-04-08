/* global SillyTavern */
import { chat_metadata, saveChatDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { currentCalculatedStats, currentStoryMoments, socialParseDebug } from './state.js';
import { 
    escapeHtml, 
    getToneClass, 
    formatAffinityPoints, 
    getShiftDescriptor,
    getAffinityNarrative,
    normalizeTraitResponse
} from './utils.js';
import { syncToastContainerWithHud, notifySuccess, notifyInfo, notifyError } from './toasts.js';
import { 
    getTierInfo, 
    getTrendNarrative, 
    getUnforgettableImpact, 
    getUnforgettableRoleStatus,
    recalculateAllStats,
    getCombinedSocial,
    bindActivePersonaState,
    getCurrentPersonaScopeKey
} from './social.js';
import { crystallizeTraitFromMemories } from './generator.js';

const HUD_VISIBILITY_RETRY_MS = 120;
let hudVisibilityRetryTimer = null;

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
            let cardsHtml = '';
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
                    ? [...allDeepMemories].reverse().map(memory => `<div class="bb-memory-pill deep ${memory.tone}">${escapeHtml(memory.text)}</div>`).join('')
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

            charsBox.innerHTML = `
                <div class="bb-panel-hero bb-panel-hero-route">
                    <div class="bb-panel-kicker">Связи</div><div class="bb-panel-headline">Состояние отношений</div><div class="bb-panel-subtitle">Здесь показаны текущие связи, изменения и важные воспоминания по персонажам.</div>
                    <div class="bb-panel-stat-grid"><div class="bb-panel-stat"><span class="bb-panel-stat-label">Связей</span><strong>${visibleCharacters}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Главный фокус</span><strong>${escapeHtml(topCharacterName || '—')}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Макс. значение</span><strong>${topCharacterName ? (topAffinity > 0 ? '+' : '') + topAffinity : '—'}</strong></div><div class="bb-panel-stat"><span class="bb-panel-stat-label">Глубоких следов</span><strong>${deepMomentsCount}</strong></div></div>
                </div>
                <div class="bb-route-card-stack">${cardsHtml}</div>
            `;

            jQuery('.bb-char-card').off('click').on('click', function(e) {
                if (jQuery(e.target).closest('.bb-char-edit-btn, .bb-char-editor, .bb-btn-crystallize-pos, .bb-btn-crystallize-neg').length) return;
                jQuery(this).toggleClass('expanded');
            });

            jQuery('.bb-char-edit-btn').off('click').on('click', function(e) {
                e.stopPropagation();
                jQuery(this).closest('.bb-char-card').find('.bb-char-editor').slideToggle(200);
            });

            jQuery('.bb-btn-save-char').off('click').on('click', function() {
                bindActivePersonaState();
                const charName = jQuery(this).attr('data-char');
                const editor = jQuery(this).closest('.bb-char-editor');
                const newBase = parseInt(String(editor.find('.bb-edit-base-input').val()), 10);
                const newRomance = parseInt(String(editor.find('.bb-edit-romance-input').val()), 10);
                const isPlatonic = editor.find('.bb-edit-platonic-cb').is(':checked');
                
                if (!isNaN(newBase)) { if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {}; chat_metadata['bb_vn_char_bases'][charName] = newBase; }
                if (!isNaN(newRomance)) { if (!chat_metadata['bb_vn_char_bases_romance']) chat_metadata['bb_vn_char_bases_romance'] = {}; chat_metadata['bb_vn_char_bases_romance'][charName] = newRomance; }
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (isPlatonic) { if (!chat_metadata['bb_vn_platonic_chars'].includes(charName)) chat_metadata['bb_vn_platonic_chars'].push(charName); }
                else { chat_metadata['bb_vn_platonic_chars'] = chat_metadata['bb_vn_platonic_chars'].filter(c => c !== charName); }
                saveChatDebounced(); recalculateAllStats(); notifySuccess("Настройки сохранены!");
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
                    saveChatDebounced(); recalculateAllStats(); notifySuccess(`Черта характера кристаллизована!`);
                } catch (e) {
                    notifyError("Не удалось кристаллизовать память.");
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
