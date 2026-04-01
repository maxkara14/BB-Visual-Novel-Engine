export let currentCalculatedStats = {};
export let currentStoryMoments = [];
export let vnGenerationAbortController = null;
export let isVnGenerationCancelled = false;
export let socialParseDebug = { status: 'idle', details: '' };

export function setVnGenerationAbortController(controller) {
    vnGenerationAbortController = controller;
}

export function setIsVnGenerationCancelled(value) {
    isVnGenerationCancelled = value;
}

export function clearCurrentStoryMoments() {
    currentStoryMoments = [];
}

export function setCurrentCalculatedStats(stats) {
    currentCalculatedStats = stats;
}

export function setSocialParseDebug(status = 'idle', details = '') {
    socialParseDebug = {
        status: String(status || 'idle'),
        details: String(details || ''),
    };
}
