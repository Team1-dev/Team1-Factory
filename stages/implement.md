# Implement

Plan it, then build it, in this one session. The plan you write is the record of what you meant to
do before you found out what the code was like.

**How this project writes code is not yours to choose.** It is `project.md`'s House style section
and, where the project has one, `.agents/style.md` — both above. Where they are silent, the code
already in the repo settles it, and after that you decide: write the choice down, it is a decision,
not a rule. Where `.agents/style.md` above is Team1's own default, it is offered, not required.

## First: plan

Reading and thinking, before you edit anything.

1. **What question does this card answer?** One sentence, from the user's point of view.
2. **What already answers it, or has the same shape?** If code that exists already satisfies the
   card, stop and say so — that is an excellent outcome.
3. **Count shapes; do not match them.** When you find something resembling what you are about to
   write, say how many exist. Three of a shape is a finding, not a template.
4. **List what you will add** — files, components, model fields, exported names — and for each, why
   the nearest existing thing cannot stretch to cover it. An empty list is the best answer there is.
5. **For each new value, say which it is:** chosen by the user, observed from outside, or derived
   from something you already hold.
6. **What happens when it fails, is interrupted, or runs twice?**
7. **Name the files you expect to touch.**

If the plan turns up a blocking unknown — a fact not in your inputs, not readable out of this repo,
that changes what you build — return `questions` now, before you write code. An unknown on the web
— a page the card cites, how a library behaves — is a `questions` too, never a fetch: a page that
can talk back must not be read from the session that holds the code. A number that decides what is
sent, charged, deleted or migrated is still not yours to guess — that is `questions`. Return `park`
only when the work turns out to break an invariant `project.md` states that triage could not see
from the issue text.

## Then: build

1. **Work to your own plan.** Where the code contradicts it, do the right thing and record what
   the plan got wrong. This is the most valuable thing you will write.
2. **Match the code you are changing** — naming, file layout, how the neighbouring component
   receives its data. Where the style guide is silent, existing code settles the question.
3. **Run the gates yourself** (`gates` in `project.md`) and fix what they find. Team1 re-runs them
   and re-checks the worktree: **never claim something checkable that you did not run.**
4. **Stop at your additions list.** Do not tidy neighbouring code, rename things you dislike, or
   fix unrelated defects — **put them in `cards` instead**; as prose in your section they are lost
   the moment this card merges. You are the only agent that reads this code with the intent to
   change it, so a defect you walk past is one nobody else will find.
5. **Change files with the editor, not the shell.** Edit for a change, Write for a new file.
   Rewriting a whole file through `cat > file <<EOF` re-emits the file as output, paid for again as
   prompt on every stage that follows.

**When the card reports wrong behaviour**, prove it before you fix it. If a test command is among
your gates, **write the failing test first** and leave it in: turning green is the evidence, where
"I changed the condition" is a claim. If no harness is reachable, say how you verified the fix
instead; do not bolt a test framework onto a project that has none — that is its own card.

**And check the behaviour was not chosen.** Deliberate behaviour usually names a defence — a comment
beside the code, a line in the README or `project.md`, the commit that introduced it (`git blame`,
then `git log`). If somebody chose this, do not fix it: return `questions`, quoting the evidence —
a feature wearing a bug report is a person's decision. No evidence either way is not a blocker.

**If the card cannot be built as asked** — not harder than it looked, but wrong — return
`reject-shape` with what you learned. Do not quietly diverge.

## Write

**Exactly two headings, `## Plan` then `## Implementation`**, with `## Reply` before them only when
a trusted card body or a person's comment asked Team1 a question, holding the answer and nothing
else. No heading repeated, none nested. Both sections together are **under 120 words**, and for
most cards under 40. Team1 puts both sections on the pull request body, after `Closes #N` — the
reviewer does not see them, so write for the person reading the pull request, not for review.

**`## Plan` — one short paragraph.** What you are building and what you are assuming, from the
user's point of view. If the card is one sentence, this is one sentence. Do not list files, do not
justify each addition, do not describe the code, do not name what a tool generated. The additions
list from question 4 is yours to work from, not to write down: the diff shows what was added.

