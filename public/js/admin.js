/* ==========================================================================
   Console behaviour (§7.3). Vanilla ES module, no dependencies.
   Everything here is optional polish: every filter and every mutation is a
   plain form POST, so the console works with JavaScript switched off.
   ========================================================================== */

/** Submit a filter form as soon as its <select> changes. */
function wireAutoSubmit() {
  document.querySelectorAll('[data-auto-submit]').forEach((control) => {
    control.addEventListener('change', () => {
      const form = control.form;
      if (form) form.requestSubmit();
    });
  });
}

/** Fill the reply box from the chosen WhatsApp template. */
function wireTemplates() {
  document.querySelectorAll('[data-template-select]').forEach((select) => {
    const group = select.closest('.admin-actions__group') || document;
    const output = group.querySelector('[data-template-output]');
    const copy = group.querySelector('[data-copy-template]');
    if (!output) return;

    const sync = () => {
      const option = select.options[select.selectedIndex];
      const body = option ? option.getAttribute('data-body') || '' : '';
      output.value = body
        .replace(/\{name\}/g, select.getAttribute('data-name') || 'there')
        .replace(/\{ref\}/g, select.getAttribute('data-ref') || 'your request');
    };
    select.addEventListener('change', sync);
    if (copy) {
      copy.addEventListener('click', async () => {
        if (!output.value) return;
        try {
          await navigator.clipboard.writeText(output.value);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy reply'; }, 2000);
        } catch {
          output.select();
        }
      });
    }
    sync();
  });
}

/** Copy the daily summary. */
function wireSummary() {
  document.querySelectorAll('[data-copy-summary]').forEach((button) => {
    const source = document.getElementById(button.getAttribute('data-copy-summary'));
    if (!source) return;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(source.value);
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = 'Copy summary'; }, 2000);
      } catch {
        source.select();
      }
    });
  });
}

/** Print the inspection report from the console (the print sheet does the work). */
function wirePrint() {
  document.querySelectorAll('[data-print]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });
}

wireAutoSubmit();
wireTemplates();
wireSummary();
wirePrint();
