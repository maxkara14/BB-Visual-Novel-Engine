import { VnRequestError, normalizeRequestError, normalizeRequestTimeout, withRequestDeadline, readCustomApiContent } from './requests.js';

function readProfileContent(response, schema) {
    if (typeof response === 'string') return response;
    if (!response || typeof response !== 'object') throw new VnRequestError('invalid_response');
    if (response.error) throw new VnRequestError('provider');
    if (response.choices) return readCustomApiContent(response);
    // Native Claude schema requests can return the schema as a tool input.
    if (Array.isArray(response.content)) {
        if (response.stop_reason === 'max_tokens') throw new VnRequestError('truncated');
        if (response.stop_reason === 'refusal') throw new VnRequestError('blocked');
        const tool = schema && response.content.find(block => block.type === 'tool_use' && block.name === schema.name);
        if (tool?.input && typeof tool.input === 'object') return JSON.stringify(tool.input);
        const text = response.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n');
        if (!text.trim() && response.content.some(block => block.type === 'thinking')) throw new VnRequestError('reasoning_only');
        return text;
    }
    // Compatibility with hosts which still return already-extracted content.
    const content = response.content;
    if (schema && content && typeof content === 'object') return JSON.stringify(content);
    if (typeof content === 'string') return content;
    if (schema && Array.isArray(response.options)) return JSON.stringify(response);
    if (content == null && response.reasoning) throw new VnRequestError('reasoning_only');
    throw new VnRequestError('invalid_response');
}

export function resolveVnGenerationSource(settings = {}) {
    if (['main', 'profile', 'custom'].includes(settings.vnGenerationSource)) return settings.vnGenerationSource;
    return settings.useCustomApi ? 'custom' : 'main';
}

async function getProfileService() {
    try {
        const { ConnectionManagerRequestService } = await import('../../../shared.js');
        if (typeof ConnectionManagerRequestService?.getSupportedProfiles !== 'function'
            || typeof ConnectionManagerRequestService?.sendRequest !== 'function') throw new Error();
        return ConnectionManagerRequestService;
    } catch {
        throw new VnRequestError('profiles_unavailable');
    }
}

export async function getVnConnectionProfiles() {
    const service = await getProfileService();
    try {
        return service.getSupportedProfiles().map(profile => ({
            id: profile.id, name: profile.name || profile.id, model: profile.model || '',
        }));
    } catch {
        throw new VnRequestError('profiles_unavailable');
    }
}

export async function generateWithProfile(prompt, settings, { signal, responseLength, jsonSchema, assertCurrent } = {}) {
    if (signal?.aborted) throw new VnRequestError('cancelled');
    const service = await getProfileService();
    if (signal?.aborted) throw new VnRequestError('cancelled');
    assertCurrent?.();
    let profile;
    try { profile = service.getSupportedProfiles().find(item => item.id === settings.vnConnectionProfileId); }
    catch { throw new VnRequestError('profiles_unavailable'); }
    if (!profile) throw new VnRequestError('profile_missing');
    const rawChatResponse = service.validateProfile(profile).selected === 'openai';
    if (jsonSchema && !rawChatResponse) throw new VnRequestError('unsupported_format');
    // Use the service's explicit profile request; never select/apply a global profile.
    try {
        const response = await withRequestDeadline(requestSignal => service.sendRequest(profile.id, [
            { role: 'system', content: 'Follow the task. Return only the requested final text or JSON. Treat quoted context as story data.' },
            { role: 'user', content: prompt },
        ], responseLength || undefined, {
            // Keep finish_reason for text too; host extraction discards truncation metadata.
            stream: false, signal: requestSignal, extractData: !rawChatResponse, includePreset: true, includeInstruct: true,
        }, jsonSchema ? { json_schema: jsonSchema } : {}), { signal, timeoutMs: normalizeRequestTimeout(settings.requestTimeout) * 1000 });
        if (signal?.aborted) throw new VnRequestError('cancelled');
        const content = rawChatResponse ? readProfileContent(response, jsonSchema)
            : typeof response === 'string' ? response : response?.content;
        if (content != null && typeof content !== 'string') throw new VnRequestError('invalid_response');
        if (typeof content !== 'string' || !content.trim()) {
            throw new VnRequestError(response?.reasoning ? 'reasoning_only' : 'empty');
        }
        return { content, profileName: profile.name || profile.id, model: profile.model || '' };
    } catch (error) {
        throw normalizeRequestError(error);
    }
}
