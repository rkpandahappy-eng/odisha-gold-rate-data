// Admin panel for the Odisha Gold Rate data.
// Reads the published files straight from GitHub (exact commit), and saves
// changes through /api/publish (Cloudflare Pages Function → GitHub commit).

const MANUAL_PATH = 'manual/today.json';
const CONFIG_PATH = 'docs/app_config.json';
const RATE_FIELDS = [
  ['gold_24k_1g', '24K / g'],
  ['gold_22k_1g', '22K / g'],
  ['gold_18k_1g', '18K / g'],
  ['silver_1kg', 'Silver 925 / kg'],
];

const S = {
  email: '',
  repo: '',
  sha: '',
  today: null, // docs/today.json
  manual: null, // manual/today.json
  config: null, // docs/app_config.json
};

let password = '';
try { password = sessionStorage.getItem('admin_pw') || ''; } catch { /* private mode */ }

const app = document.getElementById('app');
const fmt = new Intl.NumberFormat('en-IN');

// ---------------------------------------------------------------- helpers

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function istDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function istTime(iso) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

function rupees(n) {
  return typeof n === 'number' ? `₹${fmt.format(n)}` : '—';
}

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

class ApiFailure extends Error {
  constructor(status, body) {
    super(body.error || `HTTP ${status}`);
    this.status = status;
    this.code = body.error;
    this.auth = body.auth;
    this.detail = body.detail;
  }
}

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(password ? { 'x-admin-password': password } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiFailure(res.status, body);
  return body;
}

async function raw(path, fallback) {
  const res = await fetch(`https://raw.githubusercontent.com/${S.repo}/${S.sha}/${path}`, { cache: 'no-store' });
  if (res.status === 404 && fallback !== undefined) return fallback;
  if (!res.ok) throw new Error(`Could not read ${path} (${res.status})`);
  return res.json();
}

const ERRORS = {
  github_token_missing: 'The GitHub key is not set up yet in Cloudflare (GITHUB_TOKEN).',
  github_refused: 'GitHub refused the save – the GitHub key may be wrong or expired.',
  changed_elsewhere: 'This was changed somewhere else after you opened it. Reload and try again.',
  file_not_allowed: 'That file cannot be changed from here.',
  bad_manual: 'The rates are not valid',
  bad_config: 'The settings are not valid',
  wrong_origin: 'Request blocked (wrong origin).',
};

function errorText(e) {
  const base = ERRORS[e.code] || e.message || 'Something went wrong.';
  return e.detail && (e.code === 'bad_manual' || e.code === 'bad_config') ? `${base}: ${e.detail}` : base;
}

async function save(files, message) {
  const res = await api('publish', {
    method: 'POST',
    body: JSON.stringify({ base_sha: S.sha, message, files }),
  });
  S.sha = res.sha;
  return res;
}

function cityList() {
  return Object.entries(S.today?.cities || {}).map(([id, c]) => ({ id, ...c }));
}

// ---------------------------------------------------------------- loading

async function load() {
  app.innerHTML = '<p class="muted center">Loading…</p>';
  try {
    const session = await api('session');
    Object.assign(S, { email: session.email, repo: session.repo, sha: session.sha });
  } catch (e) {
    if (e.code === 'not_signed_in') {
      if (e.auth === 'password') return passwordView(!!password);
      return messageView(
        {
          weak_password: 'The admin password in Cloudflare is too short. Use at least 12 characters.',
          not_configured: 'Sign-in is not set up yet. Add Cloudflare Access or ADMIN_PASSWORD in Cloudflare.',
        }[e.auth] || 'You are not allowed to use the admin panel.',
      );
    }
    return messageView(errorText(e));
  }
  try {
    [S.today, S.manual, S.config] = await Promise.all([
      raw('docs/today.json'),
      raw(MANUAL_PATH, { schema_version: 1, date: '', cities: {} }),
      raw(CONFIG_PATH, { schema_version: 1, sponsored: {}, festivals: [] }),
    ]);
  } catch (e) {
    return messageView(e.message);
  }
  const who = document.getElementById('who');
  who.textContent = S.email === 'admin' ? 'Signed in' : S.email;
  who.hidden = false;
  document.getElementById('tabs').hidden = false;
  route();
}

