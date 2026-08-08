/**
 * XSS regression tests for HA Alert Card.
 *
 * Alert fields come from third-party feeds (USGS, NWS, RSS, ...), so every
 * feed-derived value rendered into shadowRoot.innerHTML must be escaped.
 * These tests render the real _renderAlert / _renderDismissedAlert output from
 * src/ha-alert-card.js against hostile input and assert that no executable
 * markup survives — while the intended text (including its punctuation) does.
 *
 * Run:  node test/xss.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'ha-alert-card.js');
const source = fs.readFileSync(SRC, 'utf8');

// Load the module's top-level helpers and the class body without a DOM: stub
// the custom-element registry and window bits the file touches on load.
const sandbox = {
  console,
  customElements: { define() {}, get() { return undefined; } },
  window: { customCards: [], addEventListener() {} },
  document: { createElement: () => ({ setAttribute() {}, style: {} }) },
  HTMLElement: class {},
  CustomEvent: class {},
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source + '\n;globalThis.__CARD__ = HaAlertCard;', sandbox);

const HaAlertCard = sandbox.__CARD__;
const escapeHtml = vm.runInContext('escapeHtml', sandbox);
const safeImageUrl = vm.runInContext('safeImageUrl', sandbox);

// --- Test harness -----------------------------------------------------------

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A card instance with just enough state for the render methods. */
function makeCard(config = {}) {
  const card = Object.create(HaAlertCard.prototype);
  card._config = {
    title: 'Alerts',
    show_dismiss: true,
    show_source_badge: true,
    show_area: true,
    show_time: true,
    show_image: true,
    severity_colors: { minor: '#fdd835', unknown: '#9e9e9e' },
    sources: [{ entity: 'sensor.feed', image_attribute: 'img' }],
    ...config,
  };
  card._expanded = new Set();
  card._hass = { states: {} };
  return card;
}

const PAYLOADS = {
  img: '<img src=x onerror=alert(1)>',
  svg: '<svg onload=alert(2)>',
  iframe: '<iframe src=javascript:alert(3)></iframe>',
  breakout: '"><script>alert(4)</script>',
};

function hostileAlert(extra = {}) {
  return {
    _id: `id${PAYLOADS.breakout}`,
    _sourceIdx: 0,
    _source: `src${PAYLOADS.img}`,
    _entity: 'sensor.feed',
    _raw: {},
    title: `title${PAYLOADS.img}`,
    message: `message${PAYLOADS.svg} & "quoted"`,
    severity: 'minor',
    time: PAYLOADS.breakout,       // unparseable → _formatTime returns it raw
    url: 'javascript:alert(5)',
    area: `area${PAYLOADS.iframe}`,
    instruction: `instr${PAYLOADS.img}`,
    ...extra,
  };
}

/** Tags the card's own templates are allowed to emit. */
const ALLOWED_TAGS = new Set([
  'div', '/div', 'span', '/span', 'strong', '/strong',
  'img', 'ha-icon', '/ha-icon', 'ha-markdown', '/ha-markdown',
]);

/**
 * Markup must contain no live element or handler from the payloads.
 *
 * Only *real* tags are inspected: escaped payload text such as
 * `&lt;img src=x onerror=alert(1)&gt;` contains no `<`, so it forms no tag and
 * is inert by construction.  Checking the raw string for `onerror=` would
 * therefore report false positives on correctly-escaped output.
 */
