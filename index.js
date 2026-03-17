/* global jQuery, SillyTavern, toastr */

import { setExtensionPrompt, chat_metadata, saveChatDebounced, saveSettingsDebounced, extension_prompt_roles, extension_prompt_types, generateQuietPrompt } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const MODULE_NAME = "BB-Visual-Novel";

if (!extension_settings[MODULE_NAME]) {
    extension_settings[MODULE_NAME] = { 
        autoSend: true, 
        autoGen: false,
        useCustomApi: false,
        customApiUrl: 'https://api.groq.com/openai/v1',
        customApiKey: '',
        customApiModel: '',
        useMacro: false
    };
}

let currentCalculatedStats = {};

// ==========================================
// ФАЗА 1: СОЦИАЛЬНЫЙ ТРЕКИНГ (DEEP SYNC + УМНЫЕ СТАТЫ)
// ==========================================
const SOCIAL_PROMPT = `[SYSTEM INSTRUCTION: VISUAL NOVEL ENGINE]
You are tracking the relationship affinities between {{user}} and the characters. 
At the VERY END of your response, you MUST generate a hidden JSON block evaluating how {{user}}'s last action affected the characters.

CRITICAL RULES FOR JSON:
1. "base_affinity": Only provide this (integer from -100 to 100) if evaluating a character for the VERY FIRST TIME in this chat.
2. "status": 1-3 words describing their OVERALL LONG-TERM relationship towards {{user}} (e.g., "Тайная симпатия", "Соперник", "Лучший друг"). DO NOT use temporary emotional states (like "в панике", "злится").
3. "delta": Integer representing the change in affinity. Use this STRICT scale:
   0 = Neutral interaction, normal chat (no change).
   1 to 3 = Mild positive (polite chat, small help).
   4 to 8 = Strong positive (deep bonding, major gift, saving life).
   -1 to -3 = Mild negative (annoyance, slight disagreement, awkwardness).
   -4 to -8 = Strong negative (betrayal, serious fight, deep offense).
4. "reason": Short explanation of the delta.

CRITICAL LANGUAGE RULE: Output the JSON values ENTIRELY IN RUSSIAN.

Format EXACTLY like this:
\`\`\`json
{
  "social_updates": [
    { "name": "Имя Персонажа", "base_affinity": 60, "delta": 2, "status": "Хороший друг", "reason": "Оценил помощь с заданием" }
  ]
}
\`\`\``;

function getCombinedSocialPrompt() {
    let combinedStr = SOCIAL_PROMPT;
    const characters = Object.keys(currentCalculatedStats);
    if (characters.length > 0) {
        combinedStr += `\n\n[CURRENT RELATIONSHIP STATUS WITH {{user}}]:\n`;
        characters.forEach(char => {
            const statusLabel = currentCalculatedStats[char].status || getTierInfo(currentCalculatedStats[char].affinity).label;
            combinedStr += `- ${char}: ${currentCalculatedStats[char].affinity}/100 (${statusLabel})\n`;
        });
        combinedStr += "CRITICAL: Strictly align the characters' behavior, trust level, and dialogue towards {{user}} with these current affinity levels.";
    }
    return combinedStr;
}

function injectCombinedSocialPrompt() {
    try {
        if (extension_settings[MODULE_NAME].useMacro) {
            setExtensionPrompt('bb_social_injector', '', extension_prompt_types.IN_CHAT, 3, false, extension_prompt_roles.SYSTEM);
        } else {
            const promptText = getCombinedSocialPrompt();
            setExtensionPrompt('bb_social_injector', promptText, extension_prompt_types.IN_CHAT, 3, false, extension_prompt_roles.SYSTEM);
        }
    } catch (e) { console.error("[BB VN] Ошибка инъекции:", e); }
}

function ensureToastContainer() {
    if (!document.getElementById('bb-social-toast-container')) {
        const extraClass = $('#bb-social-hud').hasClass('open') ? 'hud-open' : '';
        $('body').append(`<div id="bb-social-toast-container" class="${extraClass}"></div>`);
    }
}

