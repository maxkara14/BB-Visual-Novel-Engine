// Match the HUD's 260 ms easing while retaining native details keyboard behavior.
const mounted = new WeakSet();

export function mountSettingsAnimations(root) {
    if (!root) return;
    for (const section of root.querySelectorAll('.bb-vn-settings-section')) {
        if (mounted.has(section)) continue;
        const summary = section.querySelector('summary');
        if (!summary) continue;
        mounted.add(section);
        let animation = null;
        let targetOpen = section.open;
        const overflow = section.style.overflow;
        summary.addEventListener('click', event => {
            event.preventDefault();
            const from = section.getBoundingClientRect().height;
            targetOpen = animation ? !targetOpen : !section.open;
            if (animation) {
                animation.onfinish = null;
                animation.cancel();
                animation = null;
            }
            section.style.overflow = overflow;
            if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof section.animate !== 'function') {
                section.open = targetOpen;
                return;
            }
            // Measure the natural destination; do not keep a fixed height after completion.
            section.open = targetOpen;
            const to = section.getBoundingClientRect().height;
            section.open = true;
            section.style.overflow = 'hidden';
            animation = section.animate([{ height: from + 'px' }, { height: to + 'px' }], {
                duration: 260, easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
            });
            animation.onfinish = () => {
                section.open = targetOpen;
                section.style.overflow = overflow;
                animation = null;
            };
        });
    }
}
