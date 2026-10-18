---
name: fabrik-onboard
description: Interview the user and set up a fabrik agent company in herdr (org chart, models, Plane + Obsidian). Use when the user wants to onboard, set up or create a fabrik company, or runs /fabrik-onboard.
---

# fabrik onboarding

Goal: interview the user, propose an org of terminal agents, write a proposal file, and create
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
   - Plane: ask for the URL of one project page (for example
     `https://plane.example.com/acme/projects/…`). The base URL and the **workspace slug** (the
     first path segment, not the project name) come from it. Then ask which project identifiers
     agents may work in, and whether a dedicated Plane user exists for fabrik (recommended,
     because API keys carry their user's full permissions).
   - Each project needs the states **Todo**, **In Review** and **Blocked** next to the defaults
     (add the last two in the Started group). Recommend making Todo the default state; tickets
     in Backlog wake nobody until they move to Todo.
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

Design the smallest org that covers the goal: usually 2–5 agents (more if the user asks), with
exactly one top agent (the CEO or orchestrator). Fewer agents and mid-sized models protect the
user's limits; they can turn the company up later.

Recommend a model and effort per agent; the user adjusts both in the review popup.

- **Orchestrator (CEO):** a capable mid-tier model (claude `sonnet`, codex `gpt-6-sol`, grok
  `grok-4.7`), effort `medium`, timer `off`. Suggest `opus`/`fable`/`gpt-6.1-sol` only for complex
  goals or when the user asks for the strongest model.
- **Builders (coding, ops):** claude `sonnet` or codex `gpt-6-sol`, effort `medium`.
- **Clerical work (summaries, drafts, triage):** a cheap model (claude `haiku`, codex `gpt-6-luna`,
  grok `grok-4.7-build-fast`), effort `low`.
- Hermes agents are not supported yet. Do not propose them.
- Leave out `autonomy` and the heartbeat caps: the company **gear** sets them. Set an agent's
  `autonomy` only when the user asks for an exception (`high` disables permission prompts).
- Each agent needs: slug (`^[a-z][a-z0-9_-]{0,31}$`, a short first name works well), name,
  title, reports_to, harness, model, effort, timer, and a remit (3–6 sentences on what it owns
  and what it must not do).

**Gear.** Recommend `steady` and explain it in one sentence each:

- `steady` protects the user's tokens and limits: agents ask before edits and commands, 2 work at
  once, 15 runs per agent per day. Best for getting to know fabrik with small tasks.
- `turbo` is more autonomous and faster: no prompts inside the sandbox, 4 at once, 60 runs per
  agent per day, and noticeably more tokens. Switch any time with `fabrik gear turbo`.

Show the org as a short table (slug, title, harness, model, effort, what it owns).

## Write, review and create

1. Write the proposal to `~/fabrik/proposals/<slug>.yaml` (create the folder), never into the
   current directory, which may be someone's repository:

   ```yaml
   company: { slug: acme, name: Acme Studio, human: Marton, mission: "...", goal: "...", constraints: "...", done: "..." }
   gear: steady
   context:
     stack: "Plane CE at http://plane.lan, Obsidian vault /mnt/vault/notes, Forgejo (later)"
     inventory: "..."
     processes: "..."
     channels: "..."
   herdr: { session: default, workspace: acme }
   plane: { url: http://plane.lan, workspace: acme, projects: [ACME], key_env: PLANE_API_KEY }
   obsidian: { vault: /mnt/vault/notes, folder: Fabrik }
   router: { unassigned: ada }
   agents:
     - { slug: ada, name: Ada, title: CEO, reports_to: null, harness: claude, model: sonnet, effort: medium,
         remit: "Owns strategy and the ticket backlog. Breaks goals into tickets for the team, reviews results, asks the human before spending money." }
     - { slug: cody, name: Cody, title: Engineer, reports_to: ada, harness: codex, model: gpt-6-sol, effort: medium,
         remit: "Builds and fixes software in the company repos. Never deploys to production without a done ticket from ada." }
   notes: "anything else the user said that matters"
   ```

2. Let the user review it: run `fabrik review ~/fabrik/proposals/<slug>.yaml` and tell them a
   popup opened in herdr where they can change each agent's model and effort (←→, `e`), switch
   agents off (space), pick the gear (`g`) and accept with Enter. The command waits for them:
   - exit 0, `accepted: …`: the proposal file now holds their choices; continue.
   - exit 1, `cancelled`: ask what they want to change, edit the proposal, review again.
   - exit 4, still open: run `fabrik review ~/fabrik/proposals/<slug>.yaml --wait` until it
     returns 0 or 1. Do not edit the file meanwhile.
3. `fabrik init --from ~/fabrik/proposals/<slug>.yaml`. This creates `~/fabrik/<slug>/` and never
   touches `~/AGENTS.md`. Agents switched off in the review are created with `enabled: false`.
4. Show the user `PROPOSAL.md` and the path. Tell them how to store the Plane key, which only they
   should type: `fabrik secret set PLANE_API_KEY --company ~/fabrik/<slug>`.
5. `fabrik doctor --company ~/fabrik/<slug>` and fix what it reports.
6. Only after an explicit yes: `fabrik apply --company ~/fabrik/<slug>`. A trust dialog for the new
   folder may appear; ask the user before passing `--accept-trust`.
7. Offer `fabrik service install` to start the heartbeat. Agents use the user's own skills,
   memory, hooks and plugins; only the global instruction files stay out (`isolate: true` in
   `fabrik.yaml` keeps their personal Claude Code setup out too). Explain how work reaches agents:
   add the Plane label `agent:<slug>` to a ticket, write `@<slug>` in a comment, drop a note with
   `to: <slug>` into `Fabrik/inbox/`, or run `fabrik wake <slug>`. `fabrik review` and
   `fabrik gear` change models and the gear later; agents restart with them once idle.

## Known values (check live with `fabrik models`)

- Claude: `opus`, `sonnet`, `haiku`, `fable`, or full IDs like `claude-sonnet-5-5`. Effort: low … max.
- Codex: the slugs listed by `fabrik models codex`. Effort: low … xhigh.
- Grok: `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. Effort: low … xhigh.
