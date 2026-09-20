import { getCurrentPersonaScopeKey, resolveCharacterIdentity } from './social.js';
import { parsePortraitImage, readPortraitFile } from './portrait-provider.js';
import { withRequestDeadline } from './requests.js';

const METADATA_KEY = 'bb_vn_portrait_gallery';
const PATH = /^\/?user\/images\/bb_vne_portraits\/vne_[a-zA-Z0-9_-]+\.(png|jpeg|webp)$/;

export function createPortraitGallery(charName) {
    const context = SillyTavern.getContext();
    const metadata = context.chatMetadata;
    const chatId = context.getCurrentChatId?.() ?? context.chatId;
    const characterId = context.characterId, groupId = context.groupId;
    const persona = getCurrentPersonaScopeKey();
    const identity = resolveCharacterIdentity(charName, { allowCreate: false, allowSuggestions: false });
    const character = identity?.id || identity?.entry?.id || charName;
    const scope = JSON.stringify([persona, character]);
    const current = () => {
        const next = SillyTavern.getContext();
        return metadata && chatId != null && next.chatMetadata === metadata
            && (next.getCurrentChatId?.() ?? next.chatId) === chatId
            && next.characterId === characterId && next.groupId === groupId
            && getCurrentPersonaScopeKey() === persona;
    };
    const assertCurrent = () => { if (!current()) throw new Error('portrait_context'); };
    const list = () => {
        assertCurrent();
        const rows = metadata[METADATA_KEY]?.[scope];
        return Array.isArray(rows) ? rows.filter(row => row && typeof row.id === 'string' && PATH.test(row.path) && Number.isFinite(row.createdAt)).map(row => ({ ...row })) : [];
    };
    const write = rows => {
        assertCurrent();
        metadata[METADATA_KEY] = { ...metadata[METADATA_KEY], [scope]: rows };
        context.saveMetadataDebounced();
    };
    return {
        list,
        async add(dataUrl, signal) {
            assertCurrent();
            const image = parsePortraitImage(dataUrl);
            const id = 'vne_' + Date.now() + '_' + crypto.randomUUID();
            const path = await withRequestDeadline(async requestSignal => {
                const response = await fetch('/api/images/upload', {
                    method: 'POST', headers: context.getRequestHeaders(), signal: requestSignal,
                    body: JSON.stringify({ image: image.base64, format: image.mime.split('/')[1], ch_name: 'bb_vne_portraits', filename: id }),
                });
                if (!response.ok) throw new Error('portrait_gallery_save');
                const result = await response.json();
                if (typeof result.path !== 'string' || !PATH.test(result.path)) throw new Error('portrait_gallery_save');
                return result.path.startsWith('/') ? result.path : '/' + result.path;
            }, { signal, timeoutMs: 30000 });
            assertCurrent();
            if (signal?.aborted) throw new Error('portrait_context');
            const entry = { id, path, createdAt: Date.now() };
            write([entry, ...list()]);
            return entry;
        },
        remove(id) { write(list().filter(row => row.id !== id)); },
        async read(id, signal) {
            const entry = list().find(row => row.id === id);
            if (!entry) throw new Error('portrait_gallery_missing');
            return withRequestDeadline(async requestSignal => {
                const response = await fetch(entry.path, { signal: requestSignal });
                if (!response.ok) throw new Error('portrait_gallery_missing');
                const dataUrl = await readPortraitFile(await response.blob());
                assertCurrent();
                return dataUrl;
            }, { signal, timeoutMs: 30000 });
        },
    };
}

export function downloadPortrait(dataUrl) {
    const { mime } = parsePortraitImage(dataUrl);
    const link = document.createElement('a');
    link.href = dataUrl; link.download = 'vne-portrait-' + Date.now() + '.' + mime.split('/')[1];
    document.body.append(link); link.click(); link.remove();
}

export async function copyPortrait(dataUrl) {
    if (!globalThis.ClipboardItem || !navigator.clipboard?.write) throw new Error('portrait_clipboard');
    parsePortraitImage(dataUrl);
    // Start the clipboard operation in the click handler, retaining user activation.
    const png = (async () => {
        const image = new Image(); image.src = dataUrl; await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('portrait_clipboard');
        context.drawImage(image, 0, 0);
        return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('portrait_clipboard')), 'image/png'));
    })();
    // Permission can be denied before conversion finishes; still consume its rejection.
    png.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
