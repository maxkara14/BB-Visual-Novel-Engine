import { ui } from './i18n.js';

const starts = new WeakMap();

export function rememberRelationshipStart(stats, scope, name) {
    const data = getRelationshipBreakdown(stats, scope, name);
    for (const field of ['affinity', 'romance']) {
        data[field].start = integer(stats[field]);
        data[field].initialLimit = data[field].start - data[field].origin - data[field].adjustment;
    }
    starts.set(stats, data);
}

const integer = value => Number.parseInt(value, 10) || 0;
const clamp = value => Math.max(-100, Math.min(100, value));
const signed = value => value > 0 ? `+${value}` : String(value);

// Read-only explanation of the same starting values used by recalculateAllStats.
// Net change comes from the calculated total, not the bounded history list.
export function getRelationshipBreakdown(stats, scope = {}, name = '') {
    const saved = stats && starts.get(stats);
    if (saved) {
        const result = { imported: saved.imported };
        for (const field of ['affinity', 'romance']) {
            const total = integer(stats[field]);
            result[field] = { ...saved[field], total, change: total - saved[field].start };
        }
        return result;
    }
    const baseline = scope.snapshot_baseline;
    const imported = baseline?.characters?.[name];
    const scale = (field, bases) => {
        const base = integer(scope[bases]?.[name]);
        const origin = imported ? clamp(integer(imported[field])) : base;
        const adjustment = imported ? base - integer(baseline[bases]?.[name]) : 0;
        const start = imported ? clamp(origin + adjustment) : origin;
        const total = integer(stats?.[field]);
        return { origin, adjustment, start, initialLimit: start - origin - adjustment, change: total - start, total };
    };
    return { imported: Boolean(imported), affinity: scale('affinity', 'char_bases'), romance: scale('romance', 'char_bases_romance') };
}

export function buildRelationshipBreakdownHtml(stats, scope, name) {
    const data = getRelationshipBreakdown(stats, scope, name);
    const row = (label, field) => `<tr><th scope="row">${label}</th><td>${signed(data.affinity[field])}</td><td>${signed(data.romance[field])}</td></tr>`;
    return ui`<details class="bb-relationship-breakdown">
        <summary>Из чего складываются отношения</summary>
        <table>
            <thead><tr><th scope="col">Составляющая</th><th scope="col">Доверие</th><th scope="col">Романтика</th></tr></thead>
            <tbody>
                ${row(data.imported ? ui`Основа из снимка` : ui`Начальное значение`, 'origin')}
                ${data.imported ? row(ui`Поправка базового значения`, 'adjustment') : ''}
                ${data.affinity.initialLimit || data.romance.initialLimit ? row(ui`Поправка при расчёте основы`, 'initialLimit') : ''}
                ${row(ui`Изменения в чате (фактически)`, 'change')}
                ${row(ui`Итого`, 'total')}
            </tbody>
        </table>
        <p>Показан суммарный эффект событий активных свайпов с учётом пределов шкал −100…+100. После импорта учитываются только события, допущенные к пересчёту поверх снимка.</p>
        <p>Нулевой итог не означает отсутствие событий: положительные и отрицательные изменения могут компенсировать друг друга. Стрелка у балла показывает последнее изменение, а не сумму.</p>
    </details>`;
}
