/* global jQuery, SillyTavern, toastr */

import { setExtensionPrompt, chat_metadata, saveChatDebounced, extension_prompt_roles, extension_prompt_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = "BB-Visual-Novel";

if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = { autoSend: true, autoGen: false };
}

let currentCalculatedStats = {};

// ==========================================
// ФАЗА 1: СОЦИАЛЬНЫЙ ТРЕКИНГ (DEEP SYNC)
// ==========================================
const SOCIAL_PROMPT = `[SYSTEM INSTRUCTION: VISUAL NOVEL ENGINE]
You are tracking the relationship affinities between {{user}} and the characters. 
At the VERY END of your response, you MUST generate a hidden JSON block evaluating how {{user}}'s last action or the current event affected the characters physically present in the scene.
CRITICAL: If this is the FIRST TIME you are evaluating a character in this JSON, you MUST provide a "base_affinity" (integer from -100 to 100) estimating their current overall relationship with {{user}} based on the established lore and past events (e.g., close friends = 60 to 80, enemies = -50). 
CRITICAL: You MUST provide a "status" (1-3 words) describing the CURRENT dynamic/nature of their relationship (e.g., "Тайная симпатия", "Соперник", "Лучшая подруга", "Насторожен"). This status MUST evolve naturally based on the plot!
Only include characters whose affinity logically changed in this exact turn. "delta" must be an integer. "reason" must be a short explanation.

CRITICAL LANGUAGE RULE: Output the JSON values ENTIRELY IN RUSSIAN.

<format>
\`\`\`json
{
  "social_updates": [
    { "name": "Имя Персонажа", "base_affinity": 60, "delta": 5, "status": "Тайная симпатия", "reason": "Краткая причина на русском" }
  ]
}
\`\`\`
</format>`;

function injectSocialPrompt() {
    try {
        setExtensionPrompt('bb_social_injector', SOCIAL_PROMPT, extension_prompt_types.IN_CHAT, 3, false, extension_prompt_roles.SYSTEM);
    } catch (e) { console.error("[BB VN] Ошибка инъекции:", e); }
}

function injectSocialStatePrompt() {
    try {
        const characters = Object.keys(currentCalculatedStats);
        if (characters.length === 0) {
            setExtensionPrompt('bb_social_state_injector', '', extension_prompt_types.IN_CHAT, 4);
            return;
        }
        
        let stateStr = "[CURRENT RELATIONSHIP STATUS WITH {{user}}]:\n";
        characters.forEach(char => {
            const statusLabel = currentCalculatedStats[char].status || getTierInfo(currentCalculatedStats[char].affinity).label;
            stateStr += `- ${char}: ${currentCalculatedStats[char].affinity}/100 (${statusLabel})\n`;
        });
        stateStr += "CRITICAL: Strictly align the characters' behavior, trust level, and dialogue towards {{user}} with these current affinity levels.";
        
        setExtensionPrompt('bb_social_state_injector', stateStr, extension_prompt_types.IN_CHAT, 4, false, extension_prompt_roles.SYSTEM);
    } catch (e) { console.error("[BB VN] Ошибка инъекции состояния:", e); }
}

function ensureToastContainer() {
    if (!document.getElementById('bb-social-toast-container')) {
        const extraClass = $('#bb-social-hud').hasClass('open') ? 'hud-open' : '';
        $('body').append(`<div id="bb-social-toast-container" class="${extraClass}"></div>`);
    }
}

function showAffinityToast(name, delta, reason) {
    ensureToastContainer();
    const isPositive = delta > 0;
    const sign = isPositive ? '+' : '';
    const typeClass = isPositive ? 'positive' : 'negative';
    const initial = name.charAt(0).toUpperCase();

    const toastHtml = `
        <div class="bb-social-toast ${typeClass}">
            <div class="bb-st-icon">${initial}</div>
            <div class="bb-st-content">
                <div class="bb-st-header">
                    <span class="bb-st-name">${name}</span>
                    <span class="bb-st-delta">${sign}${delta}</span>
                </div>
                <span class="bb-st-reason">"${reason}"</span>
            </div>
        </div>
    `;
    const $toast = $(toastHtml);
    $('#bb-social-toast-container').append($toast);
    setTimeout(() => { $toast.remove(); }, 5000);
}

