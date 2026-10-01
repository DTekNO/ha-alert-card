/**
 * Compact-row tests for HA Alert Card.
 *
 * `compact: true` renders one line of layout per alert: thumbnail, title over a
 * one-line qualifier (area · message), source and time at the right. The normal
 * layout must be byte-identical with the option off, the qualifier must be built
 * from whatever the source provides, and feed text must stay inert in the new
 * markup exactly as it does in the old.
 *
 * Run:  node test/compact.test.js
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

function makeCard(config = {}) {
  const card = Object.create(HaAlertCard.prototype);
  card._config = {
    title: 'Alerts', show_dismiss: true, show_source_badge: true, show_area: true,
    show_time: true, show_image: true,
    severity_colors: { minor: '#fdd835', unknown: '#9e9e9e' },
    sources: [{ entity: 'sensor.feed' }],
    compact: false,
    ...config,
  };
  card._expanded = new Set();
  card._hass = { states: {} };
  return card;
}
const alert = (extra = {}) => ({
  _id: 'id1', _sourceIdx: 0, _source: 'COAST', _entity: 'sensor.feed',
  _raw: { entity_picture: '/local/bird.jpg' },
  title: 'Eurasian Siskin', message: 'Spinus spinus', area: '',
  severity: 'unknown', time: '', url: '', instruction: '',
  ...extra,
});

console.log('compact row structure');
{
  const html = makeCard({ compact: true })._renderAlert(alert());
  check('renders the compact row', html.includes('class="alert-row"'));
  check('does not render the stacked top row', !html.includes('alert-top-row'));
  check('thumbnail inside the row', /alert-row">\s*<img class="alert-image"/.test(html));
  check('title over subtitle in the text column',
        /alert-text">\s*<div class="alert-title">Eurasian Siskin<\/div>\s*<div class="alert-subtitle">Spinus spinus<\/div>/.test(html));
  check('source and time together in the meta cell', /alert-meta">\s*<span class="alert-source">COAST<\/span>/.test(html));
}

console.log('each field keeps its meaning');
{
  const c = makeCard({ compact: true });
  check('message is the subtitle', c._renderAlert(alert({ message: 'Gale warning in effect', area: '' })).includes('alert-subtitle">Gale warning in effect<'));
  check('area sits in the meta cell, after the source',
        /alert-source">COAST<\/span>\s*<span class="alert-area">Clark County<\/span>/.test(c._renderAlert(alert({ area: 'Clark County' }))));
  check('area never becomes the subtitle', !c._renderAlert(alert({ message: '', area: 'Vestland' })).includes('alert-subtitle'));
  check('no message: no subtitle element', !c._renderAlert(alert({ message: '' })).includes('alert-subtitle'));
  check('area hidden when show_area is off',
        !makeCard({ compact: true, show_area: false })._renderAlert(alert({ area: 'X' })).includes('alert-area'));
}

console.log('expanding shows the full message below the row');
{
  const c = makeCard({ compact: true });
  const a = alert({ message: 'Long description' });
  check('collapsed: message only in the subtitle', (c._renderAlert(a).match(/Long description/g) || []).length === 1);
  c._expanded.add('id1');
  const html = c._renderAlert(a);
  check('expanded: full message appears after the row',
        /<\/div>\s*<div class="alert-message">Long description<\/div>/.test(html));
}

console.log('the normal layout is untouched when compact is off');
{
  const html = makeCard()._renderAlert(alert());
  check('stacked top row still rendered', html.includes('alert-top-row'));
  check('no compact markup leaks in', !html.includes('alert-row') && !html.includes('alert-subtitle'));
}

console.log('feed text stays inert in the compact markup');
{
  const hostile = alert({
    title: 'title<img src=x onerror=alert(1)>',
    area: 'area<iframe src=javascript:alert(3)></iframe>',
    message: 'msg<svg onload=alert(2)>',
    _source: 'src"><script>alert(4)</script>',
  });
  const html = makeCard({ compact: true })._renderAlert(hostile);
  const tags = html.match(/<[^>]*>/g) || [];
  const allowed = new Set(['div', '/div', 'span', '/span', 'img', 'ha-icon', '/ha-icon', 'strong', '/strong', 'ha-markdown', '/ha-markdown']);
  const bad = tags.filter(t => {
    const n = (t.match(/^<\/?\s*([a-z0-9-]+)/i) || [, ''])[1].toLowerCase();
    return !allowed.has(t.startsWith('</') ? `/${n}` : n) || /\son[a-z]+\s*=/i.test(t);
  });
  check('only inert, expected tags', bad.length === 0, bad.slice(0, 3).join('; '));
  check('payload brackets escaped', !/<(?:img\s+src=x|svg\s+onload|iframe|script)/i.test(html));
}

console.log('config and chrome');
check('compact defaults off', /compact: config\.compact \|\| false/.test(source));
check('ha-card carries the compact class', /<ha-card class="\$\{this\._config\.compact \? 'compact' : ''\}">/.test(source));
check('editor exposes the switch', /id="compact"/.test(source));

console.log(failures ? `\n${failures} failure(s)` : '\nall compact tests passed');
process.exit(failures ? 1 : 0);
