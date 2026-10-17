<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/fabrik-dark.svg">
    <img alt="fabrik" src="docs/fabrik-light.svg" width="416">
  </picture>
</p>

<h3 align="center">An agent company in your terminal.</h3>

<p align="center">
  A <a href="https://herdr.dev">herdr</a> plugin that turns Claude Code, Codex and Grok into an org chart of named tabs,<br>
  and wakes each agent when it has a task. No complex configuration and no web UI.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-b11226"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-%E2%89%A524-0a0a0a">
  <img alt="herdr 0.9.3+" src="https://img.shields.io/badge/herdr-%E2%89%A50.9.3-0a0a0a">
  <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-b11226">
</p>

<p align="center">
  <a href="https://skape.io/fabrik">Website</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="PLAN.md">Design &amp; viability notes</a>
</p>

---

## Why fabrik

Agent "company" tools like Paperclip showed that a team of coding agents with roles, tickets and a
heartbeat gets real work done. They also come with a web dashboard, a database server and
configuration that only lives behind a UI.

fabrik keeps the idea and drops the rest:

- **Your terminal is the office.** Every agent is a real, interactive Claude Code, Codex or Grok
  session in its own herdr tab, named for its role (`ada · ceo`, `cody · engineer`). You can talk to
  any of them at any time.
- **Your org is a folder.** fabrik keeps your company in a folder of Markdown notes that you can open
  as an Obsidian vault: one note per agent with its name, role, model and instructions. Edit a note
  and fabrik uses it the next time it starts that agent. It's all plain files under git.
- **Work arrives as tasks, not prompts.** Tasks live in Plane. A heartbeat wakes the right agent when
  a ticket is labelled for it, and only when the agent is free.
- **Vendor-agnostic.** The only hard dependency is herdr. Mix harnesses and models per role.

## How it works

```
        you ──brief──►  ┌──────────────── herdr ────────────────┐
                        │  ada · ceo     cody · engineer   ...  │
  ┌──── Plane ────┐     │  claude/opus   codex/gpt-6-sol        │     ┌── Obsidian ──┐
  │ ACME-12       │◄────┤  fabrik task create / claim / comment ├────►│ agents/      │
  │ agent:cody    ├────►│  [fabrik wake] ACME-12: assigned      │     │ journal/     │
  └───────────────┘     └───────────────────▲───────────────────┘     │ inbox/       │
                                            │                         └──────────────┘
                              fabrik daemon (systemd --user): polls Plane and herdr,
                              wakes idle agents, enforces caps, escalates blocks
```

1. **You give your company a task.** Brief your CEO agent in its herdr tab.
2. **The CEO turns it into tickets.** It files them in Plane, each labelled `agent:<slug>` for the
   agent who should do it.
3. **The heartbeat wakes the right agent.** The fabrik daemon sees the label and sends a short
   `[fabrik wake …]` prompt to that agent's tab, but only once herdr reports it idle.
4. **The agent claims it and works.** Claims are exclusive, so two agents never do the same job.
   Progress goes on the ticket as comments.
5. **It writes down what it learned.** Decisions and journals go into your vault as plain notes.
   Chats can be reset; notes stay.
6. **It hands the work back.** The ticket moves to review, the agent runs `fabrik run done`, and it
   rests until its next task.

## Features

- **Onboarding interview:** the `fabrik-onboard` skill asks about your company, stack, servers,
  processes and channels, then proposes an org. Nothing starts until you accept it.
- **One command to staff the office:** `fabrik apply` opens one herdr tab per agent, starts each
  harness with its model, effort and permission level, shows role and model in herdr's agents pane,
  and introduces every agent once. Running it again changes nothing.
- **A heartbeat that stays out of the way:** event-driven wakes from Plane labels, comments,
  `@mentions`, Obsidian inbox notes or `fabrik wake`. Optional timers fire only when there is open
  work. The daemon enforces cooldowns, daily run caps, a company-wide concurrency limit and context
  resets, and pauses an agent after repeated failures.
- **Agents speak fabrik:** a small CLI for `inbox`, `task claim/comment/state/create`, `ask-human`,
  `note` and `run done`. Comments are signed, so agents never wake themselves.
- **Humans stay in charge:** money, outbound mail, credentials and new hires go through
  `fabrik ask-human`, which opens a Plane ticket labelled `human` and waits for your answer.
- **Survives restarts:** herdr resumes the agents and fabrik re-applies their roles and models.

## Requirements

