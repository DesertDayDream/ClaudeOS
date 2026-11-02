// Review comments on diffs, like a pull request review: click a line in any diff (Claude's edits in
// the chat, or the Git tab's changes), write what should change, and the comments gather above the
// message box. "Send to Claude" turns them into one message with the file, line and code of each.
const bar = document.getElementById('review');
const input = document.getElementById('input');
const form = document.getElementById('composer');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let comments = []; // { file, ln, kind, code, text }

function drawBar() {
  bar.hidden = !comments.length;
  if (!comments.length) return;
  bar.innerHTML = `<b>${comments.length} review comment${comments.length === 1 ? '' : 's'}</b>
    <div class="rv-list">${comments.map((c, n) => `<div class="rv-item"><span title="${esc(c.file)}">${esc(c.file.split(/[\\/]/).pop())}${c.ln ? `:${c.ln}` : ''}</span><em>${esc(c.text)}</em><button type="button" data-rv-del="${n}" title="Remove">×</button></div>`).join('')}</div>
    <div class="rv-acts"><button type="button" class="btn mini" data-rv-act="clear">Clear</button><button type="button" class="btn mini primary" data-rv-act="send">Send to Claude</button></div>`;
}
bar.addEventListener('click', e => {
  const del = e.target.closest('[data-rv-del]')?.dataset.rvDel;
  if (del != null) { comments.splice(Number(del), 1); return drawBar(); }
  const act = e.target.closest('[data-rv-act]')?.dataset.rvAct;
  if (act === 'clear' && confirm('Drop these review comments?')) { comments = []; drawBar(); }
  if (act === 'send') {
    const text = 'Please address these review comments on the changes:\n\n' + comments.map((c, n) =>
      `${n + 1}. ${c.file}${c.ln ? ` line ${c.ln}` : ''}${c.kind === 'd' ? ' (a removed line)' : ''}: \`${c.code.trim().slice(0, 200)}\`\n   ${c.text.replace(/\n/g, '\n   ')}`).join('\n\n');
    input.value = input.value.trim() ? `${input.value.trim()}\n\n${text}` : text;
    comments = [];
    drawBar();
    document.querySelector('aside header [data-tab="chat"]')?.click();
    form.requestSubmit();
  }
});

// a diff's lines take comments: .diff[data-file] > .l (data-ln: the line number, when known)
export function enableReview(root) {
  root.addEventListener('click', e => {
    const line = e.target.closest('.diff .l');
    if (!line || e.target.closest('.rv-box') || window.getSelection()?.toString()) return;
    const diff = line.closest('.diff');
    const file = diff?.dataset.file;
    if (!file) return;
    if (line.nextElementSibling?.classList.contains('rv-box')) { line.nextElementSibling.querySelector('textarea').focus(); return; }
    const box = document.createElement('div');
    box.className = 'rv-box';
    box.innerHTML = `<textarea placeholder="What should change here? Claude gets the file, line and code with it." rows="2"></textarea>
      <div><button type="button" class="btn mini" data-b="cancel">Cancel</button> <button type="button" class="btn mini primary" data-b="add">Add comment</button></div>`;
    line.after(box);
    const ta = box.querySelector('textarea');
    ta.focus();
    const add = () => {
      const text = ta.value.trim();
      if (!text) return;
      comments.push({ file, ln: line.dataset.ln || '', kind: line.classList.contains('d') ? 'd' : line.classList.contains('a') ? 'a' : ' ', code: line.textContent, text });
      line.classList.add('rv');
      box.remove();
      drawBar();
    };
    box.addEventListener('click', ev => {
      ev.stopPropagation();
      const b = ev.target.closest('[data-b]')?.dataset.b;
      if (b === 'cancel') box.remove();
      if (b === 'add') add();
    });
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); add(); }
      if (ev.key === 'Escape') box.remove();
    });
  });
}
// is a comment being written in this element? (redraws wait for it)
export const reviewing = root => !!root.querySelector('.rv-box');
