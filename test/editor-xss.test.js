/**
 * XSS regression tests for the HA Alert Card *visual editor*.
 *
 * The card's own rendering has been covered since the first review. The editor had
 * not been, and that is where the hole was: hacs/default#9602 found that the entity
 * picker's datalist interpolated every entity's `friendly_name` straight into
 * innerHTML.
 *
 * That is not the user's own text. Friendly names are set by the integration, and the
 * one-entity-per-alert integrations this card is built for — cap_alerts, NINA — name
 * their entities from feed content. So a hostile feed item becomes an entity name,
 * and the script runs the moment an administrator opens the card editor. Same class of
 * bug as an unescaped alert field, in a place nobody was looking.
 *
 * Run:  node test/editor-xss.test.js
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
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source + '\n;globalThis.__EDITOR__ = HaAlertCardEditor;', sandbox);
const HaAlertCardEditor = sandbox.__EDITOR__;

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PAYLOADS = {
  img: '<img src=x onerror=alert(1)>',
  svg: '<svg onload=alert(2)>',
  breakout: '"><script>alert(3)</script>',
};

/** Nothing executable survived, and no attribute was broken out of.
 *
 * Deliberately not a search for the word "onerror": escaped payload text still
 * contains it (`&lt;img src=x onerror=...&gt;`) and is perfectly inert. What matters is
 * that no payload reaches the output with its angle brackets or quotes intact, so the
 * test looks for the raw strings themselves.
 */
function assertInert(name, html, payloads = Object.values(PAYLOADS)) {
  check(`${name}: no raw tag`, !/<img\s|<svg\s|<script|<iframe/i.test(html),
        html.slice(0, 160));
  const leaked = payloads.filter(p => html.includes(p));
  check(`${name}: no payload verbatim`, leaked.length === 0, leaked.join(' | '));
}

function makeEditor(config = {}, states = {}) {
  const ed = Object.create(HaAlertCardEditor.prototype);
  ed._config = { title: 'Alerts', sources: [{ entity: 'sensor.feed' }], ...config };
  ed._hass = { states };
  ed._expandedPanels = new Set(['appearance', 'sources', 'interactions']);
  ed._expandedSources = new Set([0]);
  return ed;
}

console.log('\nEditor XSS regressions\n');

// --- the reported hole ------------------------------------------------------
{
  const states = {
    'sensor.cap_alerts_gale': {
      attributes: { friendly_name: `Gale warning ${PAYLOADS.img}` },
    },
    [`sensor.evil${PAYLOADS.breakout}`]: { attributes: { friendly_name: 'ok' } },
  };
  const ed = makeEditor({}, states);
  const html = ed._renderSourceExpanded({ entity: 'sensor.cap_alerts_gale' }, 0);
  assertInert('entity datalist / friendly_name', html);
  check('entity datalist: the name is still readable',
        html.includes('Gale warning'), html.slice(0, 200));
  check('entity datalist: the payload is escaped, not stripped',
        html.includes('&lt;img'), 'expected an escaped tag in the option text');
}

// --- a hostile entity id ----------------------------------------------------
{
  const evil = `sensor.x${PAYLOADS.breakout}`;
  const ed = makeEditor({}, { [evil]: { attributes: {} } });
  assertInert('entity datalist / entity id',
              ed._renderSourceExpanded({ entity: evil }, 0));
}

// --- the selected entity, which comes back from config ----------------------
{
  const ed = makeEditor();
  assertInert('entity search value',
              ed._renderSourceExpanded({ entity: `sensor.a${PAYLOADS.breakout}` }, 0));
}

// --- the user's own config: lower risk, same rule ---------------------------
{
  const ed = makeEditor();
  const src = {
    entity: 'sensor.feed',
    name: `name${PAYLOADS.img}`,
    attribute: `attr${PAYLOADS.breakout}`,
    detail_attribute: `det${PAYLOADS.svg}`,
    image_attribute: `img${PAYLOADS.img}`,
    tap_action: { action: 'navigate', navigation_path: `/x${PAYLOADS.breakout}` },
    hold_action: { action: 'url', url_path: `http://x${PAYLOADS.breakout}` },
    mapping: { title: `map${PAYLOADS.img}` },
  };
  assertInert('source fields', ed._renderSourceExpanded(src, 0));
}

// --- the card-level config, through the real _render() ----------------------
{
  const captured = { html: '' };
  const ed = makeEditor({
    title: `Alerts${PAYLOADS.img}`,
    tap_action: { action: 'navigate', navigation_path: `/p${PAYLOADS.breakout}` },
    hold_action: { action: 'url', url_path: `http://h${PAYLOADS.breakout}` },
  });
  // _render writes to shadowRoot and wires listeners; capture the markup and stub
  // the rest, so the assertion is against what the editor would really have rendered.
  ed.shadowRoot = {
    querySelectorAll: () => [],
    querySelector: () => null,
    set innerHTML(v) { captured.html = v; },
    get innerHTML() { return captured.html; },
  };
  ed._attachListeners = () => {};
  ed._setProperties = () => {};
  ed._render();
  assertInert('editor root (_render)', captured.html);
  check('editor root: the title is still readable',
        captured.html.includes('Alerts&lt;img'), captured.html.slice(0, 160));
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall editor checks passed\n');
process.exit(failures ? 1 : 0);
