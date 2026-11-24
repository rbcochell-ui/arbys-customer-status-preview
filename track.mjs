import { FORM_ONLY_SCHEMA, OBSERVED_SUBSET_SCHEMA, PHASES, ROSTER_PROJECT_SCHEMA, STALE_AFTER_MS, decryptProject, freshnessState, parseCapabilityLocation } from './crypto.mjs?v=form-only-1';
import { readEncryptedStatus } from './status-source.mjs?v=dual-carrier-1';

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

function renderFreshness(verifiedAtUtc, formOnly = false) {
  const state = freshnessState(verifiedAtUtc);
  freshnessWarning.dataset.state = state;
  freshnessWarning.hidden = state === 'current';
  if (state === 'stale') {
    document.getElementById('freshness-title').textContent = 'Updates delayed';
    document.getElementById('freshness-copy').textContent = formOnly
      ? 'This is the last FORM snapshot. Request details may have changed, and this update does not include verified work-order progress. Please reply to the email that shared this link for a current update.'
      : 'This is the last verified snapshot and may not reflect recent service changes. Please reply to the email that shared this link for a current update.';
  } else if (state === 'clockMismatch') {
    document.getElementById('freshness-title').textContent = 'Verification time needs review';
    document.getElementById('freshness-copy').textContent =
      'Your device time and the source verification time do not agree. Please reply to the email that shared this link for a current update.';
  }
}

function scheduleFreshnessDeadline(verifiedAtUtc, formOnly = false) {
  clearTimeout(freshnessDeadlineTimer);
  freshnessDeadlineTimer = undefined;
  renderedVerifiedAtUtc = verifiedAtUtc;
  if (freshnessState(verifiedAtUtc) !== 'current') return;
  const remaining = Date.parse(verifiedAtUtc) + STALE_AFTER_MS - Date.now();
  freshnessDeadlineTimer = setTimeout(() => {
    freshnessDeadlineTimer = undefined;
    if (renderedVerifiedAtUtc !== verifiedAtUtc || projectArea.hidden) return;
    renderFreshness(verifiedAtUtc, formOnly);
    // A changed device clock can make a timer fire before the 24-hour boundary.
    if (freshnessState(verifiedAtUtc) === 'current') scheduleFreshnessDeadline(verifiedAtUtc, formOnly);
  }, Math.max(1, remaining + 1));
}

function renderVisits(project) {
  const visits = project.visits;
  const rosterOnly = project.schema === ROSTER_PROJECT_SCHEMA;
  const partial = project.schema === OBSERVED_SUBSET_SCHEMA;
  const formOnly = project.schema === FORM_ONLY_SCHEMA;
  const observed = rosterOnly || partial;
  visitEmpty.hidden = Array.isArray(visits) && visits.length > 0;
  visitEmpty.textContent = visitEmpty.hidden ? '' : visits === undefined
    ? 'Individual work-order details have not been published for this project yet.'
    : formOnly ? 'This update does not include verified work-order progress yet. Work may already be underway.'
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
  const formOnly = project.schema === FORM_ONLY_SCHEMA;
  projectArea.dataset.scope = formOnly ? 'form-only' : partial ? 'partial' : 'full';
  document.getElementById('project-eyebrow').textContent = formOnly ? 'Your request' : partial ? 'Limited update' : 'Your installation progress';
  document.getElementById('project-title').textContent = formOnly ? 'We received your request' : partial ? 'Your request: work orders verified so far' : 'Follow your installation';
  document.getElementById('scope-note').textContent = formOnly
    ? 'This page confirms the FORM request only. This update does not include verified Thirsty work-order progress.'
    : partial ? 'Work orders verified so far; others may exist. This is a limited view of the records checked to date.' : '';
  document.getElementById('scope-note').hidden = !(partial || formOnly);
  document.getElementById('milestone-heading').textContent = formOnly ? 'Project steps awaiting verification' : partial ? 'Project steps under review' : 'Project milestones';
  document.getElementById('visit-heading').textContent = formOnly ? 'Work-order progress' : partial ? 'Work orders verified so far' : 'Work orders';
  document.getElementById('visit-intro').textContent = formOnly
    ? 'This FORM-only update does not confirm whether a work order exists or what stage it has reached.'
    : partial
    ? 'Others may exist. These are only the visits whose current Thirsty status was checked; a completed visit does not complete the whole project.'
    : 'Visit states come from verified work-order records. A date alone does not mark work complete.';
  document.querySelector('.intro').textContent = formOnly
    ? 'We received the request entered in FORM.com. This page can show work-order progress once verified Thirsty updates are added. A customer-requested date is a planning request until the installation date is confirmed.'
    : rosterOnly
    ? 'This page shows the latest verified Thirsty work-order roster for your request. Project milestones stay unconfirmed until their supporting events are checked. Your requested date is a planning request.'
    : partial
      ? 'This limited page shows the work orders verified so far for your request. Other work may still be linked. Project steps remain unconfirmed until their supporting events are checked. The requested date comes from the initial FORM submission and remains a planning request.'
    : 'Project and work-order progress reflect verified information from the Arby’s service workstream. “Not confirmed” means we have not yet verified an update; work may still be underway. A requested date is a planning request until the installation date is confirmed.';
  document.getElementById('requested-date').textContent = project.customerRequestedDate
    ? displayDate(project.customerRequestedDate) : 'Not provided';
  document.getElementById('requested-date-note').textContent = formOnly
    ? 'Requested in the FORM submission. Later changes have not been checked in this view.'
    : partial
    ? 'Requested in the initial FORM submission. Later request changes may not appear here until reviewed.'
    : 'This is the date requested in the form.';
  document.getElementById('confirmed-date').textContent = project.confirmedInstallDate
    ? displayDate(project.confirmedInstallDate) : 'Not verified';
  document.getElementById('confirmed-note').textContent = project.confirmedInstallDate
    ? 'Confirmed from the service workstream.' : 'A confirmed installation date has not been verified in this view.';
  const completed = PHASES.filter(([id]) => project.milestones[id] === 'complete').length;
  document.getElementById('progress-count').textContent = String(completed);
  document.getElementById('progress-card').hidden = partial || formOnly;
  document.getElementById('source-time').textContent = `${formOnly ? 'FORM request checked as of' : partial ? 'Work orders checked as of' : 'Source data as of'} ${timeFormat.format(new Date(project.lastVerifiedAtUtc))}`;
  renderFreshness(project.lastVerifiedAtUtc, formOnly);
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
      explanation.textContent = formOnly && id !== 'requestReceived'
        ? 'This update does not include verified progress for this step yet.'
        : partial && id === 'workOrders' && project.visits.length > 0
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
  scheduleFreshnessDeadline(project.lastVerifiedAtUtc, formOnly);
}

async function refresh() {
  const sequence = ++currentLoad;
  activeFetch?.abort();
  activeFetch = new AbortController();
  show('loading');
  try {
    const { handle, key } = parseCapabilityLocation(window.location);
    if (!globalThis.crypto?.subtle) throw new Error('Secure browser context unavailable');
    const envelope = await readEncryptedStatus(handle, window.location.href,
      { signal: activeFetch.signal });
    const project = await decryptProject(envelope, handle, key);
    if (sequence === currentLoad) render(project);
  } catch {
    if (sequence === currentLoad) show('unavailable');
  }
}

void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
