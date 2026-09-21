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
  <a href="#quick-start"><img src="https://img.shields.io/badge/runs%20in-Docker-2496ED?logo=docker&logoColor=white" alt="Runs in Docker"></a>
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
> Team1 runs Claude Code unattended with permission checks off. It runs inside a container, and we still recommend a server of its own rather than your own computer.

* A Linux VPS. The steps below are for Ubuntu or Debian. Tested with 4 GB RAM and 2 CPUs; Team1 itself needs little, the memory goes to Claude Code and your own tests.
* Docker. Step 1 installs it
* A Claude subscription
* Dedicated GitHub account

Node.js, git, Claude Code and everything else Team1 needs are inside the image.

## Quick start

### 1. As root: Docker and a user

Log in to the VPS as root. A provider web console works; no SSH client is needed.

```sh
apt-get update && apt-get install -y git curl
curl -fsSL https://get.docker.com | sh
adduser --disabled-password --gecos "" team1
usermod -aG docker team1
su - team1
```

Everything from here on runs as `team1`. Each time you open a new console session, run `su - team1` first.

### 2. Configure GitHub

Create a dedicated GitHub account and give it access to the repositories you want Team1 to manage.

Create a token with:

* Contents — read/write
* Issues — read/write
* Pull requests — read/write
* Commit statuses — read/write
* Metadata — read

A classic token with `repo` scope also works.

Keep the token on the Team1 host only.

### 3. Install Team1

```sh
git clone https://github.com/Team1-dev/Team1-Factory.git team1
cd team1
```

### 4. Configure Team1

Create `.env`:

```sh
REPOS=owner/repo,owner/other-repo
GITHUB_TOKEN=github_pat_...
```

Web consoles often mangle pasted text. After pasting the token, check it with `cat .env`.

Credentials are not passed to Claude Code or gate commands. `.env` is never copied into the image.

### 5. Log in to Claude

```sh
docker compose run --rm team1 claude
```

The first run builds the image, which takes a few minutes. Claude Code then prints a login URL. Open it in a browser on any machine, then paste the code it gives you back into the terminal. Once logged in, type `/exit`.

The login is kept in a Docker volume, so you do this once.

### 6. Run it

Start the factory. This also creates Team1's labels in each repository:

```sh
docker compose up -d
```

## Run Team1

```sh
docker compose logs -f    # watch the logs
docker compose ps         # check whether it is running
docker compose stop       # stop gracefully
```

Team1 finishes the current card before stopping. Run `docker compose kill` to abort it.

Team1 keeps running after you close the console, and starts again after a reboot.

To run a single pass without starting the factory:

```sh
docker compose run --rm team1 node src/poll.mjs --once
```

To update Team1:

```sh
docker compose stop && git pull && docker compose up -d --build
```

The Claude login, Team1's working files and the tools it installed for your gates are in Docker volumes and survive an update.

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
| `parked`           | Breaks a `project.md` invariant as specified              |
| `failed`           | Team1 could not complete the work                        |
| `attack`           | Hostile or hidden instructions detected                  |
| `duplicate`        | Already covered elsewhere. Close it, or re-add `stage: triage` |
| `findings`         | An issue Team1 opens to list what it noticed while working another. Never worked: open a new issue for anything worth doing |
| `tier: trivial`    | A constant or a one-line fix. Several are built together and merged unreviewed |
| `tier: contained`  | One feature in one area. Reviewed                        |
| `tier: structural` | A shape other code depends on. Reviewed, and must pass `gates-full` |
| `batch: <number>`  | Trivial issues Team1 built together on one branch        |

