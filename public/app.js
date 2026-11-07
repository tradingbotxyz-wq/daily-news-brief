/* Daily Brief — reader PWA (vanilla JS, no build step) */
const $view = document.getElementById('view');
const state = { user: null, config: null };

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const rupees = (p) => '₹' + (p / 100).toLocaleString('en-IN');
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- views ----------
function renderBrief(b) {
  if (!b) return '<div class="empty">No news brief has been published yet. Check back soon.</div>';
  const isFree = !state.user || (state.user.tier !== 'premium' && state.user.role !== 'admin');
  return `
    <div class="kicker">${esc(fmtDate(b.date))}</div>
    <h1 class="title">${esc(b.title)}</h1>
    ${b.sections.map((s) => s.locked ? `
      <section class="card locked">
        <h2>${esc(s.heading)} <span class="badge">Premium</span></h2>
        <p class="teaser">${esc(s.teaser)}</p>
        <div class="cta">
          <span class="muted">${state.user ? 'Upgrade to read the full section.' : 'Sign in and go Premium to read this.'}</span>
          <a class="btn gold" href="#/${state.user ? 'account' : 'register'}">${state.user ? 'Go Premium' : 'Create account'}</a>
        </div>
      </section>` : `
      <section class="card">
        <h2>${esc(s.heading)} ${s.premium ? '<span class="badge">Premium</span>' : ''}</h2>
        ${s.html}
      </section>`).join('')}
    ${isFree && !state.user ? `<div class="notice">Get the brief on your phone every morning: <a href="#/register">create a free account</a> and turn on notifications.</div>` : ''}
    <p class="muted" style="font-size:13px">Summaries are written for quick reading and are not investment advice.</p>`;
}

async function viewToday() {
  const { brief } = await api('/api/briefs/latest');
  $view.innerHTML = renderBrief(brief);
}
async function viewBrief(id) {
  const { brief } = await api(`/api/briefs/${encodeURIComponent(id)}`);
  $view.innerHTML = renderBrief(brief) + '<p><a href="#/archive">← All briefs</a></p>';
}
async function viewArchive() {
  const { briefs } = await api('/api/briefs');
  $view.innerHTML = `<h1 class="title">Archive</h1>` + (briefs.length
    ? `<ul class="list">${briefs.map((b) => `<li><a href="#/brief/${b.id}"><span>${esc(b.title)}</span><span class="date">${esc(new Date(b.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))}</span></a></li>`).join('')}</ul>`
    : '<div class="empty">Nothing here yet.</div>');
}

