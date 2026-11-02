import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../modules/history-recovery.js', import.meta.url), 'utf8');
const { planRecovery, recoverySource, recoveryIsCurrent, recoveryBatches, parseRecovery, applyRecovery } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const options = { scopeKey: 'player' };
const message = (mes = 'Alex speaks to Player') => ({ name: 'Narrator', mes, swipe_id: 0, extra: {} });
const update = (name = 'Alex') => ({ name, friendship_impact: 'minor_positive', romance_impact: 'none', reason: 'Helped Player', role_dynamic: 'friend' });

test('repeat and intersecting ranges skip completed messages including empty results', () => {
    const chat = [message(), message(), message()];
    const plan = planRecovery(chat, 0, 1, options);
    applyRecovery(chat, plan, [{ index: 0, updates: [update()] }, { index: 1, updates: [] }], 'player');
    assert.equal(planRecovery(chat, 0, 1, options).pending.length, 0);
    assert.deepEqual(planRecovery(chat, 1, 2, options).pending.map(item => item.index), [2]);
    assert.equal(chat[0].mes, 'Alex speaks to Player');
});

test('native events and imported baseline win; another persona remains independent', () => {
    const chat = [message(), message(), message()];
    chat[1].extra.bb_social_swipes = { 0: [{ ...update(), scope: 'player' }] };
    chat[2].extra.bb_social_swipes = { 0: [{ ...update(), scope: 'other' }] };
    const plan = planRecovery(chat, 0, 2, { ...options, cutoff: 1 });
    assert.deepEqual(plan.pending.map(item => item.index), [2]);
    assert.equal(plan.skipped.tracked, 1); assert.equal(plan.skipped.baseline, 1);
    applyRecovery(chat, plan, [{ index: 2, updates: [update('Sam')] }], 'player');
    assert.equal(chat[2].extra.bb_social_swipes[0].length, 2);
    assert.equal(chat[2].extra.bb_social_swipes[0][0].scope, 'other');
});

test('edits invalidate recovered events immediately and replacement does not accumulate', () => {
    const chat = [message()];
    applyRecovery(chat, planRecovery(chat, 0, 0, options), [{ index: 0, updates: [update()] }], 'player');
    const old = chat[0].extra.bb_social_swipes[0][0];
    assert.equal(recoveryIsCurrent(old, chat[0], recoverySource(chat, 0)), true);
    chat[0].mes = 'Sam talks to Player';
    assert.equal(recoveryIsCurrent(old, chat[0], recoverySource(chat, 0)), false);
    const plan = planRecovery(chat, 0, 0, options);
    assert.equal(plan.pending[0].replacing, true);
    applyRecovery(chat, plan, [{ index: 0, updates: [update('Sam')] }], 'player');
    assert.equal(chat[0].extra.bb_social_swipes[0].length, 1);
    assert.equal(chat[0].extra.bb_social_swipes[0][0].name, 'Sam');
});

test('swipes, previous player edits, and persona aliases are handled', () => {
    const chat = [{ ...message('Hello'), is_user: true }, message()];
    applyRecovery(chat, planRecovery(chat, 0, 1, options), [{ index: 1, updates: [update()] }], 'player');
    assert.equal(planRecovery(chat, 0, 1, { scopeKey: 'renamed', aliasSet: new Set(['player', 'renamed']) }).pending.length, 0);
    chat[1].swipes = [chat[1].mes, 'Another response']; chat[1].swipe_id = 1; chat[1].mes = 'Another response';
    assert.equal(planRecovery(chat, 1, 1, options).pending.length, 1);
    chat[1].swipe_id = 0; chat[1].mes = chat[1].swipes[0];
    assert.equal(planRecovery(chat, 1, 1, options).pending.length, 0);
    chat[0].mes = 'Changed player action';
    assert.equal(planRecovery(chat, 1, 1, options).pending.length, 1);
});

test('save validates all sources before writing and refuses races with ordinary tracking', () => {
    const chat = [message(), message()];
    const plan = planRecovery(chat, 0, 1, options);
    chat[1].mes = 'Changed';
    assert.throws(() => applyRecovery(chat, plan, [{ index: 0, updates: [update()] }, { index: 1, updates: [] }], 'player'));
    assert.deepEqual(chat[0].extra, {});
    const fresh = planRecovery(chat, 0, 1, options);
    chat[1].extra.bb_social_swipes = { 0: [update()] };
    assert.throws(() => applyRecovery(chat, fresh, [{ index: 0, updates: [update()] }, { index: 1, updates: [] }], 'player'));
    assert.deepEqual(chat[0].extra, {});
});

test('model output requires complete numbered coverage, valid impacts and safe fields', () => {
    const batch = [{ message: 1 }, { message: 3 }];
    const raw = rows => JSON.stringify({ messages: rows });
    assert.throws(() => parseRecovery(raw([{ message: 1, updates: [] }]), batch));
    assert.throws(() => parseRecovery(raw([{ message: 1, updates: [] }, { message: 1, updates: [] }]), batch));
    assert.throws(() => parseRecovery(raw([{ message: 1, updates: [{ ...update(), friendship_impact: '999' }] }, { message: 3, updates: [] }]), batch));
    const rows = parseRecovery(raw([{ message: 1, updates: [update('Player'), update('Hidden'), update('__proto__'), update('constructor'), update('<img onerror=evil>'), update('<IMG onerror=evil>')] }, { message: 3, updates: [] }]), batch, { userNames: ['Player'], ignored: ['Hidden'] });
    assert.equal(rows[0].updates.length, 1);
    assert.equal(rows[0].updates[0].name, '<img onerror=evil>'); // UI must use textContent.
    assert.equal(Object.hasOwn(rows[0].updates[0], 'scope'), false);
});

test('batching respects input size without truncating stories; invalid ranges fail', () => {
    const chat = [message('a'.repeat(100)), message('b'.repeat(100)), message('c'.repeat(100))];
    const plan = planRecovery(chat, 0, 2, options);
    assert.equal(recoveryBatches(chat, plan.pending, 400).length, 3);
    assert.throws(() => recoveryBatches(chat, plan.pending, 50));
    assert.throws(() => planRecovery(chat, -1, 2, options));
    assert.throws(() => planRecovery(chat, 0, 3, options));
});
