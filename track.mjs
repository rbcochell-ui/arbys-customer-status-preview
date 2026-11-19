import { OBSERVED_SUBSET_SCHEMA, PHASES, ROSTER_PROJECT_SCHEMA, STALE_AFTER_MS, decryptProject, freshnessState, parseCapabilityLocation } from './crypto.mjs?v=observed-3';

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
const OBSERVED_STATUS = Object.freeze({
  PendingSchedule: ['Date pending', 'Thirsty is waiting for a service date for this work order.'],
  PendingReadiness: ['Readiness pending', 'Thirsty is waiting for a readiness review.'],
  Open: ['Open', 'Thirsty currently marks this work order open.'],
  Scheduled: ['Scheduled in Thirsty', 'Thirsty currently marks this visit scheduled. Plans may change.'],
  InProgress: ['In progress in Thirsty', 'Thirsty currently marks this visit in progress.'],
  PendingCloseout: ['Closeout pending in Thirsty', 'Thirsty currently marks this work order pending closeout. Project closeout has not been verified in this view.'],
  Completed: ['Completed in Thirsty', 'Thirsty currently marks this visit complete. Project closeout may still be pending.'],
  Closed: ['Closed in Thirsty', 'Thirsty currently marks this work order closed. Project closeout has not been verified in this view.'],
  Cancelled: ['Canceled in Thirsty', 'Thirsty currently marks this visit canceled.'],
  NeedsReview: ['Update being checked', 'This work order is linked to your request; its current status needs review before we can show more.'],
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
let freshnessDeadlineTimer;
let renderedVerifiedAtUtc;

function show(which) {
  loading.hidden = which !== 'loading';
  unavailable.hidden = which !== 'unavailable';
  projectArea.hidden = which !== 'project';
  if (which !== 'project') {
    clearTimeout(freshnessDeadlineTimer);
    freshnessDeadlineTimer = undefined;
    renderedVerifiedAtUtc = undefined;
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

function scheduleFreshnessDeadline(verifiedAtUtc) {
  clearTimeout(freshnessDeadlineTimer);
  freshnessDeadlineTimer = undefined;
  renderedVerifiedAtUtc = verifiedAtUtc;
  if (freshnessState(verifiedAtUtc) !== 'current') return;
  const remaining = Date.parse(verifiedAtUtc) + STALE_AFTER_MS - Date.now();
  freshnessDeadlineTimer = setTimeout(() => {
    freshnessDeadlineTimer = undefined;
    if (renderedVerifiedAtUtc !== verifiedAtUtc || projectArea.hidden) return;
    renderFreshness(verifiedAtUtc);
    // A changed device clock can make a timer fire before the 24-hour boundary.
    if (freshnessState(verifiedAtUtc) === 'current') scheduleFreshnessDeadline(verifiedAtUtc);
  }, Math.max(1, remaining + 1));
}

function renderVisits(project) {
  const visits = project.visits;
  const rosterOnly = project.schema === ROSTER_PROJECT_SCHEMA;
  const partial = project.schema === OBSERVED_SUBSET_SCHEMA;
  const observed = rosterOnly || partial;
  visitEmpty.hidden = Array.isArray(visits) && visits.length > 0;
  visitEmpty.textContent = visitEmpty.hidden ? '' : visits === undefined
    ? 'Individual work-order details have not been published for this project yet.'
    : partial ? 'No work orders have been verified in this limited view yet. Others may exist.'
      : rosterOnly ? 'No work orders are currently linked to this request in the verified source.'
      : 'No individual work orders have been verified for this project yet.';
  const cards = (visits ?? []).map((visit, index) => {
    const item = document.createElement('li');
    item.className = observed ? 'visit visit-observed' : `visit visit-${visit.progress}`;
    item.dataset.visitRef = visit.ref;
    const top = document.createElement('div');
    top.className = 'visit-top';
    const name = document.createElement('div');
    const caption = document.createElement('span');
    caption.className = 'visit-caption';
    caption.textContent = partial
      ? `Verified work order · Ref ${visit.ref.slice(2).toUpperCase()}`
      : `Visit ${index + 1} · Ref ${visit.ref.slice(2).toUpperCase()}`;
    const title = document.createElement('h3');
    title.textContent = VISIT_NAMES[visit.visitType];
    name.append(caption, title);
    const badge = document.createElement('span');
    badge.className = 'visit-badge';
    badge.textContent = observed ? OBSERVED_STATUS[visit.observedStatus][0] : VISIT_PROGRESS[visit.progress][0];
    top.append(name, badge);
    const explanation = document.createElement('p');
    explanation.textContent = observed ? OBSERVED_STATUS[visit.observedStatus][1] : VISIT_PROGRESS[visit.progress][1];
    item.append(top, explanation);
    return item;
  });
  visitList.replaceChildren(...cards);
}

function render(project) {
  const rosterOnly = project.schema === ROSTER_PROJECT_SCHEMA;
  const partial = project.schema === OBSERVED_SUBSET_SCHEMA;
  projectArea.dataset.scope = partial ? 'partial' : 'full';
  document.getElementById('project-eyebrow').textContent = partial ? 'Limited update' : 'Your installation progress';
  document.getElementById('project-title').textContent = partial ? 'Your request: work orders verified so far' : 'Follow your installation';
  document.getElementById('scope-note').textContent = partial
    ? 'Work orders verified so far; others may exist. This is a limited view of the records checked to date.' : '';
  document.getElementById('scope-note').hidden = !partial;
  document.getElementById('milestone-heading').textContent = partial ? 'Project steps under review' : 'Project milestones';
  document.getElementById('visit-heading').textContent = partial ? 'Work orders verified so far' : 'Work orders';
  document.getElementById('visit-intro').textContent = partial
    ? 'Others may exist. These are only the visits whose current Thirsty status was checked; a completed visit does not complete the whole project.'
    : 'Visit states come from verified work-order records. A date alone does not mark work complete.';
  document.querySelector('.intro').textContent = rosterOnly
    ? 'This page shows the latest verified Thirsty work-order roster for your request. Project milestones stay unconfirmed until their supporting events are checked. Your requested date is a planning request.'
    : partial
      ? 'This limited page shows the work orders verified so far for your request. Other work may still be linked. Project steps remain unconfirmed until their supporting events are checked. Your requested date is a planning request.'
    : 'Project and work-order progress reflect verified information from the Arby’s service workstream. “Not confirmed” means we have not yet verified an update; work may still be underway. A requested date is a planning request until the installation date is confirmed.';
  document.getElementById('requested-date').textContent = project.customerRequestedDate
    ? displayDate(project.customerRequestedDate) : 'Not provided';
  document.getElementById('confirmed-date').textContent = project.confirmedInstallDate
    ? displayDate(project.confirmedInstallDate) : 'Not verified';
  document.getElementById('confirmed-note').textContent = project.confirmedInstallDate
    ? 'Confirmed from the service workstream.' : 'A confirmed installation date has not been verified in this view.';
  const completed = PHASES.filter(([id]) => project.milestones[id] === 'complete').length;
  document.getElementById('progress-count').textContent = String(completed);
  document.getElementById('progress-card').hidden = partial;
  document.getElementById('source-time').textContent = `${partial ? 'Request and observed work orders checked as of' : 'Source data as of'} ${timeFormat.format(new Date(project.lastVerifiedAtUtc))}`;
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
    if (status === 'pending') {
      explanation.textContent = partial && id === 'workOrders' && project.visits.length > 0
        ? 'The listed work orders have status updates, but the full work-order plan has not been confirmed.'
        : rosterOnly && id === 'workOrders' && project.visits.length > 0
        ? 'The listed visits have status updates, but we have not confirmed whether the work-order plan is complete.'
        : 'We have not verified an update for this step.';
    } else {
      explanation.textContent = status === 'complete' ? COMPLETE_PHASE_COPY[id] : description;
    }
    copy.append(top, explanation);
    item.append(number, copy);
    return item;
  });
  phaseList.replaceChildren(...cards);
  renderVisits(project);
  show('project');
  scheduleFreshnessDeadline(project.lastVerifiedAtUtc);
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
