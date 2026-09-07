# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual strings used in this repo's issue tracker.

This repo tracks issues as local markdown (see `issue-tracker.md`), so there is no label API. The role goes in a `Status:` line near the top of the issue file:

```markdown
# 03 VRF network state pin

Status: ready-for-agent
```

| Label in mattpocock/skills | Status value in our tracker | Meaning                                  |
| -------------------------- | --------------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`              | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`                | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`           | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`           | Requires human implementation            |
| `wontfix`                  | `wontfix`                   | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), write the corresponding value from the right-hand column into that file's `Status:` line.

Edit the right-hand column to match whatever vocabulary you actually use.
