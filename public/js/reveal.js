/**
 * Enter-view motion for the cinematic storefront (2026 redesign).
 *
 * Elements marked `data-reveal` fade and rise once, as they enter the
 * viewport. Everything else on the page is untouched, the HTML works with
 * this module absent, and a visitor who prefers reduced motion gets the
 * page exactly as it was: visible, still, no transitions.
 */

export function initReveal() {
  const nodes = Array.from(document.querySelectorAll('[data-reveal]'));
  if (!nodes.length) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) return;

  for (const node of nodes) node.classList.add('reveal');

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('reveal--in');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
  );

  for (const node of nodes) observer.observe(node);
}