function authForm(mode) {
  const reg = mode === 'register';
  $view.innerHTML = `
    <form class="auth" id="authForm">
      <h1 class="title">${reg ? 'Create your free account' : 'Sign in'}</h1>
      ${reg ? '<label for="name">Name</label><input id="name" type="text" autocomplete="name">' : ''}
      <label for="email">Email</label><input id="email" type="email" required autocomplete="email">
      <label for="password">Password ${reg ? '<span class="muted">(8+ characters)</span>' : ''}</label>
      <input id="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}">
      <p class="error" id="err"></p>
      <button class="btn primary" style="width:100%">${reg ? 'Create account' : 'Sign in'}</button>
      <p class="muted" style="text-align:center">${reg ? 'Already have an account? <a href="#/login">Sign in</a>' : 'New here? <a href="#/register">Create a free account</a>'}</p>
    </form>`;
  document.getElementById('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = { email: document.getElementById('email').value, password: document.getElementById('password').value };
    if (reg) body.name = document.getElementById('name').value;
    try {
      const { user } = await api(`/api/auth/${reg ? 'register' : 'login'}`, { method: 'POST', body });
      state.user = user; updateNav();
      location.hash = '#/account';
      toast(reg ? 'Welcome! Turn on notifications to get each brief.' : 'Signed in');
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

async function viewAccount() {
  if (!state.user) return authForm('login');
  const u = state.user, c = state.config;
  const premium = u.tier === 'premium' || u.role === 'admin';
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const sub = pushSupported ? await getPushSubscription() : null;

  $view.innerHTML = `
    <h1 class="title">Hello${u.name ? ', ' + esc(u.name) : ''}</h1>
    <section class="card">
      <h2>Your plan ${premium ? '<span class="badge">Premium</span>' : ''}</h2>
      ${premium
        ? `<p>You can read every section, including markets and stock highlights.${u.premium_until ? ` Active until <b>${esc(new Date(u.premium_until).toLocaleDateString('en-IN'))}</b>.` : ''}</p>
           ${u.role !== 'admin' && c.payments === 'demo' ? '<p><button class="btn" id="cancel">Switch back to Free (demo)</button></p>' : ''}`
        : `<p>You're on the <b>Free</b> plan: local, national and world news. Premium adds the full markets and stock section every day.</p>
           <p><button class="btn gold" id="upgrade">Go Premium · ${rupees(c.premiumPricePaise)} / ${c.premiumDays} days</button></p>
           ${c.payments === 'demo' ? '<p class="muted" style="font-size:13px">Demo mode: payments are not connected yet, so upgrading is free.</p>' : ''}`}
    </section>
    <section class="card">
      <h2>Notifications</h2>
      ${!pushSupported
        ? `<p class="muted">${isIOS && !standalone ? 'On iPhone, first add this app to your Home Screen (Share → Add to Home Screen), then open it from there to turn on notifications.' : 'This browser does not support push notifications.'}</p>`
        : `<p>${sub ? 'On: this device gets a notification when a new brief is published.' : 'Get a notification on this device when each new brief is published.'}</p>
           <p><button class="btn ${sub ? '' : 'primary'}" id="push">${sub ? 'Turn off on this device' : 'Turn on notifications'}</button></p>`}
    </section>
    ${!standalone ? `<section class="card"><h2>Install the app</h2><p>${isIOS ? 'In Safari tap <b>Share</b> → <b>Add to Home Screen</b>.' : 'Use your browser menu → <b>Install app</b> / <b>Add to Home screen</b>.'}</p><p>${deferredInstall ? '<button class="btn" id="install">Install now</button>' : ''}</p></section>` : ''}
    <div class="row">${u.role === 'admin' ? '<a class="btn" href="/admin.html">Open admin panel</a>' : ''}<span class="spacer"></span><button class="btn danger" id="logout">Sign out</button></div>`;

  document.getElementById('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); state.user = null; updateNav(); location.hash = '#/'; };
  document.getElementById('upgrade')?.addEventListener('click', upgrade);
  document.getElementById('cancel')?.addEventListener('click', async () => { state.user = (await api('/api/billing/cancel', { method: 'POST' })).user; viewAccount(); });
  document.getElementById('push')?.addEventListener('click', () => (sub ? disablePush(sub) : enablePush()).then(viewAccount).catch((e) => toast(e.message)));
  document.getElementById('install')?.addEventListener('click', async () => { deferredInstall.prompt(); deferredInstall = null; });
}

// ---------- payments ----------
async function upgrade() {
  try {
    const r = await api('/api/billing/order', { method: 'POST' });
    if (r.mode === 'demo') { state.user = r.user; toast('Premium unlocked (demo)'); return viewAccount(); }
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
    new window.Razorpay({
      key: r.keyId, order_id: r.order.id, amount: r.order.amount, currency: r.order.currency,
      name: 'Daily Brief', description: 'Premium subscription',
      prefill: { email: state.user.email, name: state.user.name },
      handler: async (resp) => {
        try { state.user = (await api('/api/billing/verify', { method: 'POST', body: resp })).user; toast('Premium unlocked — thank you!'); viewAccount(); }
        catch (e) { toast(e.message); }
      },
    }).open();
  } catch (e) { toast(e.message); }
}
const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load payment window')); document.head.appendChild(s); });

// ---------- push ----------
const b64ToBytes = (b64) => { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
async function getPushSubscription() { const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked in your browser settings');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.config.vapidPublicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  toast('Notifications on');
}
async function disablePush(sub) {
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
  toast('Notifications off');
}

// ---------- router ----------
function updateNav() {
  document.getElementById('nav-account').textContent = state.user ? 'Account' : 'Sign in';
}
async function router() {
  const h = location.hash.replace(/^#\/?/, '');
  const [r, arg] = h.split('/');
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === (r || 'today') || (r === 'brief' && a.dataset.r === 'archive') || (['login', 'register'].includes(r) && a.dataset.r === 'account')));
  try {
    if (!r) await viewToday();
    else if (r === 'archive') await viewArchive();
    else if (r === 'brief' && arg) await viewBrief(arg);
    else if (r === 'login') authForm('login');
    else if (r === 'register') authForm('register');
    else if (r === 'account') await viewAccount();
    else await viewToday();
  } catch (e) {
    $view.innerHTML = `<div class="empty">${esc(navigator.onLine ? e.message : "You're offline. Showing nothing new until you reconnect.")}</div>`;
  }
  window.scrollTo(0, 0);
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
window.addEventListener('hashchange', router);

(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { [state.config, { user: state.user }] = await Promise.all([api('/api/config'), api('/api/me')]); } catch { state.config = state.config || {}; }
  updateNav();
  router();
})();