function assertInert(name, html) {
  const tags = html.match(/<[^>]*>/g) || [];
  const offenders = [];
  for (const tag of tags) {
    const tagName = (tag.match(/^<\/?\s*([a-z0-9-]+)/i) || [, ''])[1].toLowerCase();
    const closing = tag.startsWith('</') ? `/${tagName}` : tagName;
    if (!ALLOWED_TAGS.has(closing)) offenders.push(`unexpected tag ${tag}`);
    if (/\son[a-z]+\s*=/i.test(tag)) offenders.push(`handler in ${tag}`);
    if (/(?:src|href)\s*=\s*["']?\s*javascript:/i.test(tag)) offenders.push(`javascript: in ${tag}`);
  }
  check(`${name}: only inert, expected markup`, offenders.length === 0,
        offenders.slice(0, 3).join('; '));
  // The payload's angle brackets must have been neutralised.
  check(`${name}: payload angle brackets escaped`,
        !/<(?:img\s+src=x|svg\s+onload|iframe|script)/i.test(html));
}

// --- Tests ------------------------------------------------------------------

console.log('escapeHtml');
check('escapes <', escapeHtml('<b>') === '&lt;b&gt;');
check('escapes & first (no double-encoding artefacts)',
      escapeHtml('&lt;') === '&amp;lt;');
check('escapes both quote styles',
      escapeHtml(`a"b'c`) === 'a&quot;b&#39;c');
check('null/undefined become empty', escapeHtml(null) === '' && escapeHtml(undefined) === '');
check('non-strings coerce', escapeHtml(42) === '42');

console.log('safeImageUrl');
check('allows https', safeImageUrl('https://x/i.png') === 'https://x/i.png');
check('allows protocol-relative', safeImageUrl('//x/i.png') === '//x/i.png');
check('allows site-relative', safeImageUrl('/local/i.png') === '/local/i.png');
check('allows data:image', safeImageUrl('data:image/png;base64,AA').startsWith('data:image/'));
check('blocks javascript:', safeImageUrl('javascript:alert(1)') === '');
check('blocks data:text/html', safeImageUrl('data:text/html,<script>x</script>') === '');
check('blocks empty/garbage', safeImageUrl('') === '' && safeImageUrl('nonsense:x') === '');

console.log('_renderAlert (collapsed)');
{
  const html = makeCard()._renderAlert(hostileAlert());
  assertInert('collapsed', html);
  check('title text preserved', html.includes('title&lt;img src=x'));
  check('message punctuation preserved', html.includes('&amp; &quot;quoted&quot;'));
  check('id attribute escaped', !html.includes(`data-alert-id="id"`));
}

console.log('_renderAlert (expanded — instruction + detail)');
{
  const card = makeCard();
  const alert = hostileAlert({ _raw: { formatted_content: '# heading' } });
  card._expanded.add(alert._id);
  const html = card._renderAlert(alert);
  assertInert('expanded', html);
  check('instruction escaped', html.includes('instr&lt;img src=x'));
  check('detail delegated to ha-markdown (not inlined)',
        html.includes('<ha-markdown') && !html.includes('# heading'));
}

console.log('_renderAlert (hostile image URL)');
{
  const card = makeCard();
  const alert = hostileAlert({ _raw: { img: 'javascript:alert(1)' } });
  const html = card._renderAlert(alert);
  assertInert('image', html);
  check('unsafe image src dropped entirely', !html.includes('<img class="alert-image"'));
}
{
  const card = makeCard();
  const alert = hostileAlert({ _raw: { img: 'https://ok/i.png' } });
  const html = card._renderAlert(alert);
  check('safe image src still rendered', html.includes('src="https://ok/i.png"'));
}

console.log('_renderAlert (default image attribute)');
{
  // No image_attribute configured: entity_picture is the default, so the common
  // case needs no configuration.
  const card = makeCard({ sources: [{ entity: 'sensor.feed' }] });
  card._hass = { states: { 'sensor.feed': { attributes: { entity_picture: '/api/image_proxy/x' } } } };
  const alert = hostileAlert({ _entity: 'sensor.feed' });
  const html = card._renderAlert(alert);
  assertInert('default image', html);
  check('entity_picture used when no image_attribute is set',
        html.includes('src="/api/image_proxy/x"'));
}
{
  // A per-alert value still wins over the entity attribute.
  const card = makeCard({ sources: [{ entity: 'sensor.feed' }] });
  card._hass = { states: { 'sensor.feed': { attributes: { entity_picture: '/entity.png' } } } };
  const alert = hostileAlert({ _entity: 'sensor.feed', _raw: { entity_picture: '/peritem.png' } });
  check('per-alert entity_picture takes precedence',
        card._renderAlert(alert).includes('src="/peritem.png"'));
}
{
  // An explicit image_attribute still overrides the default.
  const card = makeCard({ sources: [{ entity: 'sensor.feed', image_attribute: 'travel_tag' }] });
  card._hass = { states: { 'sensor.feed': { attributes: {
    entity_picture: '/should-not-be-used.png', travel_tag: '/badge.png' } } } };
  const alert = hostileAlert({ _entity: 'sensor.feed' });
  const html = card._renderAlert(alert);
  check('explicit image_attribute overrides the default', html.includes('src="/badge.png"'));
  check('default is not used when overridden', !html.includes('should-not-be-used'));
}
{
  // show_image remains the way to turn images off entirely.
  const card = makeCard({ show_image: false, sources: [{ entity: 'sensor.feed' }] });
  card._hass = { states: { 'sensor.feed': { attributes: { entity_picture: '/x.png' } } } };
  const alert = hostileAlert({ _entity: 'sensor.feed' });
  check('show_image false suppresses the default image',
        !card._renderAlert(alert).includes('<img class="alert-image"'));
}
{
  // An entity with no entity_picture must simply render no image.
  const card = makeCard({ sources: [{ entity: 'sensor.feed' }] });
  card._hass = { states: { 'sensor.feed': { attributes: {} } } };
  const alert = hostileAlert({ _entity: 'sensor.feed' });
  check('missing entity_picture renders no image',
        !card._renderAlert(alert).includes('<img class="alert-image"'));
}

console.log('_renderDismissedAlert');
{
  const html = makeCard()._renderDismissedAlert(hostileAlert());
  assertInert('dismissed', html);
  check('title text preserved', html.includes('title&lt;img src=x'));
}

console.log('severity colour is a lookup value, never feed text');
{
  const card = makeCard({ severity_colors: { unknown: '#9e9e9e' } });
  const html = card._renderAlert(hostileAlert({ severity: '#fff"><script>alert(1)</script>' }));
  assertInert('severity', html);
  check('unknown severity falls back to configured colour', html.includes('#9e9e9e'));
}

console.log('');
if (failures) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('all checks passed');
