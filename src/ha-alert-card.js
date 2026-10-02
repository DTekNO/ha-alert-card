/**
 * HA Alert Card
 * A Lovelace card that displays alerts from any entity with structured alert attributes.
 * Uses CAP (Common Alerting Protocol) field names as defaults — entities following CAP
 * work with zero mapping configuration.
 *
 * The version is injected at release time from the git tag — see
 * .github/workflows/release.yml.  Do not edit it by hand.
 */

const CARD_VERSION = '2026.7.2';

// Attribute consulted for each alert's inline image when a source does not name
// one. Overridable per source via image_attribute; disable images with show_image.
const DEFAULT_IMAGE_ATTRIBUTE = 'entity_picture';

// --- HTML escaping -----------------------------------------------------------
// Alert fields come from third-party feeds (USGS, NWS, RSS, ...) and are
// rendered into shadowRoot.innerHTML.  Every feed-derived value MUST pass
// through escapeHtml() on its way into markup (text and attribute contexts
// alike), so a feed item containing e.g. <img src=x onerror=...> renders as
// inert text instead of executing in the Home Assistant frontend.
//
// Deliberately NOT escaped: the expandable detail (formatted_content), which
// is assigned to <ha-markdown>.content as a property — ha-markdown renders it
// with Home Assistant's own markdown sanitizer, preserving the intended
// formatting (NWS bullet lists etc.) without allowing raw HTML through.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Image URLs from feeds may only use safe schemes: http(s), protocol-relative,
// site-relative, or inline data:image.  Anything else (javascript:, etc.)
// renders no image at all.
function safeImageUrl(url) {
  const s = String(url ?? '').trim();
  if (/^(https?:)?\/\//i.test(s) || (s.startsWith('/') && !s.startsWith('//')) || /^data:image\//i.test(s)) {
    return s;
  }
  return '';
}

// CAP-standard default field mapping
const DEFAULT_MAPPING = {
  title: 'event',           // CAP: <event> — short alert type name
  message: 'description',   // CAP: <description>
  severity: 'severity',     // CAP: <severity> (Extreme/Severe/Moderate/Minor)
  time: 'starttime',        // CAP: <effective>
  id: 'id',                 // unique identifier for dismiss tracking
  url: 'url',              // link to more details
  area: 'area',            // CAP: <areaDesc>
  instruction: 'instruction', // CAP: <instruction>
};

// Field names tried in order when the user has not mapped a field. CAP
// integrations disagree on three names: single-sensor feeds publish
// starttime, url and area; per-alert-entity ones (cap_alerts) publish the
// CAP originals onset, web and area_desc.
const DEFAULT_FIELD_ALIASES = {
  time: ['starttime', 'onset', 'effective'],
  url: ['url', 'web'],
  area: ['area', 'area_desc', 'areaDesc'],
};

// Attributes every HA entity may carry regardless of payload. An entity in
// state `unknown` with nothing beyond these has no alert to show.
const HOUSEKEEPING_ATTRS = new Set([
  'friendly_name', 'icon', 'device_class', 'state_class', 'unit_of_measurement',
  'attribution', 'entity_picture', 'supported_features', 'restored',
]);

// Default severity → color mapping (supports CAP severity values + common alternatives)
const DEFAULT_SEVERITY_COLORS = {
  // CAP standard severity values
  extreme: '#db4437',
  severe: '#ff5722',
  moderate: '#ff9800',
  minor: '#fdd835',
  unknown: '#9e9e9e',
  // Norwegian alert levels (norway_alerts)
  red: '#db4437',
  orange: '#ff9800',
  yellow: '#fdd835',
  green: '#4caf50',
  // Generic
  critical: '#db4437',
  high: '#ff5722',
  medium: '#ff9800',
  low: '#fdd835',
  info: '#2196f3',
  // Entur SX statuses
  open: '#ff9800',
  planned: '#2196f3',
};

// Severity sort order (higher = more severe)
const SEVERITY_ORDER = {
  extreme: 100, red: 100, critical: 100,
  severe: 80, high: 80,
  moderate: 60, orange: 60, medium: 60,
  minor: 40, yellow: 40, low: 40,
  info: 20, planned: 20, green: 10,
  unknown: 0,
};

class HaAlertCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._alerts = [];
    this._dismissedAlerts = []; // dismissed but still present in entity
    this._totalUndismissed = 0;
    this._knownIds = new Set(); // all IDs ever seen by this card instance (session)
    this._dismissed = new Set();
    this._expanded = new Set();
    this._showDismissed = false;
    this._config = {};
    this._hass = null;
    this._dismissedLoaded = false;
    this._lastSyncTime = 0;     // timestamp of last _syncDismissed call
    this._lastEntityStates = null; // fingerprint of last seen entity states
  }

  static get properties() {
    return { hass: {}, config: {} };
  }

  static getConfigElement() {
    return document.createElement('ha-alert-card-editor');
  }

  static getStubConfig() {
    return {
      sources: [],
      title: 'Alerts',
    };
  }

  connectedCallback() {
    // Re-render when the URL changes (e.g. ?edit=1 added/removed).
    // HA fires 'location-changed' on every navigation; popstate covers
    // the browser back/forward case.
    // Defer by one animation frame so the URL is fully updated before
    // we check window.location.search.
    this._onLocationChanged = () => {
      requestAnimationFrame(() => {
        if (this._hass) {
          this._updateAlerts();
          this._render();
        }
      });
    };
    window.addEventListener('location-changed', this._onLocationChanged);
    window.addEventListener('popstate', this._onLocationChanged);
  }

  disconnectedCallback() {
    window.removeEventListener('location-changed', this._onLocationChanged);
    window.removeEventListener('popstate', this._onLocationChanged);
  }

  set hass(hass) {
    const firstHass = !this._hass;
    const nowEdit = this._inEditMode();
    const editModeChanged = nowEdit !== this._wasEditMode;
    this._wasEditMode = nowEdit;
    this._hass = hass;
    if (firstHass && this._config.dismiss_key) {
      // Load per-user dismissed state from HA on first hass, then render.
      this._loadDismissed().then(() => {
        this._updateAlerts();
        this._render();
      });
    } else if (this._dismissedLoaded) {
      const stateFingerprint = this._getEntityFingerprint(hass);
      const entitiesChanged = stateFingerprint !== this._lastEntityStates;
      if (entitiesChanged) this._lastEntityStates = stateFingerprint;

      // Throttle cross-device dismissed sync to once per 10 seconds,
      // independent of whether entities changed.
      const now = Date.now();
      const shouldSync = now - this._lastSyncTime > 10000;
      if (shouldSync) this._lastSyncTime = now;

      const syncPromise = shouldSync ? this._syncDismissed() : Promise.resolve(false);

      syncPromise.then((dismissedChanged) => {
        if (entitiesChanged || dismissedChanged || editModeChanged) {
          this._updateAlerts();
          this._render();
        }
      });
    }
  }

  setConfig(config) {
    if (!config.sources || !Array.isArray(config.sources) || config.sources.length === 0) {
      throw new Error('Please define at least one source');
    }
    this._config = {
      title: config.title || 'Alerts',
      sources: config.sources,
      severity_colors: { ...DEFAULT_SEVERITY_COLORS, ...(config.severity_colors || {}) },
      max_items: config.max_items || 20,
      show_dismiss: config.show_dismiss !== false,
      show_source_badge: config.show_source_badge !== false,
      show_area: config.show_area !== false,
      show_time: config.show_time !== false,
      show_image: config.show_image !== false,
      hide_when_no_alerts: config.hide_when_no_alerts || false,
      hide_when_all_dismissed: config.hide_when_all_dismissed || false,
      // One line per alert — thumbnail, title over a one-line qualifier, source and
      // time at the right. For dense lists in a sections grid; see _renderAlert.
      compact: config.compact || false,
      sort_by: config.sort_by || 'severity',
      tap_action: config.tap_action || { action: 'none' },
      hold_action: config.hold_action || {},
      dismiss_key: config.dismiss_key || this._deriveDismissKey(config.sources),
      ...config,
    };
    if (this._hass) {
      // Re-config while running — reload dismissed state then re-render.
      this._loadDismissed().then(() => {
        this._updateAlerts();
        this._render();
      });
    }
  }

  getCardSize() {
    return Math.min(this._alerts.length + 1, 6);
  }

  getGridOptions() {
    // Each row ≈ 56px. Header ≈ 1 row, each alert ≈ 1 row.
    const alertCount = this._alerts ? this._alerts.length : 0;
    const rows = Math.max(2, Math.min(alertCount + 1, 8));
    return {
      rows,
      columns: "full",
      min_rows: 2,
      max_rows: 8,
      min_columns: 6,
    };
  }

  // --- Data Layer ---

  _getEntityFingerprint(hass) {
    // Returns a string that changes only when one of our source entities
    // changes. A device source covers whichever entities are under the device
    // right now, so one appearing or vanishing changes it too.
    if (!this._config.sources) return '';
    const stamp = (id) => {
      const state = hass.states[id];
      return `${id}:${state ? state.last_updated : 'missing'}`;
    };
    return this._config.sources.map(s => {
      const parts = [];
      if (s.device) {
        for (const reg of Object.values(hass.entities || {})) {
          if (reg.device_id === s.device) parts.push(stamp(reg.entity_id));
        }
        if (!parts.length) parts.push(`${s.device}:none`);
      }
      if (s.entity) parts.push(stamp(s.entity));
      return parts.join('|');
    }).join('|');
  }

  _deriveDismissKey(sources) {
    // Stable key derived from sorted entity (or device) IDs — unique per card
    // config, consistent across reloads, no manual configuration needed.
    const ids = sources.map(s => s.entity || (s.device ? `device:${s.device}` : '')).sort().join(',');
    let hash = 0;
    for (let i = 0; i < ids.length; i++) {
      hash = (Math.imul(31, hash) + ids.charCodeAt(i)) | 0;
    }
    return `ha-alert-card-${(hash >>> 0).toString(36)}`;
  }

  async _syncDismissed() {
    // Re-fetch server state and update local if it differs.
    // Returns true if the dismissed set changed (so caller can decide to re-render).
    if (!this._hass) return false;
    try {
      const result = await this._hass.callWS({
        type: 'frontend/get_user_data',
        key: this._config.dismiss_key,
      });
      const serverIds = result?.value ?? [];
      const serverSet = new Set(serverIds);
      const localIds = [...this._dismissed];
      const changed = serverSet.size !== this._dismissed.size ||
        serverIds.some(id => !this._dismissed.has(id)) ||
        localIds.some(id => !serverSet.has(id));
      if (changed) this._dismissed = serverSet;
      return changed;
    } catch { return false; }
  }

  async _loadDismissed() {
    if (!this._hass) return;
    try {
      const result = await this._hass.callWS({
        type: 'frontend/get_user_data',
        key: this._config.dismiss_key,
      });
      if (result?.value) {
        this._dismissed = new Set(result.value);
      } else {
        // Migrate from localStorage on first use.
        const legacy = localStorage.getItem(this._config.dismiss_key);
        this._dismissed = legacy ? new Set(JSON.parse(legacy)) : new Set();
        if (legacy) {
          // Save migrated state to HA and remove legacy entry.
          await this._saveDismissed();
          localStorage.removeItem(this._config.dismiss_key);
        }
      }
    } catch {
      this._dismissed = new Set();
    }
    this._dismissedLoaded = true;
  }

  _saveDismissed() {
    if (!this._hass) return Promise.resolve();
    return this._hass.callWS({
      type: 'frontend/set_user_data',
      key: this._config.dismiss_key,
      value: [...this._dismissed],
    }).catch(() => {});
  }

  _updateAlerts() {
    if (!this._hass || !this._config.sources) return;

    const allAlerts = [];
    const dismissedAlerts = [];
    const seenIds = new Set();

    for (const source of this._config.sources) {
      const mapping = { ...DEFAULT_MAPPING, ...(source.mapping || {}) };
      const userMapped = source.mapping || {};
      // A field the user mapped is read exactly as given; an unmapped one
      // tries each default name in turn.
      const field = (item, key) => {
        if (userMapped[key]) return this._resolveField(item, userMapped[key]);
        for (const name of DEFAULT_FIELD_ALIASES[key] || [DEFAULT_MAPPING[key]]) {
          const v = this._resolveField(item, name);
          if (v !== undefined && v !== null && v !== '') return v;
        }
        return undefined;
      };
      const sourceIdx = this._config.sources.indexOf(source);
      const filterExpired = source.filter_expired !== false; // default true

      for (const { entityId, items, sourceName } of this._collectSourceItems(source)) {
      for (const item of items) {
        // Filter expired/closed alerts
        if (filterExpired) {
          const status = (field(item, 'severity') || '').toLowerCase();
          if (status === 'expired' || status === 'closed') continue;

          // Also check valid_to timestamp if present
          const validTo = item.valid_to || this._resolveField(item, 'valid_to');
          if (validTo) {
            const expiry = new Date(validTo).getTime();
            if (!isNaN(expiry) && expiry < Date.now()) continue;
          }
        }

        const alertId = String(field(item, 'id') || this._hashAlert(item, mapping));

        // The same alert reaching the card twice — through two devices, or
        // two sources on one feed — is one row.
        if (seenIds.has(alertId)) continue;
        seenIds.add(alertId);

        const alertObj = {
          _id: alertId,
          _sourceIdx: sourceIdx,
          _source: sourceName,
          _entity: entityId,
          _raw: item,
          title: field(item, 'title') || this._hass.states[entityId]?.attributes?.friendly_name || 'Alert',
          message: field(item, 'message') || '',
          severity: (field(item, 'severity') || 'unknown').toLowerCase(),
          time: field(item, 'time') || '',
          url: field(item, 'url') || '',
          area: field(item, 'area') || '',
          instruction: field(item, 'instruction') || '',
        };

        if (this._dismissed.has(alertId)) {
          dismissedAlerts.push(alertObj);
        } else {
          allAlerts.push(alertObj);
        }
      }
      }
    }

    // Accumulate all seen IDs into knownIds for this card instance.
    for (const id of seenIds) this._knownIds.add(id);

    // Prune dismissed IDs that this card has seen before but are now gone
    // (alert expired/removed from entity). Only prune IDs known to THIS card
    // — prevents cross-card interference when multiple cards share the same
    // localStorage key (e.g. earthquake card pruning norway alert IDs).
    if (seenIds.size > 0) {
      let pruned = false;
      for (const id of this._dismissed) {
        if (this._knownIds.has(id) && !seenIds.has(id)) {
          this._dismissed.delete(id);
          pruned = true;
        }
      }
      if (pruned) this._saveDismissed();
    }

    // Sort
    const sortFn = this._config.sort_by === 'time'
      ? (a, b) => {
          const ta = new Date(a.time || 0).getTime();
          const tb = new Date(b.time || 0).getTime();
          return tb - ta;
        }
      : (a, b) => {
          const sa = SEVERITY_ORDER[a.severity] || 0;
          const sb = SEVERITY_ORDER[b.severity] || 0;
          if (sb !== sa) return sb - sa;
          const ta = new Date(a.time || 0).getTime();
          const tb = new Date(b.time || 0).getTime();
          return tb - ta;
        };

    // Sort independently. max_items caps only the undismissed visible window —
    // dismissing an alert reveals the next one (dismiss-as-paging).
    allAlerts.sort(sortFn);
    dismissedAlerts.sort(sortFn);
    this._totalUndismissed = allAlerts.length;
    this._alerts = allAlerts.slice(0, this._config.max_items);
    this._dismissedAlerts = dismissedAlerts;
  }

  _resolveField(item, fieldPath) {
    if (!fieldPath) return undefined;
    // Support dot notation for nested fields
    const parts = fieldPath.split('.');
    let value = item;
    for (const part of parts) {
      if (value == null) return undefined;
      value = value[part];
    }
    return value;
  }

  // A source names one entity, or a device, or both. Under a device every
  // non-diagnostic entity is read, gathered afresh each refresh: integrations
  // that create one entity per alert (cap_alerts, NINA) add and remove them
  // every poll, so a hand-listed entity id would be stale within the hour.
  // Returns [{ entityId, items, sourceName }], one per entity with alerts.
  _collectSourceItems(source) {
    const out = [];
    const attribute = source.attribute || (source.device ? '_self' : 'alerts');
    const add = (entityId, sourceName) => {
      const entity = this._hass.states[entityId];
      if (!entity) return;
      const items = this._itemsFromEntity(entity, attribute);
      if (items) out.push({ entityId, items, sourceName });
    };
    if (source.device) {
      const device = this._hass.devices?.[source.device];
      const deviceName = source.name || device?.name_by_user || device?.name || source.device;
      for (const reg of Object.values(this._hass.entities || {})) {
        // Config and diagnostic entities (counts, refresh buttons) never carry an alert.
        if (reg.device_id !== source.device || reg.entity_category) continue;
        add(reg.entity_id, deviceName);
      }
    }
    if (source.entity) {
      const entity = this._hass.states[source.entity];
      add(source.entity,
        source.name || entity?.attributes?.friendly_name || source.entity.split('.').pop());
    }
    return out;
  }

  // The alert items one entity contributes: the list (or single object) in
  // `attribute`, or with `_self` the entity's own attributes as one alert.
  // null means nothing to show.
  _itemsFromEntity(entity, attribute) {
    if (attribute === '_self') {
      const state = (entity.state || '').toLowerCase();
      const skipStates = ['normal', '0', 'unavailable', 'unknown', 'none', 'ok', 'idle'];
      if (!skipStates.includes(state)) return [entity.attributes];
      // `unknown` doubles as a CAP severity. An entity in that state whose
      // attributes carry more than HA's housekeeping is an alert, not a blank.
      const hasPayload = state === 'unknown' &&
        Object.keys(entity.attributes || {}).some((k) => !HOUSEKEEPING_ATTRS.has(k));
      return hasPayload ? [entity.attributes] : null;
    }
    const raw = entity.attributes[attribute];
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return [raw];
    return null;
  }

  _hashAlert(item, mapping) {
    // Generate a stable ID from content when no ID field exists
    const title = this._resolveField(item, mapping.title) || '';
    const time = this._resolveField(item, mapping.time) || '';
    return `${title}-${time}`.replace(/\s+/g, '-').substring(0, 64);
  }

  // --- Actions ---

  _dismissAlert(alertId, event) {
    event.stopPropagation();
    this._dismissed.add(alertId);
    this._saveDismissed();
    this._updateAlerts();
    this._render();
  }

  _dismissAll() {
    for (const alert of this._alerts) {
      this._dismissed.add(alert._id);
    }
    this._saveDismissed();
    this._updateAlerts();
    this._render();
  }

  _restoreAlert(alertId) {
    this._dismissed.delete(alertId);
    this._saveDismissed();
    this._updateAlerts();
    this._render();
  }

  _restoreAll() {
    this._dismissed.clear();
    this._saveDismissed();
    this._updateAlerts();
    this._render();
  }

  _toggleExpand(alertId) {
    if (this._expanded.has(alertId)) {
      this._expanded.delete(alertId);
    } else {
      this._expanded.add(alertId);
    }
    this._render();
  }

  _handleTap(alert) {
    const source = this._config.sources?.[alert._sourceIdx];
    const tapAction = source?.tap_action?.action ? source.tap_action : (this._config.tap_action || {});
    this._executeAction(tapAction, alert);
  }

  _handleHold(alert) {
    const source = this._config.sources?.[alert._sourceIdx];
    const holdAction = source?.hold_action?.action ? source.hold_action : (this._config.hold_action || {});
    if (holdAction.action) {
      this._executeAction(holdAction, alert);
    }
  }

  _executeAction(actionConfig, alert) {
    const action = actionConfig.action || 'default';

    switch (action) {
      case 'more-info': {
        const event = new CustomEvent('hass-more-info', {
          bubbles: true, composed: true,
          detail: { entityId: alert._entity },
        });
        this.dispatchEvent(event);
        break;
      }
      case 'navigate': {
        const path = actionConfig.navigation_path;
        if (path) {
          window.history.pushState(null, '', path);
          window.dispatchEvent(new Event('location-changed'));
        }
        break;
      }
      case 'url': {
        const url = actionConfig.url_path;
        if (url) window.open(url, '_blank', 'noopener');
        break;
      }
      case 'none':
        // 'none' suppresses navigation but still allows expand/collapse
        this._toggleExpand(alert._id);
        break;
      case 'default':
      default:
        // Default behavior: URL in alert → navigate/open, else expand
        if (alert.url) {
          if (alert.url.startsWith('/')) {
            window.history.pushState(null, '', alert.url);
            window.dispatchEvent(new Event('location-changed'));
          } else if (/^https?:\/\//i.test(alert.url)) {
            // strict scheme check: feed-supplied URLs may only open http(s)
            window.open(alert.url, '_blank', 'noopener');
          } else {
            const event = new CustomEvent('hass-more-info', {
              bubbles: true, composed: true,
              detail: { entityId: alert._entity },
            });
            this.dispatchEvent(event);
          }
        } else {
          this._toggleExpand(alert._id);
        }
        break;
    }
  }

  // --- Time Formatting ---

  _formatTime(isoString) {
    if (!isoString) return '';
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return isoString;

      const now = new Date();
      const diffMs = now - date;
      const diffMin = Math.floor(diffMs / 60000);
      const diffHrs = Math.floor(diffMs / 3600000);

      // Future timestamps
      if (diffMs < 0) {
        const absDiffMs = -diffMs;
        const absDiffMin = Math.floor(absDiffMs / 60000);
        const absDiffHrs = Math.floor(absDiffMs / 3600000);
        const absDiffDays = Math.floor(absDiffMs / 86400000);
        if (absDiffMin < 60) return `in ${absDiffMin}m`;
        if (absDiffHrs < 24) return `in ${absDiffHrs}h`;
        if (absDiffDays === 1) return 'Tomorrow';
        if (absDiffDays < 7) return `in ${absDiffDays}d`;
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }

      // Past timestamps
      if (diffMin < 1) return 'Just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      if (diffHrs < 24) return `${diffHrs}h ago`;

      const diffDays = Math.floor(diffMs / 86400000);
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays}d ago`;

      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  // --- Rendering ---

  _getSeverityColor(severity) {
    return this._config.severity_colors[severity] || this._config.severity_colors['unknown'] || '#9e9e9e';
  }

  // Detect Lovelace edit mode.  HA does NOT push a "dashboard is being edited"
  // flag to cards (element.editMode/preview is only true in the card-editor
  // dialog preview), and the sections view has no `hui-card-options` wrapper and
  // no `?edit=1` URL.  The one reliable signal is the Lovelace root's editMode,
  // so we walk up through shadow roots to find `hui-root` and read it.
  _inEditMode() {
    // Card-editor dialog preview (HA assigns these on the element).
    if (this.editMode === true || this.preview === true) return true;
    // Masonry edit wrapper.
    try { if (this.closest('hui-card-options')) return true; } catch (e) {}
    // Walk up (crossing shadow boundaries) to the Lovelace root.
    let node = this;
    for (let i = 0; i < 30 && node; i++) {
      const parent = node.parentNode;
      // A ShadowRoot (nodeType 11) exposes its host; otherwise step to parent.
      node = (parent && parent.nodeType === 11) ? parent.host : parent;
      if (node && node.lovelace && typeof node.lovelace.editMode === 'boolean') {
        return node.lovelace.editMode;
      }
    }
    return false;
  }

  _renderEditPlaceholder(reason) {
    return `
      <ha-card class="edit-placeholder">
        <div class="empty-state">
          <ha-icon icon="mdi:bell-sleep-outline"></ha-icon>
          <div class="edit-placeholder-title">${this._config.title}</div>
          <div class="edit-hint">Hidden here (${reason})<br>shown only while editing</div>
        </div>
      </ha-card>
    `;
  }

  /**
   * Tell Home Assistant to keep this element in the DOM while it is hidden.
   *
   * hui-card removes a hidden card element from the tree unless it asks to stay.
   * Staying costs nothing here — the card has no timers, only hass-driven renders —
   * and it avoids a disconnect/reconnect cycle on every hide, which would tear down
   * and rebuild the location listeners each time an alert list emptied.
   */
  get connectedWhileHidden() {
    return true;
  }

  /**
   * Hide or show the card the way the sections grid can see.
   *
   * Setting our own style.display hid the element but not the hui-card wrapper
   * around it, and the wrapper is what owns the grid cell: with a fixed
   * grid_options.rows the section kept the cell reserved and showed a blank block
   * the size of the card (reported 23.09.2026). hui-card reads the element's
   * `hidden` property and, on `card-visibility-changed`, hides *itself* — which is
   * what hui-grid-section's `.card:has(> *[hidden])` rule collapses.
   */
  _setHidden(hide) {
    if (this.hidden === hide) return;
    this.hidden = hide;
    this.dispatchEvent(new Event('card-visibility-changed', { bubbles: true, composed: true }));
  }

  _render() {
    if (!this.shadowRoot) return;

    const alertCount = this._alerts.length;
    const dismissedCount = this._dismissedAlerts.length;

    // Visibility toggles.  In edit mode the card must stay visible & grabbable,
    // so instead of hiding we render a clean placeholder (see below).
    const inEditMode = this._inEditMode();
    const totalAlerts = alertCount + dismissedCount;
    const wouldHide =
      (this._config.hide_when_no_alerts && totalAlerts === 0) ||
      (this._config.hide_when_all_dismissed && totalAlerts > 0 && alertCount === 0);

    if (wouldHide) {
      if (!inEditMode) {
        // Not editing — genuinely hide the card, and its grid cell with it.
        this._setHidden(true);
        return;
      }
      // Editing — show a tidy placeholder frame instead of the full/cluttered
      // card, so it stays selectable without exposing the empty header or the
      // expanded dismissed list.
      this._setHidden(false);
      const reason = (this._config.hide_when_no_alerts && totalAlerts === 0)
        ? 'no active alerts'
        : 'all alerts dismissed';
      this.shadowRoot.innerHTML = `
        <style>${this._getStyles()}</style>
        ${this._renderEditPlaceholder(reason)}
      `;
      return;
    }
    this._setHidden(false);

    // Respect the user's dismissed toggle even while editing.  Forcing it open
    // in edit mode expanded the whole dismissed list, which looked cluttered;
    // the card still stays visible in edit mode via the hide-guards above, so
    // it remains grabbable/configurable while showing the clean empty state.
    const showDismissed = this._showDismissed;

    // The card is rebuilt from a template on every render, which throws the
    // scrolling list away and recreates it at the top. Expanding an entry
    // halfway down, or a feed update arriving while reading, snapped the list
    // back to the first alert. Carry the scroll position across the rebuild.
    const scrollTop = this.shadowRoot.querySelector('.alert-list')?.scrollTop || 0;

    this.shadowRoot.innerHTML = `
      <style>${this._getStyles()}</style>
      <ha-card class="${this._config.compact ? 'compact' : ''}">
        <div class="card-header">
          <div class="card-header-left">
            <ha-icon icon="mdi:bell-alert-outline"></ha-icon>
            <span class="card-title">${escapeHtml(this._config.title)}</span>
            ${alertCount > 0 ? `<span class="badge">${alertCount}${this._totalUndismissed > alertCount ? ` of ${this._totalUndismissed}` : ''}</span>` : ''}
          </div>
          <div class="card-header-right">
            ${dismissedCount > 0 ? `
              <span class="toggle-dismissed" id="toggleDismissed" title="${showDismissed ? 'Hide' : 'Show'} dismissed">
                <ha-icon icon="mdi:${showDismissed ? 'eye-off' : 'eye'}"></ha-icon>
                <span>${dismissedCount}</span>
              </span>
            ` : ''}
            ${alertCount > 0 && this._config.show_dismiss ? `
              <span class="dismiss-all" id="dismissAll">${this._totalUndismissed > alertCount ? 'Dismiss visible' : 'Dismiss all'}</span>
            ` : ''}
          </div>
        </div>
        <div class="alert-list">
          ${alertCount === 0 && (!showDismissed || dismissedCount === 0) ? this._renderEmpty() : ''}
          ${this._alerts.map(a => this._renderAlert(a)).join('')}
          ${showDismissed && dismissedCount > 0 ? `
            <div class="dismissed-section">
              <div class="dismissed-header">
                <span>Dismissed (${dismissedCount})</span>
                <span class="restore-all" id="restoreAll">Restore all</span>
              </div>
              ${this._dismissedAlerts.map(a => this._renderDismissedAlert(a)).join('')}
            </div>
          ` : ''}
        </div>
      </ha-card>
    `;

    if (scrollTop) {
      // ha-card is a Lit element: its slot does not exist until its first
      // update, a microtask away, so right now the new list has no layout box
      // and an immediate scrollTop assignment is silently dropped. Restore once
      // the card has rendered, and once more a frame later for images that
      // were still sizing (the list is shorter until they have).
      const list = this.shadowRoot.querySelector('.alert-list');
      const card = this.shadowRoot.querySelector('ha-card');
      const restore = () => { if (list?.isConnected !== false) list.scrollTop = scrollTop; };
      (card?.updateComplete ?? Promise.resolve()).then(() => {
        restore();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
      });
    }

    // Attach event listeners
    this.shadowRoot.getElementById('dismissAll')?.addEventListener('click', () => this._dismissAll());
    this.shadowRoot.getElementById('toggleDismissed')?.addEventListener('click', () => {
      this._showDismissed = !this._showDismissed;
      this._render();
    });
    this.shadowRoot.getElementById('restoreAll')?.addEventListener('click', () => this._restoreAll());

    // Set content property on ha-markdown elements (can't be done via innerHTML attribute)
    this.shadowRoot.querySelectorAll('ha-markdown[data-content]').forEach((el) => {
      const alertId = el.dataset.content;
      const alert = this._alerts.find(a => a._id === alertId);
      if (!alert) return;
      const source = this._config.sources?.[alert._sourceIdx];
      const detailAttr = source?.detail_attribute || 'formatted_content';
      const detailContent = this._resolveField(alert._raw, detailAttr)
        ?? this._hass?.states?.[alert._entity]?.attributes?.[detailAttr];
      if (detailContent) el.content = String(detailContent);
    });

    this.shadowRoot.querySelectorAll('.alert-item').forEach((el) => {
      const alertId = el.dataset.alertId;
      const alert = this._alerts.find(a => a._id === alertId);
      if (!alert) return;

      // Tap
      el.addEventListener('click', () => this._handleTap(alert));

      // Hold (long press)
      let holdTimer = null;
      let held = false;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        held = false;
        holdTimer = setTimeout(() => {
          held = true;
          this._handleHold(alert);
        }, 500);
      });
      el.addEventListener('pointerup', () => { clearTimeout(holdTimer); });
      el.addEventListener('pointercancel', () => { clearTimeout(holdTimer); });
      el.addEventListener('click', (e) => { if (held) { e.stopImmediatePropagation(); held = false; } }, true);

      const dismissBtn = el.querySelector('.dismiss-btn');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => this._dismissAlert(alertId, e));
      }
    });

    this.shadowRoot.querySelectorAll('.dismissed-item .restore-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const alertId = btn.closest('.dismissed-item').dataset.alertId;
        this._restoreAlert(alertId);
      });
    });
  }

  _renderEmpty() {
    return `
      <div class="empty-state">
        <ha-icon icon="mdi:check-circle-outline"></ha-icon>
        <div>No active alerts</div>
      </div>
    `;
  }

  _renderDismissedAlert(alert) {
    const color = this._getSeverityColor(alert.severity);
    // color is safe: a lookup VALUE from config/default maps (the feed-derived
    // severity is only used as the lookup key).  Everything else is escaped.
    return `
      <div class="dismissed-item" data-alert-id="${escapeHtml(alert._id)}">
        <div class="severity-bar" style="background: ${color}; opacity: 0.4"></div>
        <div class="alert-content">
          <div class="alert-title">${escapeHtml(alert.title)}</div>
          ${alert.message ? `<div class="alert-message">${escapeHtml(alert.message)}</div>` : ''}
        </div>
        <div class="restore-btn" title="Restore">
          <ha-icon icon="mdi:restore"></ha-icon>
        </div>
      </div>
    `;
  }

  _renderAlert(alert) {
    const isExpanded = this._expanded.has(alert._id);
    const color = this._getSeverityColor(alert.severity);
    const timeStr = this._formatTime(alert.time);
    const source = this._config.sources?.[alert._sourceIdx];
    // entity_picture is the default: almost every entity that has a meaningful
    // image exposes it there, so the common case should need no configuration.
    // Set image_attribute to name a different one (travel_tag, an icon URL, …);
    // use show_image: false to turn images off entirely.
    const imageAttr = source?.image_attribute || DEFAULT_IMAGE_ATTRIBUTE;
    const imageUrl =
      alert._raw?.[imageAttr] ?? this._hass?.states?.[alert._entity]?.attributes?.[imageAttr];
    const safeImg = this._config.show_image && imageUrl ? safeImageUrl(imageUrl) : '';

    // color is safe: a lookup VALUE from config/default maps (the feed-derived
    // severity is only used as the lookup key).  All feed-derived values —
    // including _id (attribute context) and timeStr (falls back to the raw
    // feed string when unparseable) — are escaped.
    return `
      <div class="alert-item ${isExpanded ? 'expanded' : ''}" data-alert-id="${escapeHtml(alert._id)}">
        <div class="severity-bar" style="background: ${color}"></div>
        <div class="alert-content">
          ${this._config.compact ? this._renderCompactRow(alert, safeImg, timeStr, isExpanded) : `
          <div class="alert-top-row">
            ${safeImg ? `<img class="alert-image" src="${escapeHtml(safeImg)}" alt="" />` : ''}
            ${this._config.show_source_badge ? `<span class="alert-source">${escapeHtml(alert._source)}</span>` : ''}
            ${this._config.show_area && alert.area ? `<span class="alert-area">${escapeHtml(alert.area)}</span>` : ''}
            ${this._config.show_time && timeStr ? `<span class="alert-time">${escapeHtml(timeStr)}</span>` : ''}
          </div>
          <div class="alert-title">${escapeHtml(alert.title)}</div>
          ${alert.message ? `<div class="alert-message">${escapeHtml(alert.message)}</div>` : ''}`}
          ${isExpanded && alert.instruction ? `
            <div class="alert-instruction">
              <strong>Instruction:</strong> ${escapeHtml(alert.instruction)}
            </div>
          ` : ''}
          ${isExpanded ? (() => {
            const source = this._config.sources?.[alert._sourceIdx];
            const detailAttr = source?.detail_attribute || 'formatted_content';
            const detailContent = this._resolveField(alert._raw, detailAttr)
              ?? this._hass?.states?.[alert._entity]?.attributes?.[detailAttr];
            if (detailContent) {
              return `<ha-markdown class="alert-formatted-content" data-content="${escapeHtml(alert._id)}"></ha-markdown>`;
            }
            return '';
          })() : ''}
        </div>
        <div class="alert-actions">
          ${this._config.show_dismiss ? `
            <div class="dismiss-btn" title="Dismiss">
              <ha-icon icon="mdi:close"></ha-icon>
            </div>
          ` : ''}
          <div class="chevron">
            <ha-icon icon="${alert.url ? 'mdi:chevron-right' : (isExpanded ? 'mdi:chevron-up' : 'mdi:chevron-down')}"></ha-icon>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * The collapsed row in compact mode: one line of layout, two lines of text.
   *
   *   [thumb]  Title                SOURCE  area  2m ago  ⌄
   *            message (one line, ellipsised)
   *
   * Each field keeps its meaning. `message` is description, so it is the subtitle;
   * `area` is a place — a county, a line, a detector's station — so it sits with the
   * source badge and the time, where a place belongs. That makes the logically
   * correct mapping the one that renders best: the BirdNET card had been putting its
   * station into the source *name* because the normal layout shows `area` in a row
   * above the title, where a location looked wrong; here it needs no such workaround.
   * The full message appears below the row when expanded, so nothing is lost, only
   * deferred. Designed in a markdown-card prototype 30.09.2026.
   */
  _renderCompactRow(alert, safeImg, timeStr, isExpanded) {
    // Entur maps `area` to the disruption summary, which is also the title, so the
    // meta cell repeated the headline beside a badge that already named the line.
    // An area that only restates the title carries nothing; drop it.
    const area = this._config.show_area && alert.area && alert.area !== alert.title
      ? alert.area : '';
    return `
          <div class="alert-row">
            ${safeImg ? `<img class="alert-image" src="${escapeHtml(safeImg)}" alt="" />` : ''}
            <div class="alert-text">
              <div class="alert-title">${escapeHtml(alert.title)}</div>
              ${alert.message ? `<div class="alert-subtitle">${escapeHtml(alert.message)}</div>` : ''}
            </div>
            <div class="alert-meta">
              ${this._config.show_source_badge ? `<span class="alert-source">${escapeHtml(alert._source)}</span>` : ''}
              ${area ? `<span class="alert-area">${escapeHtml(area)}</span>` : ''}
              ${this._config.show_time && timeStr ? `<span class="alert-time">${escapeHtml(timeStr)}</span>` : ''}
            </div>
          </div>
          ${isExpanded && alert.message ? `<div class="alert-message">${escapeHtml(alert.message)}</div>` : ''}`;
  }

  _getStyles() {
    return `
      /* Belt and braces: hui-card hides its wrapper when we set the hidden
         property, but if anything ever renders this element bare, the UA's
         [hidden] rule must not lose to the :host display below. */
      :host([hidden]) {
        display: none !important;
      }
      :host {
        --alert-card-badge-bg: var(--error-color, #db4437);
        display: block;
        height: 100%;
        width: 100%;
        max-width: 100%;
        max-height: 100%;
        box-sizing: border-box;
        overflow: hidden;
      }
      ha-card {
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        box-sizing: border-box;
        overflow: hidden;
      }
      .card-header {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 16px 12px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .card-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
        /* The inline bell's baseline gap used to set this row's height; when the bell
           became a flex box the header lost those pixels and read as cramped. */
        min-height: 24px;
      }
      .card-header-left ha-icon {
        /* ha-icon is inline by default, so its box follows the line box and the
           baseline gap left the bell sitting a few px below the title's centre. */
        display: flex;
        --mdc-icon-size: 20px;
        color: var(--primary-text-color);
        opacity: 0.8;
      }
      .card-title {
        font-size: var(--ha-font-size-l, 16px);
        font-weight: 500;
        color: var(--primary-text-color);
      }
      .badge {
        background: var(--alert-card-badge-bg);
        color: white;
        font-size: var(--ha-font-size-xs, 11px);
        font-weight: 600;
        padding: 2px 7px;
        border-radius: 10px;
        min-width: 20px;
        text-align: center;
      }
      .card-header-right {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dismiss-all {
        color: var(--secondary-text-color);
        font-size: var(--ha-font-size-s, 12px);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.2s;
      }
      .dismiss-all:hover {
        color: var(--primary-text-color);
        background: var(--secondary-background-color);
      }
      .toggle-dismissed {
        display: flex;
        align-items: center;
        gap: 4px;
        color: var(--secondary-text-color);
        font-size: var(--ha-font-size-s, 12px);
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.2s;
      }
      .toggle-dismissed:hover {
        color: var(--primary-text-color);
        background: var(--secondary-background-color);
      }
      .toggle-dismissed ha-icon {
        --mdc-icon-size: 16px;
      }

      /* Alert List */
      .alert-list {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--divider-color, #ccc) transparent;
      }
      .alert-list::-webkit-scrollbar {
        width: 6px;
      }
      .alert-list::-webkit-scrollbar-track {
        background: transparent;
      }
      .alert-list::-webkit-scrollbar-thumb {
        background: var(--divider-color, #ccc);
        border-radius: 3px;
      }
      .alert-list::-webkit-scrollbar-thumb:hover {
        background: var(--secondary-text-color, #999);
      }

      .alert-item {
        display: flex;
        align-items: stretch;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        cursor: pointer;
        transition: background 0.15s;
        position: relative;
      }
      .alert-item:last-child { border-bottom: none; }
      .alert-item:hover { background: var(--secondary-background-color, rgba(0,0,0,0.03)); }

      .severity-bar {
        width: 4px;
        flex-shrink: 0;
      }

      .alert-content {
        flex: 1;
        padding: 12px;
        min-width: 0;
      }

      .alert-top-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
        flex-wrap: wrap;
      }

      .alert-image {
        height: 32px;
        width: auto;
        flex-shrink: 0;
        vertical-align: middle;
      }

      .alert-source {
        font-size: var(--ha-font-size-xs, 10px);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--secondary-background-color, rgba(0,0,0,0.06));
        color: var(--secondary-text-color);
        white-space: nowrap;
      }

      .alert-area {
        font-size: var(--ha-font-size-xs, 11px);
        color: var(--secondary-text-color);
      }

      .alert-time {
        font-size: var(--ha-font-size-xs, 11px);
        color: var(--secondary-text-color);
        margin-left: auto;
        white-space: nowrap;
      }

      .alert-title {
        color: var(--primary-text-color);
        font-size: var(--ha-font-size-m, 14px);
        font-weight: 500;
        line-height: 1.3;
        margin-bottom: 3px;
      }

      .alert-message {
        color: var(--secondary-text-color);
        font-size: var(--ha-font-size-s, 12px);
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .alert-item.expanded .alert-message {
        -webkit-line-clamp: unset;
        display: block;
      }

      /* Compact rows — see _renderCompactRow. Scoped on the card so the normal
         layout is untouched when the option is off. */
      ha-card.compact .card-header {
        padding: 8px 12px 6px;
      }
      ha-card.compact .card-header-left {
        gap: 8px;
      }
      ha-card.compact .card-title {
        font-size: var(--ha-font-size-m, 14px);
      }
      ha-card.compact .dismiss-all {
        font-size: var(--ha-font-size-xs, 11px);
        padding: 2px 6px;
      }
      ha-card.compact .alert-content {
        padding: 6px 6px 6px 10px;
      }
      ha-card.compact .alert-row {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      ha-card.compact .alert-image {
        /* Natural size, capped. A generated travel tag carries its own dimensions
           (about 32px tall) so every tag renders at the same small height it has in
           the normal layout, whatever its line name; a photo is far larger, hits the
           44px cap and keeps its aspect. Forcing a fixed height did the opposite:
           wide tags shrank under the width cap and sat lower than narrow ones. */
        height: auto;
        width: auto;
        max-height: 44px;
        max-width: 96px;
        border-radius: 4px;
      }
      ha-card.compact .alert-text {
        flex: 1;
        min-width: 0;
      }
      ha-card.compact .alert-title {
        margin-bottom: 1px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      ha-card.compact .alert-subtitle {
        color: var(--secondary-text-color);
        font-size: var(--ha-font-size-s, 12px);
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      ha-card.compact .alert-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        white-space: nowrap;
      }
      ha-card.compact .alert-area {
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      ha-card.compact .alert-time {
        margin-left: 0;
      }
      ha-card.compact .alert-message {
        margin-top: 6px;
        -webkit-line-clamp: unset;
        display: block;
      }

      .alert-instruction {
        margin-top: 8px;
        padding: 8px;
        background: var(--secondary-background-color, rgba(0,0,0,0.03));
        border-radius: 4px;
        font-size: var(--ha-font-size-s, 12px);
        line-height: 1.4;
        color: var(--primary-text-color);
      }

      .alert-formatted-content {
        display: block;
        margin-top: 8px;
        padding: 8px;
        background: var(--secondary-background-color, rgba(0,0,0,0.03));
        border-radius: 4px;
        font-size: var(--ha-font-size-s, 12px);
        line-height: 1.5;
        color: var(--primary-text-color);
        overflow-wrap: break-word;
      }

      .alert-formatted-content * {
        max-width: 100%;
      }

      .alert-actions {
        display: flex;
        align-items: center;
        padding-right: 8px;
        gap: 4px;
      }

      .dismiss-btn {
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        cursor: pointer;
        transition: all 0.2s;
        opacity: 0;
      }
      .dismiss-btn ha-icon {
        --mdc-icon-size: 16px;
        color: var(--secondary-text-color);
      }
      .alert-item:hover .dismiss-btn { opacity: 1; }
      .dismiss-btn:hover {
        background: var(--secondary-background-color, rgba(0,0,0,0.06));
      }
      .dismiss-btn:hover ha-icon {
        color: var(--primary-text-color);
      }

      .chevron {
        display: flex;
        align-items: center;
        opacity: 0.3;
      }
      .chevron ha-icon {
        --mdc-icon-size: 16px;
        color: var(--secondary-text-color);
      }

      /* Empty State */
      .empty-state {
        padding: 32px 20px;
        text-align: center;
        color: var(--secondary-text-color);
      }
      .empty-state ha-icon {
        --mdc-icon-size: 40px;
        opacity: 0.3;
        margin-bottom: 8px;
      }

      /* Edit-mode placeholder (shown while editing when the card would be hidden) */
      .edit-placeholder {
        border: 1px dashed var(--divider-color, #9e9e9e);
        background: transparent;
        opacity: 0.85;
      }
      .edit-placeholder-title {
        font-weight: 500;
        color: var(--primary-text-color);
        margin-bottom: 2px;
      }
      .edit-hint {
        font-size: var(--ha-font-size-s, 12px);
        line-height: 1.3;
        opacity: 0.7;
      }

      /* Dismissed section */
      .dismissed-section {
        border-top: 1px dashed var(--divider-color, #e0e0e0);
      }
      .dismissed-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        font-size: var(--ha-font-size-s, 12px);
        color: var(--secondary-text-color);
        font-weight: 500;
      }
      .restore-all {
        cursor: pointer;
        color: var(--primary-color, #03a9f4);
        font-weight: 400;
      }
      .restore-all:hover {
        text-decoration: underline;
      }
      .dismissed-item {
        display: flex;
        align-items: center;
        padding: 8px 16px 8px 0;
        opacity: 0.5;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .dismissed-item:last-child { border-bottom: none; }
      .dismissed-item .alert-content {
        flex: 1;
        min-width: 0;
      }
      .dismissed-item .alert-title {
        text-decoration: line-through;
      }
      .dismissed-item .alert-message {
        font-size: var(--ha-font-size-s, 12px);
        color: var(--secondary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .restore-btn {
        cursor: pointer;
        padding: 4px;
        border-radius: 50%;
        color: var(--secondary-text-color);
        transition: all 0.2s;
      }
      .restore-btn:hover {
        color: var(--primary-color, #03a9f4);
        background: var(--secondary-background-color);
      }
      .restore-btn ha-icon {
        --mdc-icon-size: 18px;
      }
    `;
  }
}

