import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmHistoryReset } from '../modules/history-reset.js';

function setup() {
    const context = { chat: [], chatId: 'chat-a', characterId: 1, groupId: null };
    let persona = 'persona-a';
    let resets = 0;
    return {
        context,
        getContext: () => context,
        getPersonaKey: () => persona,
        setPersona: value => { persona = value; },
        reset: () => { resets++; },
        get resets() { return resets; },
    };
}

test('cancelled history reset leaves stored data alone', async () => {
    const state = setup();
    assert.equal(await confirmHistoryReset({ ...state, confirm: async () => false }), false);
    assert.equal(state.resets, 0);
});

test('confirmed history reset runs once for the same chat and persona', async () => {
    const state = setup();
    assert.equal(await confirmHistoryReset({ ...state, confirm: async () => true }), true);
    assert.equal(state.resets, 1);
});

test('history reset refuses a changed chat or persona while confirmation is open', async () => {
    for (const change of [
        state => { state.context.chatId = 'chat-b'; },
        state => { state.context.chat = []; },
        state => { state.setPersona('persona-b'); },
    ]) {
        const state = setup();
        await assert.rejects(confirmHistoryReset({
            ...state,
            confirm: async () => { change(state); return true; },
        }), /HISTORY_RESET_CONTEXT_CHANGED/);
        assert.equal(state.resets, 0);
    }
});
