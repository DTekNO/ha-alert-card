/**
 * Visibility regression tests for HA Alert Card.
 *
 * hide_when_no_alerts / hide_when_all_dismissed must hide the card in a way the
 * sections grid can see: by setting the element's `hidden` property and firing
 * `card-visibility-changed`, which is what hui-card reads before hiding *itself* —
 * the wrapper that owns the grid cell. Setting style.display on the element hid
 * the card but left a blank cell the size of the card behind (23.09.2026).
 *
 * Run:  node test/visibility.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'ha-alert-card.js');
const source = fs.readFileSync(SRC, 'utf8');

const sandbox = {
  console,
  customElements: { define() {}, get() { return undefined; } },
  window: { customCards: [], addEventListener() {} },
  document: { createElement: () => ({ setAttribute() {}, style: {} }) },
  HTMLElement: class {},
  CustomEvent: class {},
  Event: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source + '\n;globalThis.__CARD__ = HaAlertCard;', sandbox);
const HaAlertCard = sandbox.__CARD__;

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** A card with the state _render's visibility block reads, plus recorders. */
function makeCard(config = {}, { alerts = [], dismissed = [], editMode = false } = {}) {
  const card = Object.create(HaAlertCard.prototype);
  card._config = {
    title: 'Alerts', show_dismiss: true, show_source_badge: true, show_area: true,
    show_time: true, show_image: true,
    severity_colors: { minor: '#fdd835', unknown: '#9e9e9e' },
    sources: [{ entity: 'sensor.feed' }],
    hide_when_no_alerts: false, hide_when_all_dismissed: false,
    ...config,
  };
  card._alerts = alerts;
  card._dismissedAlerts = dismissed;
  card._expanded = new Set();
  card._hass = { states: {} };
  card._inEditMode = () => editMode;
  card.shadowRoot = { innerHTML: '' };
  card.style = {};
  card.hidden = false;
  card.events = [];
  card.dispatchEvent = (ev) => card.events.push(ev.type);
  return card;
}

console.log('hide_when_no_alerts, not editing');
{
  const card = makeCard({ hide_when_no_alerts: true });
  card._render();
  check('sets the hidden property', card.hidden === true);
  check('fires card-visibility-changed once', card.events.filter(e => e === 'card-visibility-changed').length === 1);
  check('does not touch style.display', card.style.display === undefined);
  check('renders nothing while hidden', card.shadowRoot.innerHTML === '');
}

console.log('hide_when_all_dismissed, not editing');
{
  const card = makeCard({ hide_when_all_dismissed: true }, { dismissed: [{ _id: 'a' }] });
  card._render();
  check('sets the hidden property', card.hidden === true);
  check('fires card-visibility-changed once', card.events.length === 1);
}

console.log('idempotence');
{
  const card = makeCard({ hide_when_no_alerts: true });
  card._render(); card._render(); card._render();
  check('re-rendering while hidden fires no further events', card.events.length === 1);
  card._setHidden(false);
  check('un-hiding clears the property', card.hidden === false);
  check('un-hiding fires exactly one more event', card.events.length === 2);
  card._setHidden(false);
  check('a no-op un-hide is silent', card.events.length === 2);
}

console.log('edit mode keeps the card visible and grabbable');
{
  const card = makeCard({ hide_when_no_alerts: true }, { editMode: true });
  card._render();
  check('not hidden in edit mode', card.hidden === false);
  check('renders the placeholder instead', card.shadowRoot.innerHTML.length > 0);
  check('fires nothing when visibility did not change', card.events.length === 0);
}

console.log('flag off: nothing hides');
{
  const card = makeCard({ hide_when_no_alerts: false });
  let threw = false;
  try { card._render(); } catch (e) { threw = true; }   // full render needs more DOM than we stub
  check('hidden stays false', card.hidden === false);
  check('no visibility event', card.events.length === 0);
  if (threw) console.log('       (full render path not exercised here — needs a DOM)');
}

console.log('contract with hui-card');
check('asks to stay connected while hidden', Object.create(HaAlertCard.prototype).connectedWhileHidden === true);
check('source no longer sets style.display on itself', !/this\.style\.display/.test(source));
check('source guards :host([hidden])', /:host\(\[hidden\]\)\s*\{\s*display:\s*none\s*!important/.test(source));

console.log(failures ? `\n${failures} failure(s)` : '\nall visibility tests passed');
process.exit(failures ? 1 : 0);
