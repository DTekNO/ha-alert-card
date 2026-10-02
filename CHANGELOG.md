# Changelog

## [2026.10.2] - 2026-10-02

### Added

- **Device sources** (`device: <id>`): every non-diagnostic entity under a device is read
  as an alert, gathered afresh on each refresh, for integrations that create one entity
  per alert (cap_alerts, NINA). `attribute` defaults to `_self`. Refs #1.
- `_self` and single-object attributes documented in the README; both already worked.

### Changed

- Unmapped `time`, `url` and `area` also try the CAP names `onset`, `web` and `area_desc`.
- A `_self` entity in state `unknown` counts as an alert when its attributes carry one.
- The same alert id reaching the card twice is shown once.

## [2026.10.1] - 2026-10-02

### Added

- **Compact rows** (`compact: true`): one line per alert — thumbnail, title over the
  message, source/area/time on the right — and a tighter header. Expanded content is
  unchanged. Images render at natural size, capped at 44 × 96 px; an area identical to
  the title is omitted.

### Fixed

- The alert list keeps its scroll position when an entry is expanded or the feed updates.
- The header bell is vertically centred.

## [2026.9.1] — 2026-09-23

### Fixed

- **A hidden card no longer leaves its grid cell behind.** With `hide_when_no_alerts`
  or `hide_when_all_dismissed` set and a fixed `grid_options.rows` in a sections view,
  the card hid itself but the section kept the space reserved — a blank block the size
  of the card. The card now hides through the mechanism Home Assistant's card wrapper
  watches, so the cell collapses with it, exactly as a conditional card's does — and a
  neighbouring card reflows into the space. Masonry and `rows: auto` layouts were
  already fine and are unchanged.

  This relies on a wrapper contract that arrived in Home Assistant 2024.6.0, so that is
  now the declared minimum in `hacs.json` — HACS will not offer the card to older
  installs. There was no minimum before.

### Changed

- **Per-alert images now work without configuration.** `image_attribute` defaults to
  `entity_picture`, which is where almost every entity that has a meaningful image
  puts it — so a source that previously showed no image will now show one, with no
  config change. Name a different attribute to override it (`travel_tag`, an icon
  URL, and so on), or set `show_image: false` to turn images off entirely.

  Precedence is unchanged: the per-alert value wins over the entity attribute, and
  an entity without the attribute renders no image rather than a broken one. Feed
  URLs are still restricted to safe schemes.

## [2026.8.1] — 2026-08-03

### Overview

HA Alert Card is a Lovelace card for Home Assistant that displays alerts from **any entity** with structured alert data in its attributes. It is built around the [CAP (Common Alerting Protocol)](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html) field vocabulary as defaults, so CAP-compliant entities work with zero configuration; non-CAP sources are supported through a per-source field mapping.

> ⚠️ **This is a security release — please update.** Alert text arriving from third-party feeds was rendered into the page without escaping, so a feed item containing markup could execute script in your Home Assistant frontend. All feed-derived text is now escaped. If you point this card at any external feed — weather services, earthquake data, transit disruptions, RSS — this fix applies to you. Nothing in your configuration needs to change.


**What the card does**

- **Any source** — any entity exposing a list of alerts in an attribute; CAP field names by default, per-source `mapping` for everything else, and multiple sources combined in one card
- **Dismiss and restore** — per-alert dismiss stored server-side per HA user, so it syncs across browsers and devices; dismissed alerts reviewable and restorable from the header
- **Severity colouring** — a colour bar keyed to severity, with built-in support for CAP, Norwegian and generic level names, fully overridable
- **Expandable detail** — tap to expand full description and instructions, rendered as markdown
- **Per-alert images** — inline badges or icons from the feed (Entur TravelTag, Norway Alerts warning icons)
- **Visual editor** — full GUI configuration in the card picker, no YAML required
- **Lightweight** — a single plain JS file, no build step, no dependencies