function showAffinityToast(name, delta, reason) {
    if (delta === 0) return; 
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
                if (msgElement) msgElement.innerHTML = SillyTavern.getContext().markdownToHtml(msg.mes);
            }
        } catch(e) {}
    }
    return modified;
}

function recalculateAllStats(isNewMessage = false) {
    currentCalculatedStats = {};
    const chat = SillyTavern.getContext().chat;
    
    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
    if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];

    if (!chat || !chat.length) {
        renderSocialHud();
        injectCombinedSocialPrompt();
        return;
    }

    let needsSave = false;

    chat.forEach((msg, idx) => {
        if (scanAndCleanMessage(msg, idx)) needsSave = true;

        const swipeId = msg.swipe_id || 0;
        let activeUpdates = msg.extra?.bb_social_swipes?.[swipeId];

        if (!activeUpdates || !Array.isArray(activeUpdates)) {
            if (msg.extra && msg.extra.bb_social_swipes) {
                for (const key in msg.extra.bb_social_swipes) {
                    if (Array.isArray(msg.extra.bb_social_swipes[key])) {
                        activeUpdates = msg.extra.bb_social_swipes[key];
                        break; 
                    }
                }
            }
        }

        if (activeUpdates && Array.isArray(activeUpdates)) {
            activeUpdates.forEach(update => {
                const charName = update.name;
                if (!charName) return;

                if (chat_metadata['bb_vn_ignored_chars'].includes(charName)) return;

                const delta = parseInt(update.delta) || 0;
                let base = 0;
                
                if (!currentCalculatedStats[charName]) {
                    // ФИКС РЕДАКТОРА (Абсолютный приоритет глобальной базы)
                    if (chat_metadata['bb_vn_char_bases'][charName] !== undefined) {
                        base = parseInt(chat_metadata['bb_vn_char_bases'][charName]);
                    } else {
                        base = update.base_affinity !== undefined ? parseInt(update.base_affinity) : 0;
                        if (isNaN(base)) base = 0;
                        chat_metadata['bb_vn_char_bases'][charName] = base;
                    }
                    
                    currentCalculatedStats[charName] = { affinity: base, history: [], status: update.status || "" };
                    
                    if (isNewMessage && idx === chat.length - 1 && update.base_affinity !== undefined) {
                        addGlobalLog('init', `Встреча: <strong>${escapeHtml(charName)}</strong>. Базовое отношение: ${base}`);
                    }
                }
                
                currentCalculatedStats[charName].affinity += delta;
                if (currentCalculatedStats[charName].affinity > 100) currentCalculatedStats[charName].affinity = 100;
                if (currentCalculatedStats[charName].affinity < -100) currentCalculatedStats[charName].affinity = -100;
                
                if (update.status) currentCalculatedStats[charName].status = update.status;

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
    injectCombinedSocialPrompt();
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
                const baseAffinity = chat_metadata['bb_vn_char_bases']?.[charName] ?? 0;
                
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
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span class="bb-char-tier ${tier.class}" title="${escapeHtml(displayStatus)}">${escapeHtml(displayStatus)}</span>
                                <i class="fa-solid fa-gear bb-char-edit-btn" style="color:#94a3b8; cursor:pointer;" data-char="${escapeHtml(charName)}" title="Настройки персонажа"></i>
                            </div>
                        </div>
                        <div class="bb-progress-bg">
                            <div class="bb-progress-center-line"></div>
                            <div class="bb-progress-fill" style="${barStyle}"></div>
                        </div>
                        <div class="bb-char-stats">
                            <span>Отношение: ${affinity}</span>
                            <span>${affinity >= 0 ? 'Макс: 100' : 'Мин: -100'}</span>
                        </div>
                        
                        <div class="bb-char-editor" style="display:none; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 6px; padding: 10px; margin-top: 10px; cursor: default;">
                            <div style="font-size:10px; color:#94a3b8; margin-bottom:5px; font-weight:bold;">БАЗОВОЕ ОТНОШЕНИЕ:</div>
                            <input type="number" class="text_pole bb-edit-base-input" value="${baseAffinity}" style="width:100%; margin-bottom:8px; box-sizing:border-box;">
                            <div style="display:flex; gap:5px;">
                                <button class="menu_button bb-btn-save-char" data-char="${escapeHtml(charName)}" style="flex:1;"><i class="fa-solid fa-check"></i> Сохранить</button>
                                <button class="menu_button bb-btn-hide-char" data-char="${escapeHtml(charName)}" style="flex:1; background:rgba(239,68,68,0.2); color:#ef4444; border-color:#ef4444;"><i class="fa-solid fa-trash"></i> Скрыть</button>
                            </div>
                        </div>

                        <div class="bb-char-log">
                            <div style="font-size: 10px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px;">Журнал:</div>
                            ${historyHtml}
                        </div>
                    </div>
                `;
            });
            charsBox.innerHTML = html;

            $('.bb-char-card').off('click').on('click', function(e) {
                if ($(e.target).closest('.bb-char-editor, .bb-char-edit-btn').length === 0) {
                    $(this).toggleClass('expanded');
                }
            });

            $('.bb-char-edit-btn').on('click', function(e) {
                $(this).closest('.bb-char-card').find('.bb-char-editor').slideToggle(200);
            });

            $('.bb-btn-save-char').on('click', function() {
                const charName = $(this).attr('data-char');
                // @ts-ignore
                const newBase = parseInt($(this).closest('.bb-char-editor').find('.bb-edit-base-input').val());
                if (!isNaN(newBase)) {
                    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
                    chat_metadata['bb_vn_char_bases'][charName] = newBase;
                    saveChatDebounced();
                    recalculateAllStats();
                    // @ts-ignore
                    toastr.success("Настройки сохранены!");
                }
            });

            $('.bb-btn-hide-char').on('click', function() {
                const charName = $(this).attr('data-char');
                if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];
                if (!chat_metadata['bb_vn_ignored_chars'].includes(charName)) {
                    chat_metadata['bb_vn_ignored_chars'].push(charName);
                }
                saveChatDebounced();
                recalculateAllStats();
                // @ts-ignore
                toastr.info(`${charName} скрыт.`);
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

function updateHudVisibility() {
    const chatId = SillyTavern.getContext().chatId;
    if (chatId) {
        $('#bb-social-hud-toggle').show();
    } else {
        $('#bb-social-hud-toggle').hide();
        $('#bb-social-hud').removeClass('open');
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
// ФАЗА 3: ИНТЕРАКТИВНОЕ КИНО С КЭШИРОВАНИЕМ
// ==========================================

const OPTIONS_PROMPT = `Analyze the recent chat. Generate exactly 3 highly distinct, engaging actions {{user}} can take right now to respond to the situation.
For EACH action, write the FULL roleplay message (actions, thoughts, dialogue) from {{user}}'s perspective. Match {{user}}'s persona perfectly. Write in Russian.
CRITICAL: Return STRICTLY a valid JSON array. DO NOT output any other text or markdown.
Format exactly like this:
[
  {
    "intent": "Действие один (1-3 слова)",
    "risk": "Низкий",
    "message": "Полный текст сообщения от лица {{user}}..."
  },
  {
    "intent": "Действие два (1-3 слова)",
    "risk": "Средний",
    "message": "Полный текст сообщения от лица {{user}}..."
  },
  {
    "intent": "Действие три (1-3 слова)",
    "risk": "Высокий",
    "message": "Полный текст сообщения от лица {{user}}..."
  }
]

[USER PERSONA REFERENCE]:
{{persona}}

Recent Chat:
"""{{chat}}"""`;

async function runMainGen(promptText) {
    if (typeof generateQuietPrompt === 'function') {
        return await generateQuietPrompt(promptText);
    } else if (typeof window['generateQuietPrompt'] === 'function') {
        return await window['generateQuietPrompt'](promptText);
    } else {
        throw new Error("Функция генерации Таверны не найдена. Обновите SillyTavern.");
    }
}

async function generateFastPrompt(promptText) {
    const s = extension_settings[MODULE_NAME];
    if (s.useCustomApi && s.customApiUrl && s.customApiModel) {
        try {
            const baseUrl = s.customApiUrl.replace(/\/$/, '');
            const endpoint = baseUrl + '/chat/completions';
            
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${s.customApiKey || ''}`
                },
                body: JSON.stringify({
                    model: s.customApiModel,
                    messages: [
                        { role: 'system', content: 'You are an internal JSON generator. You MUST output ONLY valid JSON format. No conversational text.' },
                        { role: 'user', content: promptText }
                    ],
                    temperature: 0.7,
                    max_tokens: 4000,
                    stream: false
                })
            });
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content || "";
            if (!content.trim()) throw new Error("Прокси вернул пустой текст (Сработал фильтр).");
            return content;
        } catch (e) {
            console.warn(`[BB VN] Ошибка кастомного API (${e.message}), перехват на основной API...`);
            return await runMainGen(promptText);
        }
    } else {
        return await runMainGen(promptText);
    }
}