function getTierInfo(affinity) {
    if (affinity <= -50) return { label: 'Враг', class: 'tier-enemy', color: '#ef4444' };
    if (affinity < -10) return { label: 'Неприязнь', class: 'tier-enemy', color: '#f87171' };
    if (affinity <= 10) return { label: 'Незнакомец', class: 'tier-neutral', color: '#a1a1aa' };
    if (affinity <= 50) return { label: 'Приятель', class: 'tier-friend', color: '#4ade80' };
    if (affinity <= 80) return { label: 'Друг', class: 'tier-friend', color: '#22c55e' };
    return { label: 'Близкий', class: 'tier-close', color: '#c084fc' };
}

function addGlobalLog(type, text) {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) return;
    
    if (!chat_metadata['bb_vn_global_log']) chat_metadata['bb_vn_global_log'] = [];
    
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    chat_metadata['bb_vn_global_log'].push({ time, type, text });
    
    if (chat_metadata['bb_vn_global_log'].length > 50) chat_metadata['bb_vn_global_log'].shift();
}

function scanAndCleanMessage(msg, messageId) {
    if (!msg || msg.is_user) return false;
    let modified = false;

    const jsonRegex = /```json\s*({[\s\S]*?"social_updates"[\s\S]*?})\s*```/;
    const match = msg.mes.match(jsonRegex);
    const swipeId = msg.swipe_id || 0;

    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.bb_social_swipes) msg.extra.bb_social_swipes = {};
            
            msg.extra.bb_social_swipes[swipeId] = parsed.social_updates;
            
            msg.mes = msg.mes.replace(match[0], '').trim();
            if (msg.swipes && msg.swipes[swipeId] !== undefined) {
                msg.swipes[swipeId] = msg.mes; 
            }
            modified = true;
            
            if (messageId !== undefined) {
                const msgElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
                if (msgElement) {
                    msgElement.innerHTML = SillyTavern.getContext().markdownToHtml(msg.mes);
                }
            }
        } catch(e) {}
    }
    return modified;
}

function recalculateAllStats(isNewMessage = false) {
    currentCalculatedStats = {};
    const chat = SillyTavern.getContext().chat;
    if (!chat || !chat.length) {
        renderSocialHud();
        injectSocialStatePrompt();
        return;
    }

    let needsSave = false;

    chat.forEach((msg, idx) => {
        if (scanAndCleanMessage(msg, idx)) {
            needsSave = true;
        }

        const swipeId = msg.swipe_id || 0;
        let activeUpdates = msg.extra?.bb_social_swipes?.[swipeId];

        // === ИСПРАВЛЕНИЕ: ЗАЩИТА ПРИ ОТМЕНЕ СВАЙПА ===
        // Если в текущем свайпе нет данных (отменили генерацию), ищем данные в других свайпах ЭТОГО ЖЕ сообщения
        if (!activeUpdates || !Array.isArray(activeUpdates)) {
            if (msg.extra && msg.extra.bb_social_swipes) {
                for (const key in msg.extra.bb_social_swipes) {
                    if (Array.isArray(msg.extra.bb_social_swipes[key])) {
                        activeUpdates = msg.extra.bb_social_swipes[key];
                        break; // Забираем статы из успешного свайпа!
                    }
                }
            }
        }

        if (activeUpdates && Array.isArray(activeUpdates)) {
            activeUpdates.forEach(update => {
                const charName = update.name;
                const delta = parseInt(update.delta) || 0;
                
                let base = 0;
                if (!currentCalculatedStats[charName]) {
                    base = update.base_affinity !== undefined ? parseInt(update.base_affinity) : 0;
                    if (isNaN(base)) base = 0;
                    currentCalculatedStats[charName] = { affinity: base, history: [], status: update.status || "" };
                    
                    if (isNewMessage && idx === chat.length - 1) {
                        addGlobalLog('init', `Встреча: <strong>${escapeHtml(charName)}</strong>. Базовое отношение: ${base}`);
                    }
                }
                
                currentCalculatedStats[charName].affinity += delta;
                if (currentCalculatedStats[charName].affinity > 100) currentCalculatedStats[charName].affinity = 100;
                if (currentCalculatedStats[charName].affinity < -100) currentCalculatedStats[charName].affinity = -100;
                
                if (update.status) {
                    currentCalculatedStats[charName].status = update.status;
                }

                currentCalculatedStats[charName].history.push({ delta, reason: update.reason || "" });
                
                if (isNewMessage && idx === chat.length - 1 && delta !== 0) {
                    showAffinityToast(charName, delta, update.reason || "");
                    const sign = delta > 0 ? '+' : '';
                    addGlobalLog(delta > 0 ? 'plus' : 'minus', `<strong>${escapeHtml(charName)}</strong>: ${sign}${delta} <i>(${escapeHtml(update.reason)})</i>`);
                }
            });
        }
    });

    if (needsSave) saveChatDebounced();
    injectSocialStatePrompt();
    renderSocialHud();
}