- [herdr](https://herdr.dev) 0.9.3 or newer.
- Node.js 24 or newer. fabrik runs its TypeScript directly, with no build step.
- At least one of Claude Code, Codex or Grok, logged in, with herdr's integration installed
  (`herdr integration install claude`, and so on).
- For tasks: Plane (Community Edition or Cloud) and an API key. For notes: an Obsidian vault folder.

## Install

```sh
herdr plugin install danglenoir/fabrik                         # plugin + `fabrik` on your PATH
npx skills add danglenoir/fabrik -g -a claude-code codex grok  # the onboarding and heartbeat skills
```

## Quick start

1. **Onboard.** In any agent tab in herdr, ask your agent to run the **fabrik-onboard** skill. It
   interviews you and writes `proposal.yaml`.
2. **Create the company.** The skill runs `fabrik init --from proposal.yaml`, which creates
   `~/fabrik/<company>/`. Review `PROPOSAL.md` there.
3. **Store the Plane key** (kept 0600 in `~/.config/fabrik/`, never in git):
   ```sh
   fabrik secret set PLANE_API_KEY
   ```
4. **Check and start:**
   ```sh
   fabrik doctor
   fabrik apply             # opens the tabs and starts the agents
   fabrik service install   # starts the heartbeat (systemd --user)
   ```

Give an agent work in any of these ways:

| How | Example |
|---|---|
| Label a Plane ticket | add `agent:cody` |
| Mention it in a comment | `@ada can you split this up?` |
| Drop a note in the vault | `Fabrik/inbox/idea.md` with `to: cody` in its frontmatter |
| Wake it by hand | `fabrik wake cody --reason "check the build"` |

## Configuration

A company is a folder. It never touches `~/AGENTS.md`.

```
~/fabrik/acme/
├── fabrik.yaml          # company settings (no secrets)
├── COMPANY.md           # mission, goal, stack, processes, channels
├── AGENTS.md            # shared rules for every agent (generated)
├── ORG.md               # org chart (generated)
└── agents/
    ├── ada/AGENTS.md    # one note per agent, also its working directory
    └── cody/AGENTS.md
```

```yaml
# fabrik.yaml
company:   { slug: acme, name: Acme Studio, human: Marton }
herdr:     { session: default, workspace: acme }
plane:     { url: http://plane.lan, workspace: acme, projects: [ACME], key_env: PLANE_API_KEY }
obsidian:  { vault: /path/to/vault, folder: Fabrik }
heartbeat: { tick: 10s, timer: off, max_concurrent: 2, max_runs_per_day: 20, cooldown: 60s, rotate_after_runs: 15 }
router:    { unassigned: ada }
```

```markdown
---
name: Cody
slug: cody            # the herdr agent name
title: Engineer
reports_to: ada       # null for the top agent
harness: codex        # claude | codex | grok
model: gpt-6-sol      # in the harness's own vocabulary; `fabrik models` lists them
effort: medium
autonomy: medium      # low | medium | high
heartbeat: { timer: off }
---
You are Cody, the Engineer of Acme Studio. …
```

`autonomy` maps to each harness's own permission flags:

| autonomy | Claude Code | Codex | Grok |
|---|---|---|---|
| low | `acceptEdits` | `workspace-write`, asks on request | `acceptEdits` |
| medium | `auto` | `workspace-write`, never asks | `auto` |
| high | `bypassPermissions` | no sandbox, no approvals | `bypassPermissions` |

## CLI

| Command | What it does |
|---|---|
| `fabrik init --from proposal.yaml` | Create a company from an onboarding proposal |
| `fabrik apply [--dry-run] [--accept-trust]` | Open tabs and start agents (idempotent) |
| `fabrik doctor` | Check herdr, harnesses, models, Plane, Obsidian and the daemon |
| `fabrik status` · `org` · `models` | Show agents and queues, the org chart, available models |
| `fabrik wake <slug>` · `pause` · `resume` | Control the heartbeat per agent |
| `fabrik service install` · `daemon` | Run the heartbeat under systemd, or in the foreground |
| `fabrik secret set KEY` | Store a secret outside the company folder |

Agents use: `fabrik whoami`, `inbox`, `task show|claim|release|comment|state|create`,
`ask-human`, `note` and `run done`. `fabrik help heartbeat` prints the procedure they follow.

## Integrations

| | Status |
|---|---|
| herdr | required |
| Claude Code, Codex, Grok | supported |
| Plane (tasks) | supported (Community Edition `/api/v1`) |
| Obsidian (notes) | supported (plain files, works with the app closed) |
| Hermes Agent | planned for v0.2 |
| Twenty CRM, Stalwart mail, Forgejo, Gogs | planned |

## Safety

- No permission bypass by default. `high` autonomy has to be set by hand, and `fabrik doctor` warns about it.
- Secrets live in `~/.config/fabrik/<company>.env` (mode 0600), never in git or in prompts.
- Ticket text, comments and notes are treated as data, not instructions.
- fabrik only touches its own herdr workspace and its own folder in your vault.

## Development

```sh
git clone https://github.com/danglenoir/fabrik && cd fabrik
npm install
npm test            # unit and integration tests against a fake Plane API
npm run typecheck
herdr plugin link "$PWD" && node src/cli.ts shim install
```

Try changes in a throwaway herdr session (`herdr --session fabrik-probe-<name> …`) and isolate
fabrik's own config with `FABRIK_CONFIG_DIR`. Never override `XDG_*` for processes that start
real harnesses: Claude Code uses `XDG_DATA_HOME` to place its own binary.

The design, the reasoning behind it and the verified viability notes are in [PLAN.md](PLAN.md).

## Roadmap

- Hermes Agent support, with one Hermes profile per agent
- Plane webhooks alongside polling, and per-agent Plane users
- laya-based routing of incoming work to the right role
- Connectors for Twenty CRM, Stalwart mail, Forgejo and Gogs

## Contributing

Issues and pull requests are welcome. Please run `npm test` and `npm run typecheck` before opening
a PR, and describe how you tested anything that touches herdr or a harness.

## License

[Apache-2.0](LICENSE). Built by [skape.io](https://skape.io), made in the EU.
