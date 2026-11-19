import { PHASES, decryptProject, freshnessState, parseCapabilityLocation } from './crypto.mjs?v=3';

const loading = document.getElementById('loading');
const unavailable = document.getElementById('unavailable');
const projectArea = document.getElementById('project');
const phaseList = document.getElementById('milestone-list');
const visitList = document.getElementById('visit-list');
const visitEmpty = document.getElementById('visit-empty');
const freshnessWarning = document.getElementById('freshness-warning');
const VISIT_NAMES = Object.freeze({
  Survey: 'Survey', LineRun: 'Line run', Install: 'Installation', FireUp: 'Fire up',
  Other: 'Other service visit', Undefined: 'Visit type not confirmed',
});
const VISIT_PROGRESS = Object.freeze({
  notConfirmed: ['Status not confirmed', 'The next work-order update has not been verified.'],
  scheduled: ['Scheduled', 'The service workstream marks this visit scheduled. Plans can change.'],
  inProgress: ['In progress', 'The service workstream marks this visit in progress.'],
  complete: ['Complete', 'The service workstream marks this visit complete.'],
  cancelled: ['Canceled', 'This visit was canceled in the service workstream.'],
});
const COMPLETE_PHASE_COPY = Object.freeze({
  requestReceived: 'Your request has been received.',
  dateReview: 'The installation date has been confirmed.',
  workOrders: 'The work-order plan has been verified.',
  equipmentDelivery: 'The equipment and delivery plan has been verified.',
  installation: 'The planned field work is marked complete.',
  closeout: 'The final work and records are marked complete.',
});
const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
});
let currentLoad = 0;
let activeFetch;

function show(which) {
  loading.hidden = which !== 'loading';
  unavailable.hidden = which !== 'unavailable';
  projectArea.hidden = which !== 'project';
  if (which !== 'project') {
    phaseList.replaceChildren();
    visitList.replaceChildren();
    visitEmpty.hidden = true;
    freshnessWarning.hidden = true;
  }
}

function displayDate(date) {
  return date ? dateFormat.format(new Date(`${date}T00:00:00Z`)) : 'Not confirmed yet';
}

function phaseStatus(status) {
  return status === 'complete' ? 'Complete' : status === 'inProgress' ? 'In progress' : 'Not confirmed';
}

function renderFreshness(verifiedAtUtc) {
  const state = freshnessState(verifiedAtUtc);
  freshnessWarning.dataset.state = state;
  freshnessWarning.hidden = state === 'current';
  if (state === 'stale') {
    document.getElementById('freshness-title').textContent = 'Updates delayed';
    document.getElementById('freshness-copy').textContent =
      'This is the last verified snapshot and may not reflect recent service changes. Please reply to the email that shared this link for a current update.';
  } else if (state === 'clockMismatch') {
    document.getElementById('freshness-title').textContent = 'Verification time needs review';
    document.getElementById('freshness-copy').textContent =
      'Your device time and the source verification time do not agree. Please reply to the email that shared this link for a current update.';
  }
}

function renderVisits(project) {
  const visits = project.visits;
  visitEmpty.hidden = Array.isArray(visits) && visits.length > 0;
  visitEmpty.textContent = visitEmpty.hidden ? '' : visits === undefined
    ? 'Individual work-order details have not been published for this project yet.'
    : 'No individual work orders have been verified for this project yet.';
  const cards = (visits ?? []).map((visit, index) => {
    const item = document.createElement('li');
    item.className = `visit visit-${visit.progress}`;
    item.dataset.visitRef = visit.ref;
    const top = document.createElement('div');
    top.className = 'visit-top';
    const name = document.createElement('div');
    const caption = document.createElement('span');
    caption.className = 'visit-caption';
    caption.textContent = `Visit ${index + 1} · Ref ${visit.ref.slice(2).toUpperCase()}`;
    const title = document.createElement('h3');
    title.textContent = VISIT_NAMES[visit.visitType];
    name.append(caption, title);
    const badge = document.createElement('span');
    badge.className = 'visit-badge';
    badge.textContent = VISIT_PROGRESS[visit.progress][0];
    top.append(name, badge);
    const explanation = document.createElement('p');
    explanation.textContent = VISIT_PROGRESS[visit.progress][1];
    item.append(top, explanation);
    return item;
  });
  visitList.replaceChildren(...cards);
}

function render(project) {
  document.getElementById('requested-date').textContent = project.customerRequestedDate
    ? displayDate(project.customerRequestedDate) : 'Not provided';
  document.getElementById('confirmed-date').textContent = displayDate(project.confirmedInstallDate);
  document.getElementById('confirmed-note').textContent = project.confirmedInstallDate
    ? 'Confirmed from the service workstream.' : 'The provider and customer date are still being checked.';
  const completed = PHASES.filter(([id]) => project.milestones[id] === 'complete').length;
  document.getElementById('progress-count').textContent = String(completed);
  document.getElementById('source-time').textContent = `Source data as of ${timeFormat.format(new Date(project.lastVerifiedAtUtc))}`;
  renderFreshness(project.lastVerifiedAtUtc);
  const cards = PHASES.map(([id, title, description], index) => {
    const item = document.createElement('li');
    const status = project.milestones[id];
    item.className = `milestone milestone-${status}`;
    const number = document.createElement('span');
    number.className = 'milestone-number';
    number.textContent = String(index + 1);
    const copy = document.createElement('div');
    const top = document.createElement('div');
    top.className = 'milestone-top';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.textContent = phaseStatus(status);
    top.append(heading, badge);
    const explanation = document.createElement('p');
    explanation.textContent = status === 'pending'
      ? 'We have not verified an update for this step.'
      : status === 'complete' ? COMPLETE_PHASE_COPY[id] : description;
    copy.append(top, explanation);
    item.append(number, copy);
    return item;
  });
  phaseList.replaceChildren(...cards);
  renderVisits(project);
  show('project');
}

async function refresh() {
  const sequence = ++currentLoad;
  activeFetch?.abort();
  activeFetch = new AbortController();
  show('loading');
  try {
    const { handle, key } = parseCapabilityLocation(window.location);
    if (!globalThis.crypto?.subtle) throw new Error('Secure browser context unavailable');
    const dataUrl = new URL(`data/${handle}.json`, window.location.href);
    dataUrl.searchParams.set('fresh', String(Date.now()));
    const response = await fetch(dataUrl, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: activeFetch.signal });
    if (!response.ok) throw new Error('Status file unavailable');
    const body = await response.text();
    if (body.length > 32768) throw new Error('Status file too large');
    const project = await decryptProject(JSON.parse(body), handle, key);
    if (sequence === currentLoad) render(project);
  } catch {
    if (sequence === currentLoad) show('unavailable');
  }
}

void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