// ==========================================
// ФАЗА 2: ОТРИСОВКА ХУДА (SOCIAL LINK)
// ==========================================
function renderSocialHud() {
    const charsBox = document.getElementById('bb-hud-chars');
    if (charsBox) {
        const characters = Object.keys(currentCalculatedStats);
        if (characters.length === 0) {
            charsBox.innerHTML = `<div class="bb-empty-hud">Здесь пока пусто.<br>Взаимодействуйте с персонажами.</div>`;
        } else {
            let html = '';
            characters.sort((a, b) => currentCalculatedStats[b].affinity - currentCalculatedStats[a].affinity).forEach(charName => {
                const affinity = currentCalculatedStats[charName].affinity;
                const tier = getTierInfo(affinity);
                const displayStatus = currentCalculatedStats[charName].status || tier.label;
                
                let barStyle = '';
                if (affinity >= 0) {
                    const w = Math.min(100, affinity);
                    barStyle = `left: 50%; width: ${w / 2}%; background-color: ${tier.color};`;
                } else {
                    const w = Math.min(100, Math.abs(affinity));
                    barStyle = `right: 50%; width: ${w / 2}%; background-color: ${tier.color};`;
                }

                let historyHtml = '';
                const historyArr = currentCalculatedStats[charName].history || [];
                [...historyArr].reverse().forEach(h => {
                    const sign = h.delta > 0 ? '+' : '';
                    const color = h.delta > 0 ? '#4ade80' : '#ef4444';
                    if (h.delta !== 0) {
                        historyHtml += `<div class="bb-log-entry"><span class="bb-log-delta" style="color:${color}">${sign}${h.delta}</span> <span class="bb-log-reason">"${escapeHtml(h.reason)}"</span></div>`;
                    }
                });
                if(historyHtml === '') historyHtml = '<i style="color:#64748b;">Нет записей</i>';

                html += `
                    <div class="bb-char-card" data-char="${escapeHtml(charName)}">
                        <div class="bb-char-header">
                            <span class="bb-char-name">${charName}</span>
                            <span class="bb-char-tier ${tier.class}" title="${escapeHtml(displayStatus)}">${escapeHtml(displayStatus)}</span>
                        </div>
                        <div class="bb-progress-bg">
                            <div class="bb-progress-center-line"></div>
                            <div class="bb-progress-fill" style="${barStyle}"></div>
                        </div>
                        <div class="bb-char-stats">
                            <span>Отношение: ${affinity}</span>
                            <span>${affinity >= 0 ? 'Макс: 100' : 'Мин: -100'}</span>
                        </div>
                        <div class="bb-char-log">
                            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Журнал:</div>
                            ${historyHtml}
                        </div>
                    </div>
                `;
            });
            charsBox.innerHTML = html;

            $('.bb-char-card').off('click').on('click', function() {
                $(this).toggleClass('expanded');
            });
        }
    }

    const logBox = document.getElementById('bb-hud-log');
    if (logBox) {
        const logs = chat_metadata['bb_vn_global_log'] || [];
        if (logs.length === 0) {
            logBox.innerHTML = `<div class="bb-empty-hud">Журнал событий пуст.</div>`;
        } else {
            let logHtml = '';
            [...logs].reverse().forEach(log => {
                logHtml += `
                    <div class="bb-glog-item ${log.type}">
                        <span class="bb-glog-time">[${log.time}]</span>
                        <span class="bb-glog-text">${log.text}</span>
                    </div>
                `;
            });
            logBox.innerHTML = logHtml;
        }
    }
}

