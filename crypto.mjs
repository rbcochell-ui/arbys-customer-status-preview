export const CIPHER_SCHEMA = 'arbys-customer-cipher/v1';
export const LEGACY_PROJECT_SCHEMA = 'arbys-customer-status/v1';
export const PROJECT_SCHEMA = 'arbys-customer-status/v2';
export const ROSTER_PROJECT_SCHEMA = 'arbys-customer-status/roster-v1';
export const OBSERVED_SUBSET_SCHEMA = 'arbys-customer-status/observed-v2';
export const AAD_PREFIX = 'arbys-customer-status/v1:';
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const HANDLE_RE = /^p_[0-9a-f]{32}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const VISIT_REF_RE = /^v_[0-9a-f]{12}$/;
const VISIT_TYPES = new Set(['Survey', 'LineRun', 'Install', 'FireUp', 'Other', 'Undefined']);
const VISIT_PROGRESS = new Set(['notConfirmed', 'scheduled', 'inProgress', 'complete', 'cancelled']);
const OBSERVED_STATES = new Set([
  'PendingSchedule', 'PendingReadiness', 'Open', 'Scheduled',
  'InProgress', 'PendingCloseout', 'Completed', 'Closed', 'Cancelled', 'NeedsReview',
]);
const ACTIVE_OBSERVED_STATES = new Set([
  'PendingSchedule', 'PendingReadiness', 'Open', 'Scheduled', 'InProgress', 'PendingCloseout',
]);
export const PHASES = Object.freeze([
  ['requestReceived', 'Request received', 'Your request is in our workstream.'],
  ['dateReview', 'Date review', 'We are checking the service date with the provider and your team.'],
  ['workOrders', 'Work orders', 'At least one linked work order still has an active status in Thirsty.'],
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

// A completed or canceled visit does not prove that the entire work-order plan is complete.
export function rosterWorkOrdersPhase(visits) {
  return visits.some((visit) => ACTIVE_OBSERVED_STATES.has(visit.observedStatus))
    ? 'inProgress' : 'pending';
}

export function validateProject(value) {
  const roster = value?.schema === ROSTER_PROJECT_SCHEMA;
  const observedSubset = value?.schema === OBSERVED_SUBSET_SCHEMA;
  if (roster || observedSubset) {
    if (!exactKeys(value, ['schema', 'slug', 'customerRequestedDate', 'lastVerifiedAtUtc', 'milestones', 'visits'])
      || !HANDLE_RE.test(value.slug) || !validDate(value.customerRequestedDate, true)
      || !validUtc(value.lastVerifiedAtUtc)) {
      throw new Error('Customer work-order view shape or identity is invalid');
    }
    if (!exactKeys(value.milestones, PHASE_IDS)
      || value.milestones.requestReceived !== 'complete'
      || ['dateReview', 'equipmentDelivery', 'installation', 'closeout']
        .some((id) => value.milestones[id] !== 'pending')
      || (observedSubset && value.milestones.workOrders !== 'pending')) {
      throw new Error('Work-order view cannot promote unverified project phases');
    }
    if (!Array.isArray(value.visits) || value.visits.length > 64) {
      throw new Error('Work-order visits are invalid');
    }
    const refs = new Set();
    for (const visit of value.visits) {
      if (!exactKeys(visit, ['ref', 'visitType', 'observedStatus'])
        || !VISIT_REF_RE.test(visit.ref) || !VISIT_TYPES.has(visit.visitType)
        || !OBSERVED_STATES.has(visit.observedStatus) || refs.has(visit.ref)) {
        throw new Error('Work-order visit is invalid or repeated');
      }
      refs.add(visit.ref);
    }
    if (roster && value.milestones.workOrders !== rosterWorkOrdersPhase(value.visits)) {
      throw new Error('Roster visits and work-order phase disagree');
    }
    return value;
  }
  const legacy = value?.schema === LEGACY_PROJECT_SCHEMA;
  const fields = ['schema', 'slug', 'customerRequestedDate', 'confirmedInstallDate', 'lastVerifiedAtUtc', 'milestones'];
  if (!legacy) fields.push('visits');
  if (!exactKeys(value, fields)) {
    throw new Error('Customer status has an unexpected shape');
  }
  if (![LEGACY_PROJECT_SCHEMA, PROJECT_SCHEMA].includes(value.schema) || !HANDLE_RE.test(value.slug)) {
    throw new Error('Customer status identity is invalid');
  }
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
  if (!legacy) {
    if (!Array.isArray(value.visits) || value.visits.length > 64) {
      throw new Error('Customer visits must be a bounded array');
    }
    const refs = new Set();
    for (const visit of value.visits) {
      if (!exactKeys(visit, ['ref', 'visitType', 'progress'])
        || !VISIT_REF_RE.test(visit.ref)
        || !VISIT_TYPES.has(visit.visitType)
        || !VISIT_PROGRESS.has(visit.progress)
        || refs.has(visit.ref)) {
        throw new Error('Customer visit is invalid or repeated');
      }
      refs.add(visit.ref);
    }
    const onSiteVisits = value.visits.filter((visit) => ['Install', 'FireUp'].includes(visit.visitType));
    if (value.milestones.workOrders !== 'pending' && value.visits.length === 0) {
      throw new Error('Active work-order phase needs a verified visit roster');
    }
    if (value.milestones.workOrders === 'pending' && value.visits.length > 0) {
      throw new Error('Published visits need an active work-order phase');
    }
    if (value.milestones.workOrders === 'complete'
      && (value.visits.some((visit) => visit.visitType === 'Undefined')
        || onSiteVisits.length === 0
        || onSiteVisits.some((visit) => visit.progress === 'cancelled'))) {
      throw new Error('Complete work-order plan needs defined active on-site visits');
    }
    if (value.confirmedInstallDate === null
      && onSiteVisits.some((visit) => ['inProgress', 'complete'].includes(visit.progress))) {
      throw new Error('Installation visit needs a confirmed installation date');
    }
    if (onSiteVisits.some((visit) => ['inProgress', 'complete'].includes(visit.progress))
      && (value.milestones.workOrders !== 'complete' || value.milestones.installation === 'pending')) {
      throw new Error('Active installation visit needs a confirmed work-order plan and installation phase');
    }
    if (value.milestones.installation === 'inProgress'
      && !onSiteVisits.some((visit) => ['inProgress', 'complete'].includes(visit.progress))) {
      throw new Error('In-progress installation needs an active on-site visit');
    }
    if (value.milestones.installation === 'complete'
      && (onSiteVisits.length === 0 || onSiteVisits.some((visit) => visit.progress !== 'complete'))) {
      throw new Error('Installation phase conflicts with an unfinished installation visit');
    }
    if (value.milestones.installation === 'complete'
      && (value.milestones.workOrders !== 'complete' || value.milestones.equipmentDelivery !== 'complete')) {
      throw new Error('Installation completion needs verified work-order and equipment plans');
    }
    if (value.milestones.closeout === 'complete'
      && value.visits.some((visit) => visit.progress !== 'complete')) {
      throw new Error('Closeout phase conflicts with an unfinished visit');
    }
  }
  return value;
}

export function freshnessState(lastVerifiedAtUtc, nowMs = Date.now()) {
  const capturedMs = Date.parse(lastVerifiedAtUtc);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(nowMs)
    || capturedMs - nowMs > FUTURE_SKEW_MS) return 'clockMismatch';
  return nowMs - capturedMs >= STALE_AFTER_MS ? 'stale' : 'current';
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
