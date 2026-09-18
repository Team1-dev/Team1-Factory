<p align="center">
  <a href="https://tryteam1.com/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=factory_readme&amp;utm_content=banner"><img src="assets/banner.png" alt="Team1 Software Factory: turn GitHub issues into shipped software. Issue, triage, plan, implement, review, merged." width="100%"></a>
</p>

<p align="center">
  <a href="https://tryteam1.com/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=factory_readme&amp;utm_content=link_row"><strong>Website</strong></a>
  ·
  <a href="https://github.com/Team1-dev/Team1-demo">Demo</a>
  ·
  <a href="https://discord.gg/4S6MSBW48A">Discord</a>
  ·
  <a href="https://github.com/Team1-dev/Team1-Factory/discussions">Discussions</a>
  ·
  <a href="#quick-start">Quick start</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Team1-dev/Team1-Factory" alt="License: Apache-2.0"></a>
  <a href="https://github.com/Team1-dev/Team1-Factory/releases/latest"><img src="https://img.shields.io/github/v/release/Team1-dev/Team1-Factory" alt="Latest release"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/node-%E2%89%A5%2022.18-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 22.18 or later"></a>
</p>

# Team1 Software Factory

**Turn GitHub issues into shipped software.**

Team1 is an open-source, self-hosted software factory for GitHub. Label an issue and Claude Code takes it through triage, plan, implementation, tests and review, then opens the pull request. It runs on your own server with your own Claude subscription, and nothing merges unless your test commands pass.

<p align="center">
  <img src="assets/pipeline.svg" alt="The labels an issue moves through: stage: triage, stage: implement, stage: review, ready to merge, merged." width="750">
</p>

