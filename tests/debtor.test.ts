import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findToken, unwrapRecord } from '../lib/fc-response';
import { scoreDebtor } from '../lib/matching';

const ACME = { id: 'a3', companyName: 'Acme Manufacturing LLC', phone: '3343770535', ein: '987654321' };

test('debtor matched by EIN, exact name, or phone plus similar name', () => {
  assert.equal(scoreDebtor({ name: 'Something else', ein: '98-7654321', phone: null }, ACME)?.method, 'EIN');
  assert.equal(scoreDebtor({ name: 'ACME MANUFACTURING, L.L.C.', ein: null, phone: null }, ACME)?.method, 'Exact name');
  assert.equal(scoreDebtor({ name: 'Acme Mfg LLC', ein: null, phone: null }, ACME)?.method, 'Exact name');
  assert.equal(scoreDebtor({ name: 'Acme Manufacturing of Texas', ein: null, phone: '+1 334 377 0535' }, ACME)?.method, 'Phone + similar name');
  assert.equal(scoreDebtor({ name: 'Globex Corporation', ein: null, phone: null }, ACME), null);
});

test('records and tokens are found inside response envelopes', () => {
  assert.equal(unwrapRecord({ status: 'SUCCESS', code: 201, data: { id: 'inv1', invoiceNumber: 'T' } })?.id, 'inv1');
  assert.equal(unwrapRecord({ invoice: { id: 'inv2' } }, ['invoice'])?.id, 'inv2');
  assert.equal(unwrapRecord({ id: 'top' })?.id, 'top');
  assert.equal(findToken({ data: { accessToken: 'abc' } }), 'abc');
  assert.equal(findToken({ token: 'xyz' }), 'xyz');
});
