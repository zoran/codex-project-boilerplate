---
name: security-review
description:
  Read-only security and privacy review for changes that affect trust boundaries, authentication,
  authorization, secrets, user data, dependencies, shell execution, CI, infrastructure, or runtime
  configuration. Use near handoff when those surfaces changed or when the user explicitly requests a
  security review; skip when the task has no meaningful security surface.
---

# Security Review

Review the implemented change and report findings; do not edit files.

## Review

1. Map changed inputs, outputs, principals, data flows, trust boundaries, and operational powers.
2. Check secret/private-data exposure, authentication, authorization, validation, encoding,
   retention, logging, telemetry, and error disclosure where relevant.
3. Check shell argument handling, paths, symlinks, permissions, archive extraction, hooks, CI,
   dependency provenance, install scripts, and network failure semantics where relevant.
4. For public endpoints, assess abuse controls and resource exhaustion as well as ordinary access
   control.
5. Distinguish exploitable defects from hardening ideas and unsupported hypothetical risks.
6. Confirm security-sensitive assumptions are durable where operators or future changes depend on
   them.

Order findings by severity and include the affected boundary, realistic failure or abuse path,
preconditions, root-cause fix, and smallest proving check. If no material issue remains, state the
reviewed surfaces and residual risks. Do not create an open-ended review loop.
