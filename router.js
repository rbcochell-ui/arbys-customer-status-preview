// The published root remains the invented design preview for visitors without
// a capability URL. A project query moves the browser to the generic viewer.
if (new URL(window.location.href).searchParams.has('p')
  || new URLSearchParams(window.location.hash.slice(1)).has('k')) {
  const target = new URL('track.html', window.location.href);
  target.search = window.location.search;
  target.hash = window.location.hash;
  window.location.replace(target.href);
}
