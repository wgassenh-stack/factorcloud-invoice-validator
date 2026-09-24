import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeCompanyName,
  normalizeDate,
  normalizeMoney,
  normalizePhone,
  normalizeState,
  normalizeStreet,
  normalizeZip,
} from '../lib/normalize';

test('phones compare as digits without the US country code', () => {
  assert.equal(normalizePhone('+13343770535'), '3343770535');
  assert.equal(normalizePhone('(334) 377-0535'), '3343770535');
  assert.equal(normalizePhone('334.377.0535'), '3343770535');
});

test('money parses currency strings', () => {
  assert.equal(normalizeMoney('$12,500.00'), 12500);
  assert.equal(normalizeMoney(10000), 10000);
  assert.equal(normalizeMoney('(25.10)'), -25.1);
  assert.equal(normalizeMoney('n/a'), null);
});

test('dates become YYYY-MM-DD', () => {
  assert.equal(normalizeDate('09/24/2026'), '2026-09-24');
  assert.equal(normalizeDate('2026-09-24T00:00:00Z'), '2026-09-24');
  assert.equal(normalizeDate('9/4/26'), '2026-09-04');
  assert.equal(normalizeDate('September 24, 2026'), '2026-09-24');
  assert.equal(normalizeDate('not a date'), '');
});

test('company names ignore case, punctuation and legal suffixes', () => {
  assert.equal(normalizeCompanyName('ACME Manufacturing, L.L.C.'), 'acme manufacturing');
  assert.equal(normalizeCompanyName('Acme Manufacturing LLC'), 'acme manufacturing');
  assert.equal(normalizeCompanyName("Will's Test Trucking LLC"), 'wills test trucking');
  assert.equal(normalizeCompanyName('Smith & Sons, Inc.'), 'smith and sons');
});

test('street addresses use USPS abbreviations', () => {
  assert.equal(normalizeStreet('1234 Testing Lane'), normalizeStreet('1234 testing ln.'));
  assert.equal(normalizeStreet('100 North Main Street, Suite 5'), '100 n main st ste 5');
});

test('states and ZIPs', () => {
  assert.equal(normalizeState('Texas'), 'TX');
  assert.equal(normalizeState('tx'), 'TX');
  assert.equal(normalizeZip('75205-1234'), '75205');
});
