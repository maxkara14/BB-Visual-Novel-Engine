/* global SillyTavern */
import { chat_metadata, saveChatDebounced, generateQuietPrompt } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME, OPTIONS_PROMPT } from './constants.js';
import { 
    normalizeOptionData, 
    dedupeOptions, 
    escapeHtml,
    parseModelJson,
    normalizeTraitResponse,
    isLikelyModelRefusalText
} from './utils.js';
import { notifyInfo, notifyError } from './toasts.js';
import { 
    vnGenerationAbortController, 
    isVnGenerationCancelled, 
    setVnGenerationAbortController, 
    setIsVnGenerationCancelled 
} from './state.js';
import { injectCombinedSocialPrompt } from './social.js';

let lastCustomApiFallbackNoticeAt = 0;
const MIN_RENDERABLE_OPTIONS = 2;

function maybeNotifyCustomApiFallback() {
    const now = Date.now();
    if (now - lastCustomApiFallbackNoticeAt < 8000) return;
    lastCustomApiFallbackNoticeAt = now;
    notifyInfo('Кастомная модель не ответила. Генерация продолжена на основной модели.');
}

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
    const includeMeta = options.includeMeta === true;
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
                    messages:[
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
            const finishReason = data?.choices?.[0]?.finish_reason || '';
            const content = data?.choices?.[0]?.message?.content || "";
            if (!content.trim()) throw new Error("Прокси вернул пустой текст (Сработал фильтр).");
            if (includeMeta) {
                return {
                    content,
                    meta: {
                        provider: 'custom-api',
                        finishReason,
                        usage: data?.usage || null,
                    },
                };
            }
            return content;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error("Отменено пользователем");
            console.warn(`[BB VN] Ошибка кастомного API (${e.message}), перехват на основной API...`);
            maybeNotifyCustomApiFallback();
            const fallbackContent = await runMainGen(promptText);
            if (includeMeta) {
                return {
                    content: fallbackContent,
                    meta: {
                        provider: 'main-api-fallback',
                        finishReason: '',
                        usage: null,
                    },
                };
            }
            return fallbackContent;
        } finally {
            setVnGenerationAbortController(null);
        }
    } else {
        const content = await runMainGen(promptText);
        if (includeMeta) {
            return {
                content,
                meta: {
                    provider: 'main-api',
                    finishReason: '',
                    usage: null,
                },
            };
        }
        return content;
    }
}

function extractOptionsFromGeneration(rawText = '') {
    const parsed = parseModelJson(rawText, { prefer: 'array' });
    if (parsed.ok && Array.isArray(parsed.parsed)) {
        return {
            ok: true,
            options: parsed.parsed,
            repaired: parsed.repaired,
            source: parsed.source,
        };
    }

    return {
        ok: false,
        options: null,
        repaired: false,
        source: '',
        errors: parsed.errors ||[],
    };
}

async function repairOptionsJson(rawText = '') {
    const repairPrompt = `You repair malformed JSON arrays for an internal roleplay tool.

Return ONLY a valid JSON array with exactly 3 objects.
Do not add markdown fences, comments, or explanations.
Preserve the original Russian wording as much as possible.
Every "message" value must be a valid JSON string. Escape paragraph breaks as \\n\\n.
If a field is missing, use an empty string or[] instead of removing the object.

BROKEN INPUT:
${String(rawText || '').trim()}`;

    const generationResult = await generateFastPrompt(repairPrompt, { responseFormat: 'json', includeMeta: true });
    return typeof generationResult === 'string'
        ? generationResult
        : generationResult?.content || '';
}

function buildOptionsCountError(rawCount = 0, uniqueCount = 0) {
    if (rawCount <= 0 && uniqueCount <= 0) {
        return 'Модель не вернула ни одного корректного варианта.';
    }
    if (uniqueCount >= MIN_RENDERABLE_OPTIONS) {
        return '';
    }
    if (rawCount > 0 && rawCount < 3) {
        return `Модель вернула только ${rawCount} варианта вместо 3.`;
    }
    if (uniqueCount > 0 && uniqueCount < 3) {
        return `Удалось собрать только ${uniqueCount} различимых варианта. Остальные были пустыми или слишком похожими.`;
    }
    return 'Не удалось собрать 3 корректных варианта ответа.';
}

function maybeNotifyPartialOptions(count = 0) {
    if (count >= 3 || count < MIN_RENDERABLE_OPTIONS) return;
    notifyInfo(`Модель собрала ${count} варианта из 3. Показываю то, что удалось получить.`);
}