function route() {
  const tab = (location.hash || '#rates').slice(1);
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  ({ rates: ratesView, sponsored: sponsoredView, festivals: festivalsView, status: statusView }[tab] || ratesView)();
}

window.addEventListener('hashchange', () => { if (S.sha) route(); });

function messageView(text) {
  app.innerHTML = `<div class="card login"><p class="errors">${esc(text)}</p><button id="retry">Try again</button></div>`;
  document.getElementById('retry').onclick = load;
}

function passwordView(wrong) {
  app.innerHTML = `
    <form class="card login" id="login">
      <h2>Admin sign-in</h2>
      ${wrong ? '<p class="errors">Wrong password.</p>' : ''}
      <div class="field"><label for="pw">Admin password</label><input id="pw" type="password" name="pw" autocomplete="current-password" autofocus></div>
      <button class="primary" type="submit">Sign in</button>
    </form>`;
  document.getElementById('login').onsubmit = (e) => {
    e.preventDefault();
    password = e.target.elements.pw.value;
    try { sessionStorage.setItem('admin_pw', password); } catch { /* ignore */ }
    load();
  };
}

// ---------------------------------------------------------------- rates

function manualIsActive() {
  return S.manual?.date === istDate() && Object.keys(S.manual.cities || {}).length > 0;
}

function checkRates(values) {
  for (const [field, label] of RATE_FIELDS.slice(0, 3)) {
    if (!(values[field] > 0)) return `${label} is missing`;
  }
  const r22 = values.gold_22k_1g / values.gold_24k_1g;
  const r18 = values.gold_18k_1g / values.gold_24k_1g;
  if (r22 < 0.9 || r22 > 0.93) return '22K should be about 91.6% of 24K – check for a typo';
  if (r18 < 0.72 || r18 > 0.78) return '18K should be about 75% of 24K – check for a typo';
  if (values.silver_1kg !== undefined && !(values.silver_1kg > 0)) return 'Silver must be more than 0';
  return null;
}

function bigMoves(cities) {
  const moves = [];
  for (const [id, values] of Object.entries(cities)) {
    const published = S.today.cities?.[id];
    if (!published) continue;
    for (const [field, label] of RATE_FIELDS) {
      const old = published[field];
      const now = values[field];
      if (typeof old === 'number' && typeof now === 'number' && Math.abs(now - old) / old > 0.08) {
        moves.push(`${published.name_en} ${label}: ${rupees(old)} → ${rupees(now)}`);
      }
    }
  }
  return moves;
}

function numberInput(name, value, extra = '') {
  return `<input type="number" inputmode="decimal" min="0" step="1" name="${esc(name)}" value="${value ?? ''}" ${extra}>`;
}

