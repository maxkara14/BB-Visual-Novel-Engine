import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { MODULE_NAME } from './constants.js';
import { t } from './i18n.js';
import { generatePortrait, fetchPortraitModels, PORTRAIT_DEFAULTS, readPortraitFile, parsePortraitImage } from './portrait-provider.js';
import { generatePortraitPrompt } from './generator.js';
import { getCurrentPersonaScopeKey } from './social.js';
import { createPortraitGallery, downloadPortrait, copyPortrait } from './portrait-gallery.js';

function settings() { return { ...PORTRAIT_DEFAULTS, ...extension_settings[MODULE_NAME].portrait }; }
function node(tag, text = '', className = '') {
    const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function button(text, handler) {
    const el = node('button', t(text), 'menu_button'); el.type = 'button'; el.addEventListener('click', handler); return el;
}
function field(root, label, value, { choices, type = 'text', rows, maxLength = 8000 } = {}) {
    const wrap = node('label', '', 'bb-portrait-field'); wrap.append(node('span', t(label)));
    const input = node(choices ? 'select' : rows ? 'textarea' : 'input', '', 'text_pole');
    if (choices) for (const [value, caption] of choices) { const option = node('option', t(caption)); option.value = value; input.append(option); }
    else if (rows) input.rows = rows;
    else input.type = type;
    input.maxLength = maxLength; input.value = value;
    wrap.append(input); root.append(wrap); return input;
}

export function mountPortraitSettings(root) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const s = settings();
    const connection = node('div', '', 'bb-portrait-connection');
    const advanced = node('details', '', 'bb-portrait-fold');
    advanced.append(node('summary', t('Параметры изображения')));
    const parameters = node('div', '', 'bb-portrait-parameters'); advanced.append(parameters);
    const styleBox = node('details', '', 'bb-portrait-fold');
    styleBox.append(node('summary', t('Стиль портретов')));
    const styleBody = node('div', '', 'bb-portrait-fold-body'); styleBox.append(styleBody);
    const definitions = [
        ['type', 'Формат API', { choices: [['openai-images','OpenAI Images'],['openai-chat','OpenAI Chat'],['gemini','Gemini'],['naistera','Naistera']] }],
        ['endpoint', 'Адрес сервиса', { type: 'url' }], ['key','API-ключ',{type:'password'}],
        ['model','Модель',{choices:[]}], ['style','Общий стиль портретов',{rows:3,maxLength:2000}],
        ['size','Размер',{choices:[['1024x1024','1024×1024'],['1024x1536','1024×1536'],['1536x1024','1536×1024'],['1024x1792','1024×1792'],['1792x1024','1792×1024']]}],
        ['quality','Качество',{choices:[['','По умолчанию'],['standard','standard'],['hd','hd'],['low','low'],['medium','medium'],['high','high'],['auto','auto']]}],
        ['aspect','Пропорции портрета',{choices:[['1:1','1:1'],['3:4','3:4'],['2:3','2:3'],['4:3','4:3']]}],
        ['imageSize','Разрешение Gemini / Chat',{choices:[['1K','1K'],['2K','2K'],['4K','4K']]}],
        ['preset','Пресет Naistera',{}], ['timeout','Ожидание, сек.',{type:'number'}],
    ];
    const controls = new Map();
    let discovery = null, availableModels = [], manual;
    const endpoints = { 'openai-images': 'https://api.openai.com/v1', 'openai-chat': 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com', naistera: 'https://naistera.org' };
    const status = node('small', t('Подключение не проверено'), 'bb-portrait-connection-status');
    status.dataset.state = 'idle';
    status.setAttribute('role', 'status');
    const connect = button('Подключить', async () => {
        if (discovery) return;
        const operation = new AbortController(); discovery = operation;
        connect.disabled = true; cancel.disabled = false; cancel.hidden = false;
        status.dataset.state = 'loading';
        status.textContent = t('Проверка подключения…');
        try {
            extension_settings[MODULE_NAME].portrait = { ...settings(), endpoint: controls.get('endpoint').value.trim() || endpoints[settings().type] };
            controls.get('endpoint').value = settings().endpoint;
            saveSettingsDebounced();
            const result = await fetchPortraitModels(settings(), operation.signal);
            if (discovery !== operation || operation.signal.aborted) return;
            availableModels = result.models;
            if (!settings().model && availableModels.length) {
                extension_settings[MODULE_NAME].portrait = { ...settings(), model: availableModels[0] };
                saveSettingsDebounced();
            }
            renderModels();
            status.dataset.state = result.verified ? 'success' : 'idle';
            status.textContent = result.verified
                ? (availableModels.length ? t('Подключено. Моделей: ') + availableModels.length : t('API доступен, но список моделей пуст. Можно указать ID вручную.'))
                : t('Встроенный список Naistera. Доступ к API проверяется при генерации.');
        } catch (error) {
            if (discovery !== operation) return;
            status.dataset.state = 'error';
            status.textContent = error?.name === 'VnRequestError' ? error.message : t('Не удалось получить модели. Проверьте адрес, ключ и CORS.');
        } finally {
            if (discovery === operation) { discovery = null; connect.disabled = false; cancel.disabled = true; cancel.hidden = true; }
        }
    });
    const cancel = button('Отмена', () => invalidate()); cancel.disabled = true; cancel.hidden = true;
    connect.className += ' bb-portrait-connect-button';
    connect.title = t('Проверить подключение и обновить список моделей');
    const connectionActions = node('div', '', 'bb-portrait-connection-actions');
    connectionActions.append(connect, cancel);
    function invalidate() {
        discovery?.abort(); discovery = null;
        connect.disabled = false; cancel.disabled = true; cancel.hidden = true;
        availableModels = [];
        status.textContent = t('Подключение не проверено');
        status.dataset.state = 'idle';
        if (controls.has('model')) renderModels();
    }
    function renderModels() {
        const input = controls.get('model');
        input.replaceChildren();
        const selected = settings().model;
        const values = [...new Set([selected, ...availableModels].filter(Boolean))];
        if (!selected) { const empty = node('option', t('Выберите модель')); empty.value = ''; input.append(empty); }
        for (const value of values) { const option = node('option', value); option.value = value; input.append(option); }
        const custom = node('option', t('Указать ID вручную…')); custom.value = '__manual__'; input.append(custom);
        input.value = selected;
    }
    const profileBox = node('details', '', 'bb-portrait-profiles bb-portrait-fold');
    profileBox.append(node('summary', t('Профили подключения')));
    const profileBody = node('div', '', 'bb-portrait-fold-body'); profileBox.append(profileBody);
    const profiles = field(profileBody, 'Сохранённое подключение', '', { choices: [] });
    const profileName = field(profileBody, 'Имя профиля', '', { maxLength: 100 });
    const profileFields = ['type','endpoint','key','model','size','quality','aspect','imageSize','preset','timeout'];
    const savedProfiles = () => Array.isArray(settings().profiles) ? settings().profiles : [];
    function renderProfiles() {
        profiles.replaceChildren();
        const current = node('option', t('Текущие настройки')); current.value = ''; profiles.append(current);
        for (const item of savedProfiles()) { const option = node('option', item.label); option.value = item.id; profiles.append(option); }
        profiles.value = settings().activeProfile || '';
        profileName.value = savedProfiles().find(p => p.id === profiles.value)?.label || '';
        updateProfile.disabled = deleteProfile.disabled = !savedProfiles().some(p => p.id === profiles.value);
    }
    profiles.addEventListener('change', () => {
        const profile = savedProfiles().find(p => p.id === profiles.value);
        const values = profile ? Object.fromEntries(profileFields.map(key => [key, profile[key] ?? PORTRAIT_DEFAULTS[key]])) : {};
        extension_settings[MODULE_NAME].portrait = { ...settings(), ...values, activeProfile: profile?.id || '' };
        for (const key of profileFields) if (controls.has(key)) controls.get(key).value = settings()[key];
        saveSettingsDebounced(); invalidate(); sync(); renderProfiles();
    });
    const profileActions = node('div', '', 'bb-portrait-connection-actions bb-portrait-profile-actions');
    const updateProfile = button('Обновить выбранный', () => {
        const existing = savedProfiles().find(p => p.id === profiles.value);
        if (!existing) return;
        const label = profileName.value.trim();
        if (!label) { profileName.focus(); return; }
        const id = existing.id;
        const entry = { id, label, ...Object.fromEntries(profileFields.map(key => [key, settings()[key]])) };
        extension_settings[MODULE_NAME].portrait = { ...settings(), activeProfile: id, profiles: [...savedProfiles().filter(p => p.id !== id), entry] };
        saveSettingsDebounced(); renderProfiles();
    });
    const createProfile = button('Сохранить как новый…', () => {
        const label = window.prompt(t('Название нового профиля'), profileName.value)?.trim();
        if (!label) return;
        const id = 'portrait-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const entry = { id, label, ...Object.fromEntries(profileFields.map(key => [key, settings()[key]])) };
        extension_settings[MODULE_NAME].portrait = { ...settings(), activeProfile: id, profiles: [...savedProfiles(), entry] };
        saveSettingsDebounced(); renderProfiles();
    });
    const deleteProfile = button('Удалить профиль…', () => {
        const selected = savedProfiles().find(p => p.id === profiles.value);
        if (!selected || !window.confirm(t('Удалить сохранённый профиль? Текущее подключение останется.') + '\n' + selected.label)) return;
        extension_settings[MODULE_NAME].portrait = { ...settings(), activeProfile: '', profiles: savedProfiles().filter(p => p.id !== selected.id) };
        saveSettingsDebounced(); renderProfiles();
    });
    profileActions.append(updateProfile, createProfile, deleteProfile);
    profileBody.append(profileActions);
    const sync = () => {
        const type = controls.get('type').value;
        controls.get('endpoint').placeholder = endpoints[type];
        for (const key of ['size','quality']) controls.get(key).parentElement.hidden = type !== 'openai-images';
        controls.get('aspect').parentElement.hidden = type === 'openai-images';
        controls.get('imageSize').parentElement.hidden = !['gemini','openai-chat'].includes(type);
        controls.get('preset').parentElement.hidden = type !== 'naistera';
    };
    for (const [key, caption, options] of definitions) {
        if (key === 'model') connection.append(connectionActions, status);
        const parent = ['type','endpoint','key','model'].includes(key) ? connection : key === 'style' ? styleBody : parameters;
        const input = field(parent, caption, s[key], options); controls.set(key,input);
        input.dataset.portraitField = key;
        if (key === 'timeout') { input.min = '15'; input.max = '600'; }
        if (key === 'key') input.autocomplete = 'off';
        input.addEventListener('change', () => {
            if (key === 'model' && input.value === '__manual__') {
                manual.parentElement.hidden = false; manual.value = settings().model; manual.focus(); return;
            }
            const value = key === 'timeout' ? Math.max(15, Math.min(600, Number(input.value) || 180)) : input.value;
            extension_settings[MODULE_NAME].portrait = { ...settings(), [key]: value };
            if (key === 'type' && (!settings().endpoint || Object.values(endpoints).includes(settings().endpoint))) {
                extension_settings[MODULE_NAME].portrait.endpoint = endpoints[value];
                controls.get('endpoint').value = endpoints[value];
            }
            input.value = value; saveSettingsDebounced(); sync();
            if (['type', 'endpoint', 'key'].includes(key)) invalidate();
            if (key === 'model') manual.parentElement.hidden = true;
        });
        if (['endpoint','key'].includes(key)) input.addEventListener('input', invalidate);
        if (key === 'model') {
            manual = field(connection, 'ID модели вручную', s.model); manual.parentElement.hidden = true;
            manual.addEventListener('change', () => {
                extension_settings[MODULE_NAME].portrait = { ...settings(), model: manual.value.trim() };
                saveSettingsDebounced(); renderModels(); manual.parentElement.hidden = true;
            });
        }
    }
    parameters.append(node('small', t('Список подтверждает доступ к API, но не поддержку генерации картинок каждой моделью. OpenAI Images отправляет референсы через /images/edits; при отказе они не отбрасываются.'), 'bb-vn-settings-note'));
    root.append(connection, profileBox, advanced, styleBox);
    renderModels(); renderProfiles();
    sync();
}

export function portraitContextKey(context, persona) {
    return JSON.stringify([context.getCurrentChatId?.() ?? context.chatId, context.characterId, context.groupId, persona]);
}

export function openPortraitWorkshop({ charName, description, avatar, isEditorCurrent, apply, prepare = async value => value }) {
    if (document.querySelector('.bb-portrait-dialog')) return;
    const context = SillyTavern.getContext();
    const chat = context.chat;
    const key = portraitContextKey(context, getCurrentPersonaScopeKey());
    const narrative = () => JSON.stringify((SillyTavern.getContext().chat || []).map(m => [m.mes, m.swipe_id]));
    const initialNarrative = narrative();
    const valid = () => isEditorCurrent() && SillyTavern.getContext().chat === chat && key === portraitContextKey(SillyTavern.getContext(), getCurrentPersonaScopeKey()) && narrative() === initialNarrative;
    const dialog = node('dialog', '', 'bb-portrait-dialog');
    const title = node('h3', t('Портрет') + ' · ' + charName); title.id = 'bb-portrait-title'; dialog.setAttribute('aria-labelledby',title.id);
    let controller = null, result = '', original = '', closed = false;
    const gallery = createPortraitGallery(charName);
    let entries = gallery.list(), selectedId = '', selectedImage = '';
    const close = () => { closed = true; controller?.abort(); dialog.close(); dialog.remove(); };
    const header = node('header'); header.append(title,button('Закрыть',close)); dialog.append(header);
    const tabs = node('nav', '', 'bb-portrait-tabs'); tabs.setAttribute('aria-label', t('Портреты'));
    const createTab = button('Создать', () => showTab(false));
    const galleryTab = button('Галерея', () => showTab(true));
    tabs.append(createTab, galleryTab); dialog.append(tabs);
    const layout = node('div','','bb-portrait-layout'); dialog.append(layout);
    const preview = node('div','','bb-portrait-preview'); const image = node('img'); image.alt = t('Предпросмотр портрета'); image.hidden = true;
    const placeholder = node('p',t('Результат появится здесь. Старый аватар не изменится до применения.'));
    preview.append(image,placeholder); layout.append(preview);
    const form = node('div','','bb-portrait-form'); layout.append(form);
    form.append(node('small',t('Подключение: настройки VNE → Изображения. Сборка промпта использует обычное подключение генерации VNE.')));
    const prompt = field(form,'Промпт портрета','',{rows:6});
    const appearanceHelp = node('div', '', 'bb-portrait-appearance-help'); appearanceHelp.hidden = true;
    appearanceHelp.append(node('p', t('Недостаточно сведений о внешности. Можно дополнить образ по контексту мира или описать его самостоятельно.')));
    const appearanceActions = node('div', '', 'bb-portrait-appearance-actions');
    const supplement = button('Дополнить с ИИ', () => run('supplement'));
    const manual = button('Дополнить вручную', () => { appearanceHelp.hidden = true; prompt.focus(); });
    appearanceActions.append(supplement, manual); appearanceHelp.append(appearanceActions); form.append(appearanceHelp);
    form.append(node('small',t('Напишите свой промпт или соберите внешность из описания и сцены. Если данных мало, уточните внешность вручную.')));
    const style = field(form,'Общий стиль портретов',settings().style,{rows:2,maxLength:2000});
    style.addEventListener('change',()=> {
        extension_settings[MODULE_NAME].portrait={...settings(),style:style.value};saveSettingsDebounced();
        const settingsStyle = document.querySelector('#bb-vn-portrait-settings [data-portrait-field="style"]');
        if (settingsStyle) settingsStyle.value = style.value;
    });
    const refsDetails=node('details');refsDetails.append(node('summary',t('Референсы')));form.append(refsDetails);
    const refsList=node('div','','bb-portrait-refs');refsDetails.append(refsList);
    const refs=[];
    const status=node('p','','bb-portrait-status');status.setAttribute('role','status');dialog.append(status);
    const actions=node('footer');dialog.append(actions);
    const galleryPane = node('div', '', 'bb-portrait-gallery'); galleryPane.hidden = true; dialog.append(galleryPane);
    const galleryPreview = node('div', '', 'bb-portrait-preview');
    const galleryImage = node('img'); galleryImage.alt = t('Предпросмотр портрета'); galleryImage.hidden = true;
    const galleryEmpty = node('p', t('Здесь появятся созданные портреты этого персонажа.'));
    galleryPreview.append(galleryImage, galleryEmpty);
    const thumbnails = node('div', '', 'bb-portrait-thumbnails');
    galleryPane.append(galleryPreview, thumbnails);
    const galleryActions = node('footer', '', 'bb-portrait-gallery-actions'); galleryActions.hidden = true; dialog.append(galleryActions);
    function showTab(isGallery) {
        layout.hidden = actions.hidden = isGallery;
        galleryPane.hidden = galleryActions.hidden = !isGallery;
        createTab.setAttribute('aria-pressed', String(!isGallery)); galleryTab.setAttribute('aria-pressed', String(isGallery));
    }
    function renderGallery() {
        entries = gallery.list();
        galleryTab.textContent = t('Галерея') + ' · ' + entries.length;
        thumbnails.replaceChildren();
        for (const entry of entries) {
            const item = button('', () => selectPortrait(entry.id)); item.className = 'bb-portrait-thumbnail';
            item.setAttribute('aria-label', t('Портрет') + ' ' + new Date(entry.createdAt).toLocaleString());
            item.setAttribute('aria-pressed', String(entry.id === selectedId));
            const thumb = node('img'); thumb.src = entry.path; thumb.alt = ''; thumb.loading = 'lazy'; thumb.decoding = 'async';
            item.append(thumb); thumbnails.append(item);
        }
    }
    async function selectPortrait(id) {
        if (controller || !valid()) return;
        selectedId = id; selectedImage = ''; galleryImage.hidden = true; galleryEmpty.hidden = false;
        renderGallery();
        const operation = new AbortController(); controller = operation; refreshBusy();
        try {
            const data = await gallery.read(id, operation.signal);
            const decoded = node('img'); decoded.src = data; await decoded.decode();
            if (closed || operation.signal.aborted || !valid()) return;
            selectedId = id; selectedImage = data; galleryImage.src = data;
            galleryImage.hidden = false; galleryEmpty.hidden = true;
            status.textContent = ''; renderGallery();
        } catch (error) { if (!closed) status.textContent = errorText(error); }
        finally { if (controller === operation) { controller = null; if (!closed) refreshBusy(); } }
    }
    const galleryUse = button('Использовать', async () => {
        if (!valid() || !selectedImage || controller) return;
        const operation = new AbortController(); controller = operation; refreshBusy();
        try {
            const data = await prepare(selectedImage);
            if (closed || operation.signal.aborted || !valid()) return;
            apply(data); close();
        } catch (error) { if (!closed) status.textContent = errorText(error); }
        finally { if (controller === operation) { controller = null; if (!closed) refreshBusy(); } }
    });
    const galleryDownload = button('Скачать', () => downloadPortrait(selectedImage));
    const galleryCopy = button('Копировать изображение', () => copyImage(selectedImage));
    const galleryDelete = button('Удалить из галереи…', () => {
        if (!valid() || controller || !selectedId || !window.confirm(t('Удалить портрет из галереи? Текущий аватар и файл на диске останутся.'))) return;
        gallery.remove(selectedId); selectedId = ''; selectedImage = '';
        galleryImage.hidden = true; galleryImage.removeAttribute('src'); galleryEmpty.hidden = false;
        renderGallery(); refreshBusy();
        if (entries.length) void selectPortrait(entries[0].id);
    });
    galleryActions.append(galleryUse, galleryDownload, galleryCopy, galleryDelete);
    galleryUse.className += ' bb-portrait-primary';
    async function copyImage(data) {
        try { await copyPortrait(data); if (!closed) status.textContent = t('Изображение скопировано'); }
        catch { if (!closed) status.textContent = t('Браузер не разрешил копирование. Используйте «Скачать».'); }
    }
    const controls=[];
    function errorText(error) {
        if (error?.code === 'truncated') return t('Ответ обрезан по лимиту токенов. Прежний промпт сохранён. Проверьте лимит текстовой модели или выберите другую модель.');
        if (error?.code === 'cancelled' || error?.name === 'AbortError') return t('Отменено');
        if (error?.message === 'portrait_context') return t('Чат или карточка изменились. Откройте портрет заново.');
        if (error?.message === 'portrait_image') return t('Нужен PNG, JPEG или WebP до 10 МиБ.');
        if (error?.message === 'portrait_references') return t('Можно добавить до четырёх референсов.');
        if (error?.message === 'portrait_configuration') return t('Заполните подключение изображений и промпт.');
        if (error?.message === 'portrait_empty') return t('Провайдер не вернул изображение.');
        if (error?.message === 'portrait_gallery_missing') return t('Файл портрета недоступен. Его можно убрать из галереи.');
        if (error?.message === 'portrait_edits_unavailable') return t('Сервис не поддерживает /images/edits. Выберите модель или подключение с поддержкой референсов. Запрос без картинок не отправлялся.');
        if (error?.code === 'timeout') return t('Истекло время ожидания изображения.');
        if (error?.name === 'VnRequestError') return error.message;
        return t('Запрос не выполнен. Проверьте подключение, модель и поддержку референсов.');
    }
    function renderRefs() {
        refsList.replaceChildren();
        refs.forEach((ref,index)=>{
            const row=node('div','','bb-portrait-ref');const img=node('img');img.src=ref.dataUrl;img.alt=t('Референс');row.append(img);
            const role=field(row,'Назначение',ref.role,{choices:[['appearance','Внешность'],['style','Стиль']]});role.disabled=!!controller;
            role.addEventListener('change',()=>ref.role=role.value);
            const remove=button('Удалить',()=>{refs.splice(index,1);renderRefs();});remove.disabled=!!controller;row.append(remove);refsList.append(row);
        });
    }
    function addReference(dataUrl) {
        if (closed || controller) return;
        if (!valid()) throw new Error('portrait_context');
        parsePortraitImage(dataUrl); if(refs.length>=4)throw new Error('portrait_references');
        refs.push({dataUrl,role:'appearance'});renderRefs();
    }
    const file=node('input');file.type='file';file.accept='image/png,image/jpeg,image/webp';file.hidden=true;refsDetails.append(file);
    file.addEventListener('change',async()=>{try{if(file.files?.[0])await addReference(await readPortraitFile(file.files[0]));}catch(e){status.textContent=errorText(e);}finally{file.value='';}});
    const upload=button('Добавить референс',()=>file.click());refsDetails.append(upload);controls.push(upload);
    const current=button('Текущий аватар',async()=>{try{await addReference(avatar);}catch(e){status.textContent=errorText(e);}});current.disabled=!avatar;refsDetails.append(current);
    const build=button('Собрать промпт',()=>run('prompt'));const generate=button('Сгенерировать портрет',()=>run('image'));
    const cancel=button('Отмена',()=>controller?.abort());cancel.disabled=true;
    const use=button('Использовать',()=>{
        if(!valid()){status.textContent=t('Чат или карточка изменились. Откройте портрет заново.');return;}
        apply(result);close();
    });use.disabled=true;actions.append(build,generate,cancel,use);controls.push(build,generate,prompt,style,supplement,manual);
    use.className += ' bb-portrait-primary'; generate.className += ' bb-portrait-primary';
    const download = button('Скачать', () => downloadPortrait(original));
    const copy = button('Копировать изображение', () => copyImage(original));
    actions.append(download, copy);
    const refreshBusy=()=>{
        controls.forEach(el=>el.disabled=!!controller);current.disabled=!!controller||!avatar;cancel.disabled=!controller;use.disabled=!!controller||!result;
        download.disabled=copy.disabled=!!controller||!original;
        galleryUse.disabled=galleryDownload.disabled=galleryCopy.disabled=!!controller||!selectedImage;
        galleryDelete.disabled=!!controller||!selectedId;
        renderRefs();
    };
    async function run(kind) {
        if(controller)return;
        if(!valid()){status.textContent=t('Чат или карточка изменились. Откройте портрет заново.');return;}
        const operation=new AbortController();controller=operation;refreshBusy();status.textContent=t('Генерация…');
        const monitor=setInterval(()=>{if(!valid())operation.abort();},300);
        try {
            let output=kind!=='image'
                ? await generatePortraitPrompt({charName,currentDescription:description,signal:operation.signal,assessAppearance:kind==='prompt',supplementAppearance:kind==='supplement',draftPrompt:prompt.value})
                : await generatePortrait({...settings(),style:style.value},prompt.value,refs.map(ref=>({...ref})),operation.signal);
            if(closed||operation.signal.aborted)return;
            if(!valid())throw new Error('portrait_context');
            if(kind==='prompt') {
                prompt.value=output.prompt;
                appearanceHelp.hidden=!output.needsAppearanceDetails;
            }
            else if(kind==='supplement') { prompt.value=output; appearanceHelp.hidden=true; }
            else {
                const source = output;
                output = await prepare(output);
                if(closed||operation.signal.aborted)return;
                if(!valid())throw new Error('portrait_context');
                const decoded = node('img');
                decoded.src=output;
                await decoded.decode();
                if(closed||operation.signal.aborted)return;
                if(!valid())throw new Error('portrait_context');
                result=output;original=source;image.src=output;image.hidden=false;placeholder.hidden=true;
                try {
                    const entry = await gallery.add(source, operation.signal);
                    if (closed || operation.signal.aborted || !valid()) return;
                    selectedId = entry.id; selectedImage = source; galleryImage.src = source;
                    galleryImage.hidden = false; galleryEmpty.hidden = true; renderGallery();
                } catch {
                    if (!closed && !operation.signal.aborted) status.textContent = t('Портрет создан, но не сохранён в галерею. Скачайте его перед закрытием окна.');
                    return;
                }
            }
            status.textContent=t('Готово. Проверьте результат перед применением.');
        } catch(error) { if(!closed)status.textContent=errorText(error); }
        finally {
            clearInterval(monitor);
            if(controller===operation){
                controller=null;
                if(!closed){
                    if(operation.signal.aborted) status.textContent = valid() ? t('Отменено') : t('Чат или карточка изменились. Откройте портрет заново.');
                    refreshBusy();
                }
            }
        }
    }
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    renderGallery(); refreshBusy(); showTab(entries.length > 0);
    document.body.append(dialog);dialog.showModal();
    if (entries.length) { galleryTab.focus(); void selectPortrait(entries[0].id); }
    else prompt.focus();
}
