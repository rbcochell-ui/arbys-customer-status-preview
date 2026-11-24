/**
 * The issued pilot keeps its original public-repository file. New opaque
 * project handles read from a separate private-source, public-Pages site on
 * this same origin. A missing new file never falls back to the pilot repo.
 */
export const LEGACY_PILOT_HANDLE = 'p_d09cfd3ddbd57981ba14cc4faf423f01';
export const PRIVATE_SOURCE_PAGES_PATH = '/arbys-customer-progress-pages/data/';
export const MAX_STATUS_BYTES = 32768;

const HANDLE_RE = /^p_[0-9a-f]{32}$/;

function fail() { throw new Error('Status file unavailable'); }

export function statusAssetUrl(handle, pageHref, nowMs = Date.now()) {
  if (typeof handle !== 'string' || !HANDLE_RE.test(handle)
    || !Number.isSafeInteger(nowMs) || nowMs < 0) fail();
  let page;
  try { page = new URL(pageHref); } catch { fail(); }
  if (!['https:', 'http:'].includes(page.protocol)) fail();
  const asset = handle === LEGACY_PILOT_HANDLE
    ? new URL(`data/${handle}.json`, page)
    : new URL(`${PRIVATE_SOURCE_PAGES_PATH}${handle}.json`, page.origin);
  if (asset.origin !== page.origin) fail();
  asset.searchParams.set('fresh', String(nowMs));
  return asset.href;
}

async function boundedBody(response) {
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && length !== '') {
    if (!/^\d+$/.test(length) || Number(length) > MAX_STATUS_BYTES) fail();
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail();
      total += value.byteLength;
      if (total > MAX_STATUS_BYTES) fail();
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* The read failure is decisive. */ }
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* Already released. */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(); }
}

export async function readEncryptedStatus(handle, pageHref, {
  fetchImpl = globalThis.fetch, nowMs = Date.now(), signal,
} = {}) {
  if (typeof fetchImpl !== 'function') fail();
  const asset = statusAssetUrl(handle, pageHref, nowMs);
  let response;
  try {
    response = await fetchImpl(asset, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
    });
  } catch { fail(); }
  if (response?.status !== 200 || (response.url && response.url !== asset)) fail();
  let parsed;
  try { parsed = JSON.parse(await boundedBody(response)); } catch { fail(); }
  return parsed;
}
