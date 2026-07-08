# Changelog

## [2026.7.1] — 2026-07-08

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
