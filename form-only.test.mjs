import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import {
  AAD_PREFIX, CIPHER_SCHEMA, FORM_ONLY_SCHEMA, decryptProject, validateProject,
} from './crypto.mjs';
import { PRIVATE_SOURCE_PAGES_PATH, readEncryptedStatus } from './status-source.mjs';

const handle = `p_${'a'.repeat(32)}`;
const viewer = 'https://rbcochell-ui.github.io/arbys-customer-status-preview/track.html';

function formOnlyProject() {
  return {
    schema: FORM_ONLY_SCHEMA,
    slug: handle,
    customerRequestedDate: '2026-12-01',
    lastVerifiedAtUtc: '2026-11-24T01:12:27Z',
    milestones: {
      requestReceived: 'complete', dateReview: 'pending', workOrders: 'pending',
      equipmentDelivery: 'pending', installation: 'pending', closeout: 'pending',
    },
    visits: [],
  };
}

test('FORM-only status cannot claim a work order or completed later phase', () => {
  assert.equal(validateProject(formOnlyProject()).schema, FORM_ONLY_SCHEMA);
  const withWorkOrder = formOnlyProject();
  withWorkOrder.visits.push({ ref: 'v_aaaaaaaaaaaa', visitType: 'Install', observedStatus: 'Scheduled' });
  assert.throws(() => validateProject(withWorkOrder), /FORM-only/);
  for (const phase of ['dateReview', 'workOrders', 'equipmentDelivery', 'installation', 'closeout']) {
    const promoted = formOnlyProject();
    promoted.milestones[phase] = 'complete';
    assert.throws(() => validateProject(promoted), /FORM-only/);
  }
});

test('a new FORM-only handle decrypts from the sibling Pages path without exposing its key', async () => {
  const key = new Uint8Array(32).fill(17);
  const nonce = new Uint8Array(12).fill(23);
  const cryptoKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await webcrypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce,
    additionalData: new TextEncoder().encode(`${AAD_PREFIX}${handle}`),
    tagLength: 128,
  }, cryptoKey, new TextEncoder().encode(JSON.stringify(formOnlyProject())));
  const envelope = {
    schema: CIPHER_SCHEMA, handle,
    nonce: Buffer.from(nonce).toString('base64url'),
    ciphertext: Buffer.from(ciphertext).toString('base64url'),
  };
  const calls = [];
  const received = await readEncryptedStatus(handle, viewer, {
    nowMs: 123,
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(envelope), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `https://rbcochell-ui.github.io${PRIVATE_SOURCE_PAGES_PATH}${handle}.json?fresh=123`);
  assert(!calls[0].includes(Buffer.from(key).toString('base64url')));
  assert.equal((await decryptProject(received, handle, key)).schema, FORM_ONLY_SCHEMA);
});
