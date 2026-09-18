const animations = new WeakMap();

function reveal(element, visible, animate) {
    if (!element) return;
    const previous = animations.get(element);
    const current = previous && globalThis.getComputedStyle?.(element);
    const interrupted = current ? { opacity: current.opacity, transform: current.transform } : null;
    if (previous) {
        previous.onfinish = null;
        previous.cancel();
        animations.delete(element);
    }
    element.inert = !visible;
    if (!animate || typeof element.animate !== 'function' || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        element.hidden = !visible;
        if (element.style) element.style.overflow = '';
        return;
    }
    element.hidden = false;
    const collapsed = { opacity: 0, transform: 'translateY(10px)' };
    const expanded = { opacity: 1, transform: 'translateY(0)' };
    const frames = visible ? [interrupted || collapsed, expanded] : [interrupted || expanded, collapsed];
    const animation = element.animate(frames, {
        duration: visible ? 280 : 200,
        easing: visible ? 'cubic-bezier(0.22, 1, 0.36, 1)' : 'ease-in',
    });
    animations.set(element, animation);
    animation.onfinish = () => {
        element.hidden = !visible;
        element.style.overflow = '';
        animations.delete(element);
    };
}

export function syncOptionsVisibility(enabled, animate = false) {
    const bar = document.getElementById('bb-vn-action-bar');
    const restore = document.getElementById('bb-vn-enable-options');
    const focused = document.activeElement;
    const moveFocus = enabled ? focused === restore : bar?.contains?.(focused);
    reveal(bar, enabled, animate);
    reveal(restore, !enabled, animate);
    if (moveFocus) {
        const target = enabled ? document.getElementById('bb-vn-btn-generate') : restore;
        if (enabled) target?.setAttribute('tabindex', '-1');
        target?.focus();
    }
}