// --- Card Editor ---
class HaAlertCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._expandedSources = new Set();
    this._expandedPanels = new Set(['sources']); // sources starts expanded
    this._debug = true; // Enable debug logging
  }

  _log(...args) {
    if (this._debug) console.log('%c[AlertCard Editor]', 'color: #ff9800; font-weight: bold;', ...args);
  }

  set hass(hass) {
    const hadHass = !!this._hass;
    this._hass = hass;
    if (!hadHass && hass) {
      this._log('hass received, entity count:', Object.keys(hass.states).length);
      // Re-render to populate entity dropdowns now that we have states
      if (this._config.sources) this._render();
    }
  }

  setConfig(config) {
    this._log('setConfig called', config);
    this._config = { ...config };
    if (!this._config.sources) this._config.sources = [];
    this._render();
  }

  _render() {
    const config = this._config;
    const sources = config.sources || [];
    const tapAction = config.tap_action || {};
    const holdAction = config.hold_action || {};

    // Save expanded state of named panels before replacing DOM.
    this.shadowRoot.querySelectorAll('ha-expansion-panel[data-panel-id]').forEach(el => {
      const id = el.dataset.panelId;
      if (el.expanded) this._expandedPanels.add(id);
      else this._expandedPanels.delete(id);
    });

    this.shadowRoot.innerHTML = `
      <style>${this._getEditorStyles()}</style>
      <div class="editor">

        <!-- Appearance -->
        <ha-expansion-panel outlined data-panel-id="appearance" ${this._expandedPanels.has('appearance') ? 'expanded' : ''}>
          <div slot="header" class="panel-header">
            <ha-icon icon="mdi:palette-outline"></ha-icon>
            <span>Appearance</span>
          </div>
          <div class="panel-content">
            <div class="mapping-field-wrap">
              <label class="mapping-field-label">Title</label>
              <input
                type="text"
                class="source-field-input"
                id="title-input"
                value="${config.title || 'Alerts'}"
                placeholder="Alerts"
              />
            </div>
            <div class="row">
              <div class="mapping-field-wrap">
                <label class="mapping-field-label">Max items</label>
                <input
                  type="number"
                  class="source-field-input"
                  id="max-items-input"
                  value="${config.max_items || 20}"
                  min="1"
                  max="50"
                />
              </div>
              <div class="select-wrapper">
                <label class="select-label">Sort by</label>
                <select id="sort-select">
                  <option value="severity" ${(config.sort_by || 'severity') === 'severity' ? 'selected' : ''}>Severity</option>
                  <option value="time" ${config.sort_by === 'time' ? 'selected' : ''}>Time</option>
                </select>
              </div>
            </div>
            <div class="switches">
              <label class="switch-row">
                <ha-switch id="show-dismiss"></ha-switch>
                <span>Show dismiss buttons</span>
              </label>
              <label class="switch-row">
                <ha-switch id="show-source"></ha-switch>
                <span>Show source badges</span>
              </label>
              <label class="switch-row">
                <ha-switch id="show-image"></ha-switch>
                <span>Show images (requires Image attribute per source)</span>
              </label>
              <label class="switch-row">
                <ha-switch id="show-time"></ha-switch>
                <span>Show time</span>
              </label>
              <label class="switch-row">
                <ha-switch id="show-area"></ha-switch>
                <span>Show area</span>
              </label>
              <label class="switch-row">
                <ha-switch id="hide-when-no-alerts"></ha-switch>
                <span>Hide card when no alerts exist</span>
              </label>
              <label class="switch-row">
                <ha-switch id="hide-when-all-dismissed"></ha-switch>
                <span>Hide card when all alerts are dismissed</span>
              </label>
              <label class="switch-row">
                <ha-switch id="compact"></ha-switch>
                <span>Compact rows (one line per alert)</span>
              </label>
            </div>
          </div>
        </ha-expansion-panel>

        <!-- Sources -->
        <ha-expansion-panel outlined data-panel-id="sources" ${this._expandedPanels.has('sources') ? 'expanded' : ''}>
          <div slot="header" class="panel-header">
            <ha-icon icon="mdi:database-outline"></ha-icon>
            <span>Sources</span>
            <span class="panel-badge">${sources.length}</span>
          </div>
          <div class="panel-content">
            <div class="sources-list" id="sourcesList">
              ${sources.map((src, idx) => this._renderSource(src, idx)).join('')}
            </div>
            <button class="add-btn" id="addSourceBtn">
              <ha-icon icon="mdi:plus"></ha-icon>
              Add source
            </button>
          </div>
        </ha-expansion-panel>

        <!-- Interactions -->
        <ha-expansion-panel outlined data-panel-id="interactions" ${this._expandedPanels.has('interactions') ? 'expanded' : ''}>
          <div slot="header" class="panel-header">
            <ha-icon icon="mdi:gesture-tap"></ha-icon>
            <span>Interactions</span>
          </div>
          <div class="panel-content">
            <div class="action-group">
              <label class="mapping-field-label">Tap action</label>
              <p class="action-hint">What happens when you tap an alert</p>
              <select id="tap-action-select" class="action-select">
                <option value="default" ${(!tapAction.action || tapAction.action === 'default') ? 'selected' : ''}>Default (URL → navigate, else expand)</option>
                <option value="more-info" ${tapAction.action === 'more-info' ? 'selected' : ''}>More info (source entity)</option>
                <option value="navigate" ${tapAction.action === 'navigate' ? 'selected' : ''}>Navigate to path</option>
                <option value="url" ${tapAction.action === 'url' ? 'selected' : ''}>Open URL</option>
                <option value="none" ${tapAction.action === 'none' ? 'selected' : ''}>None (no action)</option>
              </select>
              ${tapAction.action === 'navigate' ? `
                <div class="mapping-field-wrap" style="margin-top: 8px;">
                  <label class="mapping-field-label">Navigation path</label>
                  <input type="text" class="source-field-input" id="tap-nav-path" value="${tapAction.navigation_path || ''}" placeholder="/lovelace/alerts" />
                </div>
              ` : ''}
              ${tapAction.action === 'url' ? `
                <div class="mapping-field-wrap" style="margin-top: 8px;">
                  <label class="mapping-field-label">URL</label>
                  <input type="text" class="source-field-input" id="tap-url" value="${tapAction.url_path || ''}" placeholder="https://..." />
                </div>
              ` : ''}
            </div>

            <div class="action-group">
              <label class="mapping-field-label">Hold action</label>
              <p class="action-hint">What happens on long press</p>
              <select id="hold-action-select" class="action-select">
                <option value="none" ${(!holdAction.action || holdAction.action === 'none') ? 'selected' : ''}>None</option>
                <option value="more-info" ${holdAction.action === 'more-info' ? 'selected' : ''}>More info (source entity)</option>
                <option value="navigate" ${holdAction.action === 'navigate' ? 'selected' : ''}>Navigate to path</option>
                <option value="url" ${holdAction.action === 'url' ? 'selected' : ''}>Open URL</option>
              </select>
              ${holdAction.action === 'navigate' ? `
                <div class="mapping-field-wrap" style="margin-top: 8px;">
                  <label class="mapping-field-label">Navigation path</label>
                  <input type="text" class="source-field-input" id="hold-nav-path" value="${holdAction.navigation_path || ''}" placeholder="/lovelace/alerts" />
                </div>
              ` : ''}
              ${holdAction.action === 'url' ? `
                <div class="mapping-field-wrap" style="margin-top: 8px;">
                  <label class="mapping-field-label">URL</label>
                  <input type="text" class="source-field-input" id="hold-url" value="${holdAction.url_path || ''}" placeholder="https://..." />
                </div>
              ` : ''}
            </div>
          </div>
        </ha-expansion-panel>

        <!-- Help -->
        <div class="help-text">
          <strong>CAP defaults:</strong> If your entity uses CAP field names
          (event, description, severity, starttime, id, url, area, instruction),
          no mapping is needed — just add the entity.
        </div>
      </div>
    `;

    this._attachListeners();
    // Defer property assignment for ha-switch initialization
    setTimeout(() => this._setProperties(), 50);
  }

  _setProperties() {
    const root = this.shadowRoot;
    const config = this._config;
    const sources = config.sources || [];

    this._log('_setProperties: hass available:', !!this._hass, 'sources:', sources.length);

    // Set values on card-level fields (switches only — text inputs use value in innerHTML)
    // Switches — set .checked property
    const showDismiss = root.getElementById('show-dismiss');
    if (showDismiss) showDismiss.checked = config.show_dismiss !== false;
    const showSource = root.getElementById('show-source');
    if (showSource) showSource.checked = config.show_source_badge !== false;
    const showTime = root.getElementById('show-time');
    if (showTime) showTime.checked = config.show_time !== false;
    const showArea = root.getElementById('show-area');
    if (showArea) showArea.checked = config.show_area !== false;
    const showImage = root.getElementById('show-image');
    if (showImage) showImage.checked = config.show_image !== false;
    const hideWhenNoAlerts = root.getElementById('hide-when-no-alerts');
    if (hideWhenNoAlerts) hideWhenNoAlerts.checked = !!config.hide_when_no_alerts;
    const compact = root.getElementById('compact');
    if (compact) compact.checked = !!config.compact;
    const hideWhenAllDismissed = root.getElementById('hide-when-all-dismissed');
    if (hideWhenAllDismissed) hideWhenAllDismissed.checked = !!config.hide_when_all_dismissed;

    // Values for source fields and mapping inputs are set via the value attribute in innerHTML
  }

  _renderSource(source, idx) {
    const isExpanded = this._expandedSources.has(idx);
    const mapping = source.mapping || {};
    const hasMapping = Object.keys(mapping).length > 0;

    return `
      <div class="source-card" data-idx="${idx}" draggable="true">
        <div class="source-header" data-idx="${idx}">
          <div class="source-header-left">
            <ha-icon icon="mdi:drag" class="drag-handle" style="--mdc-icon-size: 18px; opacity: 0.4; cursor: grab;"></ha-icon>
            <ha-icon icon="mdi:${hasMapping ? 'code-braces' : 'flash-auto'}" style="--mdc-icon-size: 18px; opacity: 0.6;"></ha-icon>
            <span class="source-entity-label">${escapeHtml(source.entity || (source.device ? `Device ${this._deviceLabel(source.device)}` : 'New source'))}</span>
            ${!hasMapping ? '<span class="cap-badge">CAP</span>' : ''}
          </div>
          <div class="source-header-right">
            <ha-icon-button data-idx="${idx}" data-action="toggle" class="toggle-btn">
              <ha-icon icon="mdi:chevron-${isExpanded ? 'up' : 'down'}"></ha-icon>
            </ha-icon-button>
            <ha-icon-button data-idx="${idx}" data-action="remove" class="remove-btn">
              <ha-icon icon="mdi:delete-outline"></ha-icon>
            </ha-icon-button>
          </div>
        </div>
        ${isExpanded ? this._renderSourceExpanded(source, idx) : ''}
      </div>
    `;
  }

  _renderSourceExpanded(source, idx) {
    const mapping = source.mapping || {};
    const entities = this._getEntityOptions();
    const selectedEntity = source.entity || '';

    return `
      <div class="source-body">
        <!-- Entity search -->
        <div class="entity-select-wrapper">
          <label class="entity-select-label">Entity</label>
          <input
            type="text"
            class="entity-search"
            data-idx="${idx}"
            data-field="entity"
            value="${selectedEntity}"
            placeholder="Type to search entities..."
            list="entity-list-${idx}"
            autocomplete="off"
          />
          <datalist id="entity-list-${idx}">
            ${entities.map(eid => {
              const friendly = this._hass?.states[eid]?.attributes?.friendly_name || '';
              return `<option value="${eid}">${friendly ? friendly + ' — ' + eid : eid}</option>`;
            }).join('')}
          </datalist>
        </div>

        <!-- Device: every entity under it is read, for one-entity-per-alert integrations -->
        <div class="entity-select-wrapper">
          <label class="entity-select-label">Device (instead of, or as well as, an entity)</label>
          <input
            type="text"
            class="source-field-input"
            data-idx="${idx}"
            data-field="device"
            value="${escapeHtml(source.device || '')}"
            placeholder="Every entity under the device becomes an alert"
            list="device-list-${idx}"
            autocomplete="off"
            title="For integrations that create one entity per alert and remove it when the alert ends (e.g. cap_alerts). Entities are gathered afresh on every refresh; diagnostic entities are skipped. Attribute defaults to _self."
          />
          <datalist id="device-list-${idx}">
            ${this._getDeviceOptions().map(([id, name]) =>
              `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('')}
          </datalist>
        </div>

        <!-- Name and attribute row -->
        <div class="row">
          <div class="mapping-field-wrap">
            <label class="mapping-field-label">Display name</label>
            <input
              type="text"
              class="source-field-input"
              data-idx="${idx}"
              data-field="name"
              value="${source.name || ''}"
              placeholder="Badge label"
            />
          </div>
          <div class="mapping-field-wrap">
            <label class="mapping-field-label">Attribute</label>
            <input
              type="text"
              class="source-field-input"
              data-idx="${idx}"
              data-field="attribute"
              value="${source.attribute || ''}"
              placeholder="alerts"
            />
          </div>
        </div>
        <div class="row">
          <label class="source-field-label">Detail attribute</label>
          <div class="source-field-value">
            <input
              type="text"
              class="source-field-input"
              data-idx="${idx}"
              data-field="detail_attribute"
              value="${source.detail_attribute || ''}"
              placeholder="formatted_content"
              title="Entity attribute to render as markdown when an alert is expanded. Defaults to 'formatted_content' if present."
            />
          </div>
        </div>
        <div class="row">
          <label class="source-field-label">Image attribute</label>
          <div class="source-field-value">
            <input
              type="text"
              class="source-field-input"
              data-idx="${idx}"
              data-field="image_attribute"
              value="${source.image_attribute || ''}"
              placeholder="entity_picture (default)"
              title="Attribute name for an image shown in each alert row. Checked per-alert first, then on the entity. Leave blank to use entity_picture; use the Show image toggle to turn images off."
            />
          </div>
        </div>

        <!-- Field mapping -->
        <div class="mapping-section">
          <div class="mapping-header">Field mapping</div>
          <div class="mapping-grid">
            ${this._renderMappingField(idx, 'title', mapping.title, 'Title field', 'event')}
            ${this._renderMappingField(idx, 'message', mapping.message, 'Message field', 'description')}
            ${this._renderMappingField(idx, 'severity', mapping.severity, 'Severity field', 'severity')}
            ${this._renderMappingField(idx, 'time', mapping.time, 'Time field', 'starttime')}
            ${this._renderMappingField(idx, 'id', mapping.id, 'ID field', 'id')}
            ${this._renderMappingField(idx, 'url', mapping.url, 'URL field', 'url')}
            ${this._renderMappingField(idx, 'area', mapping.area, 'Area field', 'area')}
            ${this._renderMappingField(idx, 'instruction', mapping.instruction, 'Instruction field', 'instruction')}
          </div>
        </div>

        <!-- Per-source actions (override card-level) -->
        <div class="mapping-section">
          <div class="mapping-header">Actions (override card default)</div>
          <div class="row">
            <div class="mapping-field-wrap">
              <label class="mapping-field-label">Tap action</label>
              <select class="action-select source-action-select" data-idx="${idx}" data-action-type="tap_action">
                <option value="" ${!source.tap_action?.action ? 'selected' : ''}>Use card default</option>
                <option value="default" ${source.tap_action?.action === 'default' ? 'selected' : ''}>Default (URL/expand)</option>
                <option value="more-info" ${source.tap_action?.action === 'more-info' ? 'selected' : ''}>More info</option>
                <option value="navigate" ${source.tap_action?.action === 'navigate' ? 'selected' : ''}>Navigate</option>
                <option value="url" ${source.tap_action?.action === 'url' ? 'selected' : ''}>Open URL</option>
                <option value="none" ${source.tap_action?.action === 'none' ? 'selected' : ''}>None</option>
              </select>
            </div>
            <div class="mapping-field-wrap">
              <label class="mapping-field-label">Hold action</label>
              <select class="action-select source-action-select" data-idx="${idx}" data-action-type="hold_action">
                <option value="" ${!source.hold_action?.action ? 'selected' : ''}>Use card default</option>
                <option value="more-info" ${source.hold_action?.action === 'more-info' ? 'selected' : ''}>More info</option>
                <option value="navigate" ${source.hold_action?.action === 'navigate' ? 'selected' : ''}>Navigate</option>
                <option value="url" ${source.hold_action?.action === 'url' ? 'selected' : ''}>Open URL</option>
                <option value="none" ${source.hold_action?.action === 'none' ? 'selected' : ''}>None</option>
              </select>
            </div>
          </div>
          ${(source.tap_action?.action === 'navigate' || source.hold_action?.action === 'navigate') ? `
            <div class="mapping-field-wrap" style="margin-top: 8px;">
              <label class="mapping-field-label">Navigation path</label>
              <input type="text" class="source-field-input source-action-path" data-idx="${idx}" data-action-path="navigation_path" value="${source.tap_action?.navigation_path || source.hold_action?.navigation_path || ''}" placeholder="/lovelace/..." />
            </div>
          ` : ''}
          ${(source.tap_action?.action === 'url' || source.hold_action?.action === 'url') ? `
            <div class="mapping-field-wrap" style="margin-top: 8px;">
              <label class="mapping-field-label">URL</label>
              <input type="text" class="source-field-input source-action-path" data-idx="${idx}" data-action-path="url_path" value="${source.tap_action?.url_path || source.hold_action?.url_path || ''}" placeholder="https://..." />
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  _renderMappingField(sourceIdx, fieldName, value, label, placeholder) {
    return `
      <div class="mapping-field-wrap">
        <label class="mapping-field-label">${label}</label>
        <input
          type="text"
          class="mapping-input"
          data-idx="${sourceIdx}"
          data-mapping="${fieldName}"
          value="${value || ''}"
          placeholder="${placeholder}"
        />
      </div>
    `;
  }

  _attachListeners() {
    const root = this.shadowRoot;

    // Title
    const titleInput = root.getElementById('title-input');
    titleInput?.addEventListener('change', (e) => {
      this._updateConfig('title', e.target.value);
    });

    // Max items
    root.getElementById('max-items-input')?.addEventListener('change', (e) => {
      this._updateConfig('max_items', parseInt(e.target.value, 10) || 20);
    });

    // Sort by
    root.getElementById('sort-select')?.addEventListener('change', (e) => {
      this._updateConfig('sort_by', e.target.value);
    });

    // Switches
    root.getElementById('show-dismiss')?.addEventListener('change', (e) => {
      this._updateConfig('show_dismiss', e.target.checked);
    });
    root.getElementById('show-source')?.addEventListener('change', (e) => {
      this._updateConfig('show_source_badge', e.target.checked);
    });
    root.getElementById('show-time')?.addEventListener('change', (e) => {
      this._updateConfig('show_time', e.target.checked);
    });
    root.getElementById('show-area')?.addEventListener('change', (e) => {
      this._updateConfig('show_area', e.target.checked);
    });
    root.getElementById('show-image')?.addEventListener('change', (e) => {
      this._updateConfig('show_image', e.target.checked);
    });
    root.getElementById('hide-when-no-alerts')?.addEventListener('change', (e) => {
      this._updateConfig('hide_when_no_alerts', e.target.checked);
    });
    root.getElementById('hide-when-all-dismissed')?.addEventListener('change', (e) => {
      this._updateConfig('hide_when_all_dismissed', e.target.checked);
    });
    root.getElementById('compact')?.addEventListener('change', (e) => {
      this._updateConfig('compact', e.target.checked);
    });

    // Tap action
    root.getElementById('tap-action-select')?.addEventListener('change', (e) => {
      const action = e.target.value;
      const tapAction = action === 'default' ? {} : { action };
      this._updateConfig('tap_action', tapAction);
      this._render();
      setTimeout(() => this._setProperties(), 50);
    });
    root.getElementById('tap-nav-path')?.addEventListener('change', (e) => {
      const tapAction = { ...this._config.tap_action, navigation_path: e.target.value.trim() };
      this._updateConfig('tap_action', tapAction);
    });
    root.getElementById('tap-url')?.addEventListener('change', (e) => {
      const tapAction = { ...this._config.tap_action, url_path: e.target.value.trim() };
      this._updateConfig('tap_action', tapAction);
    });

    // Hold action
    root.getElementById('hold-action-select')?.addEventListener('change', (e) => {
      const action = e.target.value;
      const holdAction = action === 'none' ? {} : { action };
      this._updateConfig('hold_action', holdAction);
      this._render();
      setTimeout(() => this._setProperties(), 50);
    });
    root.getElementById('hold-nav-path')?.addEventListener('change', (e) => {
      const holdAction = { ...this._config.hold_action, navigation_path: e.target.value.trim() };
      this._updateConfig('hold_action', holdAction);
    });
    root.getElementById('hold-url')?.addEventListener('change', (e) => {
      const holdAction = { ...this._config.hold_action, url_path: e.target.value.trim() };
      this._updateConfig('hold_action', holdAction);
    });

    // Add source button
    root.getElementById('addSourceBtn')?.addEventListener('click', () => {
      this._config.sources = [...(this._config.sources || []), { entity: '' }];
      const newIdx = this._config.sources.length - 1;
      this._expandedSources.add(newIdx);
      this._fireChanged();
      this._render();
    });

    // Source-level actions (toggle, remove)
    root.querySelectorAll('.source-header').forEach((el) => {
      el.addEventListener('click', (e) => {
        // Don't toggle if clicking remove button
        if (e.target.closest('.remove-btn')) return;
        const idx = parseInt(el.dataset.idx, 10);
        if (isNaN(idx)) return;
        if (this._expandedSources.has(idx)) {
          this._expandedSources.delete(idx);
        } else {
          this._expandedSources.add(idx);
        }
        this._render();
      });
    });

    root.querySelectorAll('.remove-btn').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        if (isNaN(idx)) return;
        const sources = this._config.sources.filter((_, i) => i !== idx);
        this._config = { ...this._config, sources };
        this._expandedSources.delete(idx);
        this._fireChanged();
        this._render();
      });
    });

    // Drag and drop reordering
    let dragIdx = null;
    root.querySelectorAll('.source-card[draggable]').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        dragIdx = parseInt(card.dataset.idx, 10);
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        dragIdx = null;
        root.querySelectorAll('.source-card.drag-over').forEach(el => el.classList.remove('drag-over'));
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        root.querySelectorAll('.source-card.drag-over').forEach(el => el.classList.remove('drag-over'));
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const dropIdx = parseInt(card.dataset.idx, 10);
        if (dragIdx === null || isNaN(dropIdx) || dragIdx === dropIdx) return;
        const sources = [...this._config.sources];
        const [moved] = sources.splice(dragIdx, 1);
        sources.splice(dropIdx, 0, moved);
        this._config = { ...this._config, sources };
        this._expandedSources.clear();
        this._fireChanged();
        this._render();
      });
    });

    // Entity search inputs
    root.querySelectorAll('input.entity-search').forEach((input) => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(input.dataset.idx, 10);
        if (isNaN(idx)) return;
        this._updateSource(idx, 'entity', e.target.value.trim());
      });
    });

    // Source text fields (name, attribute) — plain <input> elements
    root.querySelectorAll('input.source-field-input').forEach((input) => {
      input.addEventListener('change', () => {
        const idx = parseInt(input.dataset.idx, 10);
        const fieldName = input.dataset.field;
        if (isNaN(idx) || !fieldName) return;
        this._updateSource(idx, fieldName, input.value.trim());
      });
    });

    // Mapping fields — plain <input> elements now
    root.querySelectorAll('input.mapping-input').forEach((input) => {
      input.addEventListener('change', () => {
        const idx = parseInt(input.dataset.idx, 10);
        const mappingKey = input.dataset.mapping;
        if (isNaN(idx) || !mappingKey) return;
        this._updateMapping(idx, mappingKey, input.value.trim());
      });
    });

    // Per-source action selects
    root.querySelectorAll('select.source-action-select').forEach((select) => {
      select.addEventListener('change', () => {
        const idx = parseInt(select.dataset.idx, 10);
        const actionType = select.dataset.actionType; // 'tap_action' or 'hold_action'
        if (isNaN(idx) || !actionType) return;
        const value = select.value;
        if (value) {
          this._updateSource(idx, actionType, { action: value });
        } else {
          this._updateSource(idx, actionType, undefined);
        }
        this._render();
        setTimeout(() => this._setProperties(), 50);
      });
    });

    // Per-source action path inputs
    root.querySelectorAll('input.source-action-path').forEach((input) => {
      input.addEventListener('change', () => {
        const idx = parseInt(input.dataset.idx, 10);
        const pathKey = input.dataset.actionPath; // 'navigation_path' or 'url_path'
        if (isNaN(idx) || !pathKey) return;
        const sources = [...(this._config.sources || [])];
        if (!sources[idx]) return;
        // Apply to whichever action needs it
        if (sources[idx].tap_action?.action === 'navigate' || sources[idx].tap_action?.action === 'url') {
          sources[idx] = { ...sources[idx], tap_action: { ...sources[idx].tap_action, [pathKey]: input.value.trim() } };
        }
        if (sources[idx].hold_action?.action === 'navigate' || sources[idx].hold_action?.action === 'url') {
          sources[idx] = { ...sources[idx], hold_action: { ...sources[idx].hold_action, [pathKey]: input.value.trim() } };
        }
        this._config = { ...this._config, sources };
        this._fireChanged();
      });
    });
  }



  _updateConfig(key, value) {
    this._config = { ...this._config, [key]: value };
    this._fireChanged();
  }

  _updateSource(idx, field, value) {
    const sources = [...(this._config.sources || [])];
    if (!sources[idx]) return;
    sources[idx] = { ...sources[idx], [field]: value || undefined };
    // Clean empty fields
    if (!value) delete sources[idx][field];
    this._config = { ...this._config, sources };
    this._fireChanged();
    // Re-render to update header label
    if (field === 'entity' || field === 'device') this._render();
  }

  _updateMapping(idx, key, value) {
    const sources = [...(this._config.sources || [])];
    if (!sources[idx]) return;
    const mapping = { ...(sources[idx].mapping || {}) };
    if (value) {
      mapping[key] = value;
    } else {
      delete mapping[key]; // Remove empty mappings to fall back to CAP defaults
    }
    sources[idx] = { ...sources[idx], mapping: Object.keys(mapping).length > 0 ? mapping : undefined };
    if (!sources[idx].mapping) delete sources[idx].mapping;
    this._config = { ...this._config, sources };
    this._fireChanged();
  }

  _getDeviceOptions() {
    const devices = this._hass?.devices || {};
    return Object.values(devices)
      .map((d) => [d.id, d.name_by_user || d.name || d.id])
      .sort((a, b) => a[1].localeCompare(b[1]));
  }

  _deviceLabel(id) {
    const d = this._hass?.devices?.[id];
    return d?.name_by_user || d?.name || id;
  }

  _getEntityOptions() {
    if (!this._hass || !this._hass.states) return [];
    // All entities — alert data can live on any entity type
    return Object.keys(this._hass.states).sort();
  }

  _fireChanged() {
    const event = new CustomEvent('config-changed', {
      detail: { config: { ...this._config } },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  _getEditorStyles() {
    return `
      .editor {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      ha-expansion-panel {
        display: block;
        --expansion-panel-content-padding: 0;
        border-radius: 6px;
        --ha-card-border-radius: 6px;
      }
      .panel-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--ha-font-size-m, 14px);
        font-weight: 500;
      }
      .panel-header ha-icon {
        --mdc-icon-size: 20px;
        color: var(--secondary-text-color);
      }
      .panel-badge {
        background: var(--primary-color, #03a9f4);
        color: white;
        font-size: var(--ha-font-size-xs, 11px);
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 8px;
        margin-left: auto;
      }
      .panel-content {
        padding: 12px 16px 16px;
      }
      .action-group {
        margin-bottom: 16px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .action-group:last-child {
        margin-bottom: 0;
        padding-bottom: 0;
        border-bottom: none;
      }
      .action-hint {
        font-size: 11px;
        color: var(--secondary-text-color);
        margin: 2px 0 8px;
      }
      .action-select {
        width: 100%;
        padding: 10px 12px;
        border-radius: 6px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--card-background-color, var(--ha-card-background, #fff));
        color: var(--primary-text-color);
        font-size: 14px;
        appearance: auto;
        cursor: pointer;
      }
      .section {
        margin-bottom: 20px;
      }
      .section-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--primary-text-color);
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hint-inline {
        font-size: 11px;
        font-weight: 400;
        color: var(--secondary-text-color);
      }
      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 8px;
      }
      .switches {
        margin-top: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .switch-row {
        display: flex;
        align-items: center;
        gap: 12px;
        cursor: pointer;
        font-size: 14px;
        color: var(--primary-text-color);
      }
      .select-wrapper {
        display: flex;
        flex-direction: column;
      }
      .select-label {
        font-size: 12px;
        color: var(--secondary-text-color);
        margin-bottom: 4px;
      }
      select {
        padding: 8px;
        border-radius: 4px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--card-background-color);
        color: var(--primary-text-color);
        font-size: 14px;
      }

      /* Sources */
      .sources-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .source-card {
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 8px;
        overflow: hidden;
        transition: opacity 0.2s, border-color 0.2s;
      }
      .source-card.dragging {
        opacity: 0.4;
      }
      .source-card.drag-over {
        border-color: var(--primary-color, #03a9f4);
        border-style: dashed;
      }
      .source-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 8px 10px 12px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .source-header:hover {
        background: var(--secondary-background-color, rgba(0,0,0,0.03));
      }
      .source-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1;
      }
      .source-entity-label {
        font-size: 13px;
        color: var(--primary-text-color);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cap-badge {
        font-size: 9px;
        font-weight: 700;
        background: var(--success-color, #4caf50);
        color: white;
        padding: 1px 5px;
        border-radius: 3px;
        letter-spacing: 0.5px;
      }
      .source-header-right {
        display: flex;
        align-items: center;
        gap: 0;
      }
      .source-body {
        padding: 0 12px 12px;
        border-top: 1px solid var(--divider-color, #e0e0e0);
      }
      .source-body ha-entity-picker {
        margin-top: 12px;
        display: block;
        width: 100%;
      }
      .entity-select-wrapper {
        margin-top: 12px;
      }
      .entity-select-label {
        display: block;
        font-size: 12px;
        color: var(--secondary-text-color);
        margin-bottom: 4px;
      }
      .entity-search {
        width: 100%;
        padding: 10px 12px;
        border-radius: 4px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--card-background-color, var(--ha-card-background, #fff));
        color: var(--primary-text-color);
        font-size: 14px;
        box-sizing: border-box;
      }
      .entity-search:focus {
        outline: none;
        border-color: var(--primary-color, #03a9f4);
      }
      .entity-select {
        width: 100%;
        padding: 10px 12px;
        border-radius: 4px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--card-background-color, var(--ha-card-background, #fff));
        color: var(--primary-text-color);
        font-size: 14px;
        appearance: auto;
      }
      .entity-select:focus {
        outline: none;
        border-color: var(--primary-color, #03a9f4);
      }

      /* Mapping */
      .mapping-section {
        margin-top: 12px;
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 6px;
        padding: 10px 12px 12px;
      }
      .mapping-header {
        font-size: 13px;
        font-weight: 500;
        color: var(--primary-text-color);
        margin-bottom: 8px;
      }
      .mapping-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .mapping-field-wrap {
        display: flex;
        flex-direction: column;
      }
      .mapping-field-label {
        font-size: 11px;
        color: var(--secondary-text-color);
        margin-bottom: 2px;
      }
      .mapping-input,
      .source-field-input {
        width: 100%;
        padding: 8px 10px;
        border-radius: 4px;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--card-background-color, var(--ha-card-background, #fff));
        color: var(--primary-text-color);
        font-size: 13px;
        box-sizing: border-box;
      }
      .mapping-input:focus,
      .source-field-input:focus {
        outline: none;
        border-color: var(--primary-color, #03a9f4);
      }
      .mapping-input::placeholder,
      .source-field-input::placeholder {
        color: var(--secondary-text-color, #999);
        opacity: 0.6;
      }

      /* Buttons */
      .add-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 8px;
        padding: 8px 16px;
        background: none;
        border: 1px dashed var(--divider-color, #ccc);
        border-radius: 8px;
        color: var(--primary-color, #03a9f4);
        font-size: 13px;
        cursor: pointer;
        width: 100%;
        justify-content: center;
        transition: all 0.15s;
      }
      .add-btn:hover {
        background: var(--secondary-background-color, rgba(0,0,0,0.03));
        border-color: var(--primary-color, #03a9f4);
      }
      .add-btn ha-icon {
        --mdc-icon-size: 18px;
      }

      ha-icon-button {
        --mdc-icon-button-size: 36px;
        --mdc-icon-size: 20px;
        color: var(--secondary-text-color);
      }
      .remove-btn {
        color: var(--error-color, #db4437);
      }

      .help-text {
        font-size: 12px;
        color: var(--secondary-text-color);
        line-height: 1.5;
        padding: 12px;
        background: var(--secondary-background-color, rgba(0,0,0,0.03));
        border-radius: 6px;
      }
      .help-text strong {
        color: var(--primary-text-color);
      }
    `;
  }
}

// Register
customElements.define('ha-alert-card', HaAlertCard);
customElements.define('ha-alert-card-editor', HaAlertCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'ha-alert-card',
  name: 'Alert Card',
  description: 'Displays alerts from any entity with CAP-standard attributes. Supports multiple sources with configurable field mapping.',
  preview: true,
});

console.info(
  `%c HA-ALERT-CARD %c v${CARD_VERSION} `,
  'color: white; background: #db4437; font-weight: bold; padding: 2px 4px; border-radius: 3px 0 0 3px;',
  'color: white; background: #333; font-weight: bold; padding: 2px 4px; border-radius: 0 3px 3px 0;'
);
