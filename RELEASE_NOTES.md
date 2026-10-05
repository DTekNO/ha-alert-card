# HA Alert Card 2026.10.3

<!--
Release-notes recipe (kept here so each release reads the same):
  1. Copy the newest section of CHANGELOG.md below this heading, verbatim.
  2. Update the compare link.
  3. Keep the "About" pitch short and current — add a bullet only when a release
     adds a capability users would choose the card for. The README stays the
     reference; this is the shop window.
Paste the whole file (minus this comment) as the GitHub release body.
-->

### Changed

- Default field order, from testing against cap_alerts' providers (refs #1): `web` is
  tried before `url` for the link, since CAP feeds often put the raw source document in
  `url`; `severity_normalized` before `severity`; and `sent` is the last fallback for
  the time, for feeds that publish no onset. A user mapping is unaffected.

**Full Changelog**: https://github.com/DTekNO/ha-alert-card/compare/v2026.10.2...v2026.10.3

---

### About HA Alert Card

A Lovelace card that shows alerts from **any Home Assistant entity** carrying structured
alert data. It speaks [CAP](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html)
field names by default, so CAP-shaped sources need no configuration; anything else is a
per-source field mapping away.

**What the card does**

- **Any source** — a list attribute, a single alert object, the entity itself, or every
  entity under a device for integrations that create one entity per alert (cap_alerts,
  NINA). Several sources combine in one card.
- **Compact mode** (`compact: true`) — one line per alert with a thumbnail, title and
  subtitle, and source, area and time on the right, for dense dashboards. The default
  layout keeps full rows with expandable detail.
- **Dismiss and restore** — per-alert dismiss stored server-side per HA user, synced across
  browsers and devices; dismissed alerts reviewable and restorable from the header.
- **Severity colouring** — a colour bar keyed to severity, with CAP, Norwegian and generic
  level names built in and all of them overridable.
- **Expandable detail** — description and instructions rendered as markdown, with the
  feed's own formatted content when it has some.
- **Per-alert images** — from `entity_picture` automatically, or any attribute you name.
- **Safe with untrusted feeds** — feed text is escaped and link and image URLs are
  scheme-restricted.
- **Visual editor** — full configuration in the card picker, no YAML required.
- **Lightweight** — one plain JS file, no build step, no dependencies.

📖 Configuration reference, worked examples (USGS earthquakes, US NWS alerts, cap_alerts,
compact rows) and behaviour details: [README](https://github.com/DTekNO/ha-alert-card#readme).
