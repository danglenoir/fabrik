# Security policy

fabrik starts coding agents with access to your machine, your Plane workspace and your notes, so
security reports are welcome and taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[danglenoir/fabrik](https://github.com/danglenoir/fabrik/security/advisories/new). Please include
what an attacker can do, the steps to reproduce it, and the fabrik version (`fabrik version`).

We will acknowledge the report and keep you posted on the fix. Please allow reasonable time for a
fix before you disclose the problem.

## Supported versions

Only the latest release receives security fixes while fabrik is below 1.0.

## Scope notes

- Text in tickets, comments and notes reaches agents as data. A way to make agents follow it as
  instructions in spite of their AGENTS.md is in scope.
- `autonomy: high` disables the harnesses' permission prompts by design; what an agent can do in
  that mode is not a vulnerability in fabrik.
