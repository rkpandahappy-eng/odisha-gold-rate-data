// Tests for timer/worker.js. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, istClock, newPriceFound, windowFor } from '../timer/worker.js';

// Helper: a UTC timestamp for an IST wall-clock time on 2026-11-26.
const ist = (h, m) => Date.UTC(2026, 10, 26, h, m) - 330 * 60000;

const doc = (updatedAt, change22) => ({
  updated_at: updatedAt,
  cities: {
    cuttack: { change: { gold_24k_1g: change22, gold_22k_1g: change22, gold_18k_1g: change22 } },
  },
});

test('IST clock', () => {
  assert.deepEqual(istClock(ist(10, 5)), { date: '2026-11-26', minutes: 605 });
  assert.deepEqual(istClock(ist(0, 10)), { date: '2026-11-26', minutes: 10 });
});

test('windows', () => {
  assert.equal(windowFor(9 * 60 + 55), null);
  assert.equal(windowFor(10 * 60), 'fast');
  assert.equal(windowFor(14 * 60 + 55), 'fast');
  assert.equal(windowFor(15 * 60), 'slow');
  assert.equal(windowFor(15 * 60 + 5), null);
  assert.equal(windowFor(15 * 60 + 30), 'slow');
  assert.equal(windowFor(21 * 60), 'slow');
  assert.equal(windowFor(21 * 60 + 30), null);
});

test('new price found only for today with a real change', () => {
  assert.equal(newPriceFound(doc('2026-11-26T10:31:00+05:30', 240), '2026-11-26'), true);
  assert.equal(newPriceFound(doc('2026-11-26T07:16:00+05:30', 0), '2026-11-26'), false);
  assert.equal(newPriceFound(doc('2026-11-25T18:18:00+05:30', 240), '2026-11-26'), false);
  assert.equal(newPriceFound(null, '2026-11-26'), false);
});

test('fast window runs until the new price is published, then stops', () => {
  assert.equal(decide(ist(10, 0), doc('2026-11-26T07:16:00+05:30', 0)).run, true);
  assert.equal(decide(ist(10, 40), doc('2026-11-26T10:36:00+05:30', 240)).run, false);
  assert.equal(decide(ist(10, 0), null).run, true);
});

test('afternoon checks run every 30 minutes even after a change', () => {
  const changed = doc('2026-11-26T10:36:00+05:30', 240);
  assert.equal(decide(ist(15, 30), changed).run, true);
  assert.equal(decide(ist(15, 35), changed).run, false);
});

test('night does nothing', () => {
  assert.equal(decide(ist(23, 0), null).run, false);
  assert.equal(decide(ist(6, 0), null).run, false);
});