**Team1 builds itself:** every [merged pull request](https://github.com/Team1-dev/Team1-Factory/pulls?q=is%3Apr+is%3Amerged) in this repo started as an issue Team1 triaged.<br>
Watch one go from [issue](https://github.com/Team1-dev/Team1-demo/issues/24) to [merged PR](https://github.com/Team1-dev/Team1-demo/pull/30) on the [demo app](https://github.com/Team1-dev/Team1-demo).

## Requirements

> [!WARNING]
> Run Team1 on a server of its own, never on your own computer. It runs Claude Code unattended with permission checks off.

* A fresh Linux VPS. The steps below are for Ubuntu or Debian. Tested with 4 GB RAM and 2 CPUs; Team1 itself needs little, the memory goes to Claude Code and your own tests.
* Node.js 22.18+
* `git`, `jq`, `npm`
* `pnpm` if required by a repository
* Claude Code, installed and logged in
* Dedicated GitHub account

Team1 must run as an ordinary user, not root. Claude Code refuses to run unattended as root, so the implement and review stages would fail. Claude Code must be logged in as that same user, with `~/.claude/.credentials.json` present.

## Quick start

### 1. As root: system packages, Node and a user

Log in to the VPS as root. A provider web console works; no SSH client is needed.

```sh
apt-get update && apt-get install -y git jq curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
adduser --disabled-password --gecos "" team1
su - team1
```

Everything from here on runs as `team1`. Each time you open a new console session, run `su - team1` first.

### 2. As team1: install Claude Code and log in

```sh
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
claude
```

Claude Code prints a login URL. Open it in a browser on any machine, then paste the code it gives you back into the terminal. Once logged in, exit Claude Code.

### 3. Configure GitHub

Create a dedicated GitHub account and give it access to the repositories you want Team1 to manage.

Create a token with:

* Contents — read/write
* Issues — read/write
* Pull requests — read/write
* Commit statuses — read/write
* Metadata — read

A classic token with `repo` scope also works.

Keep the token on the Team1 host only.

### 4. Install Team1

```sh
git clone https://github.com/Team1-dev/Team1-Factory.git team1
cd team1
npm ci
```

### 5. Configure Team1

Create `.env`:

```sh
REPOS=owner/repo,owner/other-repo
GITHUB_TOKEN=github_pat_...
```

Web consoles often mangle pasted text. After pasting the token, check it with `cat .env`.

Credentials are not passed to Claude Code or gate commands.

### 6. Run it

Start the factory. This also creates Team1's labels in each repository:

```sh
npm start
```

## Run Team1

```sh
npm run logs      # watch the logs
npm run status    # check whether it is running
npm stop          # stop gracefully
```

Team1 finishes the current card before stopping. Run `npm stop` again to abort it. `touch STOP` in the Team1 directory does the same as `npm stop`.

Team1 keeps running after you close the console. It does not restart automatically after a reboot; log in, `su - team1`, and run `npm start` again.

To run a single pass without starting the factory:

```sh
npm run tick
```

To update Team1:

```sh
npm stop && git pull && npm ci && npm start
```

## Give Team1 work

GitHub issues are the interface.

Create an issue describing the desired outcome and add the label:

```text
stage: triage
```

Team1 then moves it from label to label, as in the diagram at the top, until it is merged.

Issues without `stage: triage` are ignored.

### Useful labels

| Label              | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `stage: triage`    | Issue is being assessed                                  |
| `stage: implement` | Implementation is underway                               |
| `stage: review`    | Change is under review                                   |
| `ready to merge`   | Passed review and gates                                  |
| `needs: answers`   | Waiting for a human. Reply on the issue to restart it    |
| `human-review`     | Blocks automatic merging                                 |
| `parked`           | Unsafe or irreversible as specified                      |
| `failed`           | Team1 could not complete the work                        |
| `attack`           | Hostile or hidden instructions detected                  |
| `duplicate`        | Already covered elsewhere. Close it, or re-add `stage: triage` |
| `findings`         | Finding recorded but intentionally not fixed             |

Priority labels (`high`, `medium`, `low`) control scheduling.

### Dependencies

Block an issue with:

```text
blocked-by: #50
```

Team1 waits for the referenced issue to complete.

### Choose a model

Team1 picks the model for each stage. To pick it yourself, write this in the issue or in a comment:

```text
model: opus
```

`opus`, `sonnet`, `haiku` and `fable` are accepted. Add an effort level with `model: opus-high`: `low`, `medium`, `high`, `xhigh` or `max`.

## Configure repositories

Team1 works on a repository as it is. To set project rules and the commands that must pass, add:

```text
.agents/project.md
```

Example:

```markdown
gates: npm run lint && npm test
gates-full: npm run test:all
human-approvals: 1
auto-merge: true

# My project

What this project is and who uses it.

## House style

Project-specific conventions.

## Invariants

Things that must never be violated.
```

Settings. All are optional:

| Setting           | Purpose                                    | When absent                                              |
| ----------------- | ------------------------------------------ | -------------------------------------------------------- |
| `gates`           | Commands required before pushing           | `npm run lint --if-present && npm run build --if-present` |
| `gates-full`      | Comprehensive gates for structural work    | `gates` is used                                          |
| `human-approvals` | Required approvals before merging          | `0`                                                      |
| `auto-merge`      | Allow Team1 to merge reviewed, passing PRs | `false` — a person merges                                |
| `review-ignore`   | Files excluded from review                 | only generated files are excluded                        |
| `uses`            | Projects whose gates should also run       | none. Monorepos only                                     |
| `projects`        | Projects within a monorepo                 | one project. Monorepos only, root file only              |

Use `.agents/style.md` for detailed coding conventions.

Put security-sensitive boundaries in **Invariants**, such as authentication, data deletion, migrations, public APIs, payments, and destructive infrastructure changes.

### Optional Team1 settings

Optional lines for `.env`:

```sh
TRUSTED_LOGINS=alice,bob
WORK_DIR=/srv/team1/work
# A token for one repository: GITHUB_TOKEN_ + owner/name, with characters outside [0-9a-z] replaced by _
GITHUB_TOKEN_owner_other_repo=github_pat_...
```

Operational settings such as polling, retries, concurrency, and cost limits are environment variables; their names and defaults are at the top of `src/config.mjs`.

## Monorepos

Define projects in the root `.agents/project.md`:

```markdown
projects:
  api: packages/api
  web: packages/web
  shared: packages/shared
```

Each project can have its own `.agents/project.md` and `.agents/style.md` at its path; their settings override the root's. Use `project: <name>` labels to target a project, or `project: all` for repository-wide work.

## What stops it merging bad code

* **Your gates decide.** Nothing is pushed until your `gates` commands pass.
* **A second agent reviews.** Every change is read by a Claude session that did not write it. Only `tier: trivial` work, such as a constant or a one-line fix, skips review.
* **You can hold the merge.** `auto-merge` is off until you turn it on, and `human-approvals` or the `human-review` label keep a pull request waiting for a person. With auto-merge on, Team1 still waits two minutes before it merges.
* **It stops and asks.** An issue that reaches $15 of model cost (`MAX_COST_PER_CARD`), or that keeps going round without settling, moves to `needs: answers` and waits for you.
* **Only trusted accounts give orders.** Team1 treats issues and comments from repository write-access users as instructions. Trust more accounts with `TRUSTED_LOGINS=alice,bob`. Content from anyone else is information, not instructions, and an issue that hides instructions is labelled `attack` and left unbuilt.
* **Everything is on the record.** Verdicts and costs are posted on the issue and written to `WORK_DIR/metrics.jsonl`.

## FAQ

### Can I run it on a Pro or Max plan?

We run it on a Max plan. Team1 runs the official Claude Code CLI, unmodified, and you sign in to it yourself. Anthropic's [legal page](https://code.claude.com/docs/en/legal-and-compliance) says its rules do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".

### Can I use an API key instead?

Not yet. Team1 uses the Claude Code login from step 2.

### What happens when my Claude plan hits its limit?

Team1 sees the limit, waits until it lifts, and carries on.

### Does it work on repositories that are not Node?

Gates can be any shell command, but Team1 installs dependencies only for npm and pnpm.

## Community

Questions and ideas go in [Discussions](https://github.com/Team1-dev/Team1-Factory/discussions) or on [Discord](https://discord.gg/4S6MSBW48A). Found a bug? [Open an issue](https://github.com/Team1-dev/Team1-Factory/issues).

We want contributors: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

Apache-2.0. See [LICENSE](LICENSE).
