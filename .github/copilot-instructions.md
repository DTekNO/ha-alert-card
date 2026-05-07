# ha-alert-card Copilot Instructions

## Project structure

- `src/ha-alert-card.js` — source of truth. This is the only file to edit when developing.
- `dist/` — release output folder. Contains only `.gitkeep` in git. **Never edit or commit files here.** Populated by the release workflow at release time. `dist/*.js` is gitignored.
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
- Do not commit anything to `dist/` — it is gitignored except for `.gitkeep`.
- To release: push a tag `vX.Y.Z` and publish a GitHub release — the workflow handles the rest.
