import { t, ui, getUiLanguage } from './i18n.js';

let currentChat;
let currentKey = '';
let query = '';
const modes = ['trust_desc', 'trust_asc', 'romance_desc', 'name'];
export const normalizeCharacterSort = value => modes.includes(value) ? value : 'trust_desc';

export function selectCharacterNames(stats, search = '', sort = 'trust_desc', language = getUiLanguage()) {
    const needle = String(search).normalize('NFKC').toLocaleLowerCase(language).trim();
    const names = Object.keys(stats).filter(name => name.normalize('NFKC').toLocaleLowerCase(language).includes(needle));
    const alphabetical = (a, b) => a.localeCompare(b, language, { numeric: true });
    const value = (name, field) => Number.isFinite(Number(stats[name]?.[field])) ? Number(stats[name][field]) : 0;
    const mode = normalizeCharacterSort(sort);
    return names.sort((a, b) => {
        const difference = mode === 'trust_desc' ? value(b, 'affinity') - value(a, 'affinity')
            : mode === 'trust_asc' ? value(a, 'affinity') - value(b, 'affinity')
            : mode === 'romance_desc' ? value(b, 'romance') - value(a, 'romance') : 0;
        return difference || alphabetical(a, b);
    });
}

export function syncCharacterToolbarContext(context, persona) {
    const key = JSON.stringify([context.chatId, context.characterId, context.groupId, persona]);
    if (currentChat !== context.chat || currentKey !== key) { query = ''; currentChat = context.chat; currentKey = key; }
}

export function mountCharacterToolbar(root, stats, settings, context, persona, save) {
    const stack = root.querySelector('.bb-route-card-stack');
    if (!stack) return;
    syncCharacterToolbarContext(context, persona);
    const doc = root.ownerDocument;
    const toolbar = doc.createElement('div');
    toolbar.className = 'bb-character-toolbar';
    const searchLabel = doc.createElement('label');
    searchLabel.textContent = t('Поиск персонажа');
    const search = doc.createElement('input');
    search.type = 'search'; search.className = 'text_pole'; search.value = query;
    search.placeholder = t('Имя персонажа');
    searchLabel.append(search);
    const sortLabel = doc.createElement('label');
    sortLabel.textContent = t('Сортировка персонажей');
    const sort = doc.createElement('select');sort.className = 'text_pole';
    for (const [value, label] of [['trust_desc', 'Доверие: сначала выше'], ['trust_asc', 'Доверие: сначала ниже'], ['romance_desc', 'Романтика: сначала выше'], ['name', 'По имени']]) {
        const option = doc.createElement('option');option.value = value;option.textContent = t(label);sort.append(option);
    }
    sort.value = normalizeCharacterSort(settings.hudCharacterSort);sortLabel.append(sort);
    const compactLabel = doc.createElement('label');compactLabel.className = 'bb-character-compact-toggle';
    const compact = doc.createElement('input');compact.type = 'checkbox';compact.checked = settings.hudCompactCards === true;
    const compactText = doc.createElement('span');compactText.textContent = t('Компактные карточки');compactLabel.append(compact, compactText);
    const reset = doc.createElement('button');reset.type = 'button';reset.className = 'menu_button';reset.textContent = t('Сбросить поиск');
    const count = doc.createElement('span');count.className = 'bb-character-result-count';count.setAttribute('aria-live', 'polite');
    const empty = doc.createElement('div');empty.className = 'bb-empty-hud';empty.textContent = t('Персонажи не найдены. Измените поиск.');
    toolbar.append(searchLabel, sortLabel, compactLabel, reset, count);
    root.insertBefore(toolbar, stack);root.insertBefore(empty, stack);
    const cards = new Map([...stack.querySelectorAll('.bb-char-card')].map(card => [card.dataset.char, card]));
    function update() {
        const names = selectCharacterNames(stats, query, sort.value);
        const visible = new Set(names);
        for (const [name, card] of cards) card.hidden = !visible.has(name);
        for (const name of names) if (cards.has(name)) stack.append(cards.get(name));
        stack.classList.toggle('bb-cards-compact', compact.checked);
        count.textContent = ui`Показано: ${names.length} / ${cards.size}`;
        empty.hidden = names.length > 0;
        reset.disabled = !search.value;
    }
    search.addEventListener('input', () => { query = search.value;update(); });
    reset.addEventListener('click', () => { query = '';search.value = '';update();search.focus(); });
    sort.addEventListener('change', () => { settings.hudCharacterSort = normalizeCharacterSort(sort.value);save();update(); });
    compact.addEventListener('change', () => { settings.hudCompactCards = compact.checked;save();update(); });
    update();
}
