import { PHASES, decryptProject, parseCapabilityLocation } from './crypto.mjs';

const loading = document.getElementById('loading');
const unavailable = document.getElementById('unavailable');
const projectArea = document.getElementById('project');
const phaseList = document.getElementById('milestone-list');
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
  if (which !== 'project') phaseList.replaceChildren();
}

function displayDate(date) {
  return date ? dateFormat.format(new Date(`${date}T00:00:00Z`)) : 'Not confirmed yet';
}

function phaseStatus(status) {
  return status === 'complete' ? 'Complete' : status === 'inProgress' ? 'In progress' : 'Not confirmed';
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
      ? 'We have not verified an update for this step.' : description;
    copy.append(top, explanation);
    item.append(number, copy);
    return item;
  });
  phaseList.replaceChildren(...cards);
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