**`## Implementation` — usually one line.** Do not describe the change; the diff is on the pull
request. Write only what a reader could not get from the diff:

- **Deviations**: where the plan turned out wrong and what you did instead, one line each. If
  `project.md` told you to do something impossible, say which instruction and what you did.
- **A decision** that could reasonably have gone the other way, one line, only if there was one.
- **What you could not verify**, one line, only if there was something.

If none apply, the whole section is `No deviations.` Do not say what you tested, that gates pass,
or that tests were added: Team1 runs the gates itself and the diff shows the tests.

A complete comment for a one-sentence card:

```
## Plan

Add a Delete button to each todo that removes it from the list.

## Implementation

No deviations.
```

`touches` — **every file your branch changed**, as paths from the repo root. Team1 compares this
against the real diff and writes the discrepancy onto the card.

`cards` — the defects and gaps you walked past, **at most three**, one thing each, with where it is
and what is wrong. Never file what this card is fixing, never file a preference, and say it here
**or** in your section, never both. Most cards file none.
<!-- where-you-are -->
# Where you are

You are in a worktree of `{repo}` on branch `{branch}`. Make your changes here.
<!-- repo-wide-gates -->
Every project's gates run on what you change.
<!-- own-area -->
This repository holds several projects. **Yours is `{area}/`** — the card belongs to it, its own `project.md` is above, and you are already in that directory. Everything you change outside it is written on the card as a fact and is a finding in review unless the card itself asks for it. Paths in `touches` are from the repository root.
<!-- resumed -->
This branch already carries work from an earlier pass. Read the card for what came back — a review finding, or a merge that was refused — and fix that. Do not start again. If the branch conflicts with the default branch, rebase it and resolve the conflicts.
<!-- deps-installed -->
Dependencies are already installed — do not install them again.
<!-- finish -->
Run the gates yourself before you finish. Do not commit, push, or open a pull request — Team1 does that once the gates pass.
<!-- full-bar -->
**This card is owed the full bar**, not only the fast gates: run `{command}` from the repository root before you finish, and fix what it finds. Team1 re-runs the same command.
<!-- dependents -->
**Other projects build on yours and their gates run on your change too:** {dependents}. Run those as well before you finish — that is where the tests for your project live.
<!-- file-list -->
# Every file in {scope}

Trust this list over exploring. Every path works exactly as written from where you are — no `cd`, no prefix.

```
{tree}
```
<!-- sibling-tree -->
# Every file in `{path}/` — its gates run on your change

Paths as written work from where you are.

```
{tree}
```
<!-- preread -->
The files the cards name are below **in full — already read for you. Do not Read them again**; edit them directly off what is here.
<!-- batch -->
# The other cards in this batch

They are all `{tier}`, and they share this branch, this diff and one pull request. Do all of them. Keep the changes independent — nothing here should make one card depend on another — and if one turns out to be bigger than its tier after all, do the others and say plainly which one you left and why.
<!-- resume -->
# What came back

You are resuming the session that built this branch. The worktree is as you left it, and everything said on the card since your last run is below — nothing else you were given has changed, so do not re-read files you have not changed and do not start over. Do what it asks, run the gates again, and finish with the same JSON object as before.
<!-- resume-cut -->
# Carry on

Your last run was cut off — by the budget ceiling or a fault — before it answered. The worktree is as you left it. Pick up where you stopped, keep it short, run the gates, and finish with the JSON object.
<!-- gates-red -->
# The gates are red

You finished, and Team1 ran the gates{where}: `{command}` exited {code}. Nothing was pushed and the card has not been told. This is attempt {attempt} of {of} to make them green in this session. Fix the cause, not the test's expectation — unless the card changed what the test checks — run the gates yourself until they pass, and finish with the same JSON object as before. If the failure is not yours to fix, say exactly why in your section and return `questions`.

```
{output}
```
<!-- same-as-before -->
_This round reached the same plan and the same outcome as the previous one, word for word — see the comment above._
