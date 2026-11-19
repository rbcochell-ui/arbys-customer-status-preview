export const CIPHER_SCHEMA = 'arbys-customer-cipher/v1';
export const PROJECT_SCHEMA = 'arbys-customer-status/v1';
export const AAD_PREFIX = 'arbys-customer-status/v1:';

const HANDLE_RE = /^p_[0-9a-f]{32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const PHASES = Object.freeze([
  ['requestReceived', 'Request received', 'Your request is in our workstream.'],
  ['dateReview', 'Date review', 'We are checking the service date with the provider and your team.'],
  ['workOrders', 'Work orders', 'The field visits needed for this request are being arranged.'],
  ['equipmentDelivery', 'Equipment and delivery', 'Equipment and delivery readiness are being checked.'],
  ['installation', 'Installation', 'The scheduled field work is being carried out.'],
  ['closeout', 'Closeout', 'The final work and records are being checked.'],
]);
const PHASE_IDS = PHASES.map(([id]) => id);
const STATUSES = new Set(['complete', 'inProgress', 'pending']);

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validDate(value, nullable = false) {
  if (value === null && nullable) return true;
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validUtc(value) {
  if (typeof value !== 'string' || !UTC_RE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace('.000Z', 'Z') === value;
}

export function validateProject(value) {
  if (!exactKeys(value, ['schema', 'slug', 'customerRequestedDate', 'confirmedInstallDate', 'lastVerifiedAtUtc', 'milestones'])) {
    throw new Error('Customer status has an unexpected shape');
  }
  if (value.schema !== PROJECT_SCHEMA || !HANDLE_RE.test(value.slug)) throw new Error('Customer status identity is invalid');
  if (!validDate(value.customerRequestedDate, true) || !validDate(value.confirmedInstallDate, true)
    || !validUtc(value.lastVerifiedAtUtc)) throw new Error('Customer status dates are invalid');
  if (!exactKeys(value.milestones, PHASE_IDS)
    || PHASE_IDS.some((id) => !STATUSES.has(value.milestones[id]))) {
    throw new Error('Customer status milestones are invalid');
  }
  if (value.milestones.requestReceived !== 'complete') throw new Error('Request receipt is unverified');
  if ((value.milestones.dateReview === 'complete') !== (value.confirmedInstallDate !== null)) {
    throw new Error('Confirmed date and date review disagree');
  }
  if (value.confirmedInstallDate === null && ['inProgress', 'complete'].includes(value.milestones.installation)) {
    throw new Error('Installation needs a confirmed date');
  }
  if (value.milestones.closeout === 'complete' && value.milestones.installation !== 'complete') {
    throw new Error('Closeout needs completed installation');
  }
  return value;
}

export function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== value) throw new Error('Invalid encoding');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function parseCapabilityLocation(locationLike) {
  const url = new URL(locationLike.href);
  const query = [...url.searchParams.entries()];
  const fragment = [...new URLSearchParams(url.hash.slice(1)).entries()];
  if (query.length !== 1 || query[0][0] !== 'p' || !HANDLE_RE.test(query[0][1])
    || fragment.length !== 1 || fragment[0][0] !== 'k' || !KEY_RE.test(fragment[0][1])) {
    throw new Error('Invalid customer link');
  }
  const key = decodeBase64Url(fragment[0][1]);
  if (key.length !== 32) throw new Error('Invalid customer link key');
  return { handle: query[0][1], key };
}

export function validateEnvelope(value, handle) {
  if (!exactKeys(value, ['schema', 'handle', 'nonce', 'ciphertext'])
    || value.schema !== CIPHER_SCHEMA || value.handle !== handle
    || !HANDLE_RE.test(value.handle) || !NONCE_RE.test(value.nonce)
    || typeof value.ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.ciphertext)) {
    throw new Error('Encrypted status is invalid');
  }
  if (decodeBase64Url(value.nonce).length !== 12 || decodeBase64Url(value.ciphertext).length < 17) {
    throw new Error('Encrypted status is invalid');
  }
  return value;
}

export async function decryptProject(envelope, handle, keyBytes) {
  validateEnvelope(envelope, handle);
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) throw new Error('Invalid customer link key');
  const key = await globalThis.crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await globalThis.crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: decodeBase64Url(envelope.nonce),
    additionalData: new TextEncoder().encode(`${AAD_PREFIX}${handle}`),
    tagLength: 128,
  }, key, decodeBase64Url(envelope.ciphertext));
  const project = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  validateProject(project);
  if (project.slug !== handle) throw new Error('Customer status identity changed');
  return project;
}