function ratesView() {
  const cities = cityList();
  const active = manualIsActive();
  const start = (id) => (active && S.manual.cities[id]) || S.today.cities[id] || {};
  const first = cities[0]?.id;

  const publishedRows = cities.map((c) => `
    <tr>
      <td>${esc(c.name_en)}</td>
      <td>${rupees(c.gold_24k_1g)}</td>
      <td>${rupees(c.gold_22k_1g)}</td>
      <td>${rupees(c.gold_18k_1g)}</td>
      <td>${rupees(c.silver_1kg)}</td>
      <td><span class="tag ${esc(c.source?.type)}">${esc(c.source?.type || '')}</span></td>
    </tr>`).join('');

  const perCityRows = cities.map((c) => `
    <tr>
      <td>${esc(c.name_en)}</td>
      ${RATE_FIELDS.map(([f]) => `<td>${numberInput(`${c.id}.${f}`, start(c.id)[f])}</td>`).join('')}
    </tr>`).join('');

  app.innerHTML = `
    <section class="card">
      <h2>Published now</h2>
      <p class="muted small">Last update: ${esc(istTime(S.today.updated_at))} IST · rates per gram (silver per kg)</p>
      <div class="table-wrap"><table>
        <thead><tr><th>City</th><th>24K</th><th>22K</th><th>18K</th><th>Silver</th><th>Source</th></tr></thead>
        <tbody>${publishedRows}</tbody>
      </table></div>
    </section>

    <section class="card">
      <h2>Manual rates for today (${esc(istDate())})</h2>
      ${active
        ? `<div class="notice warn">Manual rates are active for ${Object.keys(S.manual.cities).length} city(s). They replace the scraper until midnight.</div>`
        : '<p class="muted small">The scraper is in use. Enter rates here only if the scraper is wrong or not working.</p>'}
      <form id="rates-form">
        <div class="seg" role="radiogroup" aria-label="Entry mode">
          <label><input type="radio" name="mode" value="all" checked><span>Same for all cities</span></label>
          <label><input type="radio" name="mode" value="city"><span>Per city</span></label>
        </div>

        <div id="mode-all">
          <div class="grid">
            ${RATE_FIELDS.map(([f, label]) => `<div class="field"><label>${esc(label)}</label>${numberInput(`all.${f}`, first ? start(first)[f] : '')}</div>`).join('')}
          </div>
          <button type="button" id="derive">Fill 22K and 18K from 24K</button>
        </div>

        <div id="mode-city" hidden>
          <p class="muted small">Leave a whole row empty to keep the scraper's rate for that city.</p>
          <div class="table-wrap"><table>
            <thead><tr><th>City</th>${RATE_FIELDS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
            <tbody>${perCityRows}</tbody>
          </table></div>
        </div>

        <p class="errors" id="rates-error" hidden></p>
        <div class="row" style="margin-top:12px">
          <button class="primary" type="submit" id="publish">Publish to app</button>
          <span class="spacer"></span>
          ${active ? '<button type="button" class="danger" id="clear">Stop manual – use scraper</button>' : ''}
        </div>
      </form>
    </section>`;

  const form = document.getElementById('rates-form');
  const errorEl = document.getElementById('rates-error');
  const showError = (text) => { errorEl.textContent = text; errorEl.hidden = !text; };

  form.addEventListener('change', (e) => {
    if (e.target.name !== 'mode') return;
    const perCity = form.elements.mode.value === 'city';
    document.getElementById('mode-all').hidden = perCity;
    document.getElementById('mode-city').hidden = !perCity;
  });

  document.getElementById('derive').onclick = () => {
    const v24 = Number(form.elements['all.gold_24k_1g'].value);
    if (!(v24 > 0)) return showError('Enter the 24K rate first.');
    form.elements['all.gold_22k_1g'].value = Math.round(v24 * 0.916);
    form.elements['all.gold_18k_1g'].value = Math.round(v24 * 0.75);
    showError('');
  };

  const read = (prefix) => {
    const values = {};
    for (const [f] of RATE_FIELDS) {
      const text = form.elements[`${prefix}.${f}`].value.trim();
      if (text !== '') values[f] = Number(text);
    }
    return values;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    showError('');
    const result = {};
    if (form.elements.mode.value === 'all') {
      const values = read('all');
      const problem = checkRates(values);
      if (problem) return showError(problem);
      for (const c of cities) result[c.id] = values;
    } else {
      for (const c of cities) {
        const values = read(c.id);
        if (!Object.keys(values).length) continue;
        const problem = checkRates(values);
        if (problem) return showError(`${c.name_en}: ${problem}`);
        result[c.id] = values;
      }
      if (!Object.keys(result).length) return showError('Enter rates for at least one city.');
    }
    const moves = bigMoves(result);
    if (moves.length && !confirm(`These rates changed by more than 8%:\n\n${moves.join('\n')}\n\nPublish anyway?`)) return;

    await publishManual(
      { schema_version: 1, date: istDate(), cities: result },
      `Manual rates for ${Object.keys(result).length} city(s)`,
      'Saved. The app will show these rates in about 1–2 minutes.',
    );
  };

  const clear = document.getElementById('clear');
  if (clear) {
    clear.onclick = async () => {
      if (!confirm('Stop manual rates? The scraper rates will be published again.')) return;
      await publishManual(
        { schema_version: 1, date: '', cities: {} },
        'Stop manual rates',
        'Manual rates stopped. Scraper rates return in about 1–2 minutes.',
      );
    };
  }
}

