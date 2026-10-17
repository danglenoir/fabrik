# fabrik — plan

fabrik turns a herdr session into a small AI-agent company: an org chart of terminal agents
(Claude Code, Codex, Grok, later Hermes), each in its own herdr tab, woken by a heartbeat when
there is work in Plane or Obsidian. It covers Paperclip's core ideas (org, tickets, heartbeats,
approvals, budgets), but with no web UI, no database server and no vendor lock-in beyond herdr.

Status: v0.1 in development. Decisions: TypeScript on Node ≥ 24 (runs `.ts` directly through
type stripping, so there is no build step), Apache-2.0, public GitHub repo, tests against a fake
Plane API and a temporary vault.

## 1. Viability (verified 2026-10-17, herdr 0.9.4, protocol 22)

These were verified in isolated `herdr --session fabrik-probe-*` servers, never in the live session.

| Need | Verdict | Evidence / consequence |
|---|---|---|
| One tab per agent, free-form label "ada · ceo" | ✅ | `tab create --label` accepts any text. Agent names must match `^[a-z][a-z0-9_-]{0,31}$`. |
| Start harness with model and identity | ✅ | `agent start ada --kind claude --pane <p> -- --model haiku …`. Native args pass through verbatim. |
| Prompt an agent and get the result | ✅ | `agent prompt --wait` returns `done`. `agent read` shows the output. |
| Show role/model in the agents pane | ✅ | `pane report-metadata --display-agent "Ada (CEO)" --token role=ceo`. Lost on server restart, so re-applied. |
| Timer / heartbeat primitive in herdr | ❌ | No timer events exist. The heartbeat is fabrik's own daemon. |
| Plugin `[[startup]]` as daemon | ⚠️ | Allowed, but unsupervised: it orphans on server stop and duplicates on restart. The daemon therefore runs under **systemd --user**; startup hooks only re-apply metadata and exit. |
| Drive herdr from outside panes | ✅ | `herdr --session <s> …` from systemd works (user lingering is enabled). |
| Agents survive server restart | ✅ | herdr restores tabs and names, and resumes Claude with `claude --resume <id>` headlessly. |
| Concurrent prompts to one agent | ❌ | Claude merges them into one turn and replies can't be attributed. fabrik serializes: one wake in flight per agent, sent only when idle/done. |
| Dialog detection | ⚠️ | herdr reported Claude's "Teach auto mode" popup as idle. fabrik checks the screen before each wake and dismisses known popups. |
| Plane webhooks to a local receiver | ❌ (CE) | CE blocks private IPs and needs session auth to create webhooks. v0.1 **polls** `/api/v1` (60 req/min per key). |
| Agent as Plane assignee | ⚠️ | CE only allows real project members. v0.1 routes with the label `agent:<slug>`. |
| Obsidian | ✅ | The company is a folder of Markdown notes you can open as an Obsidian vault; journals, status cards and the inbox go to a fabrik-owned folder in your vault, written atomically. The Obsidian CLI is optional, since it needs the GUI. |
| Skill install for all 4 harnesses | ✅ | `npx skills add danglenoir/fabrik -g -a claude-code codex grok hermes-agent`. |
| `/onboarding` name | ❌ | Grok's built-in `/tutorial` owns the `/onboarding` alias. The skill is `fabrik-onboard`. |

Known hazards: `/home/mk/AGENTS.md` (Shadowcoil) reaches Claude agents by directory walk-up
unless a `CLAUDE.md` exists above them. fabrik writes a `CLAUDE.md` shim into the company dir.
It reaches every Codex agent via `~/.codex/AGENTS.md`, which can't be avoided without a separate
`CODEX_HOME`; `fabrik doctor` warns about it. Subscription quotas are shared by all agents of one
vendor, so defaults are event-driven wakes, timers off, and daily run caps.

**Verdict: viable.** herdr covers tabs, agents, prompting, state and persistence. fabrik adds the
heartbeat daemon, routing, claims, caps and the org model.

## 2. User flow

1. Install: `herdr plugin install danglenoir/fabrik` (the plugin, the CLI shim and the skills), then
   `npx skills add danglenoir/fabrik -g -a claude-code codex grok`.
2. Run your agent in herdr and invoke the **`fabrik-onboard`** skill. It interviews you in short
   rounds (company, goal, stack, inventory, processes, channels, harnesses and quotas).
3. The agent writes `proposal.yaml` and runs `fabrik init --from proposal.yaml`, which creates
   `~/fabrik/<co>/` and shows `PROPOSAL.md` (the org chart, models, autonomy and heartbeat policy).