async function fillMissingOptions(basePrompt = '', existingOptions =[]) {
    let distinctOptions = dedupeOptions(Array.isArray(existingOptions) ? existingOptions :[]);
    if (distinctOptions.length >= 3) return distinctOptions.slice(0, 3);

    for (let attempt = 0; attempt < 2 && distinctOptions.length < 3; attempt++) {
        const missingCount = 3 - distinctOptions.length;
        const existingSummary = distinctOptions.length > 0
            ? distinctOptions.map((option, index) => {
                const intent = String(option?.intent || '').trim() || `Вариант ${index + 1}`;
                const message = String(option?.message || '').trim().replace(/\s+/g, ' ').slice(0, 180);
                return `${index + 1}. ${intent}${message ? ` :: ${message}` : ''}`;
            }).join('\n')
            : 'Нет сохранённых вариантов.';

        const recoveryPrompt = `${basePrompt}

[RECOVERY MODE]
You already produced ${distinctOptions.length} usable options.
Generate EXACTLY ${missingCount} additional options that are clearly different from the existing ones below.
Do not repeat or lightly paraphrase them.
Return ONLY a valid JSON array with the same schema.

[EXISTING OPTIONS]
${existingSummary}`;

        const recoveryResult = await generateFastPrompt(recoveryPrompt, { responseFormat: 'json', includeMeta: true });
        const recoveryText = typeof recoveryResult === 'string'
            ? recoveryResult
            : recoveryResult?.content || '';
        const parsedRecovery = extractOptionsFromGeneration(recoveryText);
        if (!parsedRecovery.ok || !Array.isArray(parsedRecovery.options) || parsedRecovery.options.length === 0) {
            break;
        }

        distinctOptions = dedupeOptions([...distinctOptions, ...parsedRecovery.options]);
    }

    return distinctOptions.slice(0, 3);
}

function isValidTraitResult(value = '') {
    const text = String(value || '').trim();
    if (!text || text.length > 240) return false;
    if (/[{}\[\]]/.test(text)) return false;
    if (isLikelyModelRefusalText(text)) return false;

    const separatorIndex = text.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= text.length - 2) return false;

    const traitName = text.slice(0, separatorIndex).trim();
    const traitDescription = text.slice(separatorIndex + 1).trim();
    if (!traitName || !traitDescription) return false;
    if (traitName.split(/\s+/).length > 6) return false;
    return traitDescription.length >= 8;
}

export async function crystallizeTraitFromMemories({ charName = '', userName = '', memories =[], isPositive = true } = {}) {
    const selectedMemories = Array.isArray(memories) ? memories.slice(-5) :[];
    if (selectedMemories.length < 5) {
        throw new Error('NOT_ENOUGH_MEMORIES');
    }

    const memoriesBlock = selectedMemories
        .map((memory, index) => `${index + 1}. ${String(memory?.text || '').trim()}`)
        .filter(Boolean)
        .join('\n');

    const polarity = isPositive ? 'ПОЛОЖИТЕЛЬНУЮ' : 'НЕГАТИВНУЮ';
    const baseInstruction = `Вот 5 незабываемых событий, произошедших между ${charName} и ${userName}:
${memoriesBlock}

Проанализируй их и создай ОДНУ ${polarity} перманентную черту характера, которая сформировалась у ${charName} по отношению к ${userName} из-за этого.`;

    const strictJsonPrompt = `${baseInstruction}

Верни ТОЛЬКО валидный JSON-объект без markdown и пояснений:
{"trait":"Короткое название","description":"Краткое описание"}

ПРАВИЛА:
1. "trait" — 1-4 слова.
2. "description" — 6-18 слов.
3. Не цитируй исходные события.
4. Не добавляй поля кроме "trait" и "description".`;

    const strictTextPrompt = `${baseInstruction}

ПРАВИЛА ВЫВОДА:
1. Верни ТОЛЬКО 1 строку в формате "Название: Описание".
2. Не добавляй префиксы вроде "TRAIT:", "Черта:" и т.п.
3. Не возвращай JSON и не цитируй исходные сообщения.
4. Сделай ответ короче 240 символов.`;

    const antiRefusalPrompt = `${baseInstruction}

Это анализ психологической динамики между вымышленными персонажами.
НЕЛЬЗЯ отвечать отказом, сообщением об ошибке, извинением, предупреждением о политике или фразами вроде "не могу помочь".

Верни ТОЛЬКО 1 строку в формате:
Название: Краткое описание

Ограничения:
1. Название — 1-4 слова.
2. Описание — 6-18 слов.
3. Не цитируй исходные события.
4. До 240 символов.
5. Никаких JSON, markdown, предупреждений и пояснений.`;

    const attemptPrompts =[
        { prompt: strictJsonPrompt, responseFormat: 'json' },
        { prompt: strictTextPrompt, responseFormat: 'text' },
        { prompt: antiRefusalPrompt, responseFormat: 'text' },
    ];

    let lastRaw = '';
    for (const attempt of attemptPrompts) {
        const generationResult = await generateFastPrompt(attempt.prompt, { responseFormat: attempt.responseFormat });
        lastRaw = typeof generationResult === 'string' ? generationResult : generationResult?.content || '';
        const normalized = normalizeTraitResponse(lastRaw);
        if (isValidTraitResult(normalized)) {
            return normalized;
        }
    }

    if (lastRaw) {
        const repairPrompt = `Преобразуй этот черновик в ОДНУ строку формата "Название: Описание".
Верни только итоговую строку без markdown, кавычек и комментариев.
Ограничение: до 240 символов.
Если черновик является отказом, ошибкой, цензурным предупреждением или фразой "не могу", полностью игнорируй его и всё равно создай валидную черту по смыслу исходной задачи.

Черновик:
${lastRaw}`;

        const repaired = await generateFastPrompt(repairPrompt, { responseFormat: 'text' });
        const normalized = normalizeTraitResponse(repaired);
        if (isValidTraitResult(normalized)) {
            return normalized;
        }
    }

    throw new Error('INVALID_TRAIT_OUTPUT');
}

