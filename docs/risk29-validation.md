# Risk29 Phase 0E validation

This file records the validation gates for the Risk29 POC branch and intentionally creates a post-enable PR synchronization event so GitHub Actions can run on the fork.

## Required gates

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm test`
- `pnpm --dir apps/explorer check:schema`
- `pnpm build:cli`
- Risk29 frame render smoke
- Risk29 frame size probe / mobile review

## Risk29-specific acceptance checks

- Five Risk29 frames are present in metadata, eager registry, and lazy registry.
- Missing/unavailable values are never coerced to zero.
- Stale/error freshness is visible to the user.
- Snapshot and history payloads are schema-validated.
- Risk29 frames do not calculate score thresholds, states, or regimes locally.
- The Risk29 plugin remains separate from the public keyless provider fleet.

Do not merge the draft PR until all required gates are green.