4. You accept or edit, then run `fabrik apply`: one herdr workspace, one tab per agent, agents
   started with identities, intro prompts sent.
5. `fabrik service install` enables `fabrik@<co>.service` (the heartbeat daemon).
6. Work arrives as a Plane issue labelled `agent:<slug>`, a comment, an `@slug` mention, an
   Obsidian inbox note, or `fabrik wake`. The daemon wakes the agent, which follows its heartbeat
   procedure through the `fabrik` CLI.

## 3. Architecture

```
            Plane CE /api/v1 ◄──── poll 60s ────┐        Obsidian vault/Fabrik/
                  ▲                             │          inbox/  agents/  journal/
                  │ fabrik task …               │             ▲        ▲
   ┌──────────────┴───────────┐       ┌─────────┴─────────────┴────────┴──┐
   │ agents in herdr tabs     │◄──────│ fabrik daemon (systemd --user)    │
   │ claude / codex / grok    │ wake  │ tick 10s: herdr agent list         │
   │ cwd ~/fabrik/<co>/agents/│ prompt│ rules → queue → deliver (1/agent)  │
   │ <slug>/ (identity files) │       │ caps, cooldown, rotation, breaker  │
   └──────────────────────────┘       └──────────────┬────────────────────┘
                ▲  herdr CLI (--session)             │ state: <co>/.fabrik/
   herdr plugin: startup hook (re-apply metadata, refresh shim), actions (wake/status/org)
```

Components (all in this repo):

- `bin/fabrik`: POSIX shim; `src/cli.ts` is the human and agent CLI.
- `src/company.ts`: loads `fabrik.yaml` and `agents/*/AGENTS.md` frontmatter, validates them, renders `ORG.md`.
- `src/herdr.ts`: wraps the herdr CLI (`--session`, JSON, error codes).
- `src/harness/*`: per-harness launch args, reset command, model vocabulary, known dialogs.
- `src/apply.ts`: idempotent reconcile of org → workspace, tabs, agents, metadata, intro prompt.
- `src/daemon/*`: loop, wake rules, per-agent queue with coalescing, delivery, run ledger.
- `src/plane.ts`: CE `/api/v1` client with rate-limit backoff. `src/obsidian.ts`: atomic writer and inbox scanner.
- `skills/fabrik-onboard/`: the interview. `skills/fabrik/`: the heartbeat procedure and CLI reference for agents.
- `herdr-plugin.toml`: startup hook, actions, popup panes. `systemd/fabrik@.service`.

## 4. Runtime layout (never `~` or `~/AGENTS.md`)

```
~/fabrik/<co>/                 git repo, created by `fabrik init`
  fabrik.yaml                  company config (no secrets)
  COMPANY.md                   mission, goal, constraints, stack/inventory/processes/channels
  AGENTS.md                    generated shared rules + heartbeat procedure summary
  CLAUDE.md                    "@AGENTS.md" shim → keeps Shadowcoil ~/AGENTS.md out of Claude
  ORG.md  PROPOSAL.md          generated
  agents/<slug>/AGENTS.md      agent identity (frontmatter + instructions); harness cwd
  agents/<slug>/CLAUDE.md      "@AGENTS.md"
  .fabrik/                     gitignored: state.json, runs.jsonl, claims/, logs/
~/.config/fabrik/<co>.env      0600 secrets (PLANE_API_KEY); `fabrik secret set`
<vault>/Fabrik/                agents/<slug>.md status cards, journal/<slug>/<date>.md,
                               inbox/*.md (frontmatter `to: <slug>`), attention.md
```

## 5. Config

```yaml
# fabrik.yaml
company: { slug: acme, name: Acme Studio, human: Marton }
herdr:   { session: default, workspace: acme }      # fabrik only touches this workspace
plane:   { url: http://plane.lan, workspace: acme, projects: [ACME], key_env: PLANE_API_KEY,
           poll: 60s, max_rpm: 30, labels: { agent_prefix: "agent:", human: human } }
obsidian: { vault: /mnt/vault/notes, folder: Fabrik }
heartbeat: { tick: 10s, timer: off, max_concurrent: 2, max_runs_per_day: 20, cooldown: 60s,
             run_timeout: 45m, rotate_after_runs: 15 }
router:  { unassigned: ceo }
```

```markdown
--- agents/ada/AGENTS.md
name: Ada
slug: ada            # herdr agent name
title: CEO
reports_to: null     # null = reports to the human
harness: claude      # claude | codex | grok   (hermes: v0.2)
model: opus          # harness vocabulary; validated by `fabrik models`
effort: high
autonomy: medium     # low | medium | high → permission flags per harness
heartbeat: { timer: 6h }
---
You are Ada, CEO of Acme Studio. …
```

