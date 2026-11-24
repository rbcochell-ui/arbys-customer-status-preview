import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import {
  AAD_PREFIX, CIPHER_SCHEMA, OBSERVED_SUBSET_SCHEMA, STALE_AFTER_MS,
  decryptProject, freshnessState, validateEnvelope,
} from './crypto.mjs';
import {
  LEGACY_PILOT_HANDLE, MAX_STATUS_BYTES, PRIVATE_SOURCE_PAGES_PATH,
  readEncryptedStatus, statusAssetUrl,
} from './status-source.mjs';

const viewer = 'https://rbcochell-ui.github.io/arbys-customer-status-preview/track.html';
const inventedHandle = `p_${'a'.repeat(32)}`;
const localViewer = 'http://127.0.0.1:8818/arbys-customer-status-preview/track.html';

async function encryptedInventedStatus() {
  const key = new Uint8Array(32).fill(17);
  const nonce = new Uint8Array(12).fill(23);
  const project = {
    schema: OBSERVED_SUBSET_SCHEMA,
    slug: inventedHandle,
    customerRequestedDate: '2026-12-01',
    lastVerifiedAtUtc: '2026-11-24T01:00:00Z',
    milestones: {
      requestReceived: 'complete', dateReview: 'pending',
      workOrders: 'pending', equipmentDelivery: 'pending',
      installation: 'pending', closeout: 'pending',
    },
    visits: [],
  };
  const cryptoKey = await webcrypto.subtle.importKey('raw', key,
    'AES-GCM', false, ['encrypt']);
  const ciphertext = await webcrypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce,
    additionalData: new TextEncoder().encode(`${AAD_PREFIX}${inventedHandle}`),
    tagLength: 128,
  }, cryptoKey, new TextEncoder().encode(JSON.stringify(project)));
  return {
    key,
    envelope: {
      schema: CIPHER_SCHEMA,
      handle: inventedHandle,
      nonce: Buffer.from(nonce).toString('base64url'),
      ciphertext: Buffer.from(ciphertext).toString('base64url'),
    },
  };
}

test('issued pilot retains its exact original public status path', async () => {
  assert.equal(LEGACY_PILOT_HANDLE, 'p_d09cfd3ddbd57981ba14cc4faf423f01');
  const asset = statusAssetUrl(LEGACY_PILOT_HANDLE, viewer, 123);
  assert.equal(asset,
    `https://rbcochell-ui.github.io/arbys-customer-status-preview/data/${LEGACY_PILOT_HANDLE}.json?fresh=123`);
  const local = JSON.parse(await readFile(new URL(`./data/${LEGACY_PILOT_HANDLE}.json`,
    import.meta.url), 'utf8'));
  assert.equal(validateEnvelope(local, LEGACY_PILOT_HANDLE), local);
  const requests = [];
  const received = await readEncryptedStatus(LEGACY_PILOT_HANDLE, viewer, {
    nowMs: 123,
    fetchImpl: async (url) => {
      requests.push(url);
      return new Response(JSON.stringify(local), { status: 200 });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0], asset);
  assert.deepEqual(received, local);
});

test('the existing 24-hour source freshness boundary stays intact', () => {
  const verifiedAt = '2026-11-24T01:00:00Z';
  const verifiedMs = Date.parse(verifiedAt);
  assert.equal(freshnessState(verifiedAt, verifiedMs + STALE_AFTER_MS - 1), 'current');
  assert.equal(freshnessState(verifiedAt, verifiedMs + STALE_AFTER_MS), 'stale');
});

test('new handle uses only the same-origin private-source Pages path', () => {
  const asset = statusAssetUrl(inventedHandle, viewer, 456);
  assert.equal(asset,
    `https://rbcochell-ui.github.io${PRIVATE_SOURCE_PAGES_PATH}${inventedHandle}.json?fresh=456`);
  assert.equal(new URL(asset).origin, new URL(viewer).origin);
  assert(!asset.includes('#k='));
  assert.equal(statusAssetUrl(inventedHandle, localViewer, 456),
    `http://127.0.0.1:8818${PRIVATE_SOURCE_PAGES_PATH}${inventedHandle}.json?fresh=456`);
  assert.throws(() => statusAssetUrl('p_../../secret', viewer, 1),
    /Status file unavailable/);
});

test('new-route anonymous transport and invented AES-GCM decryption work together', async () => {
  const { key, envelope } = await encryptedInventedStatus();
  const calls = [];
  const received = await readEncryptedStatus(inventedHandle, viewer, {
    nowMs: 789,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(envelope), { status: 200 });
    },
  });
  const project = await decryptProject(received, inventedHandle, key);
  assert.equal(project.schema, OBSERVED_SUBSET_SCHEMA);
  assert.equal(project.slug, inventedHandle);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url,
    `https://rbcochell-ui.github.io${PRIVATE_SOURCE_PAGES_PATH}${inventedHandle}.json?fresh=789`);
  assert.deepEqual({ cache: calls[0].options.cache,
    credentials: calls[0].options.credentials,
    redirect: calls[0].options.redirect },
  { cache: 'no-store', credentials: 'omit', redirect: 'error' });
});

test('a revoked new status stays unavailable; no legacy fallback request occurs', async () => {
  const calls = [];
  await assert.rejects(readEncryptedStatus(inventedHandle, viewer, {
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(null, { status: 404 });
    },
  }), /Status file unavailable/);
  assert.equal(calls.length, 1);
  assert(calls[0].includes(PRIVATE_SOURCE_PAGES_PATH));
});

test('oversized bodies, redirects, and malformed JSON fail closed', async () => {
  let readCalls = 0;
  await assert.rejects(readEncryptedStatus(inventedHandle, viewer, {
    fetchImpl: async () => ({ status: 200,
      headers: { get: () => String(MAX_STATUS_BYTES + 1) },
      body: { getReader: () => { readCalls += 1; throw new Error('must not read'); } },
    }),
  }), /Status file unavailable/);
  assert.equal(readCalls, 0);
  await assert.rejects(readEncryptedStatus(inventedHandle, viewer, {
    fetchImpl: async () => new Response('x'.repeat(MAX_STATUS_BYTES + 1)),
  }), /Status file unavailable/);
  await assert.rejects(readEncryptedStatus(inventedHandle, viewer, {
    fetchImpl: async () => new Response(null, { status: 302,
      headers: { location: 'https://example.invalid/' } }),
  }), /Status file unavailable/);
  await assert.rejects(readEncryptedStatus(inventedHandle, viewer, {
    fetchImpl: async () => new Response('{not-json', { status: 200 }),
  }), /Status file unavailable/);
});
