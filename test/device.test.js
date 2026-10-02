/**
 * Device sources and CAP field aliases.
 *
 * Integrations such as cap_alerts create one entity per alert and remove it
 * when the alert ends, so `device: <id>` gathers every non-diagnostic entity
 * under a device on each refresh instead of naming entities that will not
 * exist in an hour. Unmapped fields also try the CAP originals (onset, web,
 * area_desc) that those integrations publish.
 *
 * Run:  node test/device.test.js
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

const cap = (event, extra = {}) => ({
  friendly_name: `CAP Alerts NWS ${event}`, event, description: `${event} in effect`,
  severity: 'Severe', onset: '2026-10-02T10:00:00+00:00', web: 'https://alerts.example/' + event,
  area_desc: 'Cook County', id: `urn:${event}`, ...extra,
});

function hass() {
  return {
    states: {
      'sensor.cap_alerts_nws_cap_alert_tornado_warning_1f0c6a62': { state: 'severe', attributes: cap('Tornado Warning') },
      'sensor.cap_alerts_nws_cap_alert_flood_advisory_9a1b2c3d': { state: 'unknown', attributes: cap('Flood Advisory', { severity: 'Unknown' }) },
      'sensor.cap_alerts_nws_alert_count': { state: '2', attributes: { friendly_name: 'Alert count', active: 2, upcoming: 0 } },
      'button.cap_alerts_nws_refresh': { state: 'unknown', attributes: { friendly_name: 'Refresh' } },
      'sensor.cap_alerts_nws_cap_alert_gone_00000000': { state: 'unavailable', attributes: cap('Gone') },
      'sensor.cap_alerts_eccc_cap_alert_tornado_warning_77777777': { state: 'severe', attributes: cap('Tornado Warning') },
      'sensor.legacy_feed': { state: '1', attributes: { alerts: [{ event: 'Gale', starttime: '2026-10-02T08:00:00+00:00', url: 'https://legacy', area: 'Coast', id: 'legacy-1' }] } },
      'sensor.blank_unknown': { state: 'unknown', attributes: { friendly_name: 'Blank', icon: 'mdi:help' } },
    },
    entities: {
      'sensor.cap_alerts_nws_cap_alert_tornado_warning_1f0c6a62': { entity_id: 'sensor.cap_alerts_nws_cap_alert_tornado_warning_1f0c6a62', device_id: 'dev-nws' },
      'sensor.cap_alerts_nws_cap_alert_flood_advisory_9a1b2c3d': { entity_id: 'sensor.cap_alerts_nws_cap_alert_flood_advisory_9a1b2c3d', device_id: 'dev-nws' },
      'sensor.cap_alerts_nws_alert_count': { entity_id: 'sensor.cap_alerts_nws_alert_count', device_id: 'dev-nws', entity_category: 'diagnostic' },
      'button.cap_alerts_nws_refresh': { entity_id: 'button.cap_alerts_nws_refresh', device_id: 'dev-nws', entity_category: 'diagnostic' },
      'sensor.cap_alerts_nws_cap_alert_gone_00000000': { entity_id: 'sensor.cap_alerts_nws_cap_alert_gone_00000000', device_id: 'dev-nws' },
      'sensor.cap_alerts_eccc_cap_alert_tornado_warning_77777777': { entity_id: 'sensor.cap_alerts_eccc_cap_alert_tornado_warning_77777777', device_id: 'dev-eccc' },
    },
    devices: {
      'dev-nws': { id: 'dev-nws', name: 'CAP Alerts NWS', name_by_user: null },
      'dev-eccc': { id: 'dev-eccc', name: 'CAP Alerts ECCC', name_by_user: 'Canada' },
    },
  };
}

function makeCard(sources) {
  const card = Object.create(HaAlertCard.prototype);
  card._config = { sources, max_items: 20, severity_colors: {} };
  card._hass = hass();
  card._dismissed = new Set();
  card._knownIds = new Set();
  card._saveDismissed = () => Promise.resolve();
  card._updateAlerts();
  return card;
}

console.log('device source gathers the alert entities under a device');
{
  const c = makeCard([{ device: 'dev-nws' }]);
  const ids = c._alerts.map((a) => a._entity).sort();
  check('two alerts, from the two alert sensors', c._alerts.length === 2, JSON.stringify(ids));
  check('diagnostic count and refresh entities are skipped', !ids.some((e) => /alert_count|refresh/.test(e)));
  check('an unavailable entity is skipped', !ids.some((e) => /gone/.test(e)));
  check('state `unknown` with CAP attributes is still an alert', ids.some((e) => /flood_advisory/.test(e)));
  check('each alert points at its own entity (for more-info and images)',
        c._alerts.every((a) => a._entity.includes(a._raw.event.toLowerCase().replace(' ', '_'))));
  check('source badge is the device name', c._alerts.every((a) => a._source === 'CAP Alerts NWS'));
  const t = c._alerts.find((a) => a._raw.event === 'Tornado Warning');
  check('time read from onset', t.time === '2026-10-02T10:00:00+00:00', t.time);
  check('url read from web', t.url === 'https://alerts.example/Tornado Warning', t.url);
  check('area read from area_desc', t.area === 'Cook County', t.area);
  check('id read from id', t._id === 'urn:Tornado Warning', t._id);
}

console.log('device name, explicit name, user mapping');
{
  const c = makeCard([{ device: 'dev-eccc' }]);
  check('name_by_user wins over the device name', c._alerts[0]._source === 'Canada', c._alerts[0]._source);
  const n = makeCard([{ device: 'dev-eccc', name: 'ECCC' }]);
  check('source.name wins over both', n._alerts[0]._source === 'ECCC');
  const m = makeCard([{ device: 'dev-nws', mapping: { area: 'description' } }]);
  check('a user mapping is read as given, no alias fallback',
        m._alerts.every((a) => a.area === `${a._raw.event} in effect`), m._alerts[0].area);
}

console.log('the same alert through two devices is one row');
{
  const c = makeCard([{ device: 'dev-nws' }, { device: 'dev-eccc' }]);
  const tornadoes = c._alerts.filter((a) => a._id === 'urn:Tornado Warning');
  check('one Tornado Warning row', tornadoes.length === 1, String(tornadoes.length));
  check('two rows in total', c._alerts.length === 2, String(c._alerts.length));
}

console.log('entity sources are unchanged');
{
  const c = makeCard([{ entity: 'sensor.legacy_feed' }]);
  const a = c._alerts[0];
  check('list attribute still read', c._alerts.length === 1 && a.title === 'Gale');
  check('starttime, url and area still read first', a.time.startsWith('2026-10-02T08') && a.url === 'https://legacy' && a.area === 'Coast');
  check('entity id is the source entity', a._entity === 'sensor.legacy_feed');
  check('source badge is the friendly name or id', a._source === 'legacy_feed');
}

console.log('_self on a named entity');
{
  const kept = makeCard([{ entity: 'sensor.cap_alerts_nws_cap_alert_flood_advisory_9a1b2c3d', attribute: '_self' }]);
  check('state unknown with a payload is an alert', kept._alerts.length === 1);
  const blank = makeCard([{ entity: 'sensor.blank_unknown', attribute: '_self' }]);
  check('state unknown with only housekeeping attributes is not', blank._alerts.length === 0);
}

console.log('device plus entity on one source');
{
  const c = makeCard([{ device: 'dev-nws', entity: 'sensor.legacy_feed', attribute: 'alerts' }]);
  check('attribute applies to both: device entities have no `alerts` attribute, the feed does',
        c._alerts.length === 1 && c._alerts[0].title === 'Gale', String(c._alerts.length));
}

console.log('refresh and dismiss bookkeeping know about devices');
{
  const c = makeCard([{ device: 'dev-nws' }]);
  const h = c._hass;
  const before = c._getEntityFingerprint(h);
  check('fingerprint names the device entities', before.includes('tornado_warning_1f0c6a62') && !before.includes('undefined:'));
  h.states['sensor.cap_alerts_nws_cap_alert_tornado_warning_1f0c6a62'].last_updated = 'later';
  check('an updated alert entity changes it', c._getEntityFingerprint(h) !== before);
  const mid = c._getEntityFingerprint(h);
  h.entities['sensor.new'] = { entity_id: 'sensor.new', device_id: 'dev-nws' };
  h.states['sensor.new'] = { state: 'severe', attributes: cap('Heat') };
  check('a new alert entity under the device changes it', c._getEntityFingerprint(h) !== mid);
  const kNws = c._deriveDismissKey([{ device: 'dev-nws' }]);
  const kEccc = c._deriveDismissKey([{ device: 'dev-eccc' }]);
  check('dismiss keys differ per device', kNws !== kEccc && kNws !== c._deriveDismissKey([{}]));
}

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('all device tests passed');