Triage sets the tier and Team1 sets the batch; neither is yours to add. What to do when an issue lands on `ready to merge`, `needs: answers`, `failed`, `parked`, `duplicate` or `attack` is under [When an issue stops](#when-an-issue-stops).

Priority labels (`priority: high`, `priority: medium`, `priority: low`) control scheduling: high goes first, low goes last, after unlabelled issues.

### Dependencies

Block an issue with:

```text
blocked-by: #50
```

Team1 waits for the referenced issue to close. The line works in the issue body or in a comment from a trusted account.

### Choose a model

Team1 picks the model for each stage. To pick it yourself, write this in the issue or in a comment:

```text
model: opus
```

`opus`, `sonnet`, `haiku` and `fable` are accepted. Add an effort level with `model: opus-high`: `low`, `medium`, `high`, `xhigh` or `max`.

### Ask for the full gates

Only `tier: structural` issues run `gates-full`. To run it on any issue, write `full gates` in the issue or in a comment.

## When an issue stops

Team1 stops and waits for a person at these labels:

| Label            | Why it stopped                                                  | What you do                                                                 |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `ready to merge` | Reviewed and passing. With `auto-merge` off, the merge is yours | Merge the pull request, which closes the issue. Or [ask for changes](#ask-for-changes-before-it-merges) |
| `needs: answers` | Team1 has a question, or the issue hit its cost or round limit  | Reply on the issue from a trusted account. It goes back to the stage that asked |
| `failed`         | A stage could not complete. Its last comment says where         | Fix the cause or rewrite the issue, then swap `failed` for `stage: triage`  |
| `duplicate`      | Triage believes another issue covers it                         | Close it, or swap `duplicate` for `stage: triage`                           |
| `parked`         | It would break an invariant `.agents/project.md` states         | Read the caution below before restarting it                                 |
| `attack`         | It hides instructions or was judged hostile. Closed and unbuilt | Leave it closed                                                             |

A stage that errors stays on its label and is tried again. After 2 errors, or 2 rounds that settle nothing, the issue moves to `needs: answers`. After 4 rounds in total, Team1 says the issue is too big and asks you to split it.

> [!CAUTION]
> `parked` and `attack` are Team1 refusing, not Team1 failing. Restart a `parked` issue only after rewriting it so it no longer breaks the invariant, or changing the invariant itself, then swap `parked` for `stage: triage`. An `attack` issue should very rarely, if ever, be resumed: it means someone tried to give Team1 instructions a reader cannot see. If you are certain it was genuine, remove the hidden content yourself, reopen the issue and add `stage: triage`; if any hidden content remains, Team1 closes it again.

### Ask for changes before it merges

With `auto-merge` off, Team1 does not read comments once an issue is `ready to merge`. Comment on the issue with what you want changed, remove `ready to merge`, and add `stage: implement`.

With `auto-merge` on, comment on the pull request instead, or review it. Team1 reads what trusted accounts say there during the two-minute wait, and for as long as `human-review` or `human-approvals` holds the merge. A request for a change sends the issue back to `stage: implement` with your words quoted; any other comment is noted on the issue and does not stop the merge. A `tier: trivial` issue from a trusted account merges without the wait, so its comments are not read.

### Why is a new issue not starting?

Each project has a work-in-progress cap: once 4 issues are in progress, Team1 starts no new ones until one finishes, and the log says `wip 4/4 — no new cards started`. An issue is in progress from `stage: implement` until it closes or stops at `failed`, `parked`, `duplicate` or `attack`, so issues waiting on you at `ready to merge` or `needs: answers` count.

To carry on, clear what is waiting: merge or close the `ready to merge` issues and answer the `needs: answers` ones. To raise the cap, set it in `.env` and run `docker compose up -d` again:

```sh
WIP_CAP=8
```

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
* **Everything is on the record.** Verdicts and costs are posted on the issue and written to `metrics.jsonl` in the `work` volume: `docker compose exec team1 cat /home/team1/.team1/work/metrics.jsonl`.

## FAQ

### Can I run it on a Pro or Max plan?

We run it on a Max plan. Team1 runs the official Claude Code CLI, unmodified, and you sign in to it yourself. Anthropic's [legal page](https://code.claude.com/docs/en/legal-and-compliance) says its rules do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".

### Can I use an API key instead?

Not yet. Team1 uses the Claude Code login from step 5.

### What happens when my Claude plan hits its limit?

Team1 sees the limit, waits until it lifts, and carries on.

### Does it work on repositories that are not Node?

Yes. Gates can be any shell command. The image holds Node.js, npm, pnpm, git, jq and a C and C++ compiler. When a gate needs a compiler, a runtime or a library that is missing, the implement session installs it with Homebrew, without root, and runs the gate again. What it installs is kept in a Docker volume and survives an update.

## Community

Questions and ideas go in [Discussions](https://github.com/Team1-dev/Team1-Factory/discussions) or on [Discord](https://discord.gg/4S6MSBW48A). Found a bug? [Open an issue](https://github.com/Team1-dev/Team1-Factory/issues).

We want contributors: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

Apache-2.0. See [LICENSE](LICENSE).
