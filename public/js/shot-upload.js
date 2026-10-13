/* ==========================================================================
   Per-shot photo upload for the listing wizard (console and dealer portal).

   Lives in its own module because the wizard appears on both /admin and
   /dealer pages, while dealer.js only loads on page-dealer bodies. When this
   was wired inside dealer.js, the console's Add-a-car page rendered the
   upload buttons with nothing behind them — the owner picked a photo and saw
   no reaction. Loaded unconditionally by the console layout instead.

   The file is posted as-is to /api/media/upload; the served URL it returns is
   written into the shot's link field, so drafting, validation and the photo
   review queue never change. With JavaScript off the buttons simply are not
   there and the link fields still work.
   ========================================================================== */

function wireShotUploads(form) {
  form.querySelectorAll('[data-shot-upload]').forEach((fileInput) => {
    const key = fileInput.getAttribute('data-shot-upload');
    const card = fileInput.closest('.shot-list__item') || fileInput.closest('li');
    const thumb = card && card.querySelector('.shot-upload__thumb');
    const status = card && card.querySelector('.shot-upload__status');
    const link = form.querySelector(`input[name="photo_${key}"]`);

    // A photo already on the form (draft reload, validation bounce) shows its preview.
    if (thumb && link && link.value.trim()) {
      thumb.src = link.value.trim();
      thumb.hidden = false;
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      // Feedback the moment a picture is chosen, before the network is involved.
      if (status) status.textContent = `${file.name} — uploading…`;
      try {
        const res = await fetch('/api/media/upload', {
          method: 'POST',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Upload failed — paste a link instead.');
        if (link) link.value = data.url;
        if (thumb) {
          thumb.src = data.url;
          thumb.hidden = false;
        }
        if (status) status.textContent = `${file.name} — uploaded, attached to this shot.`;
      } catch (err) {
        if (status) status.textContent = err && err.message ? err.message : 'Upload failed — paste a link instead.';
      } finally {
        fileInput.value = '';
      }
    });
  });
}

const wizard = document.querySelector('[data-dealer-wizard]');
if (wizard) wireShotUploads(wizard);
