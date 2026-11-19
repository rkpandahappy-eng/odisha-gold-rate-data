// Admin API for the Odisha Gold Rate data repository (Cloudflare Pages Function).
//
//   GET  /api/session   who is signed in + the latest commit of the data
//   POST /api/publish   save manual rates and/or app settings to GitHub in one commit
//
// Sign-in: Cloudflare Access (email code) protects /admin and /api. This code
// checks the Access token itself as well, so the API stays closed even if
// Access is switched off by mistake. Without Access settings it falls back
// to a password (ADMIN_PASSWORD), and with neither it refuses everyone.
//
// Settings (Cloudflare → Pages project → Settings → Variables and Secrets):
//   GITHUB_TOKEN        secret – fine-grained token, Contents read/write on
//                       odisha-gold-rate-data only
//   ACCESS_TEAM_DOMAIN  e.g. https://yourteam.cloudflareaccess.com
//   ACCESS_AUD          the Access application's "Application Audience" tag
//   ADMIN_EMAILS        optional, comma-separated emails allowed in
//   ADMIN_PASSWORD      secret, only if Access is not used (12+ characters)
//   GITHUB_REPO         optional, default rkpandahappy-eng/odisha-gold-rate-data
//
// Saving manual/today.json starts the "Update rates" workflow (push trigger),
// which publishes the new rates for the app within a minute or two.

const DEFAULT_REPO = 'rkpandahappy-eng/odisha-gold-rate-data';
const BRANCH = 'main';

export const MANUAL_PATH = 'manual/today.json';
export const CONFIG_PATH = 'docs/app_config.json';
const ALLOWED_FILES = new Set([MANUAL_PATH, CONFIG_PATH]);
const MAX_TEXT_BYTES = 64 * 1024;

const GOLD_FIELDS = ['gold_24k_1g', 'gold_22k_1g', 'gold_18k_1g'];
const RATE_FIELDS = [...GOLD_FIELDS, 'silver_1kg'];
const MAX_RATE = 10_000_000;

export async function onRequest(context) {
  const { request, env, params } = context;
  const route = [].concat(params.route || []).join('/');
  try {
    const user = await authenticate(request, env);
    if (!user) {
      return json({ error: 'not_signed_in', auth: authMode(env) }, 401);
    }
    if (route === 'session' && request.method === 'GET') {
      return await session(env, user);
    }
    if (route === 'publish' && request.method === 'POST') {
      checkSameOrigin(request);
      return await publish(request, env);
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    return json(
      { error: e instanceof ApiError ? e.code : 'server_error', detail: e.message, ...e.extra },
      status,
    );
  }
}

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------- sign-in

const MIN_PASSWORD = 12;

export function authMode(env) {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return 'access';
  if (env.ADMIN_PASSWORD) {
    return String(env.ADMIN_PASSWORD).length >= MIN_PASSWORD ? 'password' : 'weak_password';
  }
  return 'not_configured';
}

export async function authenticate(request, env, fetchImpl = fetch) {
  const mode = authMode(env);
  if (mode === 'access') {
    const token =
      request.headers.get('cf-access-jwt-assertion') ||
      cookie(request.headers.get('cookie'), 'CF_Authorization');
    if (!token) return null;
    const claims = await verifyAccessJwt(token, env, fetchImpl);
    if (!claims) return null;
    const email = String(claims.email || '').toLowerCase();
    const allowed = String(env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length && !allowed.includes(email)) return null;
    return { email };
  }
  if (mode === 'password') {
    const given = request.headers.get('x-admin-password') || '';
    if (await sameSecret(given, env.ADMIN_PASSWORD)) return { email: 'admin' };
    if (given) await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return null;
  }
  return null; // nothing configured: closed to everyone
}

function cookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function sameSecret(a, b) {
  // Compare hashes so the time taken doesn't reveal the password.
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0 && String(b).length > 0;
}

let certCache = { url: '', keys: [], at: 0 };

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function accessKeys(team, fetchImpl, force) {
  const url = `${team.replace(/\/$/, '')}/cdn-cgi/access/certs`;
  if (!force && certCache.url === url && Date.now() - certCache.at < 3600e3) {
    return certCache.keys;
  }
  const res = await fetchImpl(url);
  if (!res.ok) throw new ApiError(502, 'access_certs_unavailable');
  const keys = (await res.json()).keys || [];
  certCache = { url, keys, at: Date.now() };
  return keys;
}

export async function verifyAccessJwt(token, env, fetchImpl = fetch) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/\/$/, '');
  let keys = await accessKeys(team, fetchImpl, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await accessKeys(team, fetchImpl, true); // keys rotate
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
  if (claims.iss !== team) return null;
  return claims;
}

function checkSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'wrong_origin');
  }
}

// ---------------------------------------------------------------- content checks

function parseJson(text, path) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_BYTES) {
    throw new ApiError(400, 'bad_file', path);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'bad_file', `${path} is not valid JSON`);
  }
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const shortText = (v, max) => typeof v === 'string' && v.length <= max;

/** Checks manual rates and returns a clean copy. Throws ApiError on bad input. */
export function cleanManual(data) {
  if (!isObject(data) || data.schema_version !== 1) {
    throw new ApiError(400, 'bad_manual', 'schema_version must be 1');
  }
  if (!(data.date === '' || isDate(data.date))) {
    throw new ApiError(400, 'bad_manual', 'date must be YYYY-MM-DD');
  }
  if (!isObject(data.cities)) throw new ApiError(400, 'bad_manual', 'cities missing');
  const cities = {};
  for (const [id, raw] of Object.entries(data.cities)) {
    if (!/^[a-z]{2,20}$/.test(id) || !isObject(raw)) {
      throw new ApiError(400, 'bad_manual', `bad city ${id}`);
    }
    const values = {};
    for (const field of RATE_FIELDS) {
      const v = raw[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_RATE) {
        throw new ApiError(400, 'bad_manual', `${id}: bad ${field}`);
      }
      values[field] = Math.round(v);
    }
    if (!GOLD_FIELDS.every((f) => f in values)) {
      throw new ApiError(400, 'bad_manual', `${id}: 24K, 22K and 18K are all needed`);
    }
    const r22 = values.gold_22k_1g / values.gold_24k_1g;
    const r18 = values.gold_18k_1g / values.gold_24k_1g;
    if (r22 < 0.9 || r22 > 0.93) {
      throw new ApiError(400, 'bad_manual', `${id}: 22K should be about 91.6% of 24K`);
    }
    if (r18 < 0.72 || r18 > 0.78) {
      throw new ApiError(400, 'bad_manual', `${id}: 18K should be about 75% of 24K`);
    }
    cities[id] = values;
  }
  return { schema_version: 1, date: data.date, cities };
}

/** Checks app settings (sponsored card, festivals) and returns a clean copy. */
export function cleanAppConfig(data) {
  if (!isObject(data) || data.schema_version !== 1) {
    throw new ApiError(400, 'bad_config', 'schema_version must be 1');
  }
  const minVersion = data.min_supported_app_version ?? '1.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(String(minVersion))) {
    throw new ApiError(400, 'bad_config', 'min_supported_app_version must look like 1.0.0');
  }
  const s = isObject(data.sponsored) ? data.sponsored : {};
  const url = s.whatsapp_url ?? '';
  if (!(url === '' || (typeof url === 'string' && url.startsWith('https://wa.me/') && url.length <= 500))) {
    throw new ApiError(400, 'bad_config', 'WhatsApp link must start with https://wa.me/');
  }
  const cityIds = Array.isArray(s.city_ids) ? s.city_ids : [];
  if (!cityIds.every((c) => typeof c === 'string' && /^[a-z]{2,20}$/.test(c))) {
    throw new ApiError(400, 'bad_config', 'bad city list');
  }
  if (!shortText(s.title_or ?? '', 120) || !shortText(s.title_en ?? '', 120)) {
    throw new ApiError(400, 'bad_config', 'sponsored titles must be under 120 characters');
  }
  const festivals = Array.isArray(data.festivals) ? data.festivals : [];
  if (festivals.length > 50) throw new ApiError(400, 'bad_config', 'too many festivals');
  const cleanFestivals = festivals.map((f, i) => {
    if (!isObject(f) || !isDate(f.date) || !shortText(f.name_en, 60) || !shortText(f.name_or, 60) || !f.name_en || !f.name_or) {
      throw new ApiError(400, 'bad_config', `festival ${i + 1} needs a date and both names`);
    }
    return { date: f.date, name_en: f.name_en, name_or: f.name_or };
  });
  cleanFestivals.sort((a, b) => a.date.localeCompare(b.date));
  return {
    schema_version: 1,
    min_supported_app_version: String(minVersion),
    sponsored: {
      active: s.active === true,
      city_ids: [...new Set(cityIds)],
      title_or: s.title_or ?? '',
      title_en: s.title_en ?? '',
      whatsapp_url: url,
    },
    festivals: cleanFestivals,
  };
}

