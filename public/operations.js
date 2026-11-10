import { events } from '/events.js';
import { rating } from './minds.js';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let generation = 0, lines = [], pending = false;
$('opsChatToggle').onclick = () => {
  const open = document.body.classList.toggle('ops-chat');
  $('opsChatToggle').setAttribute('aria-expanded', open);
  $('opsChatToggle').textContent = open ? 'Return to workspace' : 'Open chat & tools';
};
function drawState(s) {
  const expanded = new Map([...$('opsRoster').querySelectorAll('details[data-id]')].map(d => [d.dataset.id, d.open]));
  const f = s.foundations;
  $('opsFoundationStatus').textContent = !f || f.missing ? 'No master CLAUDE.md found' : `Tracked - updated ${new Date(f.modified).toLocaleString()}${f.truncated ? ' - preview truncated' : ''}`;
  $('opsFoundations').textContent = f?.text || '';
  $('opsRoster').innerHTML = (s.skills || []).map(e => {
    const sessions = new Map(), history=[];
    for (const a of s.activity || []) {
      if (a.type === 'task') { const r={ key: `${a.session}:${a.ts}`, skills: [], status: 'working' }; sessions.set(a.session,r); history.push(r); }
      const r=sessions.get(a.session); if(!r) continue;
      if(a.type==='skill') r.skills.push(a.skill?.split(':').pop());
      if(a.type==='stop') {r.status=a.outcome || 'done';r.grade=s.grades?.[r.key];}
    }
    const score=rating(history.filter(r=>r.skills.includes(e.name)));
    const rank=!score.runs ? 'New' : score.score>=.8 ? 'Expert' : score.score>=.6 ? 'Proven' : score.score>=.4 ? 'Developing' : 'Learning';
    return `<article class="ops-card"><b>${esc(s.names?.[e.id] || e.name)}</b><span class="ops-muted">${esc(e.name)}</span><div class="ops-rank">${esc(e.model || s.minds?.[e.id]?.model || 'Inherited model')} / ${rank}${score.runs ? ' / '+Math.round(score.score*100) : ''}</div><details data-id="${esc(e.id)}" ${expanded.get(e.id) === false ? '' : 'open'}><summary>Negative constraints: ${e.constraints?.length || 0}</summary>${e.constraints?.length ? `<ul>${e.constraints.map(c=>`<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="ops-muted">No strict negative constraints recorded.</p>'}</details></article>`;
  }).join('') || '<p class="ops-muted">No employees in this brain.</p>';
}
function drawQueue(s) {
  const tasks = (s.briefs || []).flatMap(b => (b.tasks || []).filter(t=>['waiting','working'].includes(t.status)).map(t=>({...t, brief:b.title})));
  $('opsQueue').innerHTML = tasks.map(t=>`<article class="ops-card"><b>${esc(t.name || t.employee)}</b><span class="ops-rank">${esc(t.status)}</span><p>${esc(t.task)}</p><span class="ops-muted">${esc(t.brief)}${t.after?.length ? ' - waits for '+esc(t.after.join(', ')) : ''}</span></article>`).join('') || '<p class="ops-muted">No active brief tasks.</p>';
  $('opsStreamState').textContent = tasks.some(t=>t.status==='working') ? 'running' : 'idle';
}
async function loadQueue() {
  const g = generation;
  try { const r = await fetch('/api/manager', {headers:{'x-claudeos-token':window.CLAUDEOS_TOKEN}}); const s = await r.json(); if(g===generation && !s.error) drawQueue(s); } catch { $('opsStreamState').textContent = 'offline'; }
}
events.addEventListener('message', e=>drawState(JSON.parse(e.data)));
events.addEventListener('manager', e=>drawQueue(JSON.parse(e.data)));
events.addEventListener('open', loadQueue);
events.addEventListener('brain', ()=>{ generation++; lines=[]; $('opsTicker').textContent='Waiting for headless work...'; loadQueue(); });
events.addEventListener('chat', e=>{
  const v=JSON.parse(e.data); if(v.kind!=='stdout') return;
  lines.push(`${new Date(v.ts).toLocaleTimeString()} [${v.skillId}] ${v.text}`); lines=lines.slice(-120);
  if(!pending) { pending=true; requestAnimationFrame(()=>{ pending=false; const el=$('opsTicker'); const stick=el.scrollHeight-el.scrollTop-el.clientHeight<32; el.textContent=lines.join('\n'); if(stick) el.scrollTop=el.scrollHeight; }); }
});
loadQueue();

// ---------- Chat height ----------
// The edge between the chat and the stdout panel drags up or down; remembered on this PC.
const STREAM_KEY = 'claudeos.opsStreamHeight';
const setStream = h => { if (h) document.body.style.setProperty('--ops-stream-h', `${h}px`); else document.body.style.removeProperty('--ops-stream-h'); };
setStream(Number(localStorage.getItem(STREAM_KEY)) || 0);
const opsGrip = $('opsGrip');
opsGrip.addEventListener('pointerdown', e => {
  e.preventDefault();
  opsGrip.setPointerCapture(e.pointerId);
  opsGrip.classList.add('drag');
  // stream keeps at least its title (44px); the chat keeps at least 220px
  const move = ev => setStream(Math.round(Math.max(44, Math.min(innerHeight - 86 - 30 - 220, innerHeight - 20 - ev.clientY))));
  const up = () => {
    opsGrip.classList.remove('drag');
    opsGrip.removeEventListener('pointermove', move);
    const h = parseInt(document.body.style.getPropertyValue('--ops-stream-h'));
    if (h) localStorage.setItem(STREAM_KEY, h); else localStorage.removeItem(STREAM_KEY);
  };
  opsGrip.addEventListener('pointermove', move);
  opsGrip.addEventListener('pointerup', up, { once: true });
});
opsGrip.addEventListener('dblclick', () => { setStream(0); localStorage.removeItem(STREAM_KEY); });
