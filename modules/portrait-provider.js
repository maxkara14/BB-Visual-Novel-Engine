// Provider payloads adapted from BB Comic Forge; no runtime dependency on that extension.
import { withRequestDeadline, VnRequestError, httpRequestError } from './requests.js';

export const PORTRAIT_DEFAULTS = { type: 'openai-images', endpoint: '', key: '', model: '', size: '1024x1024', quality: '', imageSize: '1K', aspect: '1:1', preset: '', style: '', timeout: 180 };
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function parsePortraitImage(value) {
    const match = String(value || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match || match[2].length > MAX_IMAGE_BYTES * 1.4) throw new Error('portrait_image');
    const base64 = match[2].replace(/\s/g, '');
    const bytes = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1 || bytes > MAX_IMAGE_BYTES) throw new Error('portrait_image');
    return { mime: 'image/' + match[1], base64 };
}

export function readPortraitFile(file) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > MAX_IMAGE_BYTES) return Promise.reject(new Error('portrait_image'));
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('portrait_image'));
        reader.readAsDataURL(file);
    });
}

function baseUrl(endpoint) {
    let base = endpoint.replace(/\/+$/, '').replace(/\/(chat\/completions|images\/(?:generations|edits)|models)$/i, '');
    if (!/\/v\d+(?:\.\d+)?$/i.test(base)) base += '/v1';
    return base;
}