/** Checks a publish request; returns the files to write. */
export function checkPublishBody(body) {
  if (!isObject(body)) throw new ApiError(400, 'bad_request');
  const { base_sha, message, files } = body;
  if (!/^[0-9a-f]{40}$/.test(String(base_sha))) {
    throw new ApiError(400, 'bad_request', 'base_sha missing');
  }
  if (!isObject(files)) throw new ApiError(400, 'nothing_to_save');
  const out = [];
  for (const [path, text] of Object.entries(files)) {
    if (!ALLOWED_FILES.has(path)) throw new ApiError(400, 'file_not_allowed', path);
    const data = parseJson(text, path);
    const clean = path === MANUAL_PATH ? cleanManual(data) : cleanAppConfig(data);
    out.push({ path, content: `${JSON.stringify(clean, null, 2)}\n` });
  }
  if (!out.length) throw new ApiError(400, 'nothing_to_save');
  const text = String(message || 'Update from admin').replace(/[\r\n]+/g, ' ').slice(0, 120);
  return { baseSha: base_sha, message: text, files: out };
}

// ---------------------------------------------------------------- GitHub

function github(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) {
    throw new ApiError(503, 'github_token_missing', 'GITHUB_TOKEN is not set');
  }
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  return async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'odisha-gold-rate-admin',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(502, 'github_refused', `GitHub ${res.status}: ${text.slice(0, 200)}`);
      }
      if (res.status === 409 || res.status === 422) {
        throw new ApiError(409, 'changed_elsewhere', `GitHub ${res.status}`);
      }
      throw new ApiError(502, 'github_error', `GitHub ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };
}

async function headSha(gh) {
  const ref = await gh('GET', `/git/ref/heads/${BRANCH}`);
  return ref.object.sha;
}

async function session(env, user, fetchImpl = fetch) {
  const gh = github(env, fetchImpl);
  return json({
    email: user.email,
    repo: env.GITHUB_REPO || DEFAULT_REPO,
    branch: BRANCH,
    sha: await headSha(gh),
  });
}

export async function publish(request, env, fetchImpl = fetch) {
  const { baseSha, message, files } = checkPublishBody(await request.json());
  const gh = github(env, fetchImpl);
  const head = await headSha(gh);
  if (head !== baseSha) {
    // The rate bot commits twice a day to other files. Only refuse when one of
    // the files being saved was changed since the admin page loaded it.
    const diff = await gh('GET', `/compare/${baseSha}...${head}`);
    const changed = new Set((diff.files || []).map((f) => f.filename));
    if (files.some((f) => changed.has(f.path))) {
      throw new ApiError(409, 'changed_elsewhere', 'this file changed since it was loaded', {
        sha: head,
      });
    }
  }
  const parent = await gh('GET', `/git/commits/${head}`);
  const tree = [];
  for (const f of files) {
    const blob = await gh('POST', '/git/blobs', { content: f.content, encoding: 'utf-8' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh('POST', '/git/trees', { base_tree: parent.tree.sha, tree });
  const commit = await gh('POST', '/git/commits', {
    message: `${message}\n\nPublished from the admin panel.`,
    tree: newTree.sha,
    parents: [head],
  });
  await gh('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  return json({ sha: commit.sha, files: files.map((f) => f.path) });
}