async function publishManual(data, message, success) {
  const buttons = app.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  try {
    await save({ [MANUAL_PATH]: `${JSON.stringify(data, null, 2)}\n` }, message);
    S.manual = data;
    toast(success);
    ratesView();
  } catch (e) {
    buttons.forEach((b) => { b.disabled = false; });
    const el = document.getElementById('rates-error');
    el.textContent = errorText(e);
    el.hidden = false;
  }
}

// ---------------------------------------------------------------- sponsored

function sponsoredView() {
  const s = S.config.sponsored || {};
  const chosen = new Set(s.city_ids || []);
  app.innerHTML = `
    <form class="card" id="sp-form">
      <h2>Sponsored card</h2>
      <p class="muted small">Shown on the Today screen, marked "ପ୍ରାୟୋଜିତ (Sponsored)", only in the cities you pick.</p>
      <div class="field"><label><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Show the sponsored card</label></div>
      <div class="field"><label for="title_or">Title (Odia)</label><input id="title_or" type="text" name="title_or" maxlength="120" value="${esc(s.title_or)}"></div>
      <div class="field"><label for="title_en">Title (English)</label><input id="title_en" type="text" name="title_en" maxlength="120" value="${esc(s.title_en)}"></div>
      <div class="field">
        <label for="wa">WhatsApp link</label>
        <input id="wa" type="url" name="whatsapp_url" placeholder="https://wa.me/91XXXXXXXXXX?text=..." value="${esc(s.whatsapp_url)}">
        <div class="hint">Must start with https://wa.me/. This number is visible to everyone who uses the app.</div>
      </div>
      <div class="field">
        <label>Cities</label>
        <div class="checks">
          ${cityList().map((c) => `<label><input type="checkbox" name="city" value="${esc(c.id)}" ${chosen.has(c.id) ? 'checked' : ''}> ${esc(c.name_en)}</label>`).join('')}
        </div>
      </div>
      <p class="errors" id="sp-error" hidden></p>
      <button class="primary" type="submit">Save</button>
    </form>`;

  document.getElementById('sp-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const url = f.whatsapp_url.value.trim();
    const errorEl = document.getElementById('sp-error');
    if (url && !url.startsWith('https://wa.me/')) {
      errorEl.textContent = 'The WhatsApp link must start with https://wa.me/';
      errorEl.hidden = false;
      return;
    }
    const config = {
      ...S.config,
      sponsored: {
        active: f.active.checked,
        city_ids: [...e.target.querySelectorAll('input[name="city"]:checked')].map((i) => i.value),
        title_or: f.title_or.value.trim(),
        title_en: f.title_en.value.trim(),
        whatsapp_url: url,
      },
    };
    await saveConfig(config, 'Update sponsored card', errorEl);
  };
}

// ---------------------------------------------------------------- festivals