function ensureHudContainer() {
    if (document.getElementById('bb-social-hud')) return;
    const hudHtml = `
        <div id="bb-social-hud">
            <div id="bb-social-hud-toggle" title="Social Link">
                <i class="fa-solid fa-users"></i>
                <i class="fa-solid fa-chevron-left" id="bb-hud-arrow" style="font-size: 10px; margin-top: 5px;"></i>
            </div>
            <div class="bb-hud-header">Social Link</div>
            
            <div class="bb-hud-tabs">
                <div class="bb-hud-tab active" data-tab="chars">👥 Связи</div>
                <div class="bb-hud-tab" data-tab="log">📜 Журнал</div>
            </div>

            <div class="bb-hud-content active" id="bb-hud-chars"></div>
            <div class="bb-hud-content" id="bb-hud-log"></div>
        </div>
    `;
    $('body').append(hudHtml);

    $('.bb-hud-tab').on('click', function() {
        $('.bb-hud-tab').removeClass('active');
        $('.bb-hud-content').removeClass('active');
        $(this).addClass('active');
        $(`#bb-hud-${$(this).data('tab')}`).addClass('active');
    });

    $('#bb-social-hud-toggle').on('click', function() {
        const hud = $('#bb-social-hud');
        const toastCont = $('#bb-social-toast-container');
        hud.toggleClass('open');
        
        if (hud.hasClass('open')) {
            toastCont.addClass('hud-open');
            $('#bb-hud-arrow').removeClass('fa-chevron-left').addClass('fa-chevron-right');
            renderSocialHud();
        } else {
            toastCont.removeClass('hud-open');
            $('#bb-hud-arrow').removeClass('fa-chevron-right').addClass('fa-chevron-left');
        }
    });
}

// ==========================================
// ФАЗА 3: ИНТЕРАКТИВНОЕ КИНО
// ==========================================

const OPTIONS_PROMPT = `<task>
Analyze the recent chat. Create 3 highly distinct, engaging actions {{user}} can take right now to respond to the situation.
Make them feel like Visual Novel choices.
Return STRICTLY as a JSON object in this format:
{
  "options": [
    {
      "intent": "МАКСИМУМ 1-3 СЛОВА (например: 'Уйти на крышу', 'Грубо ответить')",
      "risk": "Низкий/Средний/Высокий"
    }
  ]
}
</task>
Recent Chat:
"""{{chat}}"""`;

const EXPAND_PROMPT = `<task>
Act as {{user}}. Write {{user}}'s next roleplay message based EXACTLY on this intent: "{{intent}}".
The user has chosen an action with a "{{risk}}" risk level. Reflect this in the boldness, emotional intensity, or stakes of the response!
Write ONLY {{user}}'s actions, thoughts, and dialogue. Do NOT act or speak for ANY other characters.
Keep the length medium (1-3 paragraphs). Write in Russian. Match {{user}}'s established personality perfectly.
CRITICAL: DO NOT output any JSON, <info> tags, RADIO_START, SCENE tags, or OS_START widgets. Output ONLY the raw narrative text for {{user}}'s message.
</task>
Recent Chat:
"""{{chat}}"""`;

