# ha-alert-card Copilot Instructions

## Project structure

- `src/ha-alert-card.js` — source of truth. This is the only file to edit when developing.
- `dist/ha-alert-card.js` — last built snapshot, committed to repo so HACS can validate the repository structure. **Never edit directly.** The release workflow overwrites it (in CI only) with the version-injected build from `src/`. It is fine for the committed copy to have an older/placeholder version number.
- `hacs.json` — points HACS to the `dist/` folder and release assets.

## Release workflow

On `release: published`, the GitHub Actions workflow:
1. Copies `src/ha-alert-card.js` → `dist/ha-alert-card.js`
2. Injects the tag version into `CARD_VERSION` via `sed`
3. Uploads `dist/ha-alert-card.js` as the release asset

HACS downloads the release asset from `dist/`, which always has the correct injected version.

## Development rules

- Always edit `src/ha-alert-card.js`, never `dist/ha-alert-card.js`.
- Keep `const CARD_VERSION = '0.0.0';` (or any placeholder) in `src/` — the real version is injected at release time.
- Do not manually update `dist/ha-alert-card.js` — it is overwritten by the release workflow in CI.
- To release: push a tag `vX.Y.Z` and publish a GitHub release — the workflow handles the rest.
