import { extension_settings } from '../../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { EN } from './locales/en.js';

export function normalizeUiLanguage(value) {
    return value === 'ru' || value === 'en' ? value : 'auto';
}

export function getUiLanguage(settings = extension_settings[MODULE_NAME] || {}, browserLanguage = globalThis.SillyTavern?.getContext?.()?.getCurrentLocale?.() || globalThis.navigator?.language || globalThis.document?.documentElement?.lang || 'ru') {
    const selected = normalizeUiLanguage(settings.uiLanguage);
    return selected === 'auto' ? (/^ru(?:-|$)/i.test(browserLanguage) ? 'ru' : 'en') : selected;
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${Object.keys(EN).sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');

// Call only with extension-owned literals. Interpolated names, model output,
// saved memories, and user text must never be passed through the catalogue.
export function t(literal, language = getUiLanguage()) {
    if (language !== 'en') return literal;
    return String(literal).replace(pattern, match => EN[match]);
}

// Translate static template parts before inserting values, preserving the
// caller's escaping and preventing accidental translation of story data.
export function ui(parts, ...values) {
    return parts.reduce((text, part, index) => text + t(part) + (index < values.length ? values[index] : ''), '');
}

// The local profile template creates new editable story text, not UI labels.
// Explicit output language wins; chat mode follows the latest text's script.
export function getTemplateLanguage(settings = extension_settings[MODULE_NAME] || {}, chat = globalThis.SillyTavern?.getContext?.()?.chat || []) {
    if (settings.outputLanguage === 'ru' || settings.outputLanguage === 'en') return settings.outputLanguage;
    const latest = [...chat].reverse().find(message => !message?.is_system && typeof message?.mes === 'string')?.mes || '';
    return /[а-яё]/i.test(latest) ? 'ru' : 'en';
}

export function templateText(literal) {
    return t(literal, getTemplateLanguage());
}

export function template(parts, ...values) {
    return parts.reduce((text, part, index) => text + templateText(part) + (index < values.length ? values[index] : ''), '');
}
