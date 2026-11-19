// Tests for functions/api/[[route]].js. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  authenticate,
  authMode,
  checkPublishBody,
  cleanAppConfig,
  cleanManual,
  publish,
} from '../functions/api/[[route]].js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const GOOD_CITY = { gold_24k_1g: 13069, gold_22k_1g: 11980, gold_18k_1g: 9802, silver_1kg: 168000 };

function manual(cities = { cuttack: GOOD_CITY }, date = '2026-11-19') {
  return { schema_version: 1, date, cities };
}

test('cleanManual accepts valid rates and rounds them', () => {
  const out = cleanManual(manual({ puri: { ...GOOD_CITY, gold_24k_1g: 13069.4 } }));
  assert.equal(out.cities.puri.gold_24k_1g, 13069);
  assert.equal(out.cities.puri.silver_1kg, 168000);
});

test('cleanManual allows clearing (empty cities, empty date)', () => {
  assert.deepEqual(cleanManual(manual({}, '')), { schema_version: 1, date: '', cities: {} });
});

test('cleanManual rejects a 22K typo', () => {
  assert.throws(() => cleanManual(manual({ cuttack: { ...GOOD_CITY, gold_22k_1g: 1198 } })), ApiError);
});

test('cleanManual needs all gold purities', () => {
  const { gold_18k_1g, ...missing } = GOOD_CITY;
  assert.throws(() => cleanManual(manual({ cuttack: missing })), /18K/);
});

test('cleanManual rejects text and bad city ids', () => {
  assert.throws(() => cleanManual(manual({ cuttack: { ...GOOD_CITY, silver_1kg: '1' } })), ApiError);
  assert.throws(() => cleanManual(manual({ 'Cuttack!': GOOD_CITY })), ApiError);
});

test('cleanAppConfig keeps only known fields and sorts festivals', () => {
  const out = cleanAppConfig({
    schema_version: 1,
    sponsored: { active: true, city_ids: ['puri', 'puri'], title_en: 'Hi', title_or: 'ନମସ୍କାର', whatsapp_url: 'https://wa.me/911234567890', extra: 1 },
    festivals: [
      { date: '2027-10-29', name_en: 'Dhanteras', name_or: 'ଧନତେରସ' },
      { date: '2027-04-19', name_en: 'Akshaya Tritiya', name_or: 'ଅକ୍ଷୟ ତୃତୀୟା' },
    ],
  });
  assert.deepEqual(out.sponsored.city_ids, ['puri']);
  assert.equal(out.sponsored.extra, undefined);
  assert.equal(out.festivals[0].name_en, 'Akshaya Tritiya');
});

test('cleanAppConfig rejects non-WhatsApp links', () => {
  assert.throws(
    () => cleanAppConfig({ schema_version: 1, sponsored: { whatsapp_url: 'https://evil.example' } }),
    /wa\.me/,
  );
});

test('checkPublishBody only allows the two admin files', () => {
  assert.throws(
    () => checkPublishBody({ base_sha: SHA_A, files: { 'docs/today.json': '{}' } }),
    /docs\/today\.json/,
  );
  const ok = checkPublishBody({ base_sha: SHA_A, files: { 'manual/today.json': JSON.stringify(manual()) } });
  assert.equal(ok.files[0].path, 'manual/today.json');
  assert.ok(ok.files[0].content.endsWith('\n'));
});

test('password sign-in needs 12+ characters and the right password', async () => {
  assert.equal(authMode({ ADMIN_PASSWORD: 'short' }), 'weak_password');
  assert.equal(authMode({}), 'not_configured');
  const env = { ADMIN_PASSWORD: 'a-long-enough-password' };
  const req = (pw) => new Request('https://x/api/session', { headers: pw ? { 'x-admin-password': pw } : {} });
  assert.deepEqual(await authenticate(req('a-long-enough-password'), env), { email: 'admin' });
  assert.equal(await authenticate(req(''), env), null);
  assert.equal(await authenticate(req(''), {}), null);
});

function fakeGitHub({ head, changedFiles = [] }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    calls.push(`${init.method} ${path}`);
    const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (path === '/git/ref/heads/main') return ok({ object: { sha: head } });
    if (path.startsWith('/compare/')) return ok({ files: changedFiles.map((filename) => ({ filename })) });
    if (path.startsWith('/git/commits/') && init.method === 'GET') return ok({ tree: { sha: 't0' } });
    if (path === '/git/blobs') return ok({ sha: 'blob1' });
    if (path === '/git/trees') return ok({ sha: 't1' });
    if (path === '/git/commits') return ok({ sha: SHA_B });
    if (path === '/git/refs/heads/main') return ok({});
    return new Response('not found', { status: 404 });
  };
  return { calls, fetchImpl };
}

function publishRequest(baseSha) {
  return new Request('https://x/api/publish', {
    method: 'POST',
    body: JSON.stringify({ base_sha: baseSha, files: { 'manual/today.json': JSON.stringify(manual()) } }),
  });
}

test('publish commits when only other files changed since loading', async () => {
  const gh = fakeGitHub({ head: SHA_B, changedFiles: ['docs/today.json', 'docs/history.json'] });
  const res = await publish(publishRequest(SHA_A), { GITHUB_TOKEN: 't' }, gh.fetchImpl);
  assert.equal(res.status, 200);
  assert.ok(gh.calls.includes('PATCH /git/refs/heads/main'));
});

test('publish refuses when the same file changed since loading', async () => {
  const gh = fakeGitHub({ head: SHA_B, changedFiles: ['manual/today.json'] });
  await assert.rejects(publish(publishRequest(SHA_A), { GITHUB_TOKEN: 't' }, gh.fetchImpl), /changed/);
  assert.ok(!gh.calls.includes('PATCH /git/refs/heads/main'));
});

test('publish needs the GitHub key', async () => {
  await assert.rejects(publish(publishRequest(SHA_A), {}), /GITHUB_TOKEN/);
});
