// Whiteboard: sketch a visual change (on a blank board or on top of a pasted screenshot) and send
// the drawing into the chat as an attached image. The board keeps its drawing while closed, so it
// can be reopened and tweaked; "Send to chat" hands a PNG to onSend.
const COLORS = ['#111111', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'];
const TOOLS = [['pen', '✏️', 'Pen (P)'], ['hl', '🖍', 'Highlighter (H)'], ['line', '／', 'Line (L)'], ['arrow', '➜', 'Arrow (A)'],
  ['rect', '▭', 'Box (R)'], ['ellipse', '◯', 'Circle (O)'], ['text', 'T', 'Text (T)'], ['erase', '⌫', 'Eraser (E)']];
const KEYS = { p: 'pen', h: 'hl', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text', e: 'erase' };

const CSS = `
#wb { position: fixed; inset: 0; z-index: 9000; background: rgba(5,6,13,0.72); display: flex; flex-direction: column; padding: 16px; gap: 8px; }
#wb[hidden] { display: none; }
#wb .wb-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; background: #151827; border: 1px solid rgba(160,175,255,0.18); border-radius: 10px; color: #e8eaf6; font: 13px system-ui, sans-serif; }
#wb .wb-grp { display: flex; gap: 4px; align-items: center; padding-right: 8px; border-right: 1px solid rgba(160,175,255,0.14); }
#wb .wb-grp:last-of-type { border-right: 0; }
#wb button { background: #23273a; color: #e8eaf6; border: 1px solid transparent; border-radius: 6px; padding: 4px 9px; cursor: pointer; font: inherit; }
#wb button:hover { background: #2e3350; }
#wb button.on { border-color: #d97757; background: #3a2a24; }
#wb button.go { background: #d97757; color: #1b0f0a; font-weight: 600; }
#wb .wb-sw { width: 20px; height: 20px; border-radius: 50%; padding: 0; border: 2px solid #555; }
#wb .wb-sw.on { border-color: #fff; }
#wb .wb-msg { margin-left: auto; color: #8c93b8; }
#wb .wb-wrap { position: relative; flex: 1; overflow: auto; border-radius: 10px; background: #fff; }
#wb canvas { display: block; touch-action: none; cursor: crosshair; }
#wb textarea { position: absolute; display: none; font: 20px system-ui, sans-serif; background: rgba(255,255,255,0.92); border: 1px dashed #d97757; outline: 0; padding: 2px 4px; min-width: 140px; resize: none; }
`;

let root = null, api = null;

export function openWhiteboard(onSend) {
  if (!root) api = build();
  api.onSend = onSend;
  root.hidden = false;
  api.fit();
}

function build() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  root = document.createElement('div');
  root.id = 'wb';
  root.hidden = true;
  root.innerHTML = `
    <div class="wb-bar">
      <div class="wb-grp" data-g="tools">${TOOLS.map(([t, ic, tip]) => `<button type="button" data-t="${t}" title="${tip}">${ic}</button>`).join('')}</div>
      <div class="wb-grp" data-g="colors">${COLORS.map(c => `<button type="button" class="wb-sw" data-c="${c}" title="${c}" style="background:${c}"></button>`).join('')}</div>
      <div class="wb-grp" data-g="sizes"><button type="button" data-s="2">thin</button><button type="button" data-s="4">mid</button><button type="button" data-s="9">thick</button></div>
      <div class="wb-grp">
        <button type="button" data-a="undo" title="Undo (Ctrl+Z)">↶</button><button type="button" data-a="redo" title="Redo (Ctrl+Y)">↷</button>
        <button type="button" data-a="clear" title="Clear the board (and the screenshot)">Clear</button>
        <button type="button" data-a="bg" title="Draw on top of a screenshot (or press Ctrl+V on the board)">🖼 Screenshot</button>
        <input type="file" accept="image/*" hidden>
      </div>
      <div class="wb-grp">
        <button type="button" class="go" data-a="send" title="Attach this drawing to your message">Send to chat</button>
        <button type="button" data-a="close" title="Close (Esc). The drawing stays for next time.">Close</button>
      </div>
      <span class="wb-msg">Draw your idea. Ctrl+V pastes a screenshot to draw on.</span>
    </div>
    <div class="wb-wrap"><canvas></canvas><textarea rows="1"></textarea></div>`;
  document.body.appendChild(root);

  const c = root.querySelector('canvas'), x = c.getContext('2d');
  const wrap = root.querySelector('.wb-wrap'), msg = root.querySelector('.wb-msg');
  const tb = root.querySelector('textarea'), fileIn = root.querySelector('input[type=file]');
  let tool = 'pen', color = COLORS[1], size = 4, bgImg = null, shapes = [], redoStack = [], cur = null;
  const self = { onSend: null, fit };
  const say = t => { msg.textContent = t; };

  function mark() {
    root.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === tool));
    root.querySelectorAll('[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === color));
    root.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', +b.dataset.s === size));
  }
  function setTool(t) { commitText(); tool = t; mark(); }
  function fit() {
    const w = Math.max(wrap.clientWidth, bgImg?.width || 0), h = Math.max(wrap.clientHeight, bgImg?.height || 0);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    draw();
  }
  function close() { commitText(); root.hidden = true; }
  function loadBg(src) {
    const img = new Image();
    img.onload = () => { bgImg = img; shapes = shapes.filter(s => s.t !== 'clear'); fit(); say('Screenshot loaded. Draw on top of it.'); };
    img.src = src;
  }

  root.querySelector('.wb-bar').addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.t) return setTool(b.dataset.t);
    if (b.dataset.c) { color = b.dataset.c; return mark(); }
    if (b.dataset.s) { size = +b.dataset.s; return mark(); }
    const a = b.dataset.a;
    if (a === 'undo') undo();
    else if (a === 'redo') redo();
    else if (a === 'clear') { commitText(); shapes = []; redoStack = []; bgImg = null; fit(); say('Cleared.'); }
    else if (a === 'bg') fileIn.click();
    else if (a === 'close') close();
    else if (a === 'send') {
      commitText();
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      if (!blob) return say('Could not make the image.');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      self.onSend?.(new File([blob], `sketch-${stamp}.png`, { type: 'image/png' }));
      close();
    }
  });
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; if (f) loadBg(URL.createObjectURL(f)); fileIn.value = ''; });
  window.addEventListener('resize', () => { if (!root.hidden) fit(); });
  document.addEventListener('paste', e => {
    if (root.hidden || document.activeElement === tb) return;
    const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
    if (f) { e.preventDefault(); e.stopPropagation(); loadBg(URL.createObjectURL(f)); }
  }, true);
  document.addEventListener('keydown', e => {
    if (root.hidden || document.activeElement === tb) return;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') close();
    else if ((e.ctrlKey || e.metaKey) && k === 'z') e.shiftKey ? redo() : undo();
    else if ((e.ctrlKey || e.metaKey) && k === 'y') redo();
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && KEYS[k]) setTool(KEYS[k]);
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);

  const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  c.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const p = pos(e);
    if (tool === 'text') { e.preventDefault(); return startText(p); }
    commitText();
    c.setPointerCapture(e.pointerId);
    cur = { t: tool, color, size: tool === 'hl' ? size * 4 : tool === 'erase' ? size * 5 : size, pts: [p] };
  });
  c.addEventListener('pointermove', e => {
    if (!cur) return;
    const p = pos(e);
    if (['pen', 'hl', 'erase'].includes(cur.t)) cur.pts.push(p); else cur.pts[1] = p;
    draw();
  });
  c.addEventListener('pointerup', () => {
    if (!cur) return;
    if (cur.pts.length > 1 || cur.t === 'pen') { shapes.push(cur); redoStack = []; }
    cur = null; draw();
  });

  function startText([px, py]) {
    commitText();
    Object.assign(tb.style, { left: `${px}px`, top: `${py - 12}px`, color, display: 'block' });
    tb.value = ''; tb.dataset.x = px; tb.dataset.y = py;
    setTimeout(() => tb.focus(), 0);
  }
  function commitText() {
    if (tb.style.display !== 'block') return;
    const v = tb.value.trim();
    tb.style.display = 'none';
    if (v) { shapes.push({ t: 'text', color: tb.style.color, size, text: v, pts: [[+tb.dataset.x, +tb.dataset.y]] }); redoStack = []; draw(); }
  }
  tb.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
    if (e.key === 'Escape') { tb.value = ''; commitText(); }
  });

  function undo() { commitText(); if (shapes.length) { redoStack.push(shapes.pop()); draw(); } }
  function redo() { if (redoStack.length) { shapes.push(redoStack.pop()); draw(); } }

  function draw() {
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    if (bgImg) x.drawImage(bgImg, 0, 0);
    for (const s of cur ? [...shapes, cur] : shapes) paint(s);
  }
  function paint(s) {
    x.save();
    x.strokeStyle = s.t === 'erase' ? '#fff' : s.color; x.fillStyle = s.color;
    x.lineWidth = s.size; x.lineCap = x.lineJoin = 'round';
    if (s.t === 'hl') x.globalAlpha = 0.35;
    const [a, b] = s.pts;
    if (s.t === 'pen' || s.t === 'hl' || s.t === 'erase') {
      x.beginPath(); x.moveTo(...a);
      if (s.pts.length === 1) x.lineTo(a[0] + 0.1, a[1]);
      for (const p of s.pts) x.lineTo(...p);
      x.stroke();
    } else if (s.t === 'line' || s.t === 'arrow') {
      x.beginPath(); x.moveTo(...a); x.lineTo(...b); x.stroke();
      if (s.t === 'arrow') {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = 10 + s.size * 3;
        x.beginPath(); x.moveTo(...b);
        x.lineTo(b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45));
        x.lineTo(b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45));
        x.closePath(); x.fill();
      }
    } else if (s.t === 'rect') x.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    else if (s.t === 'ellipse') {
      x.beginPath();
      x.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
      x.stroke();
    } else if (s.t === 'text') {
      x.font = `${14 + s.size * 3}px system-ui, sans-serif`; x.textBaseline = 'middle';
      s.text.split('\n').forEach((ln, i) => x.fillText(ln, a[0], a[1] + i * (18 + s.size * 3)));
    }
    x.restore();
  }

  mark();
  return self;
}
