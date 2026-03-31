export let currentCalculatedStats = {};
export let currentStoryMoments = [];
export let vnGenerationAbortController = null;
export let isVnGenerationCancelled = false;

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
