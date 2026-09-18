const animations = new WeakMap();

function reveal(element, visible, animate) {
    if (!element) return;
    const previous = animations.get(element);
    const from = element.hidden ? 0 : element.getBoundingClientRect?.().height || 0;
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
    const wasHidden = element.hidden;
    element.hidden = false;
    element.style.overflow = '';
    const naturalHeight = element.getBoundingClientRect().height;
    element.style.overflow = 'hidden';
    const collapsed = {height:'0px', opacity:0, paddingTop:'0px', paddingBottom:'0px', marginTop:'0px', marginBottom:'0px', borderTopWidth:'0px', borderBottomWidth:'0px'};
    const expanded = {height:naturalHeight + 'px', opacity:1};
    const frames = visible
        ? [wasHidden ? collapsed : {height:from + 'px'}, expanded]
        : [{height:from + 'px', opacity:1}, collapsed];
    const animation = element.animate(frames, {duration:220, easing:'cubic-bezier(0.4, 0, 0.2, 1)'});
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
