/*
 * Shared platform chrome for every tool + the hub.
 *
 * Injects two dialogs into the page and wires them up via event delegation, so
 * any element carrying `data-platform-help` or `data-platform-aboba` triggers
 * them — this works even inside React-rendered menubars, because the listener
 * lives on `document`, not on the element itself.
 *
 *   data-platform-help   -> Feedback / bug report dialog (POSTs to /api/feedback)
 *   data-platform-aboba  -> "aboba" window showing the paperclip gif
 *
 * Loaded on every page with: <script src="/shared/platform-ui.js" defer></script>
 * The dialog markup reuses the shared xp.css classes already loaded on the page.
 */
(function () {
  function h(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  const feedbackDialog = h(`
    <div class="dialog-overlay hidden" data-dialog="feedback">
      <div class="dialog window">
        <div class="titlebar">
          <div class="titlebar-icon"></div>
          <span class="titlebar-text">Feedback &amp; bug reports</span>
          <div class="titlebar-buttons">
            <button class="win-btn win-btn-close" data-close tabindex="-1">X</button>
          </div>
        </div>
        <div class="dialog-body">
          <form data-feedback-form>
            <p class="dialog-error" data-error></p>
            <div class="field">
              <label class="field-label" for="pf-type">Type</label>
              <select id="pf-type" data-type>
                <option value="feedback">General feedback</option>
                <option value="bug">Bug report</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="pf-message">Message</label>
              <textarea id="pf-message" data-message rows="6" maxlength="5000"
                placeholder="What's on your mind? For bugs, include what you did and what went wrong." required></textarea>
            </div>
            <div class="dialog-actions">
              <button type="button" class="btn" data-close>Cancel</button>
              <button type="submit" class="btn primary" data-submit>Send</button>
            </div>
          </form>
        </div>
      </div>
    </div>`);

  const abobaDialog = h(`
    <div class="dialog-overlay hidden" data-dialog="aboba">
      <div class="dialog window" style="width:auto;">
        <div class="titlebar">
          <div class="titlebar-icon"></div>
          <span class="titlebar-text">aboba</span>
          <div class="titlebar-buttons">
            <button class="win-btn win-btn-close" data-close tabindex="-1">X</button>
          </div>
        </div>
        <div class="dialog-body" style="text-align:center;">
          <img src="/public/gif/paperclip.gif" alt="aboba"
            style="display:block; max-width:320px; width:100%; image-rendering:auto;" />
        </div>
      </div>
    </div>`);

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    document.body.appendChild(feedbackDialog);
    document.body.appendChild(abobaDialog);

    const errEl = feedbackDialog.querySelector('[data-error]');
    const typeEl = feedbackDialog.querySelector('[data-type]');
    const messageEl = feedbackDialog.querySelector('[data-message]');
    const submitBtn = feedbackDialog.querySelector('[data-submit]');
    const form = feedbackDialog.querySelector('[data-feedback-form]');

    function open(dialog) {
      dialog.classList.remove('hidden');
    }
    function close(dialog) {
      dialog.classList.add('hidden');
    }

    function openFeedback() {
      errEl.textContent = '';
      form.reset();
      open(feedbackDialog);
      messageEl.focus();
    }

    // Trigger dialogs from any tagged element (works for React-rendered ones too).
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-platform-help]')) { e.preventDefault(); openFeedback(); return; }
      if (e.target.closest('[data-platform-aboba]')) { e.preventDefault(); open(abobaDialog); return; }
      const closer = e.target.closest('[data-close]');
      if (closer) { close(closer.closest('.dialog-overlay')); return; }
    });

    // Keyboard access for the menubar triggers (they are role="button").
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const trigger = e.target.closest('[data-platform-help], [data-platform-aboba]');
      if (!trigger) return;
      e.preventDefault();
      if (trigger.hasAttribute('data-platform-help')) openFeedback();
      else open(abobaDialog);
    });

    // Click on the dimmed backdrop closes the dialog.
    [feedbackDialog, abobaDialog].forEach(function (d) {
      d.addEventListener('click', function (e) { if (e.target === d) close(d); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { close(feedbackDialog); close(abobaDialog); }
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      errEl.textContent = '';
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ type: typeEl.value, message: messageEl.value }),
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          errEl.textContent = data.error || 'Could not send. Please try again.';
          return;
        }
        close(feedbackDialog);
      } catch (_) {
        errEl.textContent = 'Network error. Please try again.';
      } finally {
        submitBtn.disabled = false;
      }
    });
  });
})();
