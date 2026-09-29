import { t, ui, getUiLanguage } from './i18n.js';
import { listSnapshotRecords } from './snapshot-records.js';
import { allMemoryEditorEntries } from './memory-editor.js';
import { listRelationshipEvents } from './relationship-event-editor.js';
import { getCurrentPersonaScopeKey } from './social.js';
import { currentCalculatedStats } from './state.js';
import { escapeHtml } from './utils.js';

const memoryKindLabel = kind => ({ soft: t('Мягкие следы'), deep: t('Незабываемые события'),
    archive: t('Архив'), trait: t('Черты характера') })[kind] || t('Память');

export function listRelationshipEditorRecords(scope = {}) {
    const chat = globalThis.SillyTavern?.getContext?.()?.chat;
    const scopeKey = getCurrentPersonaScopeKey();
    return [
        ...allMemoryEditorEntries(chat, scopeKey).map(entry => ({
            kind: 'memory', key: String(entry.index), index: entry.index, revision: entry.revision,
            title: entry.name, text: entry.text, detail: memoryKindLabel(entry.kind),
            memoryKind: entry.kind, imported: entry.imported, hidden: entry.hidden, canUndo: entry.canUndo,
        })),
        ...listRelationshipEvents(chat, scopeKey).map(entry => ({
            kind: 'event', key: entry.key, index: entry.index, revision: entry.revision,
            title: entry.name, text: entry.reason, detail: entry.time, mood: entry.mood,
            reason: entry.reason, friendshipDelta: entry.friendshipDelta, romanceDelta: entry.romanceDelta,
            points: [entry.friendshipDelta ? `🤝 ${t('Доверие')}: ${entry.friendshipDelta > 0 ? '+' : ''}${entry.friendshipDelta}` : '',
                entry.romanceDelta ? `💖 ${t('Влечение')}: ${entry.romanceDelta > 0 ? '+' : ''}${entry.romanceDelta}` : ''].filter(Boolean),
            disabled: entry.disabled, canUndo: entry.canUndo,
            platonic: scope.platonic_chars?.includes(entry.name) === true,
        })),
        ...Object.entries(currentCalculatedStats || {})
            .filter(([name]) => !Object.hasOwn(scope.snapshot_baseline?.characters || {}, name))
            .map(([name, entry]) => ({
                kind: 'character', key: name, title: name, text: name, readOnly: true,
                detail: [entry?.status, Number.isFinite(entry?.affinity) ? `🤝 ${entry.affinity}` : '',
                    Number.isFinite(entry?.romance) ? `💖 ${entry.romance}` : ''].filter(Boolean).join(' · '),
            })),
        ...listSnapshotRecords(scope),
    ];
}

export function snapshotRecordRemovalPrompt(record) {
    const isJournal = record.kind === 'log';
    const kind = record.kind === 'character' ? t('Персонаж')
        : isJournal ? `${t('Журнал')} #${record.number}` : t('Момент');
    const body = isJournal && (record.reason || record.mood || record.points?.length)
        ? `${record.mood ? `<div class="bb-vn-snapshot-confirm-field"><span>${t('Эмоция')}</span><p>${escapeHtml(record.mood)}</p></div>` : ''}
           ${record.reason ? `<div class="bb-vn-snapshot-confirm-field"><span>${t('Событие')}</span><p>${escapeHtml(record.reason)}</p></div>` : ''}
           ${record.points?.length ? `<div class="bb-vn-snapshot-confirm-points">${record.points.map(point => `<span>${escapeHtml(point)}</span>`).join('')}</div>` : ''}`
        : `<p class="bb-vn-snapshot-confirm-text">${escapeHtml(record.text === record.title ? record.detail : record.text || record.detail || '')}</p>`;
    return ui`<div class="bb-vn-snapshot-confirm">
        <h3>Удалить запись из основы снимка?</h3>
        <div class="bb-vn-snapshot-confirm-card">
            <span class="bb-vn-snapshot-confirm-kind">${kind}</span>
            <strong>${escapeHtml(record.title)}</strong>
            ${body}
            ${isJournal && record.detail ? `<small>${escapeHtml(record.detail)}</small>` : ''}
        </div>
        <p class="bb-vn-snapshot-confirm-note">Сообщения чата не изменятся. Последнее удаление можно отменить.</p>
    </div>`;
}

