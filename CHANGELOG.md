# Changelog

All notable changes to fabrik are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and fabrik adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-18

fabrik now starts frugal and lets you turn it up: new users explore with small tasks on modest
limits, and switch to turbo when they have the budget.

### Added

- Gears: `gear: steady | turbo` in `fabrik.yaml`, `steady` by default. `steady` protects tokens
  and limits (agents ask before edits and commands, 2 at once, 15 runs per agent per day);
  `turbo` runs agents without prompts inside the sandbox, 4 at once, 60 runs per day.
  `fabrik gear [steady|turbo]` shows or changes it.
- `fabrik review [PROPOSAL]`: a picker for each agent's model and effort, switching agents on or
  off, and the gear. Inside herdr it opens as a popup; in a terminal it draws in place. It edits
  an onboarding proposal before `fabrik init`, or a running company.
- Agents restart with new launch settings (model, effort, gear) once they are idle: `fabrik apply`
  does it right away, the daemon rolls changes through the company one agent per tick. Agents
  switched off (`enabled: false`) quit once idle and are never woken.
- The daemon reloads `fabrik.yaml` and the agent files on every tick.

### Changed

- Onboarding recommends mid-tier models (sonnet, gpt-6-sol, grok-4.7) and the smallest team,
  recommends the steady gear, and opens the review popup before `fabrik init`.
- Agents without an `autonomy` of their own follow the gear; `init` no longer writes a default
  autonomy. Explicit `max_concurrent` and `max_runs_per_day` still override the gear.

## [0.2.0] - 2026-10-18

The first end-to-end run with real Claude Code, Codex and Grok agents against a live Plane
instance ([docs/first-run-test.md](docs/first-run-test.md)) found the problems fixed here.

### Added

- Agents get `FABRIK_AGENT`, `FABRIK_COMPANY_DIR`, `FABRIK_DATA_DIR`, `FABRIK_VAULT` and
  `FABRIK_OBSIDIAN_DIR` in their environment. Claude agents can also read the company's Obsidian
  folder without a prompt.
- `fabrik stop <slug>` interrupts an agent's turn, pauses it and keeps the interrupted work queued
  ("continue after a stop") for `fabrik resume`. The plugin has a matching "stop this agent" action.
- Global instruction files no longer reach agents: Codex agents get a `CODEX_HOME` that links to
  everything in `~/.codex` except `AGENTS.md` (in testing, a global operator brief made an agent
  touch an unrelated repository). Agents still use the human's skills, memory, hooks and plugins.
- `isolate: true` in `fabrik.yaml` starts Claude agents with `--setting-sources project,local`,
  without the human's personal settings, hooks, plugins and user skills.
- The heartbeat skill ships inside every company (`.claude/skills`, `.agents/skills`) and is
  refreshed by `fabrik apply`.
- Loop guard: at most 4 wakes per ticket per hour caused by another agent's comment or mention.
- Once the asking agent has handled a human's answer, the daemon closes the `human` ticket and
  ticks its line in `attention.md`.
- `fabrik task state <KEY> done` refuses while the ticket has open sub-tasks; `--force` overrides.
- `fabrik doctor` checks the Node used by plugin commands, the In Review and Blocked states,
  workspace membership (with a hint on 403), projects outside `plane.projects` that the key can
  reach, and agent isolation.
- Generated agent instructions forbid revealing secrets.
- `fabrik init` creates the Obsidian inbox with a README; the daemon creates its logs on start.
- `fabrik --version`, CI, a contribution guide, a security policy and issue templates.

### Changed

- `autonomy: low` now asks before edits and commands in Claude Code and Grok (`default` mode
  instead of `acceptEdits`).
- Claiming a ticket no longer adds the `agent:<slug>` label. The agent holding the claim still
  receives comment wakes and sees the ticket in its inbox.
- The status popup is compact (72×14), redraws in place and uses herdr's theme colours.
- Journals, attention lines, status cards and the daily run cap use local time instead of UTC.
- The onboarding skill writes proposals to `~/fabrik/proposals/<slug>.yaml` and derives the Plane
  workspace slug from a project URL.
- Mention wakes remind the agent that the ticket belongs to someone else.

### Fixed

- The status popup, the wake action and the startup hook crashed when an older Node came first on
  herdr's PATH. All plugin commands now run through a launcher that finds Node 24.
- Introductions were marked as delivered without checking that the agent received them.
- A Codex update prompt blocked startup, and `apply` could not recover an agent whose start was
  interrupted and whose herdr name was lost.
- `apply --dry-run` reported agents as started.
- Short runs right after a context reset were never closed. This caused false "did not react"
  escalations with phone pushes, duplicate wakes, and runs counted twice against the daily cap.
- Codex's worktree picker after `/new` swallowed the next wake.
- Tickets moved from Backlog to Todo woke nobody.
- "all sub-tasks done" fired for parents that were already closed, and open `human` questions
  kept it from firing at all.
- Plane's rate limit was tracked per process instead of per API key; 429 retries were silent.
- Claims stayed held after a human closed the ticket in Plane.
- Sub-hour timers were shown as fractional hours, and the `fabrik.yaml` header pointed to a file
  that does not exist in the company folder.

## [0.1.0] - 2026-10-17

First public release.

- `fabrik-onboard` skill: interview, org proposal, `fabrik init`.
- `fabrik apply`: one herdr tab per agent, harness start with model, effort and permissions, role
  metadata in herdr's agents pane, a one-time introduction.
- Heartbeat daemon: Plane polling (labels, comments, mentions, reopen, sub-tasks, human answers),
  Obsidian inbox notes, timers with open work, manual wakes, caps, cooldowns, context resets.
- Agent CLI: `whoami`, `inbox`, `task show|claim|release|comment|state|create`, `ask-human`,
  `note`, `run done`.
- Claude Code, Codex and Grok adapters; herdr plugin with a status popup and a wake action.

[Unreleased]: https://github.com/danglenoir/fabrik/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/danglenoir/fabrik/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/danglenoir/fabrik/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/danglenoir/fabrik/releases/tag/v0.1.0
