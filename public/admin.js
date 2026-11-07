/* Admin panel: review Claude's drafts, edit, mark premium sections, publish + notify. */
const $view = document.getElementById('view');
const api = async (path, opts = {}) => {
  const res = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200); }

function loginView(msg) {
  $view.innerHTML = `
    <form class="auth" id="f">
      <h1 class="title">Admin sign in</h1>
      <label for="email">Email</label><input id="email" type="email" required autocomplete="username">
      <label for="password">Password</label><input id="password" type="password" required autocomplete="current-password">
      <p class="error" id="err">${esc(msg || '')}</p>
      <button class="btn primary" style="width:100%">Sign in</button>
    </form>`;
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { user } = await api('/api/auth/login', { method: 'POST', body: { email: document.getElementById('email').value, password: document.getElementById('password').value } });
      if (user.role !== 'admin') return loginView('This account is not an admin.');
      route();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

async function dashboard() {
  const [stats, { briefs }] = await Promise.all([api('/api/admin/stats'), api('/api/admin/briefs')]);
  $view.innerHTML = `
    <h1 class="title">Dashboard</h1>
    <div class="stats">
      <div class="stat"><b>${stats.drafts}</b><span>Drafts to review</span></div>
      <div class="stat"><b>${stats.published}</b><span>Published</span></div>
      <div class="stat"><b>${stats.users}</b><span>Subscribers</span></div>
      <div class="stat"><b>${stats.premium}</b><span>Premium</span></div>
      <div class="stat"><b>${stats.pushDevices}</b><span>Phones with alerts</span></div>
    </div>
    <div class="row" style="margin-bottom:10px"><h2 style="margin:0;font:700 19px var(--serif)">Briefs</h2><span class="spacer"></span><a class="btn primary" href="#new">+ New brief</a></div>
    ${briefs.length ? `<ul class="list">${briefs.map((b) => `
      <li><a href="#${b.id}">
        <span>${esc(b.title)} <span class="badge ${b.status === 'draft' ? 'draft' : 'live'}">${b.status === 'draft' ? 'Needs review' : 'Live'}</span>
          ${b.source === 'claude' ? '<span class="badge" style="background:none;color:var(--muted)">from Claude</span>' : ''}</span>
        <span class="date">${esc(b.date)}</span></a></li>`).join('')}</ul>` : '<div class="empty">No briefs yet.</div>'}`;
}

function sectionEditor(s, i) {
  return `<div class="section-edit" data-i="${i}">
    <div class="row"><input type="text" class="h" value="${esc(s.heading)}" aria-label="Section heading" style="flex:1;min-width:180px">
      <label class="check"><input type="checkbox" class="p" ${s.premium ? 'checked' : ''}> Premium only</label>
      <button class="btn danger rm" type="button" title="Remove section">✕</button></div>
    <textarea class="b" aria-label="Section text (Markdown)">${esc(s.body_md)}</textarea>
  </div>`;
}

async function editor(id) {
  const { brief: b } = await api(`/api/admin/briefs/${id}`);
  $view.innerHTML = `
    <p><a href="#">← Dashboard</a></p>
    <div class="row"><span class="badge ${b.status === 'draft' ? 'draft' : 'live'}">${b.status === 'draft' ? 'Draft — not visible to readers' : 'Live'}</span>${b.source === 'claude' ? '<span class="muted" style="font-size:14px">Written by Claude</span>' : ''}</div>
    <label for="title">Title</label><input id="title" type="text" value="${esc(b.title)}">
    <label for="date">Date</label><input id="date" type="date" value="${esc(b.date)}" style="max-width:200px">
    <h2 style="font:700 19px var(--serif);margin:22px 0 8px">Sections</h2>
    <p class="muted" style="font-size:14px;margin-top:0">Write in Markdown (- bullets, **bold**, tables). Tick “Premium only” to lock a section for free readers.</p>
    <div id="secs">${b.sections.map(sectionEditor).join('')}</div>
    <p><button class="btn" id="add" type="button">+ Add section</button></p>
    <div class="card" style="padding-bottom:14px">
      <div class="row">
        <button class="btn" id="save">Save</button>
        ${b.status === 'draft'
          ? `<label class="check"><input type="checkbox" id="notify" checked> Send phone notification</label><span class="spacer"></span><button class="btn primary" id="publish">Approve & publish</button>`
          : `<span class="spacer"></span><button class="btn" id="unpublish">Unpublish</button>`}
        <button class="btn danger" id="del">Delete</button>
      </div>
    </div>
    <h2 style="font:700 19px var(--serif);margin:22px 0 8px">Preview</h2>
    <div id="preview">${b.sections.map((s) => `<section class="card"><h2>${esc(s.heading)} ${s.premium ? '<span class="badge">Premium</span>' : ''}</h2>${s.html}</section>`).join('')}</div>`;

  const collect = () => ({
    title: document.getElementById('title').value,
    date: document.getElementById('date').value,
    sections: [...document.querySelectorAll('.section-edit')].map((el) => ({ heading: el.querySelector('.h').value, body_md: el.querySelector('.b').value, premium: el.querySelector('.p').checked })),
  });
  const save = async () => { await api(`/api/admin/briefs/${id}`, { method: 'PUT', body: collect() }); };
  document.getElementById('secs').addEventListener('click', (e) => { if (e.target.classList.contains('rm')) e.target.closest('.section-edit').remove(); });
  document.getElementById('add').onclick = () => document.getElementById('secs').insertAdjacentHTML('beforeend', sectionEditor({ heading: 'New section', body_md: '', premium: false }, Date.now()));
  document.getElementById('save').onclick = async () => { try { await save(); toast('Saved'); editor(id); } catch (e) { toast(e.message); } };
  document.getElementById('publish')?.addEventListener('click', async () => {
    if (!confirm('Publish this brief to all readers now?')) return;
    try {
      await save();
      const r = await api(`/api/admin/briefs/${id}/publish`, { method: 'POST', body: { notify: document.getElementById('notify').checked } });
      toast(r.push ? `Published · notifications sent to ${r.push.sent} of ${r.push.total} devices` : 'Published');
      editor(id);
    } catch (e) { toast(e.message); }
  });
  document.getElementById('unpublish')?.addEventListener('click', async () => { await api(`/api/admin/briefs/${id}/unpublish`, { method: 'POST' }); toast('Moved back to drafts'); editor(id); });
  document.getElementById('del').onclick = async () => { if (!confirm('Delete this brief permanently?')) return; await api(`/api/admin/briefs/${id}`, { method: 'DELETE' }); location.hash = ''; };
}

function newBrief() {
  const today = new Date().toISOString().slice(0, 10);
  $view.innerHTML = `
    <p><a href="#">← Dashboard</a></p>
    <h1 class="title">New brief</h1>
    <p class="muted">Paste the whole brief in Markdown. Each <code>## Heading</code> becomes a section; headings with “market” or “stock” are marked Premium automatically.</p>
    <label for="title">Title (optional — taken from the # heading if blank)</label><input id="title" type="text">
    <label for="date">Date</label><input id="date" type="date" value="${today}" style="max-width:200px">
    <label for="md">Brief (Markdown)</label><textarea id="md" style="min-height:320px" placeholder="# News brief — ${today}\n\n## Local\n- ...\n\n## National\n- ...\n\n## Markets\n- ..."></textarea>
    <p class="error" id="err"></p>
    <button class="btn primary" id="create">Create draft</button>`;
  document.getElementById('create').onclick = async () => {
    try {
      const { id } = await api('/api/admin/briefs', { method: 'POST', body: { title: document.getElementById('title').value || undefined, date: document.getElementById('date').value, markdown: document.getElementById('md').value } });
      location.hash = String(id);
    } catch (e) { document.getElementById('err').textContent = e.message; }
  };
}

async function route() {
  const h = location.hash.replace('#', '');
  try {
    const { user } = await api('/api/me');
    if (!user || user.role !== 'admin') return loginView(user ? 'This account is not an admin.' : '');
    if (h === 'new') newBrief();
    else if (/^\d+$/.test(h)) await editor(h);
    else await dashboard();
    window.scrollTo(0, 0);
  } catch (e) { if (e.status === 401 || e.status === 403) loginView(); else $view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
route();
