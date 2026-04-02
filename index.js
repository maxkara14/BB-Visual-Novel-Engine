/* global jQuery, SillyTavern */
import { extension_settings } from '../../../extensions.js';
import { MODULE_NAME, DEFAULT_SETTINGS } from './modules/constants.js';
import { 
    injectCombinedSocialPrompt, 
    recalculateAllStats, 
    setRenderHudCallback,
    getCombinedSocial
} from './modules/social.js';
import { 
    ensureHudContainer, 
    updateHudVisibility, 
    renderSocialHud,
    openSocialHud,
    closeSocialHud
} from './modules/hud.js';
import { setupExtensionSettings, wipeGlobalLog, wipeAllSocialData, injectDebugData } from './modules/settings.js';
import { injectVNActionsUI } from './modules/actions.js';
import { restoreVNOptions, bbVnGenerateOptionsFlow, clearVNOptions } from './modules/generator.js';

// Глобальный экспорт для консоли и внешних вызовов
window['recalculateAllStats'] = recalculateAllStats;
window['getCombinedSocial'] = getCombinedSocial;
window['injectCombinedSocialPrompt'] = injectCombinedSocialPrompt;
window['bbVnGenerateOptionsFlow'] = bbVnGenerateOptionsFlow;
window['restoreVNOptions'] = restoreVNOptions;
window['clearVNOptions'] = clearVNOptions;
window['injectVNActionsUI'] = injectVNActionsUI;
window['setupExtensionSettings'] = setupExtensionSettings;
window['renderSocialHud'] = renderSocialHud;
window['openSocialHud'] = openSocialHud;
window['closeSocialHud'] = closeSocialHud;
window['wipeGlobalLog'] = wipeGlobalLog;
window['wipeAllSocialData'] = wipeAllSocialData;
window['updateHudVisibility'] = updateHudVisibility;
window['ensureHudContainer'] = ensureHudContainer;
window['injectDebugData'] = injectDebugData;

// Инициализация настроек по умолчанию
extension_settings[MODULE_NAME] = {
    ...DEFAULT_SETTINGS,
    ...(extension_settings[MODULE_NAME] || {}),
};

// Привязываем коллбэк отрисовки HUD к логике пересчета статов
setRenderHudCallback(renderSocialHud);

jQuery(async () => {
    try {
        const { eventSource, event_types } = SillyTavern.getContext();
        const registerHudVisibilityRecoveryEvents = () => {
            const recoveryEventCandidates = [
                'CHAT_CREATED',
                'CHAT_LOADED',
                'CHARACTER_CHANGED',
                'GROUP_UPDATED',
                'GROUP_CHAT_CREATED',
                'GROUP_CHAT_DELETED',
                'IMPERSONATE_READY',
                'SETTINGS_LOADED_AFTER',
            ];

            recoveryEventCandidates.forEach((eventKey) => {
                const eventName = event_types[eventKey];
                if (!eventName) return;
                eventSource.on(eventName, () => { updateHudVisibility(); });
            });
        };
        
        setupExtensionSettings();

        const context = SillyTavern.getContext();
        if (context.registerMacro) {
            context.registerMacro('bb_vn', () => {
                return extension_settings[MODULE_NAME].useMacro ? getCombinedSocial() : '';
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
            restoreVNOptions(false);
            injectCombinedSocialPrompt();
            injectVNActionsUI();
            recalculateAllStats(); 
            updateHudVisibility();
        });

        registerHudVisibilityRecoveryEvents();

        eventSource.on(event_types.MESSAGE_RECEIVED, () => { restoreVNOptions(false); recalculateAllStats(true); }); 
        eventSource.on(event_types.MESSAGE_DELETED, () => { restoreVNOptions(false); recalculateAllStats(); });
        eventSource.on(event_types.MESSAGE_SWIPED, () => { restoreVNOptions(false); recalculateAllStats(); });
        eventSource.on(event_types.MESSAGE_UPDATED, () => { recalculateAllStats(); });
        eventSource.on(event_types.GENERATION_STOPPED, () => { recalculateAllStats(); });
        
        if (event_types.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => { recalculateAllStats(); });
        }

        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            if (extension_settings[MODULE_NAME].autoGen) {
                setTimeout(() => {
                    const btn = jQuery('#bb-vn-btn-generate');
                    if (btn.is(':visible') && !btn.hasClass('loading')) btn.click();
                }, 1500);
            }
        });

        eventSource.on(event_types.GENERATE_AFTER_DATA, (generate_data) => {
            if (extension_settings[MODULE_NAME].useMacro && generate_data && Array.isArray(generate_data.messages)) {
                const promptText = getCombinedSocial();
                generate_data.messages.forEach(msg => {
                    if (msg && msg.content && typeof msg.content === 'string' && msg.content.includes('{{bb_vn}}')) {
                        msg.content = msg.content.replace(/\{\{bb_vn\}\}/g, promptText);
                    }
                });
            }
        });

    } catch (e) { console.error("[BB VN] Ошибка запуска:", e); }
});
