/**
 * Self-check for tip amounts — the one rule standing between a viewer's typing and
 * a card charge.
 *
 * Run: npm run test:tips
 *
 * `src/lib/tips.ts` has no imports precisely so this can run under plain
 * `node --experimental-strip-types`, which resolves neither the `@/` alias nor React.
 */
import assert from 'node:assert/strict'
import {
  TIP_MAX_CENTS,
  TIP_MIN_CENTS,
  TIP_PRESETS_CENTS,
  parseTipAmount,
} from '../src/lib/tips.ts'

// Ordinary amounts, in both the forms a currency field invites.
assert.equal(parseTipAmount('5'), 500)
assert.equal(parseTipAmount('5.00'), 500)
assert.equal(parseTipAmount('4.20'), 420)
assert.equal(parseTipAmount(' 10 '), 1000)

// The bounds themselves are inclusive.
assert.equal(parseTipAmount('0.50'), TIP_MIN_CENTS)
assert.equal(parseTipAmount('5000'), TIP_MAX_CENTS)

// Below Stripe's floor and above our ceiling: rejected, not clamped. Clamping would
// charge an amount the viewer never agreed to.
assert.equal(parseTipAmount('0.49'), null)
assert.equal(parseTipAmount('0'), null)
assert.equal(parseTipAmount('5000.01'), null)

// Rounding must not sneak a sub-minimum amount through: 0.499 rounds to 50 cents by
// arithmetic alone, so the bound is re-checked after rounding, not before.
assert.equal(parseTipAmount('0.499'), null)

// Not amounts at all.
for (const junk of ['', '   ', 'abc', '-5', '1e3', '5.', '.5', '5.123', '1,000', 'Infinity']) {
  assert.equal(parseTipAmount(junk), null, junk)
}

// Every preset the dialog offers must be an amount the server will accept —
// otherwise a one-tap button produces a rejection the viewer cannot explain.
for (const preset of TIP_PRESETS_CENTS) {
  assert.ok(Number.isInteger(preset), String(preset))
  assert.ok(preset >= TIP_MIN_CENTS && preset <= TIP_MAX_CENTS, String(preset))
  assert.equal(parseTipAmount((preset / 100).toFixed(2)), preset)
}

console.log('tips: all checks passed')