// ОТРИСОВКА КНОПОК ИЗ МАССИВА (РАБОТАЕТ ДЛЯ ГЕНЕРАЦИИ И КЭША)
window['renderVNOptionsFromData'] = function(parsedOptions, autoOpen = false) {
    let optionsHtml = '';
    parsedOptions.forEach(opt => {
        let riskClass = 'risk-med';
        const r = (opt.risk || '').toLowerCase();
        if (r.includes('низкий') || r.includes('low')) riskClass = 'risk-low';
        if (r.includes('высокий') || r.includes('high')) riskClass = 'risk-high';

        optionsHtml += `
            <div class="bb-vn-option ${riskClass}" data-intent="${escapeHtml(opt.intent)}" data-message="${encodeURIComponent(opt.message || '')}">
                <div class="bb-vn-op-head">${escapeHtml(opt.intent)}</div>
                <div class="bb-vn-op-risk">Риск: ${escapeHtml(opt.risk)}</div>
            </div>
        `;
    });
    
    optionsHtml += `
        <div style="flex: 0 0 100%; display:flex; gap:10px; margin-top:5px;">
            <div class="bb-vn-option risk-med" id="bb-vn-btn-reroll" style="flex:1; text-align: center; border-color: #f59e0b; padding: 10px;">
                <div class="bb-vn-op-head" style="justify-content:center;"><i class="fa-solid fa-rotate-right"></i>&nbsp; Реролл вариантов</div>
            </div>
            <div class="bb-vn-option risk-med" id="bb-vn-btn-cancel" style="flex:1; text-align: center; border-color: #64748b; padding: 10px;">
                <div class="bb-vn-op-head" style="justify-content:center;"><i class="fa-solid fa-chevron-up"></i>&nbsp; Свернуть</div>
            </div>
        </div>
    `;

    $('#bb-vn-options-container').html(optionsHtml);

    if (autoOpen) {
        $('#bb-vn-options-container').addClass('active');
        $('#bb-vn-btn-generate').removeClass('loading').hide();
    } else {
        $('#bb-vn-options-container').removeClass('active');
        $('#bb-vn-btn-generate').removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия (Сохранены)').show();
    }

    $('.bb-vn-option[data-intent]').off('click').on('click', function() {
        const message = decodeURIComponent($(this).attr('data-message') || '');
        const textarea = document.querySelector('#send_textarea');
        if (textarea && message) {
            // @ts-ignore
            textarea.value = message;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            
            if (extension_settings[MODULE_NAME].autoSend) {
                $('#bb-vn-options-container').removeClass('active');
                $('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)');
                const sendBtn = document.getElementById('send_but');
                if (sendBtn) sendBtn.click();
            }
        }
    });

    $('#bb-vn-btn-cancel').off('click').on('click', function() {
        $('#bb-vn-options-container').removeClass('active');
        $('#bb-vn-btn-generate').show().html('<i class="fa-solid fa-clapperboard"></i> Действия (Сохранены)');
    });

    $('#bb-vn-btn-reroll').off('click').on('click', async function() {
        await window['bbVnGenerateOptionsFlow']();
    });
};