📖 **Full configuration reference, worked examples (USGS earthquakes, US NWS alerts) and behaviour details: [README](https://github.com/DTekNO/ha-alert-card#readme).** Per-release detail for earlier versions is below.

### Security

- **Alert fields from third-party feeds are now HTML-escaped before rendering** — the card interpolated `title`, `message`, `area`, `instruction`, the source badge, the formatted time and the alert id straight into `shadowRoot.innerHTML`. Because those values come from external feeds (USGS, NWS, RSS, …), a feed item whose text contained markup such as `<img src=x onerror=…>` would execute script in the Home Assistant frontend. All feed-derived values now pass through an escape helper, in both text and attribute contexts, and in both the active and dismissed alert renderers.

  Reported by [@frenck](https://github.com/frenck) during HACS default-repository review.

- **Feed-supplied image URLs are restricted to safe schemes** — `image_attribute` values may now only be `http(s)`, protocol-relative, site-relative, or `data:image/…`. Anything else (for example `javascript:`) renders no image rather than an active URL.

- **Tap-action URLs require an explicit `http(s)` scheme** — the external-link branch previously accepted any value merely *starting with* `http`, and now matches `https?://` strictly.

### Unchanged by design

- **Expandable detail content still renders as markdown.** The `detail_attribute` (default `formatted_content`) is assigned to `<ha-markdown>` as a property, so Home Assistant's own markdown renderer and sanitizer handles it — bullet lists and other formatting in NWS descriptions continue to work exactly as before.
- Severity colours are unaffected: the feed-derived severity is only ever used as a *lookup key* into the built-in or user-configured colour map, and the resulting colour comes from that map, never from feed text.
- Legitimate punctuation is preserved. Ampersands, apostrophes, quotes, em/en dashes and accented characters render as typed — escaping affects only markup, not text.

### Internal

- Added `test/xss.test.js` — a dependency-free regression suite (`node test/xss.test.js`) that renders the real `_renderAlert` / `_renderDismissedAlert` output against hostile input and asserts that only the card's own inert markup survives, that unsafe image URLs are dropped, that the detail pane stays delegated to `ha-markdown`, and that intended text and punctuation are preserved.
- Removed a stale `Version: 0.1.0` line from the file header, left behind by the earliest releases. The version comes solely from the git tag, injected into `dist/` by the release workflow.
- Added a **Sync dist** workflow: pushes to `main` that touch `src/` rebuild `dist/ha-alert-card.js` and commit it only if it changed. `dist/` stays committed because HACS resolves a plugin file from the release asset, then `dist/`, then the repo root — but being committed meant it could silently drift from `src/` (it had lagged by several releases, which made an unrelated commit's diff appear to contain lost work).

## [2026.7.3] — 2026-07-28

### Overview

HA Alert Card is a Lovelace card for Home Assistant that displays alerts from any entity with structured alert data in its attributes. It is built around the [CAP (Common Alerting Protocol)](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html) field vocabulary as defaults, meaning CAP-compliant entities work with zero configuration. Non-CAP sources are supported through a per-source field mapping.

This release focuses on dashboard editing experience and robustness: cards that hide themselves when idle (`hide_when_no_alerts`, `hide_when_all_dismissed`) now stay visible and selectable in edit mode instead of vanishing, and alert titles/source labels fall back to the entity's friendly name when no explicit value is available.

### Features

**Universal alert source support**
- Works with any entity that exposes a list of alerts in an attribute
- CAP field names (`event`, `description`, `severity`, `starttime`, `id`, `url`, `area`, `instruction`) used by default — no mapping needed for compliant sources
- Per-source `mapping` block to rename fields for non-CAP entities
- Per-source `attribute` override (default: `alerts`)
- Multiple sources combined in a single card

**Dismiss system**
- Per-alert dismiss button (×)
- Dismissed state stored server-side via HA's `frontend/get_user_data` / `frontend/set_user_data` — persists across browser sessions and devices, per HA user
- Auto-migration from legacy `localStorage` on first load
- Dismissed IDs are pruned automatically when alerts expire or are removed from the source
- Cross-device sync: dismissed state propagates to other open sessions without page reload
- Unique dismiss key derived from the card's entity set — multiple cards on the same dashboard don't interfere with each other

**Dismissed alert review**
- Eye icon in card header shows count of dismissed alerts
- Click to reveal dismissed alerts with restore (un-dismiss) buttons

**Paging via dismiss**
- `max_items` caps the visible window of undismissed alerts
- Dismissing alerts reveals the next batch — acts as a natural paging mechanism
- Badge shows "N of M" when more alerts exist beyond the visible window

**Severity system**
- Color bar per alert keyed to severity level
- Built-in support for CAP values (`extreme`, `severe`, `moderate`, `minor`), Norwegian levels (`red`, `orange`, `yellow`, `green`), generic values (`critical`, `high`, `medium`, `low`, `info`), and Entur SX statuses (`open`, `planned`)
- Fully customizable via `severity_colors` in config
- Default sort: highest severity first. Alternative: `sort_by: time`

**Alert interaction**
- Tap an alert with a `url` field: navigates within HA (internal paths) or opens a new tab (external URLs)
- Tap an alert without a `url`: expands inline to show full description and instruction text
- `tap_action` / `hold_action` support for custom navigation or more-info

**Display options**
- `show_dismiss` — toggle dismiss buttons
- `show_source_badge` — show which source each alert came from
- `show_area` — show geographic area
- `show_time` — show relative timestamp
- `hide_when_no_alerts` — hide the card entirely when the data source returns no alerts
- `hide_when_all_dismissed` — hide the card when alerts exist but all have been dismissed; card reappears automatically when new alerts arrive

**Edit mode**
- Cards that hide themselves via `hide_when_no_alerts` or `hide_when_all_dismissed` now display a subtle dashed placeholder frame while the dashboard is being edited, so they remain selectable and configurable without requiring any workaround
- Edit mode is detected reliably across masonry, sections, and panel layouts by walking the shadow root tree to the Lovelace root — not dependent on URL query strings or wrapper elements

**Visual editor**
- Full GUI editor in the Lovelace card picker — no YAML required for basic use
- Source cards with expand/collapse and drag-to-reorder
- Mapping fields editable per source
- All display toggles available as switches
- Appearance, behavior, and tap action sections

**Lightweight**
- Single plain JS file, no build step, no npm dependencies
- HACS-compatible, released as a plugin

### Fixed
- Cards configured with `hide_when_no_alerts` or `hide_when_all_dismissed` no longer disappear entirely during dashboard editing — a placeholder is shown instead so the card can still be selected and reconfigured
- Alert title now falls back to the entity's `friendly_name` when no `title`/`event` field is present in the alert data, instead of defaulting to the generic string `"Alert"`
- Source badge label now falls back to `friendly_name` when no `name` is configured for the source
- `detail_attribute` field resolution now goes through the full field resolver, so dotted key paths work correctly
- Deleting a source in the visual editor no longer mutates config in place — fixes a reactivity bug that could cause the editor to get out of sync

## [2026.7.2] — 2026-07-08

### Overview

First stable release. HA Alert Card is a Lovelace card for Home Assistant that displays alerts from any entity with structured alert data in its attributes. It is built around the [CAP (Common Alerting Protocol)](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html) field vocabulary as defaults, meaning CAP-compliant entities work with zero configuration. Non-CAP sources are supported through a per-source field mapping.

### Features

**Universal alert source support**
- Works with any entity that exposes a list of alerts in an attribute
- CAP field names (`event`, `description`, `severity`, `starttime`, `id`, `url`, `area`, `instruction`) used by default — no mapping needed for compliant sources
- Per-source `mapping` block to rename fields for non-CAP entities
- Per-source `attribute` override (default: `alerts`)
- Multiple sources combined in a single card

**Dismiss system**
- Per-alert dismiss button (×)
- Dismissed state stored server-side via HA's `frontend/get_user_data` / `frontend/set_user_data` — persists across browser sessions and devices, per HA user
- Auto-migration from legacy `localStorage` on first load
- Dismissed IDs are pruned automatically when alerts expire or are removed from the source
- Cross-device sync: dismissed state propagates to other open sessions without page reload
- Unique dismiss key derived from the card's entity set — multiple cards on the same dashboard don't interfere with each other

**Dismissed alert review**
- Eye icon in card header shows count of dismissed alerts
- Click to reveal dismissed alerts with restore (un-dismiss) buttons

**Paging via dismiss**
- `max_items` caps the visible window of undismissed alerts
- Dismissing alerts reveals the next batch — acts as a natural paging mechanism
- Badge shows "N of M" when more alerts exist beyond the visible window

**Severity system**
- Color bar per alert keyed to severity level
- Built-in support for CAP values (`extreme`, `severe`, `moderate`, `minor`), Norwegian levels (`red`, `orange`, `yellow`, `green`), generic values (`critical`, `high`, `medium`, `low`, `info`), and Entur SX statuses (`open`, `planned`)
- Fully customizable via `severity_colors` in config
- Default sort: highest severity first. Alternative: `sort_by: time`

**Alert interaction**
- Tap an alert with a `url` field: navigates within HA (internal paths) or opens a new tab (external URLs)
- Tap an alert without a `url`: expands inline to show full description and instruction text
- `tap_action` / `hold_action` support for custom navigation or more-info

**Display options**
- `show_dismiss` — toggle dismiss buttons
- `show_source_badge` — show which source each alert came from
- `show_area` — show geographic area
- `show_time` — show relative timestamp
- `hide_when_no_alerts` — hide the card entirely when the data source returns no alerts
- `hide_when_all_dismissed` — hide the card when alerts exist but all have been dismissed; card reappears automatically when new alerts arrive

**Visual editor**
- Full GUI editor in the Lovelace card picker — no YAML required for basic use
- Source cards with expand/collapse and drag-to-reorder
- Mapping fields editable per source
- All display toggles available as switches
- Appearance, behavior, and tap action sections

**Lightweight**
- Single plain JS file, no build step, no npm dependencies
- HACS-compatible, released as a plugin

### Changed
- License changed from MIT to AGPL-3.0

### Fixed
- Editor expansion panels (Appearance, Interactions) no longer collapse when a setting is changed
- Expanding one alert no longer shows all alerts' detail content — each expanded alert now shows only its own formatted content

### Added
- `image_attribute` per-source config: shows a small image (e.g. `entity_picture` or `travel_tag`) in each alert row. Per-alert value is used when available, with fallback to the entity attribute
- `show_image` card-level toggle: enable/disable image display globally (default: on). Works alongside `image_attribute`
