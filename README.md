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
> Team1 runs Claude Code unattended with permission checks off. Every card runs in a sandbox container of its own, which holds no GitHub token; we still recommend a server of its own rather than your own computer.

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

### 3. Set up Team1

```sh
git clone https://github.com/Team1-dev/Team1-Factory.git team1
cd team1
./setup.sh
```

`setup.sh` checks Docker, then asks for your repositories one at a time: paste a GitHub link (or `owner/name`) and the token for it, and it checks at once that the token can write to that repository. It builds Team1 and the sandbox every card runs in, and logs in to Claude with your subscription: it prints a link to open in a browser on any machine, and you paste back the code and then the token it gives you. Everything goes into `.env`, readable by you only, never into an image.

Run it again to add or remove a repository, or to change a token.

### 4. Start it

```sh
./start.sh
```

It starts Team1, creates Team1's labels in each repository, and shows whether it came up.

**The first card of each repository waits while Team1 builds that repository's images** (see [Sandboxes](#sandboxes)): a few minutes, once. On a 2-CPU server, for a monorepo with .NET and a dozen Node apps: about 1 minute for the tools, then about 6 for the default branch built. The log says what it is building. Later restarts reuse both images.

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
docker compose stop && git pull && ./start.sh
```

When Claude's login expires, Team1 says so in its log and on the issue it was working on. Run `./login.sh`: it logs in again and restarts Team1.

Team1's working files are in Docker volumes and survive an update. The sandboxes of cards in progress keep running across an update, and Team1 picks them up again, with the card's checkout and Claude session as they were; a sandbox that was stopped is started again. Only a change to what the repository needs (its environment) replaces a card's sandbox.

## Sandboxes

Every card runs in a container of its own, and Team1's own container keeps the secrets:

* **A sandbox per card**, opened when the card first needs a checkout (implement, review or merge) and removed once the card is merged, closed or stopped. Each has a network of its own, so sandboxes cannot reach each other.
* **Every sandbox starts warm.** For each repository Team1 keeps two images: the **environment** (the tools the repository needs, worked out from its files and from `needs:` and `services:` in `.agents/project.md`) and, on top of it, the **warm image** (the default branch checked out where a card works, with every area's gates run, so packages are downloaded and projects built). A card's checkout moves to its own branch, cut from the current default branch, so its code is always up to date, and its first build compiles only what it changes. The warm image is rebuilt in the background once a day while cards carry on in the sandboxes they have. A sandbox opens in about a second: it shares the image's files and copies only what the card changes. Only the very first build of a repository is waited for; see [Start it](#4-start-it).
* **Inside, the agent can install anything** (it may `sudo`), because nothing of value is in there.
* **No GitHub token in the sandbox.** Its git talks to a proxy in Team1, which adds the token and lets a push through only to that card's own branch, force-push included. The merge itself is Team1's, through GitHub's API.
* **The Claude token does go into the sandbox** while Claude runs there. A proxy for it is planned.

Team1 needs Docker for this and does not start without it. `PARALLEL_CARDS` (default 2) is how many cards are worked at once, never two in one area; `SANDBOX_MEMORY_MB` (default 1536) caps each sandbox's memory, and `SANDBOX_CPUS` its CPUs (default 0: every CPU, shared fairly between the cards being worked); `WARM_REFRESH_HOURS` (default 24) is how old a repository's warm image gets before it is rebuilt in the background; `GITHUB_URL` (default `https://github.com`) is where the proxy sends git.

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
| `duplicate`        | Already covered elsewhere; Team1 closes it. Reopen it and re-add `stage: triage` if it is not |
| `findings`         | An issue Team1 opens to list what it noticed while working another. Team1 triages it on its own: it fixes what is worth doing and belongs to that project, opens an issue for the rest worth doing, and closes what is not |
| `from proposals`   | A card opened from a `findings` issue. What Team1 notices while working it is filed, but waits for you to put it on `stage: triage`, so proposals never breed without end |
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
| `parked`         | It would break an invariant `.agents/project.md` states         | Read the caution below before restarting it                                 |
| `attack`         | It hides instructions or was judged hostile. Closed and unbuilt | Leave it closed                                                             |

Team1 closes an issue itself, with a comment saying why, when triage finds it a duplicate or already done, or when implement finds nothing needs changing. Reopen it and add `stage: triage` if that was wrong.

An issue that is the wrong shape is never left waiting on you. Implement moves one that belongs to another project to that project, and splits one that is too big, or spans projects, into issues of their own that go straight to triage; the original waits for them and closes once they have all landed. When Team1 needs a decision only a person can make, it asks on the issue, and the person who opened it can answer there.

