/**
 * The alert list keeps its scroll position across a re-render.
 *
 * Every render rebuilds the shadow root from a template, so without help the
 * list came back scrolled to the top: expanding an entry halfway down, or a
 * feed update while reading, snapped the list back to the first alert.
 *
 * Run:  node test/scroll.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ha-alert-card.js'), 'utf8');
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

// A shadow root whose .alert-list is a fresh object after every innerHTML
// assignment, as a real one would be.
function fakeShadowRoot() {
  const root = { list: null, renders: 0 };
  Object.defineProperty(root, 'innerHTML', {
    set() { root.renders++; root.list = { scrollTop: 0 }; },
    get() { return ''; },
  });
  root.querySelector = (sel) => (sel === '.alert-list' ? root.list : null);
  root.querySelectorAll = () => [];
  root.getElementById = () => null;
  return root;
}

function makeCard() {
  const card = Object.create(HaAlertCard.prototype);
  card._config = {
    title: 'Alerts', show_dismiss: true, show_source_badge: true, show_area: true,
    show_time: true, show_image: true, severity_colors: { unknown: '#9e9e9e' },
    sources: [{ entity: 'sensor.feed' }], compact: false,
  };
  card._alerts = [{ _id: 'a', _sourceIdx: 0, _source: 'X', _entity: 'sensor.feed', _raw: {},
    title: 'One', message: '', area: '', severity: 'unknown', time: '', url: '', instruction: '' }];
  card._dismissedAlerts = [];
  card._totalUndismissed = 1;
  card._expanded = new Set();
  card._hass = { states: {} };
  card._inEditMode = () => false;
  card._showDismissed = false;
  card.shadowRoot = fakeShadowRoot();
  card.style = {};
  card.hidden = false;
  card.dispatchEvent = () => {};
  return card;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log('scroll position survives a re-render');
  {
    const card = makeCard();
    card._render();
    await tick();
    check('first render starts at the top', card.shadowRoot.list.scrollTop === 0);
    card.shadowRoot.list.scrollTop = 240;
    card._toggleExpand('a');
    check('list was rebuilt', card.shadowRoot.renders === 2);
    check('not restored synchronously (ha-card has no slot yet)', card.shadowRoot.list.scrollTop === 0);
    await tick();
    check('restored once the card has rendered', card.shadowRoot.list.scrollTop === 240,
          `got ${card.shadowRoot.list.scrollTop}`);
    card._render();
    await tick();
    check('and across a plain re-render', card.shadowRoot.list.scrollTop === 240);
  }

  console.log('ha-card.updateComplete is awaited when present');
  {
    const card = makeCard();
    let resolve; const updateComplete = new Promise((r) => { resolve = r; });
    const root = card.shadowRoot;
    root.querySelector = (sel) => (sel === '.alert-list' ? root.list : sel === 'ha-card' ? { updateComplete } : null);
    card._render();
    root.list.scrollTop = 120;
    card._render();
    await tick();
    check('nothing restored before the card finishes updating', root.list.scrollTop === 0);
    resolve();
    await tick();
    check('restored after updateComplete resolves', root.list.scrollTop === 120, `got ${root.list.scrollTop}`);
  }

  if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
  console.log('all scroll tests passed');
})();
