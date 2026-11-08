// Normalize display text entering VNE, never the original roleplay message or IDs.
// Keep line breaks, tabs and ZWJ/ZWNJ (used by emoji and writing systems) intact.
export function normalizeVneText(value = '') {
    return String(value ?? '').replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u2800\u3000\uFEFF\u115F\u1160\u3164\uFFA0]/g, ' ');
}