A stage that errors stays on its label and is tried again. After 2 errors, or 2 rounds that settle nothing, the issue moves to `needs: answers`. After 4 rounds in total, Team1 says the issue is too big and asks you to split it.

> [!CAUTION]
> `parked` and `attack` are Team1 refusing, not Team1 failing. Restart a `parked` issue only after rewriting it so it no longer breaks the invariant, or changing the invariant itself, then swap `parked` for `stage: triage`. An `attack` issue should very rarely, if ever, be resumed: it means someone tried to give Team1 instructions a reader cannot see. If you are certain it was genuine, remove the hidden content yourself, reopen the issue and add `stage: triage`; if any hidden content remains, Team1 closes it again.

### Ask for changes before it merges

With `auto-merge` off, Team1 does not read comments once an issue is `ready to merge`. Comment on the issue with what you want changed, remove `ready to merge`, and add `stage: implement`.

With `auto-merge` on, comment on the pull request instead, or review it. Team1 reads what trusted accounts say there during the one-minute wait, and for as long as `human-review` or `human-approvals` holds the merge. A request for a change sends the issue back to `stage: implement` with your words quoted; any other comment is noted on the issue and does not stop the merge. A `tier: trivial` issue from a trusted account merges without the wait, so its comments are not read.

### Why is a new issue not starting?

Each project has one pull request open at a time: while one is open, only the issue it belongs to is worked there, and the log says `#N waits: <project> has a pull open`. Across projects, Team1 merges what is ready, reviews what is waiting and builds what is triaged before it triages anything new.

Team1 works on two issues at a time (`PARALLEL_CARDS`), never two in one area, across every repository it watches. After a pass with nothing to do it waits 30 seconds, then twice as long each quiet pass, up to 5 minutes, so a label you add is picked up within 5 minutes. A pull request waiting out its one-minute comment window wakes it when the window ends.

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
| `uses`            | Projects this one builds on; a change to one runs this project's gates at review | none. Monorepos only |
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

### How gates run in a monorepo

* **Implement** runs the gates of the issue's project and of every project it changed a file in, after every round.
* **Review** runs, once, the gates of every project that `uses` those, before the model reads the change. A red one sends the issue back to implement with the output.
* **Merge** runs both again only when the default branch moved and the pull request had to be rebased.

Projects run in waves: a project starts once every project it `uses` has passed, and the projects of one wave run side by side. Installs run one at a time first, because they share the repository's dependency tree.

### Fast .NET builds in a monorepo

Team1 runs each project's `gates` command separately. If every .NET project's gate is its own `dotnet build`, the projects they share (a core library, an auth library) are built again by each one, and each build pays the MSBuild start-up again: seven small projects took 44 seconds that way on a 2-core machine. Building them side by side does not help there, since one `dotnet build` already uses every core.

Build them once instead. Give every .NET project the same gate script, and have it:

1. build every .NET project in the repository in **one** `dotnet build` of a solution it generates (say in a gitignored `.gates/`),
2. record a fingerprint of the working tree — the commit, `git diff HEAD`, and the content of untracked files — and skip the build when the fingerprint is unchanged, so the other projects' gates on the same tree only run their tests (`dotnet test --no-build`),
3. hold a lock (`flock`) around the build, so gates started side by side wait for the one build instead of racing it.

The same projects then built in 15 seconds, and a gate on a tree already built takes under a second.

## What stops it merging bad code

* **Your gates decide.** Nothing is pushed until your `gates` commands pass.
* **A second agent reviews.** Every change is read by a Claude session that did not write it. Only `tier: trivial` work, such as a constant or a one-line fix, skips review.
* **You can hold the merge.** `auto-merge` is off until you turn it on, and `human-approvals` or the `human-review` label keep a pull request waiting for a person. With auto-merge on, Team1 still waits one minute before it merges.
* **It stops and asks.** An issue whose runs reach $15 at API list prices (`MAX_COST_PER_CARD`; a subscription is not billed that), or that keeps going round without settling, moves to `needs: answers` and waits for you.
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

Yes. Gates can be any shell command. Team1 works out what each repository needs from its files (.NET, Node, Go, Python) and from `needs:` and `services:` in `.agents/project.md`, installs it once, and builds the default branch on top of it; every card starts from that (see [Sandboxes](#sandboxes)). When a gate still needs something missing, the implement session installs it in its own sandbox (it may `sudo apt-get`) and runs the gate again.

## Community

Questions and ideas go in [Discussions](https://github.com/Team1-dev/Team1-Factory/discussions) or on [Discord](https://discord.gg/4S6MSBW48A). Found a bug? [Open an issue](https://github.com/Team1-dev/Team1-Factory/issues).

We want contributors: see [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

## License

Apache-2.0. See [LICENSE](LICENSE).