function injectVNActionsUI() {
    if (document.getElementById('bb-vn-action-bar')) return;

    const barHtml = `
        <div id="bb-vn-action-bar" style="display: flex;">
            <div id="bb-vn-btn-generate" class="bb-vn-main-btn">
                <i class="fa-solid fa-clapperboard"></i> Сгенерировать варианты действий
            </div>
            <div id="bb-vn-options-container"></div>
        </div>
    `;

    $('#send_form').prepend(barHtml);

    /** @type {HTMLTextAreaElement | null} */
    const ta = document.querySelector('#send_textarea');
    if (ta) {
        ta.addEventListener('input', () => {
            const bar = document.getElementById('bb-vn-action-bar');
            if (!bar) return;
            if (ta.value.trim().length > 0) {
                bar.style.opacity = '0';
                bar.style.maxHeight = '0px';
                bar.style.padding = '0px 10px';
                bar.style.pointerEvents = 'none';
            } else {
                bar.style.opacity = '1';
                bar.style.maxHeight = '200px';
                bar.style.padding = '8px 10px';
                bar.style.pointerEvents = 'auto';
            }
        });
    }

    $('#bb-vn-btn-generate').on('click', async function() {
        const btn = $(this);
        if (btn.hasClass('loading')) return;

        btn.addClass('loading').html('<i class="fa-solid fa-spinner fa-spin"></i> Анализ ситуации...');
        $('#bb-vn-options-container').removeClass('active').empty();

        try {
            const chat = SillyTavern.getContext().chat;
            if (!chat || chat.length === 0) throw new Error("Чат пуст");
            const recentMessages = chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\\n\\n');

            const prompt = OPTIONS_PROMPT.replace('{{chat}}', recentMessages);
            // @ts-ignore
            const result = await SillyTavern.getContext().generateQuietPrompt(prompt);

            let cleanResult = String(result).trim().replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
            const start = cleanResult.indexOf('{');
            const end = cleanResult.lastIndexOf('}');
            if (start === -1 || end === -1) throw new Error("API не вернуло JSON");
            
            const parsed = JSON.parse(cleanResult.substring(start, end + 1));

            if (parsed.options && parsed.options.length > 0) {
                let optionsHtml = '';
                parsed.options.forEach(opt => {
                    let riskClass = 'risk-med';
                    const r = (opt.risk || '').toLowerCase();
                    if (r.includes('низкий') || r.includes('low')) riskClass = 'risk-low';
                    if (r.includes('высокий') || r.includes('high')) riskClass = 'risk-high';

                    optionsHtml += `
                        <div class="bb-vn-option ${riskClass}" data-intent="${escapeHtml(opt.intent)}" data-risk="${escapeHtml(opt.risk)}">
                            <div class="bb-vn-op-head">${opt.intent}</div>
                            <div class="bb-vn-op-risk">Риск: ${opt.risk || 'Неизвестно'}</div>
                        </div>
                    `;
                });
                
                optionsHtml += `<div class="bb-vn-option risk-med" id="bb-vn-btn-cancel" style="flex: 0 0 100%; text-align: center; border-color: #64748b;"><div class="bb-vn-op-head" style="justify-content:center;"><i class="fa-solid fa-xmark"></i>&nbsp; Отмена / Написать самостоятельно</div></div>`;

                $('#bb-vn-options-container').html(optionsHtml).addClass('active');
                btn.hide();

                $('.bb-vn-option').not('#bb-vn-btn-cancel').on('click', function() {
                    const intent = $(this).attr('data-intent');
                    const risk = $(this).attr('data-risk');
                    executeVNOption(intent, risk);
                });

                $('#bb-vn-btn-cancel').on('click', function() {
                    $('#bb-vn-options-container').removeClass('active').empty();
                    $('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Сгенерировать варианты действий');
                });
            }

        } catch (e) {
            console.error("[BB VN] Ошибка генерации опций:", e);
            // @ts-ignore
            toastr.error("Не удалось сгенерировать варианты");
            btn.removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Сгенерировать варианты действий');
        }
    });
}

async function executeVNOption(intent, risk) {
    const container = $('#bb-vn-options-container');
    const userName = SillyTavern.getContext().name1 || "Персонаж";
    container.html(`<div style="color: #c084fc; font-weight: bold; width: 100%; text-align: center; padding: 15px;"><i class="fa-solid fa-pen-nib fa-bounce"></i> ${escapeHtml(userName)} пишет сообщение...</div>`);

    try {
        const chat = SillyTavern.getContext().chat;
        const recentMessages = chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\\n\\n');
        
        // @ts-ignore
        const persona = SillyTavern.getContext().substituteParams('{{persona}}');
        
        let prompt = EXPAND_PROMPT.replace('{{intent}}', intent).replace('{{risk}}', risk).replace('{{chat}}', recentMessages);
        prompt += `\\n\\n[USER PERSONA REFERENCE]:\\n${persona}`;

        // @ts-ignore
        let generatedText = await SillyTavern.getContext().generateQuietPrompt(prompt);
        generatedText = String(generatedText || "").trim();
        
        if (!generatedText) {
            console.warn("[BB VN] ИИ вернул пустой ответ (choices: [])");
            // @ts-ignore
            toastr.warning("Сработал фильтр или сбой API. Попробуйте другой вариант.", "BB Visual Novel");
            container.removeClass('active').empty();
            $('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Сгенерировать варианты действий');
            return;
        }
        
        /** @type {HTMLTextAreaElement | null} */
        const textarea = document.querySelector('#send_textarea');
        if (textarea) {
            textarea.value = generatedText;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            
            container.removeClass('active').empty();
            $('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Сгенерировать варианты действий');

            if (extension_settings[MODULE_NAME].autoSend) {
                const sendBtn = document.getElementById('send_but');
                if (sendBtn) sendBtn.click();
            }
        }

    } catch (e) {
        console.error("[BB VN] Ошибка генерации ответа:", e);
        container.removeClass('active').empty();
        $('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Сгенерировать варианты действий');
    }
}

