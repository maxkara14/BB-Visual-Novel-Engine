import { planRecovery, recoveryBatches, parseRecovery, recoveryPrompt, applyRecovery } from './history-recovery.js';
import { bindActivePersonaState, recalculateAllStats, getCurrentPersonaScopeKey } from './social.js';
import { generateFastPrompt } from './generator.js';
import { currentCalculatedStats } from './state.js';
import { chat_metadata, saveChatDebounced, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME, normalizeImpactSettings } from './constants.js';
import { t } from './i18n.js';

export function openHistoryRecovery() {
    if (document.querySelector('.bb-history-recovery')) return;
    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    const { scopeKey, scopeState, aliasSet } = bindActivePersonaState();
    const integrity = chat_metadata.integrity;
    const chatId = context.chatId;
    const settings = extension_settings[MODULE_NAME];
    const stateSignature = () => JSON.stringify([scopeState.snapshot_cutoff_index, scopeState.snapshot_baseline, scopeState.char_bases, scopeState.char_bases_romance, scopeState.ignored_chars, scopeState.relationship_event_edits]);
    const initialState = stateSignature();
    const isCurrent = () => {
        const now = SillyTavern.getContext();
        return now.chat === chat && now.chatId === chatId && chat_metadata.integrity === integrity
            && getCurrentPersonaScopeKey() === scopeKey && stateSignature() === initialState;
    };
    const node = (tag, text = '', className = '') => {
        const element = document.createElement(tag);
        element.textContent = t(text); element.className = className; return element;
    };
    const button = (text, action) => {
        const element = node('button', text, 'menu_button'); element.type = 'button';
        element.addEventListener('click', action); return element;
    };
    const dialog = node('dialog', '', 'bb-portrait-dialog bb-history-recovery');
    let controller, plan, results, selections = [], closed = false;
    const close = () => { closed = true; controller?.abort(); dialog.close(); dialog.remove(); };
    const header = node('header'), title = node('h3', 'Восстановить отношения из истории');
    title.id = 'bb-history-recovery-title'; dialog.setAttribute('aria-labelledby', title.id);
    header.append(title, button('Закрыть', close));
    const intro = node('p', 'Выберите сообщения. Модель предложит персонажей и изменения отношений; сохранение — после просмотра. При сохранении трекер включится.');
    const fields = node('div', '', 'bb-recovery-fields');
    const mode = node('select', '', 'text_pole');
    for (const [value, text] of [['recent', 'Последние N сообщений'], ['all', 'Весь чат'], ['range', 'Свой диапазон']]) {
        const option = node('option', text); option.value = value; mode.append(option);
    }
    mode.value = 'recent';
    const label = (text, control) => { const element = node('label', text); element.append(control); fields.append(element); return element; };
    label('Участок истории', mode);
    const number = value => { const input = node('input', '', 'text_pole'); input.type = 'number'; input.min = '1'; input.max = String(chat.length); input.step = '1'; input.value = String(value); return input; };
    const count = number(Math.min(50, chat.length) || 1), from = number(1), to = number(chat.length || 1);
    const countLabel = label('Количество сообщений', count), fromLabel = label('От сообщения', from), toLabel = label('До сообщения', to);
    const boundaries = node('p', '', 'bb-recovery-boundaries');
    const summary = node('p'), status = node('p', '', 'bb-portrait-status'); status.setAttribute('role', 'status');
    const preview = node('div', '', 'bb-recovery-preview');
    const footer = node('footer');
    const save = button('Сохранить выбранное', () => {
        try {
            if (!isCurrent() || closed) throw new Error('Чат, персона или отношения изменились. Откройте окно заново.');
            const selectedResults = results.map(row => ({ ...row, updates: row.updates.filter(update => selections.find(item => item.update === update)?.checkbox.checked) }));
            applyRecovery(chat, plan, selectedResults, scopeKey, aliasSet);
            settings.disableRelationshipTracker = false;
            const checkbox = document.querySelector('#bb-vn-cfg-disable-tracker'); if (checkbox) checkbox.checked = false;
            saveSettingsDebounced(); recalculateAllStats(false); saveChatDebounced();
            window.updateHudVisibility?.(); window.renderSocialHud?.();
            status.textContent = t('Отношения восстановлены.');
            save.disabled = true; analyze.disabled = true;
        } catch (error) { status.textContent = error.message; }
    });
    save.hidden = true;
    const configure = () => {
        results = null; save.hidden = true; preview.replaceChildren();
        countLabel.hidden = mode.value !== 'recent'; fromLabel.hidden = toLabel.hidden = mode.value !== 'range';
        try {
            const start = mode.value === 'all' ? 0 : mode.value === 'recent' ? Math.max(0, chat.length - Number(count.value)) : Number(from.value) - 1;
            const end = mode.value === 'range' ? Number(to.value) - 1 : chat.length - 1;
            if (mode.value === 'recent' && (!Number.isInteger(Number(count.value)) || Number(count.value) < 1)) throw new Error('Укажите количество сообщений.');
            plan = planRecovery(chat, start, end, { scopeKey, aliasSet, cutoff: Number(scopeState.snapshot_cutoff_index) || 0 });
            const batches = recoveryBatches(chat, plan.pending);
            const excerpt = index => `#${index + 1} ${chat[index]?.name || ''}: ${String(chat[index]?.mes || '').replace(/\s+/g, ' ').slice(0, 140)}`;
            boundaries.textContent = `${excerpt(start)}\n…\n${excerpt(end)}`;
            summary.textContent = `${t('К анализу')}: ${plan.pending.length}. ${t('Запросов к модели')}: ${batches.length}. ${t('Пропущено — уже в трекере')}: ${plan.skipped.tracked}; ${t('уже восстановлено')}: ${plan.skipped.recovered}; ${t('в импортированной основе')}: ${plan.skipped.baseline}.`;
            analyze.disabled = !batches.length;
            status.textContent = '';
        } catch (error) { plan = null; analyze.disabled = true; status.textContent = error.message; }
    };
    const analyze = button('Анализировать', async () => {
        if (!isCurrent()) { status.textContent = t('Чат или персона изменились. Откройте окно заново.'); return; }
        configure(); if (!plan?.pending.length) return;
        controller = new AbortController();
        const controls = [mode, count, from, to, analyze]; controls.forEach(control => { control.disabled = true; });
        try {
            const batches = recoveryBatches(chat, plan.pending), collected = [];
            for (let index = 0; index < batches.length; index++) {
                if (closed || !isCurrent()) throw new Error('Чат или персона изменились. Откройте окно заново.');
                status.textContent = `${t('Анализ истории')} · ${index + 1}/${batches.length}`;
                const previousEvents = collected.flatMap(row => row.updates).slice(-20);
                const knownNames = [...new Set([...Object.keys(currentCalculatedStats), ...previousEvents.map(update => update.name)])];
                const raw = await generateFastPrompt(recoveryPrompt(batches[index], knownNames, context.name1, String(context.substituteParams?.('{{persona}}') || '').slice(0, 3200), previousEvents), { responseFormat: 'json', signal: controller.signal });
                if (closed || controller.signal.aborted) return;
                collected.push(...parseRecovery(raw, batches[index], { userNames: [context.name1], ignored: scopeState.ignored_chars || [] }));
            }
            if (!isCurrent()) throw new Error('Чат или персона изменились. Откройте окно заново.');
            results = collected; selections = []; preview.replaceChildren();
            const friendship = normalizeImpactSettings(settings.friendshipImpactValues), romance = normalizeImpactSettings(settings.romanceImpactValues);
            for (const row of results) {
                const item = plan.pending.find(item => item.index === row.index);
                const section = node('section'), heading = node('h4', `#${row.index + 1} · ${item.replacing ? t('Замена устаревших записей') : t('Новые записи')}`);
                section.append(heading);
                if (!row.updates.length) section.append(node('p', 'Новых событий нет. Участок будет отмечен обработанным.'));
                for (const update of row.updates) {
                    const entry = node('label', '', 'bb-recovery-entry'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
                    const text = node('span');
                    text.textContent = `${update.name} · ${Object.hasOwn(currentCalculatedStats, update.name) ? t('Дополнение') : t('Новый персонаж')}\n${t('Доверие')}: ${friendship[update.friendship_impact] || 0}; ${t('Влечение')}: ${romance[update.romance_impact] || 0}\n${update.role_dynamic}\n${update.reason}`;
                    entry.append(checkbox, text); section.append(entry); selections.push({ update, checkbox });
                }
                preview.append(section);
            }
            status.textContent = t('Проверьте предложения. Снятые отметки будут пропущены, сообщения отмечены обработанными. Устаревшие записи выбранного участка заменяются.');
            save.hidden = false;
        } catch (error) { if (!closed) status.textContent = `${t('Данные не сохранены.')} ${error.message}`; }
        finally { if (!closed) controls.forEach(control => { control.disabled = false; }); }
    });
    for (const control of [mode, count, from, to]) control.addEventListener('change', configure);
    footer.append(analyze, save);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.append(header, intro, fields, boundaries, summary, preview, status, footer);
    document.body.append(dialog); configure(); dialog.showModal(); mode.focus();
}