// Discovery follows Comic Forge's provider routes. Returned IDs are not a
// guarantee that a model supports image generation or image edits.
export async function fetchPortraitModels(settings, signal) {
    const s = { ...PORTRAIT_DEFAULTS, ...settings };
    let endpoint;
    try { endpoint = new URL(s.endpoint.trim()); } catch { throw new VnRequestError('configuration'); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new VnRequestError('configuration');
    if (s.type === 'naistera') return { models: ['nano banana', 'grok', 'grok-pro', 'novelai'], verified: false };
    const headers = s.key ? { Authorization: 'Bearer ' + s.key } : {};
    let url;
    if (s.type === 'gemini') {
        let base = s.endpoint.trim().replace(/\/+$/, '').replace(/\/v1beta\/models(?:\/[^/]+)?$/i, '');
        url = base + (/\/v1beta$/i.test(base) ? '' : '/v1beta') + '/models';
        if (endpoint.hostname === 'generativelanguage.googleapis.com') {
            delete headers.Authorization;
            headers['x-goog-api-key'] = s.key;
        }
    } else if (s.type === 'openai-images' || s.type === 'openai-chat') url = baseUrl(s.endpoint.trim()) + '/models';
    else throw new VnRequestError('configuration');
    return withRequestDeadline(async requestSignal => {
        const names = new Set();
        const pages = new Set();
        for (let page = 0; page < 20; page++) {
            const response = await fetch(url, { method: 'GET', headers, signal: requestSignal });
            if (!response.ok) throw httpRequestError(response.status);
            const payload = await response.json();
            const rows = Array.isArray(payload) ? payload : payload?.data ?? payload?.models;
            if (!Array.isArray(rows) || payload?.error) throw new VnRequestError('invalid_response');
            for (const row of rows) {
                const value = typeof row === 'string' ? row : row?.id || row?.name || row?.model;
                if (typeof value === 'string' && value.trim() && value.length <= 256) names.add(value.replace(/^models\//, '').trim());
            }
            const next = s.type === 'gemini' ? payload.nextPageToken : null;
            if (!next) return { models: [...names].sort(), verified: true };
            if (typeof next !== 'string' || pages.has(next)) throw new VnRequestError('invalid_response');
            pages.add(next);
            const nextUrl = new URL(url); nextUrl.searchParams.set('pageToken', next); url = nextUrl.href;
        }
        throw new VnRequestError('invalid_response');
    }, { signal, timeoutMs: 30000 });
}

export function buildPortraitRequest(settings, prompt, references = []) {
    const s = { ...PORTRAIT_DEFAULTS, ...settings };
    s.endpoint = s.endpoint.trim();
    let endpoint;
    try { endpoint = new URL(s.endpoint); } catch { throw new Error('portrait_configuration'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !s.model.trim() || !prompt.trim()) throw new Error('portrait_configuration');
    if (references.length > 4) throw new Error('portrait_references');
    const refs = references.map(ref => ({ ...ref, ...parsePortraitImage(ref.dataUrl) }));
    const instructions = refs.map((ref, i) => 'Reference ' + (i + 1) + ': ' + (ref.role === 'style' ? 'use artistic style only; do not copy identity' : 'preserve character appearance and identity')).join('\n');
    const fullPrompt = [prompt.slice(0, 8000), s.style ? 'Art style: ' + s.style.slice(0, 2000) : '', 'One character portrait, face clearly visible, room for cropping. No lettering or watermark.', instructions].filter(Boolean).join('\n\n');
    const headers = { 'Content-Type': 'application/json', ...(s.key ? { Authorization: 'Bearer ' + s.key } : {}) };
    let url, body;
    if (s.type === 'openai-images') {
        url = baseUrl(s.endpoint) + (refs.length ? '/images/edits' : '/images/generations');
        const fields = { model: s.model, prompt: fullPrompt, size: s.size, n: '1', ...(s.quality ? { quality: s.quality } : {}) };
        if (refs.length) {
            body = new FormData();
            for (const [key, value] of Object.entries(fields)) body.append(key, value);
            refs.forEach((ref, i) => {
                const bytes = Uint8Array.from(atob(ref.base64), ch => ch.charCodeAt(0));
                body.append(refs.length > 1 ? 'image[]' : 'image', new Blob([bytes], { type: ref.mime }), 'reference-' + i + '.' + ref.mime.split('/')[1]);
            });
            delete headers['Content-Type'];
        } else body = JSON.stringify({ ...fields, n: 1 });
    } else if (s.type === 'openai-chat') {
        url = baseUrl(s.endpoint) + '/chat/completions';
        body = JSON.stringify({ model: s.model, messages: [{ role: 'user', content: [{ type: 'text', text: fullPrompt + '\n[aspect_ratio: ' + s.aspect + '] [image_size: ' + s.imageSize + ']' }, ...refs.map(ref => ({ type: 'image_url', image_url: { url: ref.dataUrl } }))] }], modalities: ['image', 'text'], stream: false });
    } else if (s.type === 'gemini') {
        let base = s.endpoint.replace(/\/+$/, '');
        if (!/:(generateContent|streamGenerateContent)$/i.test(base)) {
            base = base.replace(/\/v1beta\/models\/[^/]+$/i, '');
            url = base + (/\/v1beta$/i.test(base) ? '' : '/v1beta') + '/models/' + encodeURIComponent(s.model) + ':generateContent';
        } else url = base;
        if (endpoint.hostname === 'generativelanguage.googleapis.com') { delete headers.Authorization; headers['x-goog-api-key'] = s.key; }
        body = JSON.stringify({ contents: [{ role: 'user', parts: [...refs.map(ref => ({ inlineData: { mimeType: ref.mime, data: ref.base64 } })), { text: fullPrompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: s.aspect, imageSize: s.imageSize } } });
    } else if (s.type === 'naistera') {
        url = s.endpoint.replace(/\/+$/, '');
        if (!/\/api\/generate$/i.test(url)) url += '/api/generate';
        body = JSON.stringify({ prompt: fullPrompt, model: s.model, aspect_ratio: s.aspect, preset: s.preset || undefined, reference_images: refs.map(ref => ref.dataUrl), reference_labels: refs.map(ref => ref.role === 'style' ? 'style' : 'appearance') });
    } else throw new Error('portrait_configuration');
    return { url, init: { method: 'POST', headers, body } };
}

export function extractPortraitImage(result) {
    if (result?.data_url) return result.data_url;
    const data = result?.data?.[0];
    if (data?.b64_json) return 'data:image/png;base64,' + data.b64_json;
    if (data?.url) return data.url;
    for (const part of result?.candidates?.[0]?.content?.parts || []) {
        const image = part.inlineData || part.inline_data;
        if (image?.data) return 'data:' + (image.mimeType || image.mime_type || 'image/png') + ';base64,' + image.data;
    }
    const message = result?.choices?.[0]?.message;
    for (const image of message?.images || []) {
        if (typeof image === 'string') return image;
        if (image.image_url?.url || image.url) return image.image_url?.url || image.url;
        if (image.b64_json) return 'data:image/png;base64,' + image.b64_json;
    }
    for (const part of Array.isArray(message?.content) ? message.content : []) {
        if (part.image_url?.url) return part.image_url.url;
        if (part.source?.data) return 'data:' + part.source.media_type + ';base64,' + part.source.data;
    }
    if (message?.image_url?.url) return message.image_url.url;
    if (typeof message?.content === 'string') {
        const dataUrl = message.content.match(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/);
        if (dataUrl) return dataUrl[0];
        const markdown = message.content.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
        if (markdown) return markdown[1];
    }
    throw new Error('portrait_empty');
}

export async function generatePortrait(settings, prompt, references, signal) {
    const request = buildPortraitRequest(settings, prompt, references);
    const timeout = Math.max(15, Math.min(600, Number(settings.timeout) || 180));
    return withRequestDeadline(async requestSignal => {
        const response = await fetch(request.url, { ...request.init, signal: requestSignal });
        if (!response.ok && settings.type !== 'openai-chat' && /\/images\/edits$/.test(request.url) && [404, 405, 501].includes(response.status)) throw new Error('portrait_edits_unavailable');
        if (!response.ok) throw httpRequestError(response.status);
        const value = extractPortraitImage(await response.json());
        let dataUrl = value;
        if (/^https?:\/\//i.test(value)) {
            // Signed result URLs are fetched without forwarding provider credentials.
            const image = await fetch(value, { signal: requestSignal, credentials: 'omit' });
            if (!image.ok) throw new Error('portrait_image');
            dataUrl = await readPortraitFile(await image.blob());
        }
        parsePortraitImage(dataUrl);
        if (requestSignal.aborted) throw new VnRequestError('cancelled');
        return dataUrl;
    }, { signal, timeoutMs: timeout * 1000 });
}
