const ERROR_MESSAGES = {
    cancelled: 'Отменено пользователем',
    timeout: 'Время ожидания ответа истекло. Повторите запрос или увеличьте тайм-аут.',
    auth: 'API отклонил ключ или доступ к модели. Проверьте подключение.',
    rate_limit: 'API ограничил частоту запросов или исчерпал квоту. Повторите позже.',
    network: 'Не удалось связаться с API. Проверьте адрес, сеть и разрешение CORS.',
    provider: 'Провайдер не смог завершить запрос.',
    blocked: 'Провайдер заблокировал запрос или отказался возвращать результат.',
    empty: 'Модель вернула пустой ответ.',
    reasoning_only: 'Модель вернула только рассуждения. Проверьте лимит ответа и настройки модели.',
    truncated: 'Ответ обрезан по лимиту токенов. Уменьшите длину или увеличьте лимит ответа.',
    invalid_response: 'API вернул ответ в неподдерживаемом формате.',
    busy: 'Основная модель уже выполняет служебный запрос VNE. Дождитесь его завершения.',
    configuration: 'Укажите URL и модель для Custom API.',
    request_rejected: 'API отклонил параметры запроса. Проверьте адрес, модель и поддерживаемый формат.',
};

export class VnRequestError extends Error {
    constructor(code) {
        super(ERROR_MESSAGES[code] || ERROR_MESSAGES.provider);
        this.name = 'VnRequestError';
        this.code = code;
    }
}

export function normalizeRequestTimeout(value) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? Math.max(15, Math.min(600, Math.round(seconds))) : 120;
}

export function httpRequestError(status) {
    if (status === 401 || status === 403) return new VnRequestError('auth');
    if (status === 429) return new VnRequestError('rate_limit');
    if (status >= 400 && status < 500) return new VnRequestError('request_rejected');
    return new VnRequestError('provider');
}

export function normalizeRequestError(error) {
    if (error instanceof VnRequestError) return error;
    if (error?.name === 'AbortError') return new VnRequestError('cancelled');
    if (error instanceof TypeError) return new VnRequestError('network');
    return new VnRequestError('provider');
}

export function readCustomApiContent(data) {
    if (!data || typeof data !== 'object') throw new VnRequestError('invalid_response');
    if (data.error) throw new VnRequestError('provider');
    const choice = data.choices?.[0];
    if (!choice || typeof choice !== 'object') throw new VnRequestError('invalid_response');
    if (choice.finish_reason === 'content_filter' || choice.message?.refusal) throw new VnRequestError('blocked');
    if (choice.finish_reason === 'length') throw new VnRequestError('truncated');
    const content = choice.message?.content;
    if (content != null && typeof content !== 'string') throw new VnRequestError('invalid_response');
    if (!content?.trim()) {
        throw new VnRequestError(choice.message?.reasoning_content || choice.message?.reasoning ? 'reasoning_only' : 'empty');
    }
    return content;
}

// Every request owns its deadline and signal. A transport ignoring abort still cannot hold the UI open.
export async function withRequestDeadline(task, { signal, timeoutMs, onAbort } = {}) {
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const abort = error => {
        if (controller.signal.aborted) return;
        controller.abort(error);
        rejectAbort(error);
        try { onAbort?.(); } catch { /* Cancellation must still complete if the host stop hook fails. */ }
    };
    const cancel = () => abort(new VnRequestError('cancelled'));
    if (signal?.aborted) throw new VnRequestError('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => abort(new VnRequestError('timeout')), timeoutMs);
    try {
        return await Promise.race([task(controller.signal), aborted]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}
