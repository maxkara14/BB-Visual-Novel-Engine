import { t, ui, getUiLanguage } from './i18n.js';

export function snapshotStatusText(scope = {}) {
    const baseline = scope.snapshot_baseline;
    if (!baseline) return t('Импорт не активен. Отношения рассчитываются по данным чата.');
    const date = typeof baseline.imported_at === 'string' ? new Date(baseline.imported_at) : null;
    const when = date && Number.isFinite(date.getTime())
        ? date.toLocaleString(getUiLanguage() === 'ru' ? 'ru-RU' : 'en-US')
        : t('время неизвестно');
    return ui`Импортированная основа активна. Импорт: ${when}.`;
}

export function refreshSnapshotControls(scope = {}) {
    const status = document.querySelector('#bb-social-snapshot-status');
    if (status) status.textContent = snapshotStatusText(scope);
    const button = document.querySelector('#bb-social-clear-snapshot-btn');
    if (button) button.disabled = !scope.snapshot_baseline;
}

export function snapshotRemovalPrompt(hasRestore) {
    return ui`<h3>Убрать импортированную основу?</h3>
        <p>Сообщения чата останутся. Экспортированные файлы не изменятся.</p>
        <p>${hasRestore
            ? t('Будут восстановлены базовые настройки до первого импорта и заново учтены события текущих активных свайпов. Это не откат переписки к моменту импорта.')
            : t('У этого старого импорта нет сохранённой точки восстановления. Основа снимка будет удалена; расчёт продолжится по текущим базовым значениям и событиям чата. Восстановление состояния до импорта не гарантируется.')}</p>
        <p>Данные, существующие только в импортированной основе, перестанут участвовать в расчёте. Чтобы сохранить текущее состояние, сначала отмените действие и экспортируйте его.</p>`;
}
