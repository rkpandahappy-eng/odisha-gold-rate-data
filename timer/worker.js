// Cloudflare Worker: a reliable timer for the "Update rates" GitHub workflow.
//
// GitHub's own schedule often runs hours late, so this Worker (cron "*/5 * * * *")
// asks GitHub to run the workflow:
//   10:00 AM - 3:00 PM IST  every 5 minutes, until today's new price is published
//    3:00 PM - 9:00 PM IST  every 30 minutes (catches a second change in the day)
//
// Setup (Cloudflare dashboard): paste this file as the Worker code, add the secret
// GH_TOKEN (fine-grained GitHub token: this repo only, Actions = Read and write),
// and add one cron trigger: */5 * * * *

const REPO = 'rkpandahappy-eng/odisha-gold-rate-data';
const WORKFLOW = 'update-rates.yml';
const TODAY_URL = 'https://rkpandahappy-eng.github.io/odisha-gold-rate-data/today.json';
const IST_OFFSET_MIN = 330;
const GOLD_FIELDS = ['gold_24k_1g', 'gold_22k_1g', 'gold_18k_1g'];

/** IST date ("YYYY-MM-DD") and minutes since IST midnight for a UTC time. */
export function istClock(nowMs) {
  const ist = new Date(nowMs + IST_OFFSET_MIN * 60000);
  return {
    date: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

/** Which window this tick falls in: "fast", "slow" or null (do nothing). */
export function windowFor(minutes) {
  if (minutes >= 10 * 60 && minutes < 15 * 60) return 'fast';
  if (minutes >= 15 * 60 && minutes <= 21 * 60 && minutes % 30 < 5) return 'slow';
  return null;
}

/** True when the published data already has a new price from today. */
export function newPriceFound(todayDoc, istDate) {
  if (!todayDoc || typeof todayDoc.updated_at !== 'string') return false;
  if (!todayDoc.updated_at.startsWith(istDate)) return false;
  const cities = Object.values(todayDoc.cities || {});
  return cities.some((city) =>
    GOLD_FIELDS.some((field) => {
      const change = city?.change?.[field];
      return typeof change === 'number' && change !== 0;
    }),
  );
}

/** Decide what to do for one tick. Returns { run: boolean, reason: string }. */
export function decide(nowMs, todayDoc) {
  const { date, minutes } = istClock(nowMs);
  const window = windowFor(minutes);
  if (!window) return { run: false, reason: 'outside the checking hours' };
  if (window === 'fast' && newPriceFound(todayDoc, date)) {
    return { run: false, reason: "today's new price is already published" };
  }
  return { run: true, reason: `${window} check` };
}

async function loadToday() {
  try {
    const response = await fetch(`${TODAY_URL}?t=${Date.now()}`, {
      cf: { cacheTtl: 0 },
      headers: { 'Cache-Control': 'no-cache' },
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null; // If the data can't be read, run the update anyway.
  }
}

async function startWorkflow(token) {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'odisha-gold-rate-timer',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    },
  );
  if (response.status !== 204) {
    throw new Error(`GitHub answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

export default {
  async scheduled(event, env) {
    const nowMs = event.scheduledTime ?? Date.now();
    const { minutes } = istClock(nowMs);
    // Only read today.json inside the fast window, where it decides whether to stop.
    const todayDoc = windowFor(minutes) === 'fast' ? await loadToday() : null;
    const decision = decide(nowMs, todayDoc);
    console.log(`timer: ${decision.run ? 'run' : 'skip'} (${decision.reason})`);
    if (!decision.run) return;
    if (!env.GH_TOKEN) throw new Error('GH_TOKEN secret is not set');
    await startWorkflow(env.GH_TOKEN);
    console.log('timer: update started');
  },

  async fetch() {
    return new Response('Odisha Gold Rate timer is running.\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};
