---
name: dependency-maintenance
description:
  Inspect, update, pin, or remediate dependencies across a multi-package workspace while preserving
  each package's current version line, lockfile integrity, migration requirements, and explicit
  network uncertainty. Use for dependency reports, patch/minor/major upgrades, lockfile changes,
  supply-chain incidents, or dependency policy work.
---

# Dependency Maintenance

## Rules

- Keep deterministic manifest/lock consistency separate from network-dependent registry freshness.
- Preserve workspace, manifest, dependency section, current spec, and current version identity for
  every recommendation and update. Never collapse updates by package name alone.
- A patch update must remain on that manifest's current major/minor line. Minor updates require user
  selection; major updates require explicit selection, migration review, and targeted regression.
- Registry or advisory lookup failure is indeterminate, not proof that no update or vulnerability
  exists. Report it and leave manifests unchanged.
- Pre-push is read-only. Apply dependency changes before commit through an explicit maintenance
  command.

## Workflow

1. Read root and workspace manifests, lockfile, package-manager version, and dependency policy.
2. Run the compact report:

   ```bash
   pnpm deps:report
   ```

3. Preview automatic patch/fix maintenance and inspect the exact per-workspace targets:

   ```bash
   pnpm deps:update:patch
   ```

   Apply that same reviewed plan explicitly:

   ```bash
   pnpm deps:update:patch:apply
   ```

4. For selected minor/major work, name the package and affected workspace explicitly. Check official
   migration notes and breaking changes before editing.
5. Re-resolve the lockfile with scripts disabled unless an audited package requires a build step.
   Inspect unexpected transitive/native changes.
6. Run install/lock consistency plus the tests/builds for every affected consumer. Run
   `pnpm verify:external` for a fresh registry/advisory result when required.

## Supply-Chain Incident

For a compromise or active advisory, do not choose a registry update automatically. Confirm the
incident through a trusted primary source; identify direct and transitive resolved versions and
actual use/exposure; independently verify a safe target or replacement; then contain with removal,
replacement, override, or a documented pin. Run `$security-review` for the affected build/runtime
boundary and record uncertainty when no trusted safe version is known.

## Output

Provide a compact per-workspace table of current, wanted, latest, delta, action, and uncertainty.
Record pins with an owner/reason and review condition instead of leaving unexplained permanent pins.
