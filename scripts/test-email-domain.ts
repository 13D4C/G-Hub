import assert from 'node:assert/strict'
import { ALLOWED_EMAIL_DOMAIN, isAllowedEmail } from '../src/lib/email-domain.ts'

assert.equal(ALLOWED_EMAIL_DOMAIN, 'kmitl.ac.th')

for (const email of [
  '66010001@kmitl.ac.th',
  'somchai.ja@kmitl.ac.th',
  '  66010001@kmitl.ac.th  ',
  '66010001@KMITL.AC.TH',
  '66010001@Kmitl.Ac.Th',
]) {
  assert.equal(isAllowedEmail(email), true, `should accept ${JSON.stringify(email)}`)
}

for (const email of [
  'someone@gmail.com',
  'someone@kmitl.ac.th.evil.com',
  'someone@notkmitl.ac.th',
  'someone@fake-kmitl.ac.th',
  'someone@mail.kmitl.ac.th',
  'someone@kmitl.ac.th2',
  'kmitl.ac.th',
  '@kmitl.ac.th',
  'a@b@kmitl.ac.th',
  '',
  null,
  undefined,
]) {
  assert.equal(isAllowedEmail(email), false, `should reject ${JSON.stringify(email)}`)
}

console.log('email domain: all assertions passed')