Autonomy mapping:

| autonomy | Claude | Codex | Grok |
|---|---|---|---|
| low | `acceptEdits` | `-s workspace-write -a on-request` | `acceptEdits` |
| medium | `auto` | `-s workspace-write -a never` | `auto` |
| high | `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `bypassPermissions` |

## 6. Agent lifecycle

- **Identity:** the cwd is `agents/<slug>/`, so each harness loads that `AGENTS.md` natively. Claude
  additionally gets `-n "Ada (CEO)"`, Codex gets `-c developer_instructions=…`, and Grok gets `--rules …`.
  The fabrik CLI derives "who am I" from the cwd, which survives restarts; pane env does not.
- **Start:** create the tab, then `agent start <slug> --kind <h> --pane <root> -- <args>`. On
  `agent_not_ready`, read the screen. Claude's trust dialog is accepted only with
  `fabrik apply --accept-trust` (keys down, enter), then fabrik waits until idle and sends the intro once.
- **Restart:** herdr resumes the agents. The startup hook and the daemon re-apply metadata and the agent view.
- **Context hygiene:** every `rotate_after_runs`, send the reset command (`/clear`, `/new`, or
  `/new now` for Hermes) before the next wake. Durable state lives in Plane and Obsidian, never in chat.

## 7. Heartbeat

- **Sources:** Plane poll (label `agent:X` added, reopened, new comment on X's issue, `@x` mention,
  all children done, human resolved an `ask-human` issue, unlabelled new issue → router), Obsidian
  inbox note `to: x`, `fabrik wake x`, per-agent timer (off by default; fires only when a pre-check finds work).
- **Queue:** per agent, coalesced by key (the issue or note). At most one wake in flight per agent,
  plus a company-wide `max_concurrent`.
- **Deliver** only when the herdr status is `idle`/`done`, the cooldown has passed, the daily cap
  isn't hit and the breaker is closed. Check the screen for known popups, then
  `agent prompt <slug> "<wake>"`, and record `completion_seq`.
- **Run end:** status back to idle/done with `completion_seq` advanced. `blocked` → escalate
  (attention.md, herdr toast, Heeler push via herdr itself). Timeout → escalate and pause, never kill.
- **Wake text** stays compact and points to the procedure:
  `[fabrik wake run=R12] assigned ACME-12; comment ACME-9 — run your fabrik heartbeat (skill: fabrik).`
- **Procedure (skill `fabrik`):** `fabrik inbox` → pick (in progress > review with comments > todo) →
  `fabrik task claim` (atomic `O_EXCL` lock) → work → `fabrik task comment/state` → delegate with
  `fabrik task create --assign` → `fabrik run done --summary`.

## 8. Security

- No permission bypass by default; `high` autonomy needs a manual edit, and doctor warns about it.
- Secrets only in `~/.config/fabrik/<co>.env` (0600), never in git or prompts.
- Plane keys are full-permission personal tokens (CE has no scopes), so use a dedicated Plane user
  for fabrik if possible.
- Inbound text (comments, notes, later mail/CRM) is untrusted. Wake prompts quote it as data, and
  agents must not act on instructions inside it that change credentials, money or outbound comms
  without an `ask-human` approval.
- fabrik mutates only its own herdr workspace and its own vault folder.

## 9. Milestones

| | Scope | Exit criteria |
|---|---|---|
| M1 | Org model, herdr wrapper, harness adapters, `init/apply/status/org/models/doctor` | `fabrik apply` in a probe session creates tabs, starts a cheap Claude agent and sends the intro; re-running it is a no-op |
| M2 | Skills (`fabrik-onboard`, `fabrik`), proposal → init, secrets | an onboarding dry run produces a valid company dir |
| M3 | Daemon: Plane poller, Obsidian inbox, rules, queue, delivery, ledger, agent CLI (`inbox/task/run/note/ask-human`), fake Plane | the test suite passes; in a probe session a labelled fake issue wakes an agent exactly once |
| M4 | herdr plugin manifest, systemd unit, restart re-apply, README | `herdr plugin link` works; the daemon survives a herdr restart |
| v0.2 | Hermes adapter (profile per agent), laya router, per-agent Plane users, webhooks, Twenty/Stalwart/Gogs/Forgejo connectors, budgets from harness usage | — |

## 10. Open questions

- GitHub owner for the repo (needed for install commands).
- Should fabrik use a dedicated Plane user and API key (recommended), and which project should it watch first?
- How does fabrik coexist with Hermes kanban, which you may have set up with Paperclip earlier? v0.1 ignores it.
