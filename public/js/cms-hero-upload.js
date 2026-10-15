/* ==========================================================================
   CMS post hero image — pick a photo from the device instead of typing a path.

   Mirrors shot-upload.js: the file is posted as-is to /api/media/upload and the
   served URL it returns is written into the post's hero_image field, so
   drafting, validation and storage are unchanged. Guarded by element presence,
   so on pages without the uploader it does nothing. With JavaScript off the
   picker is simply inert and the link field below it still works.
   ========================================================================== */

const heroFile = document.querySelector('#f-hero-file');
const heroField = document.querySelector('#f-hero');

if (heroFile && heroField) {
  const preview = document.querySelector('#f-hero-preview');
  const status = document.querySelector('#f-hero-status');

  // A value already on the form (editing, validation bounce) shows its preview.
  if (preview && heroField.value.trim()) {
    preview.src = heroField.value.trim();
    preview.hidden = false;
  }

  heroFile.addEventListener('change', async () => {
    const file = heroFile.files && heroFile.files[0];
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
      if (!res.ok || !data.ok) throw new Error(data.error || 'Upload failed — type a link instead.');
      heroField.value = data.url;
      if (preview) {
        preview.src = data.url;
        preview.hidden = false;
      }
      if (status) status.textContent = `${file.name} — uploaded.`;
    } catch (err) {
      if (status) status.textContent = (err && err.message) || 'Upload failed — type a link instead.';
    } finally {
      heroFile.value = '';
    }
  });
}
