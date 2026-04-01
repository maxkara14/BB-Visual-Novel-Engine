/* global SillyTavern */
import { setExtensionPrompt, chat_metadata, saveChatDebounced, extension_prompt_roles, extension_prompt_types, callPopup } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { 
    currentCalculatedStats, 
    currentStoryMoments, 
    setCurrentCalculatedStats,
    setSocialParseDebug
} from './state.js';
import { MODULE_NAME, SOCIAL_PROMPT } from './constants.js';
import { 
    sanitizeMoodlet, 
    getMemoryBucket, 
    getMemoryTone, 
    coerceUserFacingStatus, 
    isCollectiveEntityName, 
    getShiftDescriptor,
    formatAffinityPoints,
    escapeHtml,
    sanitizeRelationshipStatus,
    sanitizeTraitOutput
} from './utils.js';
import { showStoryMomentToast, notifySuccess, notifyInfo, notifyError, pickToastMoment } from './toasts.js';
import { buildChoiceContextPrompt } from './generator.js';

export function getCombinedSocial() {
    let combinedStr = SOCIAL_PROMPT;
    const characters = Object.keys(currentCalculatedStats);
    
    if (characters.length > 0) {
        combinedStr += `\n\n[CURRENT RELATIONSHIP STATUS]:\n`;
        const impactInstructions = [];

        characters.forEach(char => {
            const stats = currentCalculatedStats[char];
            const tier = getTierInfo(stats.affinity).label;
            const status = stats.status || getUnforgettableRoleStatus(stats.memories?.deep) || tier;
            
            const recent = (stats.memories?.soft || []).map(m => m.text).join('; ');
            const deepMemories = stats.memories?.deep || [];
            const recentDeep = deepMemories.slice(-5); 
            const unforgettable = recentDeep.map(m => m.text).join('; ');
            const coreTraits = stats.core_traits || []; 
            const traitsText = coreTraits.length > 0 ? coreTraits.map(t => t.trait).join(' ') : '';

            combinedStr += `- ${char}: [Status: ${status}] [Trust: ${stats.affinity}] [Romance: ${stats.romance || 0}]`;
            if (recent) combinedStr += ` [Recent: ${recent}]`;
            if (unforgettable) combinedStr += ` [Unforgettable: ${unforgettable}]`; 
            if (traitsText) combinedStr += ` [CORE TRAITS: ${traitsText}]`; 
            
            if (chat_metadata['bb_vn_platonic_chars'] && chat_metadata['bb_vn_platonic_chars'].includes(char)) {
                combinedStr += ` [CRITICAL: THIS CHARACTER IS STRICTLY PLATONIC. "romance_impact" MUST ALWAYS BE "none".]`;
            }
            combinedStr += `\n`;

            const impact = getUnforgettableImpact(stats.memories?.deep || []);
            let guideLines = [];
            
            if (impact.prompt) {
                guideLines.push(`- Current Focus: ${impact.label}`);
                guideLines.push(`- Unforgettable Directive: ${impact.prompt}`);
            }
            if (coreTraits.length > 0) {
                guideLines.push(`- CORE TRAIT (Permanent): ${traitsText}`);
                guideLines.push(`- Trait Directive: These core traits are fundamental to their psychology and MUST dictate their underlying behavior and reactions to {{user}}.`);
            }
            if (guideLines.length > 0) {
                impactInstructions.push(`### ${char} BEHAVIOR GUIDE:\n${guideLines.join('\n')}`);
            }
        });

        combinedStr += `\n[NARRATIVE DIRECTIVES]:\n`;
        combinedStr += `1. Behavior: Dialogue and actions must strictly match the Status and Relationship Tier.\n`;
        combinedStr += `2. Memory: Characters must act based on 'Recent' (short-term mood) and 'Unforgettable' (permanent emotional anchor) memories.\n`;
        combinedStr += `3. Name Consistency: When evaluating existing characters, use EXACTLY these names: ${characters.join(', ')}.`;

        if (impactInstructions.length > 0) {
            combinedStr += `\n\n[UNFORGETTABLE IMPACT LOGIC]:\n${impactInstructions.join('\n')}\n`;
            combinedStr += `\nCRITICAL: Unforgettable memory directives override temporary scene moods.`;
        }
    }

    combinedStr += buildChoiceContextPrompt();
    return combinedStr;
}