// ГЛОБАЛЬНАЯ ФУНКЦИЯ ДЛЯ ГЕНЕРАЦИИ
window['bbVnGenerateOptionsFlow'] = async function() {
    const btn = $('#bb-vn-btn-generate');
    if (btn.hasClass('loading')) return;

    btn.show().addClass('loading').html('<i class="fa-solid fa-spinner fa-spin"></i> Сценарий в обработке...');
    $('#bb-vn-options-container').removeClass('active').empty();

    try {
        const chat = SillyTavern.getContext().chat;
        if (!chat || chat.length === 0) throw new Error("Чат пуст");
        const recentMessages = chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\\n\\n');

        // @ts-ignore
        const persona = SillyTavern.getContext().substituteParams('{{persona}}');
        const prompt = OPTIONS_PROMPT.replace('{{chat}}', recentMessages).replace('{{persona}}', persona);
        const result = await generateFastPrompt(prompt);

        let cleanResult = String(result || "").trim();
        cleanResult = cleanResult.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
        
        const start = cleanResult.indexOf('[');
        const end = cleanResult.lastIndexOf(']');
        if (start !== -1 && end !== -1) {
            cleanResult = cleanResult.substring(start, end + 1);
        } else {
            cleanResult = '[' + cleanResult.replace(/}\s*{/g, '},{') + ']';
        }
        cleanResult = cleanResult.replace(/,\s*([\]}])/g, '$1');

        let parsedOptions;
        try {
            parsedOptions = JSON.parse(cleanResult);
        } catch (err) {
            parsedOptions = [];
            const intentMatches = [...cleanResult.matchAll(/"intent"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            const riskMatches = [...cleanResult.matchAll(/"risk"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            const messageMatches = [...cleanResult.matchAll(/"message"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
            
            for (let i = 0; i < intentMatches.length; i++) {
                parsedOptions.push({
                    intent: intentMatches[i],
                    risk: riskMatches[i] || "Средний",
                    message: messageMatches[i] || ""
                });
            }
            if (parsedOptions.length === 0) throw new Error("Модель вернула сломанный код.");
        }

        if (parsedOptions && parsedOptions.length > 0) {
            // СОХРАНЕНИЕ КНОПОК В ПАМЯТЬ СВАЙПА!
            const lastMsg = chat[chat.length - 1];
            const swipeId = lastMsg.swipe_id || 0;
            if (!lastMsg.extra) lastMsg.extra = {};
            if (!lastMsg.extra.bb_vn_options_swipes) lastMsg.extra.bb_vn_options_swipes = {};
            lastMsg.extra.bb_vn_options_swipes[swipeId] = parsedOptions;
            saveChatDebounced();

            window['renderVNOptionsFromData'](parsedOptions, true);
        } else { throw new Error("Ответ пуст"); }

    } catch (e) {
        console.error("[BB VN] Ошибка генерации:", e);
        // @ts-ignore
        toastr.error("Не удалось сгенерировать варианты");
        btn.removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)').show();
    }
};

// ВОССТАНОВЛЕНИЕ КЭША ПРИ СВАЙПЕ
window['restoreVNOptions'] = function(autoOpen = false) {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) {
        window['clearVNOptions']();
        return;
    }
    const lastMsg = chat[chat.length - 1];
    if (lastMsg.is_user) {
        window['clearVNOptions']();
        return;
    }
    const swipeId = lastMsg.swipe_id || 0;
    const savedOptions = lastMsg.extra?.bb_vn_options_swipes?.[swipeId];

    if (savedOptions && Array.isArray(savedOptions) && savedOptions.length > 0) {
        window['renderVNOptionsFromData'](savedOptions, autoOpen);
    } else {
        window['clearVNOptions']();
    }
};

// ОЧИСТКА ВАРИАНТОВ ПРИ СМЕНЕ КОНТЕКСТА
window['clearVNOptions'] = function() {
    $('#bb-vn-options-container').empty().removeClass('active');
    const ta = document.querySelector('#send_textarea');
    // @ts-ignore
    if (!ta || ta.value.trim().length === 0) {
        $('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)');
    }
};

function injectVNActionsUI() {
    if (document.getElementById('bb-vn-action-bar')) return;

    const barHtml = `
        <div id="bb-vn-action-bar" style="display: flex;">
            <div id="bb-vn-btn-generate" class="bb-vn-main-btn">
                <i class="fa-solid fa-clapperboard"></i> Действия (Visual Novel)
            </div>
            <div id="bb-vn-options-container"></div>
        </div>
    `;

    $('#send_form').prepend(barHtml);

    const ta = document.querySelector('#send_textarea');
    if (ta) {
        ta.addEventListener('input', () => {
            const btnGen = document.getElementById('bb-vn-btn-generate');
            const opts = document.getElementById('bb-vn-options-container');
            if (!btnGen || !opts) return;
            
            // @ts-ignore
            if (ta.value.trim().length > 0) {
                btnGen.style.display = 'none';
            } else if (!opts.classList.contains('active')) {
                btnGen.style.display = 'block';
            }
        });
    }

    $('#bb-vn-btn-generate').on('click', async function() {
        const container = $('#bb-vn-options-container');
        if (container.children('.bb-vn-option[data-intent]').length > 0) {
            container.addClass('active');
            $(this).hide();
        } else {
            await window['bbVnGenerateOptionsFlow']();
        }
    });
}

function escapeHtml(unsafe) {
    if (!unsafe) return "";
    return String(unsafe).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function wipeGlobalLog() {
    chat_metadata['bb_vn_global_log'] = [];
    saveChatDebounced();
    renderSocialHud();
    // @ts-ignore
    toastr.success("Журнал событий очищен!");
}

function wipeAllSocialData() {
    const chat = SillyTavern.getContext().chat;
    if (!chat) return;
    chat.forEach(msg => {
        if (msg.extra && msg.extra.bb_social_swipes) {
            delete msg.extra.bb_social_swipes;
        }
        if (msg.extra && msg.extra.bb_vn_options_swipes) {
            delete msg.extra.bb_vn_options_swipes;
        }
    });
    chat_metadata['bb_vn_global_log'] = [];
    chat_metadata['bb_vn_char_bases'] = {};
    chat_metadata['bb_vn_ignored_chars'] = [];
    addGlobalLog('system', 'Все отношения сброшены до нуля.');
    saveChatDebounced();
    recalculateAllStats();
    // @ts-ignore
    toastr.success("История отношений в этом чате полностью сброшена!");
}

function setupExtensionSettings() {
    if (document.getElementById('bb-social-settings-wrapper')) return;
    
    const s = extension_settings[MODULE_NAME];
    
    const settingsHtml = `
        <div id="bb-social-settings-wrapper" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💖 BB Visual Novel Engine</b>
                <div class="inline-drawer-icon fa-solid fa-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding: 10px;">
                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">Настройки Интерактивного Кино:</span>
                
                <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-vn-cfg-autosend" ${s.autoSend ? 'checked' : ''}>
                        <span>Авто-отправка при выборе (откл для предпросмотра)</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="bb-vn-cfg-autogen" ${s.autoGen ? 'checked' : ''}>
                        <span>Авто-показ 3 вариантов действий при ответе ИИ</span>
                    </label>
                </div>

                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">
                
                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">⚡ Custom API (Для быстрой генерации ответов):</span>
                <label class="checkbox_label" style="margin-top: 5px;">
                    <input type="checkbox" id="bb-vn-cfg-usecustom" ${s.useCustomApi ? 'checked' : ''}>
                    <span>Использовать свой API-ключ</span>
                </label>
                
                <div id="bb-vn-custom-api-block" style="display: ${s.useCustomApi ? 'flex' : 'none'}; flex-direction: column; gap: 8px; margin-top: 8px; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px;">
                    <input type="text" id="bb-vn-cfg-url" class="text_pole" placeholder="URL: http://example:1234/v1" value="${s.customApiUrl || ''}">
                    <input type="password" id="bb-vn-cfg-key" class="text_pole" placeholder="API Ключ" value="${s.customApiKey || ''}">
                    <button id="bb-vn-btn-connect" class="menu_button"><i class="fa-solid fa-plug"></i>&nbsp; Подключиться / Обновить</button>
                    <select id="bb-vn-cfg-model" class="text_pole" ${!s.customApiModel ? 'disabled' : ''}>
                        <option value="${s.customApiModel || ''}">${s.customApiModel || 'Модели не загружены'}</option>
                    </select>
                    <span style="font-size: 10px; color: #94a3b8; line-height: 1.2;">* Работает по стандарту OpenAI. Идеально для Flash-моделей.</span>
                </div>

                <hr style="border-color: rgba(255,255,255,0.1); margin: 10px 0;">

                <span style="font-size: 13px; color: #cbd5e1; font-weight:bold;">⚙️ Для пресетов:</span>
                <label class="checkbox_label" style="margin-top: 5px;">
                    <input type="checkbox" id="bb-vn-cfg-usemacro" ${s.useMacro ? 'checked' : ''}>
                    <span>Использовать макрос <code>{{bb_vn}}</code> вместо авто-вставки</span>
                </label>
                <span style="font-size: 10px; color: #94a3b8; line-height: 1.2; margin-bottom: 5px; display:block;">* Отключит автоматическое внедрение правил. Вам нужно будет вручную вписать <code>{{bb_vn}}</code> в ваш пресет.</span>
<button id="bb-social-restore-chars-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;"><i class="fa-solid fa-users-viewfinder"></i>&nbsp; Вернуть скрытых персонажей</button>
<button id="bb-social-clear-log-btn" class="menu_button" style="width: 100%; margin-bottom: 5px;"><i class="fa-solid fa-eraser"></i>&nbsp; Очистить Журнал событий</button>
<button id="bb-social-wipe-btn" class="menu_button" style="width: 100%; background: rgba(239, 68, 68, 0.2); color: #ef4444; border-color: #ef4444;"><i class="fa-solid fa-trash-can"></i>&nbsp; Сбросить отношения в этом чате</button>
            </div>
        </div>
    `;
    const target = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
    if (target) target.insertAdjacentHTML('beforeend', settingsHtml);

    $('#bb-vn-cfg-autosend').on('change', function() {
        extension_settings[MODULE_NAME].autoSend = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#bb-vn-cfg-autogen').on('change', function() {
        extension_settings[MODULE_NAME].autoGen = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#bb-vn-cfg-usecustom').on('change', function() {
        const isChecked = $(this).is(':checked');
        extension_settings[MODULE_NAME].useCustomApi = isChecked;
        if (isChecked) {
            $('#bb-vn-custom-api-block').slideDown(200);
        } else {
            $('#bb-vn-custom-api-block').slideUp(200);
        }
        saveSettingsDebounced();
    });

    $('#bb-vn-cfg-url, #bb-vn-cfg-key').on('change input', function() {
        extension_settings[MODULE_NAME].customApiUrl = $('#bb-vn-cfg-url').val();
        extension_settings[MODULE_NAME].customApiKey = $('#bb-vn-cfg-key').val();
        saveSettingsDebounced();
    });
    
    $(document).on('change', '#bb-vn-cfg-model', function() {
         extension_settings[MODULE_NAME].customApiModel = $(this).val();
         saveSettingsDebounced();
    });

    $('#bb-vn-cfg-usemacro').on('change', function() {
        extension_settings[MODULE_NAME].useMacro = $(this).is(':checked');
        saveSettingsDebounced();
        injectCombinedSocialPrompt();
    });

    $('#bb-vn-btn-connect').on('click', async function() {
        const btn = $(this);
        // @ts-ignore
        const url = $('#bb-vn-cfg-url').val().replace(/\/$/, '');
        const key = $('#bb-vn-cfg-key').val();

        btn.html('<i class="fa-solid fa-spinner fa-spin"></i> Подключение...');

        try {
            const modelsUrl = url + '/models';
            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Ошибка ${response.status}: ${errText}`);
            }
            const data = await response.json();
            
            if (data && data.data && Array.isArray(data.data)) {
                const select = $('#bb-vn-cfg-model');
                select.empty();
                data.data.forEach(m => {
                    select.append(`<option value="${m.id}">${m.id}</option>`);
                });
                select.prop('disabled', false);
                
                if (extension_settings[MODULE_NAME].customApiModel && select.find(`option[value="${extension_settings[MODULE_NAME].customApiModel}"]`).length) {
                    select.val(extension_settings[MODULE_NAME].customApiModel);
                } else {
                    extension_settings[MODULE_NAME].customApiModel = select.val();
                }
                
                // @ts-ignore
                toastr.success("Модели успешно загружены!", "BB Visual Novel");
                saveSettingsDebounced();
            } else {
                throw new Error("API не вернул список моделей.");
            }
        } catch (e) {
            console.error("[BB VN] Ошибка подключения к API:", e);
            // @ts-ignore
            toastr.error(`Не удалось подключиться: ${e.message}`, "BB Visual Novel");
        } finally {
            btn.html('<i class="fa-solid fa-plug"></i> Подключиться / Обновить');
        }
    });

    $('#bb-social-restore-chars-btn').on('click', function() {
        chat_metadata['bb_vn_ignored_chars'] = [];
        saveChatDebounced();
        recalculateAllStats();
        // @ts-ignore
        toastr.success("Скрытые персонажи восстановлены!");
    });

    const clearLogBtn = document.getElementById('bb-social-clear-log-btn');
    if (clearLogBtn) clearLogBtn.addEventListener('click', wipeGlobalLog);

    const wipeBtn = document.getElementById('bb-social-wipe-btn');
    if (wipeBtn) wipeBtn.addEventListener('click', wipeAllSocialData);
}

// Запуск и привязка событий
jQuery(async () => {
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        
        setupExtensionSettings();

        const context = SillyTavern.getContext();
        if (context.registerMacro) {
            context.registerMacro('bb_vn', () => {
                return extension_settings[MODULE_NAME].useMacro ? getCombinedSocialPrompt() : '';
            });
        }

        injectCombinedSocialPrompt();
        ensureHudContainer();
        injectVNActionsUI();
        updateHudVisibility();

        eventSource.on(event_types.APP_READY, () => {
            setupExtensionSettings();
            injectCombinedSocialPrompt();
            ensureHudContainer();
            injectVNActionsUI();
            recalculateAllStats(); 
            updateHudVisibility();
        });
        
        eventSource.on(event_types.CHAT_CHANGED, () => {
            window['restoreVNOptions'](false);
            injectCombinedSocialPrompt();
            injectVNActionsUI();
            recalculateAllStats(); 
            updateHudVisibility();
        });

        // ПРИ СВАЙПЕ ИЛИ НОВОМ СООБЩЕНИИ ПЫТАЕМСЯ ВОССТАНОВИТЬ КЭШ КНОПОК
        eventSource.on(event_types.MESSAGE_RECEIVED, () => { window['restoreVNOptions'](false); recalculateAllStats(true); }); 
        eventSource.on(event_types.MESSAGE_DELETED, () => { window['restoreVNOptions'](false); recalculateAllStats(); });
        eventSource.on(event_types.MESSAGE_SWIPED, () => { window['restoreVNOptions'](false); recalculateAllStats(); });
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

        eventSource.on(event_types.GENERATE_AFTER_DATA, (generate_data) => {
            if (extension_settings[MODULE_NAME].useMacro && generate_data && Array.isArray(generate_data.messages)) {
                const promptText = getCombinedSocialPrompt();
                generate_data.messages.forEach(msg => {
                    if (msg && msg.content && typeof msg.content === 'string' && msg.content.includes('{{bb_vn}}')) {
                        msg.content = msg.content.replace(/\{\{bb_vn\}\}/g, promptText);
                    }
                });
            }
        });

    } catch (e) { console.error("[BB VN] Ошибка запуска:", e); }
});
