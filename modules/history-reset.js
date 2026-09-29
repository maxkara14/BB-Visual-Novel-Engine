export async function confirmHistoryReset({ getContext, getPersonaKey, confirm, reset }) {
    const initial = getContext();
    const chat = initial.chat;
    const key = JSON.stringify([initial.chatId, initial.characterId, initial.groupId]);
    const length = chat?.length;
    const persona = getPersonaKey();

    if (await confirm() !== true) return false;

    const current = getContext();
    if (current.chat !== chat || current.chat?.length !== length
        || JSON.stringify([current.chatId, current.characterId, current.groupId]) !== key
        || getPersonaKey() !== persona) {
        throw new Error('HISTORY_RESET_CONTEXT_CHANGED');
    }

    reset();
    return true;
}
