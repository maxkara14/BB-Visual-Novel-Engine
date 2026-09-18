import { t, ui } from './i18n.js';
import { escapeHtml } from './utils.js';
import { memoryEditorEntries, changeMemoryEntry } from './memory-editor.js';

export function buildMemoryEditorHtml(name) {
    const records = memoryEditorEntries(name);
    if (!records.length) return '';
    const labels = { soft: t('Мягкие следы'), deep: t('Незабываемые события'), archive: t('Архив'), trait: t('Черты характера') };
    const options = records.map(record => `<option value="${record.index}">${escapeHtml(`${labels[record.kind]}${record.hidden ? ` · ${t('Удалено')}` : ''}: ${record.text.slice(0, 80)}`)}</option>`).join('');
    return ui`<details class="bb-memory-editor" data-char="${escapeHtml(name)}">
        <summary>Редактор памяти и черт</summary>
        <p>Правки меняют память для будущих ответов, но не баллы отношений и не журнал событий. Удалённые записи можно вернуть через отмену. Сохраняются последние 20 правок каждой записи.</p>
        <label>Запись<select class="text_pole bb-memory-select">${options}</select></label>
        <label>Текст записи<textarea class="text_pole bb-memory-text" rows="4"></textarea></label>
        <p>Черта: «Название: описание», до 240 символов. Воспоминание: до 2000 символов.</p>
        <div class="bb-memory-editor-actions">
            <button type="button" class="menu_button" data-action="edit">Сохранить текст</button>
            <button type="button" class="menu_button" data-action="delete">Удалить запись</button>
            <button type="button" class="menu_button" data-action="undo">Отменить правку записи</button>
        </div>
    </details>`;
}

export function mountMemoryEditors(root, { getContext, getPersonaKey, confirm, changed, error }) {
    for (const editor of root.querySelectorAll('.bb-memory-editor')) {
        const records = memoryEditorEntries(editor.dataset.char);
        const select = editor.querySelector('.bb-memory-select');
        const text = editor.querySelector('.bb-memory-text');
        const buttons = [...editor.querySelectorAll('[data-action]')];
        const originalContext = getContext();
        const chat = originalContext.chat;
        const scene = JSON.stringify(chat?.map(message => [message.mes, message.swipe_id]));
        const persona = getPersonaKey();
        const contextKey = context => JSON.stringify([context.chatId, context.characterId, context.groupId]);
        const key = contextKey(originalContext);
        const selected = () => records.find(record => record.index === Number(select.value));
        const sync = () => {
            const record = selected();
            text.value = record?.text || '';
            text.maxLength = record?.kind === 'trait' ? 240 : 2000;
            for (const button of buttons) button.disabled = !record
                || (button.dataset.action === 'undo' && !record.canUndo)
                || (button.dataset.action !== 'undo' && record.hidden);
            text.disabled = !record || record.hidden;
        };
        select.addEventListener('change', sync);
        sync();
        for (const button of buttons) button.addEventListener('click', async event => {
            event.stopPropagation();
            const record = selected();
            if (!record) return;
            const action = button.dataset.action;
            const value = text.value;
            try {
                if (action === 'delete' && await confirm(t('Удалить запись из памяти? Баллы отношений и журнал останутся прежними. Удаление можно отменить.')) !== true) return;
                const context = getContext();
                if (context.chat !== chat || contextKey(context) !== key || getPersonaKey() !== persona
                    || JSON.stringify(context.chat?.map(message => [message.mes, message.swipe_id])) !== scene) throw new Error('EDITOR_STALE');
                if (changeMemoryEntry(record.index, record.revision, action, value)) {
                    changed();
                    const refreshed = [...root.querySelectorAll('.bb-memory-editor')].find(node => node.dataset.char === editor.dataset.char);
                    if (refreshed) {
                        refreshed.open = true;
                        const refreshedSelect = refreshed.querySelector('.bb-memory-select');
                        if ([...refreshedSelect.options].some(option => Number(option.value) === record.index)) refreshedSelect.value = String(record.index);
                        refreshedSelect.dispatchEvent(new Event('change'));
                    }
                }
            } catch (cause) {
                error(t(cause.message === 'EDITOR_TEXT'
                    ? 'Проверьте длину текста. Для черты используйте «Название: описание».'
                    : 'Сцена или записи изменились. Откройте редактор заново.'));
            }
        });
    }
}
