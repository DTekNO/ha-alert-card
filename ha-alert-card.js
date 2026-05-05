/**
 * HA Alert Card
 * A Lovelace card that displays alerts from any entity with structured alert attributes.
 * Uses CAP (Common Alerting Protocol) field names as defaults — entities following CAP
 * work with zero mapping configuration.
 *
 * Version: 0.1.0
 */

const CARD_VERSION = '0.1.5';

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
    this._dismissed = new Set();
    this._expanded = new Set();
    this._showDismissed = false;
    this._config = {};
    this._hass = null;
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

  set hass(hass) {
    this._hass = hass;
    this._updateAlerts();
    this._render();
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
      sort_by: config.sort_by || 'severity', // 'severity' or 'time'
      tap_action: config.tap_action || { action: 'more-info' },
      dismiss_key: config.dismiss_key || 'ha-alert-card-dismissed',
      ...config,
    };
    this._loadDismissed();
    if (this._hass) {
      this._updateAlerts();
      this._render();
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

  _loadDismissed() {
    try {
      const stored = localStorage.getItem(this._config.dismiss_key);
      this._dismissed = stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      this._dismissed = new Set();
    }
  }

  _saveDismissed() {
    try {
      localStorage.setItem(this._config.dismiss_key, JSON.stringify([...this._dismissed]));
    } catch { /* quota exceeded, ignore */ }
  }

  _updateAlerts() {
    if (!this._hass || !this._config.sources) return;

    const allAlerts = [];
    const dismissedAlerts = [];
    const seenIds = new Set();

    for (const source of this._config.sources) {
      const entity = this._hass.states[source.entity];
      if (!entity) continue;

      const mapping = { ...DEFAULT_MAPPING, ...(source.mapping || {}) };
      const attribute = source.attribute || 'alerts';

      let items;

      if (attribute === '_self') {
        // _self mode: treat entity.attributes as a single alert item
        // Skip if entity state indicates no active alert
        const skipStates = ['normal', '0', 'unavailable', 'unknown', 'none', 'ok', 'idle'];
        if (skipStates.includes((entity.state || '').toLowerCase())) continue;
        items = [entity.attributes];
      } else {
        const raw = entity.attributes[attribute];
        if (Array.isArray(raw)) {
          items = raw;
        } else if (raw && typeof raw === 'object') {
          // Single object attribute (not array) — wrap as single item
          items = [raw];
        } else {
          // Attribute missing, null, or primitive — skip this entity
          continue;
        }
      }

      const filterExpired = source.filter_expired !== false; // default true

      for (const item of items) {
        // Filter expired/closed alerts
        if (filterExpired) {
          const status = (this._resolveField(item, mapping.severity) || '').toLowerCase();
          if (status === 'expired' || status === 'closed') continue;

          // Also check valid_to timestamp if present
          const validTo = item.valid_to || this._resolveField(item, 'valid_to');
          if (validTo) {
            const expiry = new Date(validTo).getTime();
            if (!isNaN(expiry) && expiry < Date.now()) continue;
          }
        }

        const alertId = this._resolveField(item, mapping.id) ||
                        this._hashAlert(item, mapping);

        seenIds.add(alertId);

        const alertObj = {
          _id: alertId,
          _source: source.name || source.entity.split('.').pop(),
          _entity: source.entity,
          _raw: item,
          title: this._resolveField(item, mapping.title) || 'Alert',
          message: this._resolveField(item, mapping.message) || '',
          severity: (this._resolveField(item, mapping.severity) || 'unknown').toLowerCase(),
          time: this._resolveField(item, mapping.time) || '',
          url: this._resolveField(item, mapping.url) || '',
          area: this._resolveField(item, mapping.area) || '',
          instruction: this._resolveField(item, mapping.instruction) || '',
        };

        if (this._dismissed.has(alertId)) {
          dismissedAlerts.push(alertObj);
        } else {
          allAlerts.push(alertObj);
        }
      }
    }

    // Prune dismissed IDs that are no longer in entity data
    for (const id of this._dismissed) {
      if (!seenIds.has(id)) {
        this._dismissed.delete(id);
      }
    }
    this._saveDismissed();

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

    allAlerts.sort(sortFn);
    dismissedAlerts.sort(sortFn);

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
    if (alert.url) {
      // Navigate to URL
      const event = new Event('hass-more-info', { bubbles: true, composed: true });
      if (alert.url.startsWith('/')) {
        window.history.pushState(null, '', alert.url);
        window.dispatchEvent(new Event('location-changed'));
      } else if (alert.url.startsWith('http')) {
        window.open(alert.url, '_blank', 'noopener');
      } else {
        // Treat as entity for more-info dialog
        event.detail = { entityId: alert._entity };
        this.dispatchEvent(event);
      }
    } else {
      // Default: toggle expand to show details
      this._toggleExpand(alert._id);
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

  _render() {
    if (!this.shadowRoot) return;

    const alertCount = this._alerts.length;
    const dismissedCount = this._dismissedAlerts.length;

    this.shadowRoot.innerHTML = `
      <style>${this._getStyles()}</style>
      <ha-card>
        <div class="card-header">
          <div class="card-header-left">
            <ha-icon icon="mdi:bell-alert-outline"></ha-icon>
            <span class="card-title">${this._config.title}</span>
            ${alertCount > 0 ? `<span class="badge">${alertCount}</span>` : ''}
          </div>
          <div class="card-header-right">
            ${dismissedCount > 0 ? `
              <span class="toggle-dismissed" id="toggleDismissed" title="${this._showDismissed ? 'Hide' : 'Show'} dismissed">
                <ha-icon icon="mdi:${this._showDismissed ? 'eye-off' : 'eye'}"></ha-icon>
                <span>${dismissedCount}</span>
              </span>
            ` : ''}
            ${alertCount > 0 && this._config.show_dismiss ? `
              <span class="dismiss-all" id="dismissAll">Dismiss all</span>
            ` : ''}
          </div>
        </div>
        <div class="alert-list">
          ${alertCount === 0 && (!this._showDismissed || dismissedCount === 0) ? this._renderEmpty() : ''}
          ${this._alerts.map(a => this._renderAlert(a)).join('')}
          ${this._showDismissed && dismissedCount > 0 ? `
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

    // Attach event listeners
    this.shadowRoot.getElementById('dismissAll')?.addEventListener('click', () => this._dismissAll());
    this.shadowRoot.getElementById('toggleDismissed')?.addEventListener('click', () => {
      this._showDismissed = !this._showDismissed;
      this._render();
    });
    this.shadowRoot.getElementById('restoreAll')?.addEventListener('click', () => this._restoreAll());

    this.shadowRoot.querySelectorAll('.alert-item').forEach((el) => {
      const alertId = el.dataset.alertId;
      const alert = this._alerts.find(a => a._id === alertId);
      if (!alert) return;

      el.addEventListener('click', () => this._handleTap(alert));

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
    return `
      <div class="dismissed-item" data-alert-id="${alert._id}">
        <div class="severity-bar" style="background: ${color}; opacity: 0.4"></div>
        <div class="alert-content">
          <div class="alert-title">${alert.title}</div>
          ${alert.message ? `<div class="alert-message">${alert.message}</div>` : ''}
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

    return `
      <div class="alert-item ${isExpanded ? 'expanded' : ''}" data-alert-id="${alert._id}">
        <div class="severity-bar" style="background: ${color}"></div>
        <div class="alert-content">
          <div class="alert-top-row">
            ${this._config.show_source_badge ? `<span class="alert-source">${alert._source}</span>` : ''}
            ${this._config.show_area && alert.area ? `<span class="alert-area">${alert.area}</span>` : ''}
            ${this._config.show_time && timeStr ? `<span class="alert-time">${timeStr}</span>` : ''}
          </div>
          <div class="alert-title">${alert.title}</div>
          ${alert.message ? `<div class="alert-message">${alert.message}</div>` : ''}
          ${isExpanded && alert.instruction ? `
            <div class="alert-instruction">
              <strong>Instruction:</strong> ${alert.instruction}
            </div>
          ` : ''}
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

  _getStyles() {
    return `
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
      }
      .card-header-left ha-icon {
        --mdc-icon-size: 20px;
        color: var(--primary-text-color);
        opacity: 0.8;
      }
      .card-title {
        font-size: 16px;
        font-weight: 500;
        color: var(--primary-text-color);
      }
      .badge {
        background: var(--alert-card-badge-bg);
        color: white;
        font-size: 11px;
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
        font-size: 12px;
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
        font-size: 12px;
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

      .alert-source {
        font-size: 10px;
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
        font-size: 11px;
        color: var(--secondary-text-color);
      }

      .alert-time {
        font-size: 11px;
        color: var(--secondary-text-color);
        margin-left: auto;
        white-space: nowrap;
      }

      .alert-title {
        color: var(--primary-text-color);
        font-size: 14px;
        font-weight: 500;
        line-height: 1.3;
        margin-bottom: 3px;
      }

      .alert-message {
        color: var(--secondary-text-color);
        font-size: 12px;
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

      .alert-instruction {
        margin-top: 8px;
        padding: 8px;
        background: var(--secondary-background-color, rgba(0,0,0,0.03));
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.4;
        color: var(--primary-text-color);
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

      /* Dismissed section */
      .dismissed-section {
        border-top: 1px dashed var(--divider-color, #e0e0e0);
      }
      .dismissed-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        font-size: 12px;
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
        font-size: 12px;
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

    this.shadowRoot.innerHTML = `
      <style>${this._getEditorStyles()}</style>
      <div class="editor">

        <!-- Card Settings -->
        <div class="section">
          <div class="section-title">Card Settings</div>
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
              <ha-switch id="show-time"></ha-switch>
              <span>Show time</span>
            </label>
            <label class="switch-row">
              <ha-switch id="show-area"></ha-switch>
              <span>Show area</span>
            </label>
          </div>
        </div>

        <!-- Sources -->
        <div class="section">
          <div class="section-title">
            Sources
            <span class="hint-inline">Entities providing alert data</span>
          </div>
          <div class="sources-list" id="sourcesList">
            ${sources.map((src, idx) => this._renderSource(src, idx)).join('')}
          </div>
          <button class="add-btn" id="addSourceBtn">
            <ha-icon icon="mdi:plus"></ha-icon>
            Add source
          </button>
        </div>

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
            <span class="source-entity-label">${source.entity || 'New source'}</span>
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
        this._config.sources.splice(idx, 1);
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
    if (field === 'entity') this._render();
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