export function snapshotStatusText(scope = {}) {
    const warning = scope.snapshot_branch_uncertain
        ? `${t('Для этой старой ветки точное состояние снимка не сохранилось. При необходимости импортируйте снимок вручную.')} `
        : '';
    const baseline = scope.snapshot_baseline;
    if (!baseline) return warning + t('Импорт не активен. Отношения рассчитываются по данным чата.');
    const date = typeof baseline.imported_at === 'string' ? new Date(baseline.imported_at) : null;
    const when = date && Number.isFinite(date.getTime())
        ? date.toLocaleString(getUiLanguage() === 'ru' ? 'ru-RU' : 'en-US')
        : t('время неизвестно');
    return warning + ui`Импортированная основа активна. Импорт: ${when}.`;
}

export function refreshSnapshotControls(scope = {}) {
    const status = document.querySelector('#bb-social-snapshot-status');
    if (status) status.textContent = snapshotStatusText(scope);
    const button = document.querySelector('#bb-social-clear-snapshot-btn');
    if (button) button.disabled = !scope.snapshot_baseline;
    const editor = document.querySelector('#bb-social-snapshot-records');
    if (!editor) return;
    editor.hidden = false;
    const list = document.querySelector('#bb-social-snapshot-record-list');
    const filters = document.querySelector('#bb-social-snapshot-record-filters');
    const preview = document.querySelector('#bb-social-snapshot-record-preview');
    if (!list || !filters || !preview) return;
    const records = listRelationshipEditorRecords(scope);
    const kinds = [
        ['all', t('Все')], ['character', t('Персонажи')],
        ['memory', t('Память и черты')], ['event', t('Изменения')], ['log', t('Журнал')], ['moment', t('Моменты')],
    ];
    const filter = kinds.some(([kind]) => kind === filters.dataset.filter) ? filters.dataset.filter : 'all';
    const query = document.querySelector('#bb-social-snapshot-record-search')?.value.trim().toLocaleLowerCase() || '';
    filters.replaceChildren(...kinds.map(([kind, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bb-vn-snapshot-filter';
        button.dataset.kind = kind;
        button.setAttribute('aria-pressed', String(kind === filter));
        button.textContent = `${label} ${kind === 'all' ? records.length : records.filter(record => record.kind === kind).length}`;
        return button;
    }));
    const visible = records.filter(record => (filter === 'all' || record.kind === filter)
        && (!query || `${record.title} ${record.text} ${record.detail} ${record.mood || ''} ${(record.points || []).join(' ')}`.toLocaleLowerCase().includes(query)));
    const recordId = record => `${record.kind}:${record.key}`;
    const selected = visible.find(record => recordId(record) === list.dataset.selected) || visible[0];
    const editing = selected?.kind === 'memory' || selected?.kind === 'event';
    list.dataset.selected = selected ? recordId(selected) : '';
    list.replaceChildren(...visible.map(record => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bb-vn-snapshot-record';
        button.dataset.record = recordId(record);
        button.setAttribute('aria-pressed', String(record === selected));
        const kind = document.createElement('span');
        kind.className = 'bb-vn-snapshot-record-kind';
        kind.textContent = record.kind === 'character' ? `${t('Персонаж')} · ${t(record.readOnly ? 'Чат' : 'Импорт')}`
            : record.kind === 'memory' ? `${record.detail} · ${record.imported ? t('Импорт') : t('Чат')}${record.hidden ? ` · ${t('Удалено')}` : ''}`
                : record.kind === 'event' ? `${t('Изменение')} · ${t('Чат')}${record.disabled ? ` · ${t('Отключено')}` : ''}`
                : record.kind === 'log' ? `${t('Журнал')} #${record.number} · ${t('Импорт')}` : `${t('Момент')} · ${t('Импорт')}`;
        const title = document.createElement('strong');
        title.textContent = record.title;
        if (record.mood) {
            const mood = document.createElement('span');
            mood.className = 'bb-vn-snapshot-record-mood';
            mood.textContent = record.mood;
            button.append(kind, title, mood);
        } else {
            button.append(kind, title);
        }
        if (!(record === selected && editing)) {
            const excerpt = document.createElement('span');
            excerpt.className = 'bb-vn-snapshot-record-excerpt';
            excerpt.textContent = record.reason || (record.text === record.title ? record.detail : record.text || record.detail || t('Без описания'));
            button.append(excerpt);
        }
        return button;
    }));
    preview.hidden = editing;
    preview.replaceChildren();
    if (selected && !editing) {
        const label = document.createElement('span');
        label.className = 'bb-vn-snapshot-preview-label';
        label.textContent = selected.kind === 'log' ? `${t('Журнал')} #${selected.number}`
            : selected.kind === 'memory' ? `${selected.detail} · ${selected.imported ? t('Импорт') : t('Чат')}` : t('Выбрана запись');
        const title = document.createElement('strong');
        title.textContent = selected.title;
        preview.append(label, title);
        if (selected.mood) {
            const mood = document.createElement('span');
            mood.className = 'bb-vn-snapshot-preview-mood';
            mood.textContent = selected.mood;
            preview.append(mood);
        }
        const bodyText = selected.kind === 'memory' ? '' : selected.reason || (selected.text === selected.title ? selected.detail
            : selected.text || selected.detail || t('Без описания'));
        if (bodyText) {
            const body = document.createElement('p');
            body.textContent = bodyText;
            preview.append(body);
        }
        if (selected.points?.length) {
            const points = document.createElement('div');
            points.className = 'bb-vn-snapshot-preview-points';
            for (const value of selected.points) {
                const chip = document.createElement('span');
                chip.textContent = value;
                points.append(chip);
            }
            preview.append(points);
        }
        if (selected.detail && selected.text !== selected.title) {
            const detail = document.createElement('small');
            detail.textContent = selected.detail;
            preview.append(detail);
        }
    } else if (!selected) {
        preview.textContent = records.length ? t('Записи не найдены') : t('Записей пока нет');
    }
    const remove = document.querySelector('#bb-social-snapshot-record-remove');
    if (remove) {
        remove.disabled = !selected || selected.readOnly === true || (selected.kind === 'memory' && selected.hidden) || (selected.kind === 'event' && selected.disabled);
        remove.textContent = selected?.kind === 'memory' ? t('Скрыть запись')
            : selected?.kind === 'event' ? t('Отключить событие') : t('Удалить запись');
    }
    const undo = document.querySelector('#bb-social-snapshot-record-undo');
    if (undo) {
        undo.disabled = !selected || selected.readOnly === true || (editing ? !selected.canUndo : !scope.snapshot_record_undo);
        undo.textContent = editing ? t('Отменить правку') : t('Отменить удаление');
    }
    const text = document.querySelector('#bb-social-snapshot-record-text');
    const label = document.querySelector('#bb-social-snapshot-record-text-label');
    const hint = document.querySelector('#bb-social-snapshot-record-hint');
    const save = document.querySelector('#bb-social-snapshot-record-save');
    for (const node of [text, label, hint, save]) if (node) node.hidden = !editing;
    if (label) label.textContent = selected?.kind === 'event' ? t('Причина изменения') : t('Текст записи');
    if (hint) hint.textContent = selected?.kind === 'event'
        ? t('Правка события пересчитает баллы отношений, память и журнал.')
        : t('Правки памяти и черт не меняют баллы отношений и журнал.');
    if (save) save.textContent = selected?.kind === 'event' ? t('Сохранить изменение') : t('Сохранить текст');
    if (text) {
        if (text.dataset.record !== list.dataset.selected || text.dataset.revision !== String(selected?.revision)) {
            text.value = editing ? selected.text : '';
        }
        text.dataset.record = list.dataset.selected;
        text.dataset.revision = String(selected?.revision);
        text.disabled = !editing || selected.hidden === true || selected.disabled === true;
        text.maxLength = selected?.memoryKind === 'trait' ? 240 : 2000;
    }
    if (save) save.disabled = !editing || selected.hidden === true || selected.disabled === true;
    const eventFields = document.querySelector('#bb-social-snapshot-event-fields');
    const mood = document.querySelector('#bb-social-snapshot-event-mood');
    const friendship = document.querySelector('#bb-social-snapshot-event-friendship');
    const romance = document.querySelector('#bb-social-snapshot-event-romance');
    if (eventFields) eventFields.hidden = selected?.kind !== 'event';
    for (const [node, value] of [[mood, selected?.mood || ''], [friendship, selected?.friendshipDelta ?? 0], [romance, selected?.romanceDelta ?? 0]]) {
        if (!node) continue;
        if (node.dataset.record !== list.dataset.selected || node.dataset.revision !== String(selected?.revision)) node.value = value;
        node.dataset.record = list.dataset.selected;
        node.dataset.revision = String(selected?.revision);
        node.disabled = selected?.disabled === true || (node === romance && selected?.platonic === true);
    }
}

export function snapshotRemovalPrompt(hasRestore) {
    return ui`<h3>Убрать импортированную основу?</h3>
        <p>Сообщения чата останутся. Экспортированные файлы не изменятся.</p>
        <p>${hasRestore
            ? t('Будут восстановлены базовые настройки до первого импорта и заново учтены события текущих активных свайпов. Это не откат переписки к моменту импорта.')
            : t('У этого старого импорта нет сохранённой точки восстановления. Основа снимка будет удалена; расчёт продолжится по текущим базовым значениям и событиям чата. Восстановление состояния до импорта не гарантируется.')}</p>
        <p>Данные, существующие только в импортированной основе, перестанут участвовать в расчёте. Чтобы сохранить текущее состояние, сначала отмените действие и экспортируйте его.</p>`;
}