function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function wipeAllSocialData() {
    const chat = SillyTavern.getContext().chat;
    if (!chat) return;
    chat.forEach(msg => {
        if (msg.extra && msg.extra.bb_social_swipes) {
            delete msg.extra.bb_social_swipes;
        }
    });
    chat_metadata['bb_vn_global_log'] = [];
    addGlobalLog('system', 'Все отношения сброшены до нуля.');
    saveChatDebounced();
    recalculateAllStats();
    // @ts-ignore
    toastr.success("История отношений в этом чате полностью сброшена!");
}

function setupExtensionSettings() {
    if (document.getElementById('bb-social-settings-wrapper')) return;
    const settingsHtml = `
        <div id="bb-social-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💖 BB Visual Novel Engine</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <span style="font-size: 13px; color: #cbd5e1;">Настройки Интерактивного Кино:</span>
                
                <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-vn-cfg-autosend" ${extension_settings[MODULE_NAME].autoSend ? 'checked' : ''}>
                        <span>Авто-отправка сгенерированного ответа в чат</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-vn-cfg-autogen" ${extension_settings[MODULE_NAME].autoGen ? 'checked' : ''}>
                        <span>Авто-показ 3 вариантов действий при ответе ИИ</span>
                    </label>
                </div>

                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                <button id="bb-social-wipe-btn" class="menu_button" style="width: 100%; background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;"><i class="fa-solid fa-trash-can"></i> Сбросить отношения в этом чате</button>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.insertAdjacentHTML('beforeend', settingsHtml);

    $('#bb-vn-cfg-autosend').on('change', function() {
        extension_settings[MODULE_NAME].autoSend = $(this).is(':checked');
        // @ts-ignore
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    });
    $('#bb-vn-cfg-autogen').on('change', function() {
        extension_settings[MODULE_NAME].autoGen = $(this).is(':checked');
        // @ts-ignore
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    });

    const wipeBtn = document.getElementById('bb-social-wipe-btn');
    if (wipeBtn) wipeBtn.addEventListener('click', wipeAllSocialData);
}

// Запуск и привязка событий
jQuery(async () => {
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        
        setupExtensionSettings();
        injectSocialPrompt();
        injectSocialStatePrompt();
        ensureHudContainer();
        injectVNActionsUI();

        eventSource.on(event_types.APP_READY, () => {
            setupExtensionSettings();
            injectSocialPrompt();
            injectSocialStatePrompt();
            ensureHudContainer();
            injectVNActionsUI();
            recalculateAllStats(); 
        });
        
        eventSource.on(event_types.CHAT_CHANGED, () => {
            injectSocialPrompt();
            injectVNActionsUI();
            recalculateAllStats(); 
        });

        eventSource.on(event_types.MESSAGE_RECEIVED, () => { recalculateAllStats(true); }); 
        eventSource.on(event_types.MESSAGE_DELETED, () => { recalculateAllStats(); });
        eventSource.on(event_types.MESSAGE_SWIPED, () => { recalculateAllStats(); });
        eventSource.on(event_types.MESSAGE_UPDATED, () => { recalculateAllStats(); });
        eventSource.on(event_types.GENERATION_STOPPED, () => { recalculateAllStats(); });

        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            if (extension_settings[MODULE_NAME].autoGen) {
                setTimeout(() => {
                    const btn = $('#bb-vn-btn-generate');
                    if (btn.is(':visible') && !btn.hasClass('loading')) btn.click();
                }, 1500);
            }
        });

    } catch (e) { console.error("[BB VN] Ошибка запуска:", e); }
});