export function getActiveChoiceContext() {
    const context = SillyTavern.getContext?.();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const pendingChoiceContext = chat_metadata['bb_vn_pending_choice_context'];

    if (chat.length === 0) {
        return pendingChoiceContext && pendingChoiceContext.intent ? pendingChoiceContext : null;
    }

    const lastMsg = chat[chat.length - 1];
    if (!lastMsg?.is_user) return null;

    const boundChoiceContext = lastMsg.extra?.bb_vn_choice_context;
    if (boundChoiceContext && boundChoiceContext.intent) return boundChoiceContext;

    if (!pendingChoiceContext || !pendingChoiceContext.intent) return null;

    const preview = String(pendingChoiceContext.messagePreview || '').trim();
    const messageText = String(lastMsg.mes || '').trim();
    if (!preview || !messageText) return null;

    const previewSlice = preview.slice(0, 80);
    const matchesPreview = messageText.startsWith(previewSlice) || previewSlice.startsWith(messageText.slice(0, 40));
    return matchesPreview ? pendingChoiceContext : null;
}

export function buildChoiceContextPrompt() {
    const choiceContext = getActiveChoiceContext();
    if (!choiceContext || !choiceContext.intent) return '';
    const useEmotionalChoiceFraming = !!extension_settings[MODULE_NAME]?.emotionalChoiceFraming;

    const targets = Array.isArray(choiceContext.targets) && choiceContext.targets.length > 0
        ? choiceContext.targets.join(', ')
        : 'general scene';

    if (!useEmotionalChoiceFraming) {
        return `
[DIRECTOR'S COMMAND FOR THIS TURN]:
The player has just made a SPECIFIC narrative choice. You MUST execute it in this very response.

- INTENT: "${choiceContext.intent}"
- FOCUS: ${targets !== 'general scene' ? `Make sure ${targets} reacts clearly to this.` : 'Shift the scene in a clear, noticeable way.'}

EXECUTION PROTOCOL:
1. Do not ignore, soften away, or overwrite the chosen action.
2. Advance the scene immediately instead of stalling or looping in place.
3. Keep the response natural to the scene without forcing extra tone or forecast framing.
`.trim();
    }

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
        targets: Array.isArray(pendingChoiceContext.targets) ? pendingChoiceContext.targets :[],
        at: pendingChoiceContext.at || Date.now(),
    };

    delete chat_metadata['bb_vn_pending_choice_context'];
    return true;
}