export function injectCombinedSocialPrompt() {
    try {
        const promptText = getCombinedSocial();
        setExtensionPrompt('bb_social_injector', promptText, extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    } catch (e) { console.error("[BB VN] Ошибка инъекции:", e); }
}

export function getTierInfo(affinity) {
    if (affinity <= -50) return { label: 'Враг', class: 'tier-enemy', color: '#ef4444' };
    if (affinity < -10) return { label: 'Неприязнь', class: 'tier-enemy', color: '#f87171' };
    if (affinity <= 10) return { label: 'Незнакомец', class: 'tier-neutral', color: '#a1a1aa' };
    if (affinity <= 50) return { label: 'Приятель', class: 'tier-friend', color: '#4ade80' };
    if (affinity <= 80) return { label: 'Друг', class: 'tier-friend', color: '#22c55e' };
    return { label: 'Близкий', class: 'tier-close', color: '#c084fc' };
}

export function getUnforgettableImpact(memories = []) {
    if (!Array.isArray(memories) || memories.length === 0) {
        return { label: 'Нет активного следа', prompt: '' };
    }

    const total = memories.reduce((sum, memory) => sum + (parseInt(memory.delta) || 0), 0);
    const hasPositive = memories.some(memory => (parseInt(memory.delta) || 0) > 0);
    const hasNegative = memories.some(memory => (parseInt(memory.delta) || 0) < 0);

    let label = '';
    let prompt = '';

    if (hasPositive && hasNegative) {
        label = 'Противоречивая связь';
        prompt = 'Past unforgettable events create inner conflict: the character is torn between closeness and pain, so reactions should feel emotionally unstable and layered.';
    } 
    else if (total >= 18) {
        label = 'Глубокая привязанность';
        prompt = 'Unforgettable positive events create a powerful pull toward {{user}}. Even in tense scenes, warmth, trust, or longing should leak through.';
    } 
    else if (total > 0) {
        label = 'Тёплый осадок';
        prompt = 'Unforgettable positive events still shape the character. Small gestures from {{user}} should be interpreted more softly and personally.';
    } 
    else if (total <= -18) {
        label = 'Непростительная обида';
        prompt = 'Unforgettable negative events still dominate the character’s perception. Suspicion, pain, or guardedness should override calm surface behavior.';
    } 
    else {
        label = 'Тяжёлое воспоминание';
        prompt = 'Unforgettable negative events remain unresolved. Even neutral interactions should carry some hesitation, distance, or emotional recoil.';
    }

    return { label, prompt };
}

export function getUnforgettableRoleStatus(memories = []) {
    void memories;
    return '';
}

export function appendCharacterMemory(charStats, delta, reason, moodlet = '') {
    if (!charStats || !reason || delta === 0) return;
    const bucket = getMemoryBucket(delta);
    if (!bucket) return;
    const memory = {
        text: reason,
        delta,
        tone: getMemoryTone(delta),
        moodlet: sanitizeMoodlet(moodlet),
    };

    charStats.memories[bucket].push(memory);
    
    if (bucket === 'soft' && charStats.memories.soft.length > 4) {
        charStats.memories.soft.shift();
    }
}

export function maybeAddStoryMoment(moment) {
    if (!moment || !moment.title || !moment.text) return;
    currentStoryMoments.push(moment);
    if (currentStoryMoments.length > 30) currentStoryMoments.shift();
    return moment;
}

export function addGlobalLog(type, text, timeString) {
    if (!chat_metadata['bb_vn_global_log']) chat_metadata['bb_vn_global_log'] = [];
    const time = timeString || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    chat_metadata['bb_vn_global_log'].push({ time, type, text });
    if (chat_metadata['bb_vn_global_log'].length > 100) chat_metadata['bb_vn_global_log'].shift();
}

export function tryParseSocialUpdates(rawText) {
    const text = String(rawText || '');
    if (!/social_updates/i.test(text)) return null;

    const candidates = [];

    const hiddenBlockMatch = text.match(/<div[^>]*class=["'][^"']*bb-vn-data[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (hiddenBlockMatch?.[1]) {
        candidates.push(hiddenBlockMatch[1]);
    }

    const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]).filter(Boolean);
    candidates.push(...fencedBlocks);
    candidates.push(text);

    const parseObjectContainingSocialUpdates = (sourceText) => {
        const keywordMatch = [...sourceText.matchAll(/(["']?)social_updates\1\s*:/gi)].pop();
        if (!keywordMatch) return null;
        const keywordIdx = keywordMatch.index ?? -1;
        if (keywordIdx < 0) return null;

        let openBraceIdx = -1;
        for (let i = keywordIdx; i >= 0; i--) {
            if (sourceText[i] === '{') { openBraceIdx = i; break; }
        }
        if (openBraceIdx === -1) return null;

        let depth = 0;
        let closeBraceIdx = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = openBraceIdx; i < sourceText.length; i++) {
            const char = sourceText[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\') { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; }

            if (!inString) {
                if (char === '{') depth++;
                else if (char === '}') {
                    depth--;
                    if (depth === 0) { closeBraceIdx = i; break; }
                }
            }
        }

        if (closeBraceIdx === -1) return null;

        const jsonStr = sourceText.substring(openBraceIdx, closeBraceIdx + 1).trim();
        const normalizedQuotes = jsonStr
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'");

        const quotedKeys = normalizedQuotes.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

        const parsers = [
            jsonStr,
            jsonStr.replace(/\n/g, '\\n').replace(/\r/g, ''),
            normalizedQuotes,
            quotedKeys,
            quotedKeys.replace(/\n/g, '\\n').replace(/\r/g, ''),
        ];

        for (const candidate of parsers) {
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && Array.isArray(parsed.social_updates)) {
                    return { parsed, source: jsonStr };
                }
            } catch (e) {
                void e;
            }
        }
        return null;
    };

    for (const candidate of candidates) {
        const parsedCandidate = parseObjectContainingSocialUpdates(String(candidate || ''));
        if (parsedCandidate) return parsedCandidate;
    }

    return null;
}

export function scanAndCleanMessage(msg, messageId) {
    if (!msg || msg.is_user) return false;
    let modified = false;
    const swipeId = msg.swipe_id || 0;
    const existingUpdates = msg.extra?.bb_social_swipes?.[swipeId];
    
    const originalMes = msg.mes;
    let currentMes = String(msg.mes || '').replace(/[\u200B-\u200D\uFEFF]/g, '');

    const parsedPayload = tryParseSocialUpdates(currentMes);

    if (parsedPayload) {
        try {
            const parsed = parsedPayload.parsed;
            if (!msg.extra) msg.extra = {};
            if (!msg.extra.bb_social_swipes) msg.extra.bb_social_swipes = {};

            msg.extra.bb_social_swipes[swipeId] = parsed.social_updates;
            currentMes = currentMes.replace(parsedPayload.source, '');
            setSocialParseDebug('parsed', `social_updates: ${parsed.social_updates.length}`);
        } catch(e) {}
    } else if (Array.isArray(existingUpdates) && existingUpdates.length > 0) {
        setSocialParseDebug('parsed', `social_updates (stored): ${existingUpdates.length}`);
    } else if (String(currentMes || '').trim()) {
        setSocialParseDebug('missing', 'В ответе нет social_updates');
    }
    
    const bt = String.fromCharCode(96, 96, 96);
    const emptyBlockRegex = new RegExp(bt + '{1,3}[a-zA-Z0-9_-]*\\s*' + bt + '{1,3}', 'gi');
    currentMes = currentMes.replace(emptyBlockRegex, '');
    currentMes = currentMes.replace(/<div[^>]*>\s*<\/div>/gi, '');
    const trailingBlockRegex = new RegExp(bt + '{1,3}[a-zA-Z0-9_-]*\\s*$', 'gi');
    currentMes = currentMes.replace(trailingBlockRegex, '');
    
    if (originalMes !== currentMes) {
        msg.mes = currentMes.trim(); 
        modified = true;
        
        if (msg.swipes && msg.swipes[swipeId] !== undefined) {
            msg.swipes[swipeId] = msg.mes; 
        } else if (msg.swipes && msg.swipes.length > 0) {
            msg.swipes[0] = msg.mes; 
        } else {
            msg.swipes = [msg.mes]; 
        }
    }
    
    if (modified && messageId !== undefined) {
        const msgElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (msgElement) msgElement.innerHTML = SillyTavern.getContext().markdownToHtml(msg.mes);
    }
    
    return modified;
}

let renderHudCallback = () => {};
export function setRenderHudCallback(cb) { renderHudCallback = cb; }

export async function handleNewCharacterInterviews(chars) {
    let madeChanges = false;
    const userName = SillyTavern.getContext().substituteParams('{{user}}');

    for (const charName of chars) {
        const result = await callPopup(`<h3>Новая связь: ${escapeHtml(charName)}</h3><p>Этот персонаж впервые появился в трекере.<br>Задайте базовое отношение к <strong>${escapeHtml(userName)}</strong> (от -100 до 100).<br><br><span style="font-size:12px; color:#94a3b8;">0 — незнакомец, 50 — друг, -50 — враг.</span></p>`, 'input', '0');
        
        if (result !== undefined && result !== null && result !== false) {
            const parsed = parseInt(String(result).trim(), 10);
            if (!isNaN(parsed)) {
                chat_metadata['bb_vn_char_bases'][charName] = parsed;
                madeChanges = true;
            }
        }
    }
    
    if (madeChanges) {
        saveChatDebounced();
        recalculateAllStats();
    }
}

export function recalculateAllStats(isNewMessage = false) {
    const newStats = {};
    setCurrentCalculatedStats(newStats);
    currentStoryMoments.length = 0;
    chat_metadata['bb_vn_global_log'] = [];
    const chat = SillyTavern.getContext().chat;
    let latestChoiceContext = null;
    const newlyDiscoveredChars = [];
    
    if (!chat_metadata['bb_vn_char_bases']) chat_metadata['bb_vn_char_bases'] = {};
    if (!chat_metadata['bb_vn_ignored_chars']) chat_metadata['bb_vn_ignored_chars'] = [];
    setSocialParseDebug('idle', 'Ожидание ответа модели');

    let needsSave = false;

    if (chat && chat.length > 0 && chat_metadata['bb_vn_char_traits'] && Object.keys(chat_metadata['bb_vn_char_traits']).length > 0) {
        const lastMsg = chat[chat.length - 1];
        const sId = lastMsg.swipe_id || 0;
        if (!lastMsg.extra) lastMsg.extra = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes) lastMsg.extra.bb_vn_char_traits_swipes = {};
        if (!lastMsg.extra.bb_vn_char_traits_swipes[sId]) lastMsg.extra.bb_vn_char_traits_swipes[sId] = [];
        
        for (const cName in chat_metadata['bb_vn_char_traits']) {
            chat_metadata['bb_vn_char_traits'][cName].forEach(t => {
                lastMsg.extra.bb_vn_char_traits_swipes[sId].push({ charName: cName, trait: t.trait, type: t.type });
            });
        }
        delete chat_metadata['bb_vn_char_traits'];
        needsSave = true;
    }

    if (!chat || !chat.length) {
        renderHudCallback();
        injectCombinedSocialPrompt();
        return;
    }

    chat.forEach((msg, idx) => {
        if (msg?.is_user && msg.extra?.bb_vn_choice_context) {
            latestChoiceContext = msg.extra.bb_vn_choice_context;
        }

        if (scanAndCleanMessage(msg, idx)) needsSave = true;

        const swipeId = msg.swipe_id || 0;

        const msgTraits = msg.extra?.bb_vn_char_traits_swipes?.[swipeId];
        if (msgTraits && Array.isArray(msgTraits)) {
            msgTraits.forEach(t => {
                const cName = t.charName;
                if (!cName || chat_metadata['bb_vn_ignored_chars'].includes(cName)) return;

                if (t.trait) {
                    const before = String(t.trait);
                    t.trait = sanitizeTraitOutput(t.trait);
                    if (t.trait !== before) {
                        needsSave = true;
                    }
                }

                if (!t.trait || t.trait.length > 240) {
                    needsSave = true;
                    return;
                }
                
                if (!newStats[cName]) {
                    let base = chat_metadata['bb_vn_char_bases']?.[cName] ?? 0;
                    newStats[cName] = { affinity: base, history: [], status: coerceUserFacingStatus("", base, "", 0), memories: { soft: [], deep: [] }, core_traits: [] };
                }
                if (!newStats[cName].core_traits) newStats[cName].core_traits = [];
                newStats[cName].core_traits.push(t);
            });
        }

        let activeUpdates = msg.extra?.bb_social_swipes?.[swipeId];
        if (!activeUpdates && msg.extra?.bb_social_swipes) {
            for (const key in msg.extra.bb_social_swipes) {
                if (Array.isArray(msg.extra.bb_social_swipes[key])) { activeUpdates = msg.extra.bb_social_swipes[key]; break; }
            }
        }

        if (activeUpdates && Array.isArray(activeUpdates)) {
            activeUpdates.forEach(update => {
                const charName = update.name;
                if (!charName || isCollectiveEntityName(charName)) return;
                if (chat_metadata['bb_vn_ignored_chars'].includes(charName)) return;

                const IMPACT_MAP = { "unforgivable": -20, "major_negative": -8, "minor_negative": -2, "none": 0, "minor_positive": 2, "major_positive": 8, "life_changing": 20 };
                const f_delta = IMPACT_MAP[update.friendship_impact || update.impact_level] || 0;
                let r_delta = IMPACT_MAP[update.romance_impact] || 0;
                if (!chat_metadata['bb_vn_platonic_chars']) chat_metadata['bb_vn_platonic_chars'] = [];
                if (chat_metadata['bb_vn_platonic_chars'].includes(charName)) r_delta = 0;

                const currentStatus = update.role_dynamic || update.status || ""; 
                const currentEmotion = update.emotion || update.moodlet || "";
                
                if (!newStats[charName]) {
                    let base = 0, baseRomance = 0, isBrandNew = false;
                    if (chat_metadata['bb_vn_char_bases']?.[charName] !== undefined) base = parseInt(chat_metadata['bb_vn_char_bases'][charName]);
                    else { chat_metadata['bb_vn_char_bases'][charName] = 0; isBrandNew = true; newlyDiscoveredChars.push(charName); }
                    if (chat_metadata['bb_vn_char_bases_romance']?.[charName] !== undefined) baseRomance = parseInt(chat_metadata['bb_vn_char_bases_romance'][charName]);

                    newStats[charName] = { affinity: base, romance: baseRomance, history: [], status: coerceUserFacingStatus(currentStatus, base, "", f_delta), memories: { soft: [], deep: [] }, core_traits: [] };
                    if (isBrandNew) {
                        const introMoment = maybeAddStoryMoment({ type: 'intro', char: charName, title: 'Новый контакт', text: `${charName} появился в трекере отношений.` });
                        if (isNewMessage && idx === chat.length - 1) showStoryMomentToast(introMoment);
                    }
                }

                const previousAffinity = newStats[charName].affinity;
                const previousStatus = newStats[charName].status || "";
                newStats[charName].affinity += f_delta;
                newStats[charName].romance = (newStats[charName].romance || 0) + r_delta;
                
                if (newStats[charName].affinity > 100) newStats[charName].affinity = 100;
                if (newStats[charName].affinity < -100) newStats[charName].affinity = -100;
                if (newStats[charName].romance > 100) newStats[charName].romance = 100;
                if (newStats[charName].romance < -100) newStats[charName].romance = -100;

                const safeStatus = coerceUserFacingStatus(currentStatus, newStats[charName].affinity, previousStatus, f_delta);
                if (safeStatus) newStats[charName].status = safeStatus;

                const moodlet = sanitizeMoodlet(currentEmotion);
                const isRomanceShift = Math.abs(r_delta) > Math.abs(f_delta);
                const dominantDelta = isRomanceShift ? r_delta : f_delta;
                
                newStats[charName].history.push({ delta: dominantDelta, reason: update.reason || "", moodlet });
                appendCharacterMemory(newStats[charName], dominantDelta, update.reason || "", moodlet);

                const previousTier = getTierInfo(previousAffinity).label;
                const newTier = getTierInfo(newStats[charName].affinity).label;
                let toastMoment = null;
                if (previousTier !== newTier) toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: 'tier-shift', char: charName, title: 'Сдвиг в отношениях', text: `${charName}: статус изменился с «${previousTier}» на «${newTier}».` }));

                if (Math.abs(dominantDelta) >= 2 && update.reason) {
                    const shift = getShiftDescriptor(dominantDelta, moodlet);
                    let momentType = dominantDelta > 0 ? 'soft-positive' : 'soft-negative';
                    if (isRomanceShift) momentType = dominantDelta > 0 ? 'romance-positive' : 'romance-negative';
                    toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: momentType, char: charName, title: shift.full, text: `${charName}: ${update.reason}` }));
                }

                if (Math.abs(dominantDelta) >= 15 && update.reason) toastMoment = pickToastMoment(toastMoment, maybeAddStoryMoment({ type: dominantDelta > 0 ? 'deep-positive' : 'deep-negative', char: charName, title: 'Незабываемое событие', text: `${charName}: ${update.reason}` }));
                if (dominantDelta !== 0 && isNewMessage && idx === chat.length - 1 && toastMoment) showStoryMomentToast(toastMoment);

                if (f_delta !== 0 || r_delta !== 0) {
                    const totalDelta = f_delta + r_delta;
                    const logType = totalDelta > 0 ? 'plus' : (totalDelta < 0 ? 'minus' : 'system');
                    let pointsHtml = '';
                    if (f_delta !== 0) pointsHtml += `<div class="bb-glog-points" style="margin-right: 4px; padding: 4px 10px; border-radius: 8px;">🤝 Доверие: ${f_delta > 0 ? '+' : ''}${f_delta}</div>`;
                    if (r_delta !== 0) pointsHtml += `<div class="bb-glog-points" style="color: #f472b6; border-color: rgba(244,114,182,0.35); background: rgba(190,24,93,0.28); margin-right: 4px; padding: 4px 10px; border-radius: 8px;">💖 Влечение: ${r_delta > 0 ? '+' : ''}${r_delta}</div>`;
                    let timeStr = "";
                    if (msg.send_date) { try { timeStr = new Date(msg.send_date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); } catch(e) {} }
                    const logText = `<div class="bb-glog-main" style="display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%;"><span class="bb-glog-char">${escapeHtml(charName)}</span>${moodlet ? `<span class="bb-glog-delta" style="align-self: flex-start;">${escapeHtml(moodlet)}</span>` : ''}</div>${update.reason ? `<div class="bb-glog-reason" style="margin-top: 4px;">${escapeHtml(update.reason)}</div>` : ''}<div style="display:flex; flex-wrap:wrap; margin-top:6px;">${pointsHtml}</div>`;
                    addGlobalLog(logType, logText, timeStr);
                }
            });
        }
    });

    for (const char in newStats) {
        const stats = newStats[char];
        if (!stats.core_traits) stats.core_traits = []; 
        let posTraitsCount = 0, negTraitsCount = 0, legacyTraitsCount = 0;
        stats.core_traits.forEach(t => { if (t.type === 'positive') posTraitsCount++; else if (t.type === 'negative') negTraitsCount++; else legacyTraitsCount++; });
        const posToArchive = (posTraitsCount * 5) + (legacyTraitsCount * 5);
        const negToArchive = (negTraitsCount * 5) + (legacyTraitsCount * 5);
        stats.memories.archive = [];
        const newDeep = [];
        let posArchived = 0, negArchived = 0;
        for (const m of stats.memories.deep) {
            if (m.tone === 'positive' && posArchived < posToArchive) { stats.memories.archive.push(m); posArchived++; }
            else if (m.tone === 'negative' && negArchived < negToArchive) { stats.memories.archive.push(m); negArchived++; }
            else newDeep.push(m);
        }
        stats.memories.deep = newDeep;
    }

    if (latestChoiceContext) chat_metadata['bb_vn_choice_context'] = latestChoiceContext;
    else if (chat_metadata['bb_vn_pending_choice_context']) chat_metadata['bb_vn_choice_context'] = chat_metadata['bb_vn_pending_choice_context'];
    else delete chat_metadata['bb_vn_choice_context'];

    if (needsSave) saveChatDebounced();
    injectCombinedSocialPrompt();
    renderHudCallback();

    if (newlyDiscoveredChars.length > 0) handleNewCharacterInterviews(newlyDiscoveredChars);
}

export function getTrendNarrative(history = []) {
    const recent = history.filter(h => h.delta !== 0).slice(-3);
    if (recent.length === 0) return 'Штиль';
    const sum = recent.reduce((acc, curr) => acc + curr.delta, 0);
    if (sum >= 8) return 'Уверенное сближение';
    if (sum > 0) return 'Позитивный сдвиг';
    if (sum <= -8) return 'Резкое отторжение';
    if (sum < 0) return 'Нарастание напряжения';
    return 'Неоднозначно';
}
