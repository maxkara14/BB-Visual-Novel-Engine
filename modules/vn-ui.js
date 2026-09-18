import { t, ui } from './i18n.js';
function getVnGenerateButton() {
    return jQuery('#bb-vn-btn-generate');
}

function buildVnGenerateButtonContent({ loading = false } = {}) {
    if (loading) {
        return ui`
            <span class="bb-vn-main-btn__content">
                <i class="fa-solid fa-spinner fa-spin"></i>
                <span class="bb-vn-main-btn__label">Сценарий в обработке...</span>
                <span class="bb-vn-main-btn__cancel" aria-hidden="true">
                    <i class="fa-solid fa-xmark"></i>
                </span>
            </span>
        `;
    }

    return ui`
        <span class="bb-vn-main-btn__content">
            <i class="fa-solid fa-clapperboard"></i>
            <span class="bb-vn-main-btn__label">Действия VN</span>
        </span>
    `;
}

export function hasRenderedVnOptions() {
    return jQuery('#bb-vn-options-container .bb-vn-option[data-intent]').length > 0;
}

export function resetVnOptionsContainer({ clear = false } = {}) {
    const container = jQuery('#bb-vn-options-container');
    if (!container.length) return container;

    const closeTimerId = Number(container.data('bbVnCloseTimer') || 0);
    if (closeTimerId) {
        window.clearTimeout(closeTimerId);
        container.removeData('bbVnCloseTimer');
    }

    if (clear) {
        container.empty();
    }

    container.removeClass('active is-closing is-opening');
    return container;
}

export function setVnGenerateButtonIdle({ hasSaved = false } = {}) {
    const button = getVnGenerateButton();
    if (!button.length) return;

    button
        .removeClass('loading')
        .toggleClass('has-saved', !!hasSaved)
        .attr('title', hasSaved ? t('Есть сохранённые варианты VN') : t('Открыть панель действий VN'))
        .html(buildVnGenerateButtonContent());
}

export function setVnGenerateButtonLoading() {
    const button = getVnGenerateButton();
    if (!button.length) return;

    button
        .removeClass('has-saved')
        .addClass('loading')
        .attr('title', t('Нажмите, чтобы отменить генерацию'))
        .html(buildVnGenerateButtonContent({ loading: true }))
        .show();
}

export function hideVnGenerateButton() {
    getVnGenerateButton().hide();
}

export function showVnGenerateButton() {
    getVnGenerateButton().show();
}
