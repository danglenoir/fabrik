---
name: fabrik-onboard
description: Interview the user and set up a fabrik agent company in herdr (org chart, models, Plane + Obsidian). Use when the user wants to onboard, set up or create a fabrik company, or runs /fabrik-onboard.
---

# fabrik onboarding

Goal: interview the user, propose an org of terminal agents, write `proposal.yaml`, and create
the company with `fabrik init`. Nothing starts until the user accepts: proposing a team does
not authorize hiring it.

## Before you start

- Run `fabrik --help`. If the command is missing, tell the user to install the plugin
  (`herdr plugin install danglenoir/fabrik`, then `fabrik shim install`) and stop.
- You must be running inside herdr (`echo $HERDR_ENV` prints 1).
- Read the "Known values" section below so you only offer options that exist on this machine.

## Interview

Ask in short rounds of at most 4 questions. Offer defaults and keep moving.

1. **Company:** name, slug (lowercase, at most 16 characters), what it does, the first goal for the
   next weeks, hard constraints, and what "done" looks like for that goal.
2. **Stack** (MVP supports Plane.so and Obsidian; record anything else as context for later):
   - Plane: base URL, workspace slug, which project identifiers agents may work in. Ask whether a
     dedicated Plane user exists for fabrik (recommended, because API keys have full permissions).
   - Obsidian: vault path. fabrik only writes below one folder (default `Fabrik`).
   - Other tools (CRM, mail, git, ...): note them, but do not configure them.
3. **Inventory:** servers, services, repos and accounts the agents may touch. Mark anything that is off-limits.
4. **Processes:** recurring work such as customer management, finances, releases and support. Who does
   it today, and how often?
5. **Channels:** how the human wants to be reached for approvals (Plane, Obsidian
   `Fabrik/attention.md`, herdr notifications, phone push via the Heeler plugin).
6. **Harnesses and quotas:** which of claude, codex and grok the user is logged in to, and on which
   plans. Agents on one subscription share its limits, so fewer agents is cheaper.

## Propose

Design the smallest org that covers the goal. Usually that is 2–5 agents with exactly one
top agent (the CEO or orchestrator).

- **Orchestrator (CEO):** the strongest reasoning model the user has (claude `opus` or `fable`, codex
  `gpt-6.1-sol`, grok `grok-4.7`), autonomy `medium`, timer `6h` or `off`.
- **Builders (coding, ops):** claude `sonnet` or codex `gpt-6-sol`, autonomy `medium`.
- **Clerical work (summaries, drafts, triage):** a cheap model (claude `haiku`, codex `gpt-6-luna`,
  grok `grok-4.7-build-fast`), autonomy `low`.
- Hermes agents are planned for v0.2. Do not propose them yet.
- Use `high` autonomy only if the user explicitly asks; it disables permission prompts.
- Each agent needs: slug (`^[a-z][a-z0-9_-]{0,31}$`, a short first name works well), name,
  title, reports_to, harness, model, effort, autonomy, timer, and a remit (3–6 sentences on what it
  owns and what it must not do).

Show the org as a table and wait for the user to accept or change it.

## Write and create

Write `proposal.yaml` in the current directory:

```yaml
company: { slug: acme, name: Acme Studio, human: Marton, mission: "...", goal: "...", constraints: "...", done: "..." }
context:
  stack: "Plane CE at http://plane.lan, Obsidian vault /mnt/vault/notes, Forgejo (later)"
  inventory: "..."
  processes: "..."
  channels: "..."
herdr: { session: default, workspace: acme }
plane: { url: http://plane.lan, workspace: acme, projects: [ACME], key_env: PLANE_API_KEY }
obsidian: { vault: /mnt/vault/notes, folder: Fabrik }
heartbeat: { timer: off, max_runs_per_day: 20, max_concurrent: 2 }
router: { unassigned: ada }
agents:
  - { slug: ada, name: Ada, title: CEO, reports_to: null, harness: claude, model: opus, effort: high, autonomy: medium, timer: 6h,
      remit: "Owns strategy and the ticket backlog. Breaks goals into tickets for the team, reviews results, asks the human before spending money." }
  - { slug: cody, name: Cody, title: Engineer, reports_to: ada, harness: codex, model: gpt-6-sol, autonomy: medium,
      remit: "Builds and fixes software in the company repos. Never deploys to production without a done ticket from ada." }
notes: "anything else the user said that matters"
```

Then:

1. `fabrik init --from proposal.yaml`. This creates `~/fabrik/<slug>/` and never touches `~/AGENTS.md`.
2. Show the user `PROPOSAL.md` and the path. Tell them how to store the Plane key, which only they
   should type: `fabrik secret set PLANE_API_KEY --company ~/fabrik/<slug>`.
3. `fabrik doctor --company ~/fabrik/<slug>` and fix what it reports.
4. Only after an explicit yes: `fabrik apply --company ~/fabrik/<slug>`. A trust dialog for the new
   folder may appear; ask the user before passing `--accept-trust`.
5. Offer `fabrik service install` to start the heartbeat. Explain how work reaches agents: add the
   Plane label `agent:<slug>` to a ticket, write `@<slug>` in a comment, drop a note with
   `to: <slug>` into `Fabrik/inbox/`, or run `fabrik wake <slug>`.

## Known values (check live with `fabrik models`)

- Claude: `opus`, `sonnet`, `haiku`, `fable`, or full IDs like `claude-sonnet-5-5`. Effort: low … max.
- Codex: the slugs listed by `fabrik models codex`. Effort: low … max.
- Grok: `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. Effort: low … xhigh.