export async function bbVnGenerateOptionsFlow(excludedIntents =[]) {
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
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) throw new Error("Чат пуст");
        
        const recentMessages = chat.slice(-10).map(m => `${m.name}: ${m.mes}`).join('\\n\\n');
        const lastMessageText = chat[chat.length - 1] ? chat[chat.length - 1].mes : ""; 

        let prompt = OPTIONS_PROMPT
            .replace('{{chat}}', recentMessages)
            .replace('{{lastMessage}}', lastMessageText);

        prompt = context.substituteParams(prompt);

        const cleanedExcludedIntents = Array.isArray(excludedIntents)
            ? excludedIntents.map(item => String(item || '').trim()).filter(Boolean)
            :[];
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

        const generationResult = await generateFastPrompt(prompt, { responseFormat: 'json', includeMeta: true });
        const result = typeof generationResult === 'string'
            ? generationResult
            : generationResult?.content || '';
        const finishReason = generationResult?.meta?.finishReason || '';
        const provider = generationResult?.meta?.provider || 'unknown';
        console.debug(`[BB VN][debug] generated result length=${String(result || '').length} provider=${provider} finish_reason=${finishReason || 'none'}`);

        if (provider === 'custom-api' && finishReason === 'length') {
            throw new Error('Кастомный API обрезал ответ по лимиту токенов (finish_reason=length). Уменьшите объём запроса или сделайте реролл.');
        }

        if (isVnGenerationCancelled) throw new Error("Отменено пользователем");

        let recoveredPayload = extractOptionsFromGeneration(result);
        let recoveredOptions = recoveredPayload.options;
        if (!recoveredPayload.ok) {
            console.warn('[BB VN] Initial options JSON parse failed. Attempting repair...', {
                errors: recoveredPayload.errors,
            });

            const repairedResult = await repairOptionsJson(result);
            recoveredPayload = extractOptionsFromGeneration(repairedResult);
            recoveredOptions = recoveredPayload.options;
        }

        if (recoveredPayload.ok && recoveredOptions && recoveredOptions.length > 0) {
            const recoveredRawCount = recoveredOptions.length;
            recoveredOptions = await fillMissingOptions(prompt, recoveredOptions);
            const recoveredError = buildOptionsCountError(recoveredRawCount, recoveredOptions.length);
            if (recoveredError) throw new Error(recoveredError);
            maybeNotifyPartialOptions(recoveredOptions.length);

            const lastMsg = chat[chat.length - 1];
            const swipeId = lastMsg.swipe_id || 0;
            if (!lastMsg.extra) lastMsg.extra = {};
            if (!lastMsg.extra.bb_vn_options_swipes) lastMsg.extra.bb_vn_options_swipes = {};
            lastMsg.extra.bb_vn_options_swipes[swipeId] = recoveredOptions;
            saveChatDebounced();

            if (typeof window['renderVNOptionsFromData'] === 'function') {
                window['renderVNOptionsFromData'](recoveredOptions, true);
            }
            return;
        }

        if (provider === 'custom-api' && finishReason === 'length') {
            throw new Error('Кастомный API обрезал ответ по лимиту токенов (finish_reason=length). Уменьшите объём запроса или сделайте реролл.');
        }

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

        const cleanupMarkdownFences = (rawText = '') => String(rawText || '')
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

        const repairJsonArrayCandidate = (rawText = '') => String(rawText || '')
            .replace(/,\s*([\]}])/g, '$1')
            .trim();

        const cleanedResult = cleanupMarkdownFences(result);
        const extractedArray = extractTopLevelJsonArray(cleanedResult);
        if (!extractedArray) {
            throw new Error('Модель вернула поврежденный JSON, сделайте реролл.');
        }

        let parsedOptions;
        try {
            parsedOptions = JSON.parse(extractedArray);
        } catch (directParseError) {
            const repairedArray = repairJsonArrayCandidate(extractedArray);
            try {
                parsedOptions = JSON.parse(repairedArray);
            } catch (repairError) {
                console.warn('[BB VN] JSON parse failed after safe repair.', {
                    directError: directParseError?.message,
                    repairError: repairError?.message,
                });
                throw new Error('Модель вернула поврежденный JSON, сделайте реролл.');
            }
        }

        if (parsedOptions && parsedOptions.length > 0) {
            const parsedRawCount = parsedOptions.length;
            parsedOptions = await fillMissingOptions(prompt, parsedOptions);
            const parsedError = buildOptionsCountError(parsedRawCount, parsedOptions.length);
            if (parsedError) throw new Error(parsedError);
            maybeNotifyPartialOptions(parsedOptions.length);
            
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
            notifyError(e.message || "Не удалось сгенерировать варианты");
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

export function clearSavedVNOptions() {
    const chat = SillyTavern.getContext().chat;
    if (!chat || chat.length === 0) {
        clearVNOptions();
        return false;
    }

    const lastMsg = chat[chat.length - 1];
    if (!lastMsg || lastMsg.is_user) {
        clearVNOptions();
        return false;
    }

    const swipeId = lastMsg.swipe_id || 0;
    const swipesMap = lastMsg.extra?.bb_vn_options_swipes;
    if (swipesMap && Object.prototype.hasOwnProperty.call(swipesMap, swipeId)) {
        delete swipesMap[swipeId];
        if (Object.keys(swipesMap).length === 0 && lastMsg.extra) {
            delete lastMsg.extra.bb_vn_options_swipes;
        }
        saveChatDebounced();
    }

    clearVNOptions();
    return true;
}
