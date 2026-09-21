import { t } from './i18n.js';
import { createHiddenCharacterSession } from './social.js';

// One compact manager, shared by the relationship toolbar and settings.
export function openHiddenCharacters() {
    if (document.querySelector('.bb-hidden-characters')) return;
    const session = createHiddenCharacterSession();
    const node = (tag, text = '', className = '') => {
        const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
    };
    const button = (text, action) => {
        const el = node('button', t(text), 'menu_button'); el.type = 'button'; el.addEventListener('click', action); return el;
    };
    const dialog = node('dialog', '', 'bb-portrait-dialog bb-hidden-characters');
    const close = () => { dialog.close(); dialog.remove(); };
    const header = node('header');
    const title = node('h3', t('Скрытые персонажи')); title.id = 'bb-hidden-characters-title';
    dialog.setAttribute('aria-labelledby', title.id);
    header.append(title, button('Закрыть', close));
    const search = node('input', '', 'text_pole'); search.type = 'search';
    search.placeholder = t('Имя персонажа'); search.setAttribute('aria-label', t('Поиск персонажа'));
    const status = node('p', '', 'bb-portrait-status'); status.setAttribute('role', 'status');
    const list = node('div', '', 'bb-hidden-list');
    const footer = node('footer');
    const all = button('Вернуть всех', () => restore(null)); footer.append(all);
    const restore = name => {
        if (!session.current()) {
            status.textContent = t('Чат или персона изменились. Откройте список заново.');
            all.disabled = true; list.replaceChildren(); return;
        }
        session.restore(name); render();
        search.focus();
    };
    function render() {
        const names = session.list();
        title.textContent = t('Скрытые персонажи') + ' · ' + names.length;
        all.disabled = names.length === 0;
        const needle = search.value.normalize('NFKC').toLocaleLowerCase().trim();
        const matches = names.filter(name => name.normalize('NFKC').toLocaleLowerCase().includes(needle)).sort((a,b) => a.localeCompare(b));
        status.textContent = !names.length ? t('Нет скрытых персонажей.') : !matches.length ? t('Персонажи не найдены. Измените поиск.') : '';
        list.replaceChildren();
        for (const name of matches) {
            const row = node('div', '', 'bb-hidden-row');
            const initials = name.trim().split(/\s+/).slice(0,2).map(part => Array.from(part)[0] || '').join('').toUpperCase();
            const avatar = node('span', initials, 'bb-hidden-initials'); avatar.setAttribute('aria-hidden', 'true');
            const label = node('span', name, 'bb-hidden-name');
            const action = button('Вернуть', () => restore(name)); action.setAttribute('aria-label', t('Вернуть') + ': ' + name);
            row.append(avatar, label, action); list.append(row);
        }
    }
    search.addEventListener('input', render);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.append(header, search, status, list, footer);
    render(); document.body.append(dialog); dialog.showModal(); search.focus();
}

export function mountHiddenCharactersButton(root) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button bb-hidden-open';
    button.textContent = t('Скрытые') + ' · ' + createHiddenCharacterSession().list().length;
    button.addEventListener('click', openHiddenCharacters);
    (root.querySelector('.bb-character-toolbar') || root).append(button);
}
