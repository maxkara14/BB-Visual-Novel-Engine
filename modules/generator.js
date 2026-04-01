/* global SillyTavern */
import { chat_metadata, saveChatDebounced, generateQuietPrompt } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME, OPTIONS_PROMPT } from './constants.js';
import { 
    normalizeOptionData, 
    dedupeOptions, 
    extractJsonStringMatches, 
    escapeHtml
} from './utils.js';
import { notifyInfo, notifyError } from './toasts.js';
import { 
    vnGenerationAbortController, 
    isVnGenerationCancelled, 
    setVnGenerationAbortController, 
    setIsVnGenerationCancelled 
} from './state.js';
import { injectCombinedSocialPrompt } from './social.js';

export async function runMainGen(promptText) {
    if (typeof generateQuietPrompt === 'function') {
        return await generateQuietPrompt(promptText);
    } else if (typeof window['generateQuietPrompt'] === 'function') {
        return await window['generateQuietPrompt'](promptText);
    } else {
        throw new Error("Функция генерации Таверны не найдена. Обновите SillyTavern.");
    }
}

export async function generateFastPrompt(promptText, options = {}) {
    const responseFormat = options.responseFormat === 'text' ? 'text' : 'json';
    const s = extension_settings[MODULE_NAME];
    if (s.useCustomApi && s.customApiUrl && s.customApiModel) {
        try {
            const controller = new AbortController();
            setVnGenerationAbortController(controller);
            const baseUrl = s.customApiUrl.replace(/\/$/, '');
            const endpoint = baseUrl + '/chat/completions';
            
            const response = await fetch(endpoint, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${s.customApiKey || ''}`
                },
                body: JSON.stringify({
                    model: s.customApiModel,
                    messages: [
                        {
                            role: 'system',
                            content: responseFormat === 'text'
                                ? 'You are an internal text generator. Return only the requested final result without extra explanations or wrappers.'
                                : 'You are an internal JSON generator. You MUST output ONLY valid JSON format. No conversational text.'
                        },
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
            if (e.name === 'AbortError') throw new Error("Отменено пользователем");
            console.warn(`[BB VN] Ошибка кастомного API (${e.message}), перехват на основной API...`);
            return await runMainGen(promptText);
        } finally {
            setVnGenerationAbortController(null);
        }
    } else {
        return await runMainGen(promptText);
    }
}

export function buildChoiceContextPrompt() {
    const choiceContext = chat_metadata['bb_vn_choice_context'];
    if (!choiceContext || !choiceContext.intent) return '';

    const targets = Array.isArray(choiceContext.targets) && choiceContext.targets.length > 0
        ? choiceContext.targets.join(', ')
        : 'general scene';

    return `
[DIRECTOR'S STRICT COMMAND FOR THIS TURN]:
The player has just made a SPECIFIC narrative choice. You MUST execute it.

- INTENT: "${choiceContext.intent}"
- MANDATORY EMOTIONAL TONE: ${choiceContext.tone || 'neutral'} (You MUST write your response heavily saturated with this exact emotion).
- FORCED OUTCOME / FORECAST: ${choiceContext.forecast || 'Follow the natural flow'}

EXECUTION PROTOCOL:
1. FOCUS: ${targets !== 'general scene' ? `Make sure ${targets} reacts strongly to this.` : 'Shift the entire scene dynamic based on the forecast.'}
2. OUTCOME: You are FORBIDDEN from stalling. The "FORCED OUTCOME" must actually happen or clearly begin to manifest in this very response.
3. THEME: Adapt your vocabulary, pacing, and character reactions to perfectly match the "${choiceContext.tone || 'neutral'}" tone.
`.trim();
}

export function tryBindPendingChoiceContextToMessage(msg) {
    const pendingChoiceContext = chat_metadata['bb_vn_pending_choice_context'];
    if (!pendingChoiceContext || !msg || !msg.is_user) return false;
    if (msg.extra?.bb_vn_choice_context) return false;

    const preview = String(pendingChoiceContext.messagePreview || '').trim();
    const messageText = String(msg.mes || '').trim();
    if (!preview || !messageText) return false;

    const previewSlice = preview.slice(0, 80);
    const matchesPreview = messageText.startsWith(previewSlice) || previewSlice.startsWith(messageText.slice(0, 40));
    if (!matchesPreview) return false;

    if (!msg.extra) msg.extra = {};
    msg.extra.bb_vn_choice_context = {
        intent: pendingChoiceContext.intent || '',
        tone: pendingChoiceContext.tone || '',
        forecast: pendingChoiceContext.forecast || '',
        targets: Array.isArray(pendingChoiceContext.targets) ? pendingChoiceContext.targets : [],
        at: pendingChoiceContext.at || Date.now(),
    };

    delete chat_metadata['bb_vn_pending_choice_context'];
    return true;
}

export async function bbVnGenerateOptionsFlow(excludedIntents = []) {
    const btn = jQuery('#bb-vn-btn-generate');
    
    if (btn.hasClass('loading')) {
        setIsVnGenerationCancelled(true);
        if (vnGenerationAbortController) vnGenerationAbortController.abort();
        btn.removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия VN').show();
        notifyInfo("Генерация вариантов отменена");
        return;
    }

    setIsVnGenerationCancelled(false);

    btn.show().addClass('loading').html('<i class="fa-solid fa-spinner fa-spin"></i> Сценарий в обработке... <i class="fa-solid fa-xmark" style="margin-left: 6px; color: #ef4444;" title="Отменить"></i>');
    jQuery('#bb-vn-options-container').removeClass('active').empty();

    try {
        const chat = SillyTavern.getContext().chat;
        if (!chat || chat.length === 0) throw new Error("Чат пуст");
        
        const recentMessages = chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\\n\\n');
        const lastMessageText = chat[chat.length - 1] ? chat[chat.length - 1].mes : ""; 

        const persona = SillyTavern.getContext().substituteParams('{{persona}}');
        
        let prompt = OPTIONS_PROMPT
            .replace('{{chat}}', recentMessages)
            .replace('{{persona}}', persona)
            .replace('{{lastMessage}}', lastMessageText); 

        const cleanedExcludedIntents = Array.isArray(excludedIntents)
            ? excludedIntents.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        if (cleanedExcludedIntents.length > 0) {
            prompt += `\n\n[DO NOT REPEAT THESE PREVIOUS ACTION IDEAS]\n${cleanedExcludedIntents.map((item, idx) => `${idx + 1}. ${item}`).join('\n')}\nGenerate clearly different actions.`;
        }

        if (typeof window['bbGetSceneDirectorPrompt'] === 'function') {
            const sceneVibe = window['bbGetSceneDirectorPrompt']();
            if (sceneVibe) {
                console.log("[BB VNE] 🎬 Успешно подхватили стиль Режиссёра:\n", sceneVibe);
                prompt = sceneVibe + "\n\n" + prompt;
            }
        }

        const result = await generateFastPrompt(prompt, { responseFormat: 'json' });

        if (isVnGenerationCancelled) throw new Error("Отменено пользователем");

        const extractTopLevelJsonArray = (rawText = '') => {
            const source = String(rawText || '');
            let start = -1;
            let depth = 0;
            let inString = false;
            let escapeNext = false;

            for (let i = 0; i < source.length; i++) {
                const ch = source[i];
                if (escapeNext) { escapeNext = false; continue; }
                if (ch === '\\') { escapeNext = true; continue; }
                if (ch === '"') { inString = !inString; continue; }
                if (inString) continue;

                if (ch === '[') {
                    if (start === -1) start = i;
                    depth++;
                    continue;
                }

                if (ch === ']') {
                    if (depth > 0) depth--;
                    if (start !== -1 && depth === 0) {
                        return source.substring(start, i + 1);
                    }
                }
            }
            return '';
        };

        let cleanResult = String(result || "").trim();
        cleanResult = cleanResult.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();

        const extractedArray = extractTopLevelJsonArray(cleanResult);
        if (extractedArray) {
            cleanResult = extractedArray;
        } else {
            cleanResult = '[' + cleanResult.replace(/}\s*{/g, '},{') + ']';
        }
        cleanResult = cleanResult.replace(/,\s*([\]}])/g, '$1');

        let parsedOptions;
        try {
            parsedOptions = JSON.parse(cleanResult);
        } catch (err) {
            parsedOptions = [];
            const intentMatches = extractJsonStringMatches(cleanResult, 'intent');
            const toneMatches = extractJsonStringMatches(cleanResult, 'tone');
            const forecastMatches = extractJsonStringMatches(cleanResult, 'forecast');
            const riskMatches = extractJsonStringMatches(cleanResult, 'risk');
            const messageMatches = extractJsonStringMatches(cleanResult, 'message|text|action|reply|response|dialogue|content|description');
            const targetsMatches = [...cleanResult.matchAll(/"targets"\s*:\s*\[([^\]]*)\]/gi)].map(m =>
                m[1].split(',').map(item => item.replace(/["']/g, '').trim()).filter(Boolean)
            );
            
            for (let i = 0; i < intentMatches.length; i++) {
                parsedOptions.push({
                    intent: intentMatches[i],
                    tone: toneMatches[i] || "",
                    forecast: forecastMatches[i] || "",
                    targets: targetsMatches[i] || [],
                    risk: riskMatches[i] || "Средний",
                    message: messageMatches[i] || ""
                });
            }
            if (parsedOptions.length === 0) throw new Error("Модель вернула сломанный код.");
        }

        if (parsedOptions && parsedOptions.length > 0) {
            parsedOptions = dedupeOptions(parsedOptions);
            if (parsedOptions.length < 3) throw new Error("Модель вернула слишком похожие варианты. Попробуйте реролл ещё раз.");
            
            const lastMsg = chat[chat.length - 1];
            const swipeId = lastMsg.swipe_id || 0;
            if (!lastMsg.extra) lastMsg.extra = {};
            if (!lastMsg.extra.bb_vn_options_swipes) lastMsg.extra.bb_vn_options_swipes = {};
            lastMsg.extra.bb_vn_options_swipes[swipeId] = parsedOptions;
            saveChatDebounced();

            if (typeof window['renderVNOptionsFromData'] === 'function') {
                window['renderVNOptionsFromData'](parsedOptions, true);
            }
        } else { throw new Error("Ответ пуст"); }

    } catch (e) {
        if (e.message !== "Отменено пользователем") {
            console.error("[BB VN] Ошибка генерации:", e);
            notifyError("Не удалось сгенерировать варианты");
            btn.removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия VN').show();
        }
    }
}

export function restoreVNOptions(autoOpen = false) {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) {
        clearVNOptions();
        return;
    }
    const lastMsg = chat[chat.length - 1];
    if (lastMsg.is_user) {
        clearVNOptions();
        return;
    }
    const swipeId = lastMsg.swipe_id || 0;
    const savedOptions = lastMsg.extra?.bb_vn_options_swipes?.[swipeId];

    if (savedOptions && Array.isArray(savedOptions) && savedOptions.length > 0) {
        if (typeof window['renderVNOptionsFromData'] === 'function') {
            window['renderVNOptionsFromData'](savedOptions, autoOpen);
        }
    } else {
        clearVNOptions();
    }
}

export function clearVNOptions() {
    jQuery('#bb-vn-options-container').empty().removeClass('active');
    const ta = document.querySelector('#send_textarea');
    if (ta instanceof HTMLTextAreaElement && ta.value.trim().length === 0) {
        jQuery('#bb-vn-btn-generate').show().removeClass('loading').html('<i class="fa-solid fa-clapperboard"></i> Действия VN');
    }
}
