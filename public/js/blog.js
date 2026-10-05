/**
 * Blog interactions — §6.9.
 *
 *   • “Load more” appends the next 9 posts from /api/posts (no page reload)
 *   • YouTube facade: the iframe is only created on click (§13.2 — video is
 *     strictly tap-to-load, with the duration label shown up front)
 *   • table of contents highlights the section you are reading
 *   • “Was this helpful?” feedback widget (no public comments at launch)
 *   • article_read_75 is fired by events.js once 75% is scrolled
 */

import { track } from './events.js';

export function initLoadMore(root = document) {
  const button = root.querySelector('[data-load-more]');
  const grid = root.querySelector('[data-post-grid]');
  if (!button || !grid) return;

  button.addEventListener('click', async (event) => {
    event.preventDefault();
    const page = Number(button.dataset.nextPage || 2);
    const params = new URLSearchParams({ page: String(page) });
    if (button.dataset.category) params.set('category', button.dataset.category);
    if (button.dataset.query) params.set('q', button.dataset.query);

    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Loading…';

    try {
      const response = await fetch(`/api/posts?${params.toString()}`, { headers: { Accept: 'text/html' } });
      const html = await response.text();
      if (response.ok && html.trim()) {
        grid.insertAdjacentHTML('beforeend', html);
        button.dataset.nextPage = String(page + 1);
        const shown = grid.children.length;
        track('filter_applied', { source: 'blog_load_more', result_count: shown });
      }
      // The server tells us when we have run out by omitting the button, so a
      // short response means this was the last page.
      if (!html.trim() || html.trim().split('post-card').length < 3) {
        button.remove();
      } else {
        button.disabled = false;
        button.textContent = label;
      }
    } catch {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

/**
 * §13.2 — video is strictly tap-to-load, and our own clips play here.
 *
 * Nothing is fetched until the visitor presses the button, and when they do the
 * player is created in place of the poster with the metadata already declared,
 * so the browser does not have to probe the file before it can show controls.
 * The poster stays behind the <video> while it buffers, so the frame never goes
 * black on a slow connection.
 */
export function initOwnVideoFacades(root = document) {
  root.querySelectorAll('[data-video-facade]').forEach((facade) => {
    const link = facade.querySelector('[data-video-link]');
    if (!link) return;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const src = link.getAttribute('href');
      const video = document.createElement('video');
      video.src = src;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.setAttribute('poster', facade.querySelector('img')?.getAttribute('src') || '');
      link.classList.add('video-facade__frame--playing');
      link.replaceChildren(video);
      link.removeAttribute('aria-label');
      // §13.2: the tap cost this much. Reported from the file's measured size, so
      // the low-bandwidth work can be judged on data rather than on intent.
      track('gallery_engaged', {
        source: 'video_facade',
        item_id: src,
        video_duration: Number(link.dataset.videoSeconds) || undefined,
        video_size: Number(link.dataset.videoBytes) || undefined,
      });
      video.play().catch(() => {
        /* the controls are right there; a blocked autoplay is not an error */
      });
    }, { once: true });
  });
}

export function initVideoFacades(root = document) {
  initOwnVideoFacades(root);
  root.querySelectorAll('[data-youtube-facade]').forEach((facade) => {
    const play = facade.querySelector('[data-youtube-play]');
    if (!play) return;
    play.addEventListener('click', () => {
      const id = facade.dataset.videoId;
      if (!id) return;
      track('gallery_engaged', { source: 'video_facade', item_id: id });
      const iframe = document.createElement('iframe');
      iframe.width = '100%';
      iframe.height = '100%';
      iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0`;
      iframe.title = play.textContent.trim();
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture';
      iframe.allowFullscreen = true;
      iframe.style.border = '0';
      facade.innerHTML = '';
      facade.appendChild(iframe);
    });
  });
}

export function initTableOfContents(root = document) {
  const toc = root.querySelector('[data-toc]');
  if (!toc) return;
  const links = [...toc.querySelectorAll('a[href^="#"]')];
  const targets = links
    .map((link) => document.getElementById(link.getAttribute('href').slice(1)))
    .filter(Boolean);
  if (!targets.length || !('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((link) => {
          const active = link.getAttribute('href') === `#${entry.target.id}`;
          link.style.fontWeight = active ? '600' : '';
          if (active) link.setAttribute('aria-current', 'true');
          else link.removeAttribute('aria-current');
        });
      });
    },
    { rootMargin: '-80px 0px -70% 0px' },
  );
  targets.forEach((target) => observer.observe(target));
}

export function initHelpful(root = document) {
  const widget = root.querySelector('[data-helpful]');
  if (!widget) return;
  const thanks = widget.querySelector('[data-helpful-thanks]');

  widget.querySelectorAll('[data-helpful-yes], [data-helpful-no]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.hasAttribute('data-helpful-yes') ? 'yes' : 'no';
      track('review_link_clicked', { source: 'helpful_widget', value });
      widget.querySelectorAll('button').forEach((other) => { other.disabled = true; });
      if (thanks) thanks.classList.remove('hidden');
    });
  });
}
