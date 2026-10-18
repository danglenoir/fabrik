# Contributing to fabrik

Thanks for helping. fabrik is small on purpose: plain TypeScript run directly by Node 24, one
runtime dependency (`yaml`), and no build step.

## Development

```sh
git clone https://github.com/danglenoir/fabrik && cd fabrik
npm install
npm test            # unit and integration tests against a fake Plane API and a fake herdr
npm run typecheck
herdr plugin link "$PWD" && sh bin/fabrik shim install
```

Tests never touch your real configuration: they redirect `FABRIK_CONFIG_DIR` and `CODEX_HOME`
to temporary directories.

### Trying changes against herdr and real harnesses

- Use a throwaway herdr session (`herdr --session fabrik-probe-<name>`), never the session you work
  in. Stop and delete it afterwards.
- Isolate fabrik's own config with `FABRIK_CONFIG_DIR`. Never override `XDG_*` for processes that
  start real harnesses: Claude Code uses `XDG_DATA_HOME` to locate its own binary.
- Use the cheapest models at `effort: low`. [docs/first-run-test.md](docs/first-run-test.md) is a
  complete end-to-end run that keeps token use low.

## Commit messages

fabrik uses [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(daemon): close short runs from their report

Explain what was wrong and why the change fixes it. Wrap at 72 columns.
```

- **Types:** `feat` (new behaviour), `fix` (a bug), `docs`, `refactor` (no behaviour change),
  `test`, `chore` (tooling, CI, releases).
- **Scopes** follow the source files: `apply`, `daemon`, `rules`, `tasks`, `plane`, `harness`,
  `agents`, `control`, `doctor`, `init`, `status`, `plugin`, `skills`.
- One logical change per commit, with its tests. A breaking change gets a `!` after the scope and a
  `BREAKING CHANGE:` footer.

## Changelog and versions

- Add user-visible changes to the **Unreleased** section of [CHANGELOG.md](CHANGELOG.md) in the same
  pull request. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- fabrik follows [Semantic Versioning](https://semver.org/). Until 1.0, a minor release (0.x.0) may
  change behaviour; a patch release (0.x.y) only fixes bugs.
- The version lives in two places, which must match: `package.json` and `herdr-plugin.toml`.

## Releasing

1. Move the **Unreleased** entries in CHANGELOG.md under a new version heading with today's date,
   and update the comparison links at the bottom.
2. Bump `version` in `package.json` and `herdr-plugin.toml`, and run `npm install` so that
   `package-lock.json` follows.
3. Commit as `chore(release): X.Y.Z`, then tag it: `git tag -a vX.Y.Z -m "fabrik X.Y.Z"`.
4. Push the commit and the tag: `git push --follow-tags`.

## Reporting security issues

Please do not open a public issue for security problems. See [SECURITY.md](SECURITY.md).
