import { t } from './i18n.js';
import { getVnConnectionProfiles, resolveVnGenerationSource } from './connections.js';
import { createTextOption } from './utils.js';

export function mountVnConnectionControls(root, settings, onChange) {
    if (!root) return { sync() {} };
    const sourceLabel = document.createElement('label');
    sourceLabel.textContent = t('Подключение для генерации');
    sourceLabel.htmlFor = 'bb-vn-cfg-source';
    const source = document.createElement('select');
    source.id = 'bb-vn-cfg-source';
    source.className = 'text_pole';
    for (const [value, label] of [
        ['main', t('Текущее подключение SillyTavern')],
        ['profile', t('Профиль Connection Manager')],
        ['custom', t('Своё API')],
    ]) source.append(createTextOption(label, value));
    const profileBlock = document.createElement('div');
    profileBlock.className = 'bb-vn-settings-stack';
    const label = document.createElement('label');
    label.textContent = t('Профиль подключения');
    label.htmlFor = 'bb-vn-cfg-profile';
    const profiles = document.createElement('select');
    profiles.id = 'bb-vn-cfg-profile';
    profiles.className = 'text_pole';
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'menu_button';
    refresh.textContent = t('Обновить профили');
    const note = document.createElement('span');
    note.className = 'bb-vn-settings-note';
    note.setAttribute('aria-live', 'polite');
    profileBlock.append(label, profiles, refresh, note);
    root.append(sourceLabel, source, profileBlock);

    let refreshVersion = 0;
    async function refreshProfiles() {
        const version = ++refreshVersion;
        refresh.disabled = true;
        profiles.disabled = true;
        note.textContent = t('Загрузка профилей…');
        try {
            const available = await getVnConnectionProfiles();
            if (version !== refreshVersion || !root.isConnected) return;
            profiles.replaceChildren(createTextOption(t('Выберите профиль'), ''));
            for (const profile of available) {
                profiles.append(createTextOption(`${profile.name}${profile.model ? ` · ${profile.model}` : ''}`, profile.id));
            }
            const selected = settings.vnConnectionProfileId || '';
            if (selected && !available.some(profile => profile.id === selected)) {
                profiles.append(createTextOption(t('Сохранённый профиль недоступен'), selected));
            }
            profiles.value = selected;
            profiles.disabled = available.length === 0;
            note.textContent = selected && !available.some(profile => profile.id === selected)
                ? t('Сохранённый профиль недоступен. Выберите другой профиль.')
                : available.length
                    ? t('Модель, пресет и instruct берутся из профиля. Основное подключение чата не переключается.')
                    : t('Нет доступных профилей. Создайте текстовый профиль в Connection Manager.');
        } catch (error) {
            if (version !== refreshVersion || !root.isConnected) return;
            profiles.replaceChildren(createTextOption(t('Профили недоступны'), settings.vnConnectionProfileId || ''));
            note.textContent = error.message;
        } finally {
            if (version === refreshVersion) refresh.disabled = false;
        }
    }

    function sync() {
        source.value = resolveVnGenerationSource(settings);
        profileBlock.hidden = source.value !== 'profile';
        profileBlock.style.display = profileBlock.hidden ? 'none' : 'flex';
        if (!profileBlock.hidden) void refreshProfiles();
    }
    source.addEventListener('change', () => {
        settings.vnGenerationSource = source.value;
        sync();
        onChange();
    });
    profiles.addEventListener('change', () => {
        settings.vnConnectionProfileId = profiles.value;
        void refreshProfiles();
        onChange();
    });
    refresh.addEventListener('click', () => { void refreshProfiles(); });
    sync();
    return { sync };
}
