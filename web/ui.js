// Themed confirm dialog used instead of the browser's confirm().

let dialog = null;

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'ops-dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <div class="ask-head"><span class="mono ask-tag"></span><h2 class="ask-title"></h2></div>
      <p class="ask-msg"></p>
      <div class="ask-detail"></div>
      <div class="ask-row">
        <button value="cancel" class="btn ghost ask-cancel"></button>
        <button value="ok" class="btn ask-ok"></button>
      </div>
    </form>`;
  document.body.appendChild(dialog);
}

/**
 * @param {{title: string, message?: string, detail?: string | string[], ok?: string, cancel?: string, danger?: boolean, tag?: string}} o
 * @returns {Promise<boolean>} true when confirmed
 */
export function ask(o) {
  if (!dialog) build();
  const q = (s) => dialog.querySelector(s);
  q('.ask-tag').textContent = o.tag || (o.danger ? 'WARNING' : 'CONFIRM');
  q('.ask-title').textContent = o.title;
  q('.ask-msg').textContent = o.message || '';
  const lines = Array.isArray(o.detail) ? o.detail : o.detail ? [o.detail] : [];
  q('.ask-detail').innerHTML = '';
  for (const l of lines) {
    const div = document.createElement('div');
    div.textContent = l;
    q('.ask-detail').appendChild(div);
  }
  q('.ask-detail').hidden = !lines.length;
  q('.ask-ok').textContent = o.ok || '确定';
  q('.ask-cancel').textContent = o.cancel || '取消';
  dialog.classList.toggle('danger', Boolean(o.danger));
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
    // destructive actions start on "cancel" so a stray Enter doesn't fire them
    (o.danger ? q('.ask-cancel') : q('.ask-ok')).focus();
  });
}