function festivalsView() {
  const rows = (S.config.festivals || []).map((f) => ({ ...f }));
  const render = () => {
    app.innerHTML = `
      <form class="card" id="fe-form">
        <h2>Buying days</h2>
        <p class="muted small">Take dates from a local panjika. Shown in the app's "ଶୁଭ ଦିନ" list.</p>
        <div id="fe-rows">
          ${rows.map((f, i) => `
            <div class="festival">
              <input type="date" name="date-${i}" value="${esc(f.date)}" aria-label="Date">
              <input type="text" name="en-${i}" value="${esc(f.name_en)}" placeholder="English name" maxlength="60" aria-label="English name">
              <input type="text" name="or-${i}" value="${esc(f.name_or)}" placeholder="ଓଡ଼ିଆ ନାମ" maxlength="60" aria-label="Odia name">
              <button type="button" class="danger" data-remove="${i}" aria-label="Remove">✕</button>
            </div>`).join('') || '<p class="muted">No buying days yet.</p>'}
        </div>
        <div class="row" style="margin-top:8px">
          <button type="button" id="fe-add">+ Add day</button>
          <span class="spacer"></span>
          <button class="primary" type="submit">Save</button>
        </div>
        <p class="errors" id="fe-error" hidden></p>
      </form>`;
    const form = document.getElementById('fe-form');
    const sync = () => rows.forEach((f, i) => {
      f.date = form.elements[`date-${i}`].value;
      f.name_en = form.elements[`en-${i}`].value.trim();
      f.name_or = form.elements[`or-${i}`].value.trim();
    });
    document.getElementById('fe-add').onclick = () => { sync(); rows.push({ date: '', name_en: '', name_or: '' }); render(); };
    form.querySelectorAll('[data-remove]').forEach((b) => {
      b.onclick = () => { sync(); rows.splice(Number(b.dataset.remove), 1); render(); };
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      sync();
      const errorEl = document.getElementById('fe-error');
      const bad = rows.findIndex((f) => !f.date || !f.name_en || !f.name_or);
      if (bad >= 0) {
        errorEl.textContent = `Row ${bad + 1} needs a date and both names.`;
        errorEl.hidden = false;
        return;
      }
      await saveConfig({ ...S.config, festivals: rows }, 'Update buying days', errorEl);
    };
  };
  render();
}

async function saveConfig(config, message, errorEl) {
  const buttons = app.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  errorEl.hidden = true;
  try {
    await save({ [CONFIG_PATH]: `${JSON.stringify(config, null, 2)}\n` }, message);
    S.config = config;
    toast('Saved. The app picks this up within a few minutes.');
  } catch (e) {
    errorEl.textContent = errorText(e);
    errorEl.hidden = false;
  }
  buttons.forEach((b) => { b.disabled = false; });
}

// ---------------------------------------------------------------- status

async function statusView() {
  const actionsUrl = `https://github.com/${S.repo}/actions/workflows/update-rates.yml`;
  app.innerHTML = `
    <section class="card">
      <h2>Rate updates</h2>
      <p class="muted small">Runs at 11:15 AM and 5:30 PM IST, and right after you publish manual rates.</p>
      <ul class="runs" id="runs"><li class="muted">Loading…</li></ul>
      <p class="small"><a href="${esc(actionsUrl)}" target="_blank" rel="noopener">Open all runs on GitHub ↗</a></p>
    </section>
    <section class="card">
      <h3>Today's data</h3>
      <p>Last published: <strong>${esc(istTime(S.today.updated_at))} IST</strong></p>
      <p>Manual rates: <strong>${manualIsActive() ? `active (${Object.keys(S.manual.cities).length} cities)` : 'not in use'}</strong></p>
    </section>`;
  const list = document.getElementById('runs');
  try {
    const res = await fetch(`https://api.github.com/repos/${S.repo}/actions/workflows/update-rates.yml/runs?per_page=8`);
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const { workflow_runs: runs = [] } = await res.json();
    const why = { schedule: 'scheduled', push: 'after manual save', workflow_dispatch: 'started by hand' };
    list.innerHTML = runs.map((r) => {
      const state = r.status !== 'completed' ? 'running' : r.conclusion === 'success' ? 'success' : 'failure';
      const label = state === 'running' ? 'running' : state === 'success' ? 'OK' : 'FAILED';
      return `<li><span class="dot ${state}"></span><a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(istTime(r.created_at))}</a> · ${esc(why[r.event] || r.event)} · <strong>${label}</strong></li>`;
    }).join('') || '<li class="muted">No runs yet.</li>';
  } catch (e) {
    list.innerHTML = `<li class="errors">Could not load runs (${esc(e.message)}).</li>`;
  }
}

load();
