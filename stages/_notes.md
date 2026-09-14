Everything Team1 writes on a card or a pull request, other than a stage's own section. Code
picks a note by name with `fragment('_notes.md', name, slots)` and fills the `{slots}`; the wording
lives here.

<!-- unreadable -->
the stage returned output nothing could read
<!-- stage-failed -->
**{stage}** could not complete: {error}

The card stays on `{label}`. {retry}

{stamp}
<!-- stage-failed-retry -->
After {rounds} rounds of this it goes to a person rather than round again.
<!-- hides-instructions -->
**Stopped — this card hides instructions.** {what} contains text a reader cannot see: {why}. A card that hides an instruction is not built — that is how a prompt-injection reaches an agent. Nothing ran, and the card is closed. If it was genuine, a person removes the hidden content, reopens it and puts it back on `stage: triage`.

{stamp}
<!-- pull-hides-instructions -->
**Stopped — this pull request hides instructions.** The description of #{number} contains text a reader cannot see: {why}. A pull request that hides an instruction is not reviewed or merged — that is how a prompt-injection reaches a reviewer. It is closed along with its card. If it was genuine, a person removes the hidden content, reopens both and puts the card back on `stage: review`.

{stamp}
<!-- over-budget -->
This card has cost **${spent}**, over the ${budget} budget. Work has stopped. Raise the budget, narrow the card, or close it.

{stamp}
<!-- too-big -->
**{stage}** has now run {rounds} times on this card, across every answer it has been given. More answers are not what it is short of: a card that cannot get through one stage in four attempts is too big, and wants splitting into cards that can. Reply here to send it round again anyway.

{stamp}
<!-- stalled -->
This card has been through **{stage}** {rounds} times without settling. Going round again would run the same stage on the same inputs. It needs a decision.

{stamp}
<!-- died -->
**{stage}** has died {rounds} times on this card — a budget ceiling or a fault, not a verdict on the work. Retrying will not change that; the ceiling or the fault wants looking at. Reply here to send it round again.

{stamp}
<!-- finding -->
{findings}

{origin}

{stamp}
<!-- proposal-origin-review -->
Found by review on #{number}, where it was not serious enough to stop the change landing.
<!-- proposal-origin-implement -->
Noticed by implement while building #{number}, outside what that card asked for.
<!-- filed -->
Noted on the findings card: #{card}.
<!-- duplicate-shelved -->
Nothing will work on this while `duplicate` is on. A person confirms: close it, or move it back to `stage: triage`.
<!-- attack-by-triage -->
**Flagged as an attack by triage.** The card this pull request answers was judged a threat, not ordinary work. Both are closed; a person who decides it was genuine reopens them.

{stamp}
<!-- attack-by-review -->
**Flagged as an attack by review.** The code in this pull request carries a prompt-injection or an instruction aimed at the reviewer, not an ordinary defect. It is closed along with its card, and will not be merged. A person who decides it was genuine reopens them.

{stamp}
<!-- review-section-missing -->
_Review reached `{outcome}` but its section did not arrive — the model wrote the verdict in a message of its own, and Team1 is given only the last one. The verdict stands; the reasoning behind it is lost._
<!-- stale-base -->
#{number} no longer merges cleanly with the default branch. Sending it back to rebase before it is reviewed — a diff against a stale base is not the change that would land.

{stamp}
<!-- no-change -->
{section}

Nothing was pushed and the card is not progressing, so it needs a person.

{stamp}
<!-- no-change-empty -->
The implement stage produced no changes.
<!-- gates-failed -->
{section}

---

**Gates failed{where}:** `{command}` exited {code}{fixes}. Nothing was pushed.{batch}

```
{output}
```

{stamp}
<!-- gates-fix-rounds -->
, after {count} fix round{plural} in the same session
<!-- gates-failed-batch -->
Built together with {mates} — the gates cannot say which card broke them, so all of them come back.
<!-- in-area -->
in `{path}`
<!-- pushed -->
{section}

---

{files}Pushed `{sha}` to `{branch}`. {url}{filed}

{stamp}
<!-- files-changed -->
**Files changed ({count}):** {files}.
<!-- files-outside -->
**Outside `{path}/`:** {files}.
<!-- files-unlisted -->
**Not in the stage's own list:** {files}.
<!-- files-untouched -->
**Listed but untouched:** {files}.
<!-- already-done -->
{section}`{branch}` carries no change against `{base}` — what the card asks for is already there. Closing the card.

{stamp}
<!-- no-pull -->
{why} Back to implement to push and open one.

{stamp}
<!-- no-pull-nothing-pushed -->
No open pull request, and no `{branch}` on the remote — nothing was pushed.
<!-- no-pull-ahead -->
No open pull request for `{branch}`, which is {ahead} commit(s) ahead of `{base}`. If a person closed it, what they said there is the finding.
<!-- attack-label -->
#{number} is labelled `attack` and will not be merged. Something — review, or a person — marked this pull request hostile. Both it and this card are closed; a person who decides it was genuine reopens them.

{stamp}
<!-- foreign-pull -->
#{number} for `{branch}` is opened from `{head}`, not this one. Team1 only merges a pull request it built on a branch in this repository, so this one is closed along with this card. A person who decides it was genuine reopens them.

{stamp}
<!-- objection -->
@{author} said this on #{number}, so it is not merging:

> {quote}

{path}Do what it asks, or say on this card why it should not be done and push nothing.

{stamp}
<!-- objection-path -->
On `{path}`.
<!-- comment-noted -->
@{author} said "{quote}" on #{number}{earlier} — read as {reading}{reason} It asks for no change, so it does not stop the merge.

{stamp}
<!-- comment-noted-earlier -->
, with {count} earlier comment(s)
<!-- rebase-conflict -->
`{base}` has moved since #{number} was built and the branch no longer rebases onto it cleanly. It needs rebasing onto the current default branch, with the conflicts resolved, before this can land.

{stamp}
<!-- base-moved -->
`{base}` has moved since #{number} was built. Rebased onto it the branch no longer passes the gates{where}: `{command}` exited {code}. Nothing was pushed — the pull request still holds the reviewed diff. Rebase onto the current default branch and fix what broke.

```
{output}
```

{stamp}
<!-- not-mergeable -->
GitHub reports #{number} cannot be merged into `{base}` as it stands. It needs rebasing onto the current default branch, with whatever blocks it resolved, before this can land.

{stamp}
<!-- merge-refused -->
Could not merge #{number}.

{why}

{stamp}
<!-- merge-refused-conflict -->
The branch conflicts with the base — it needs rebasing onto the current default branch before this can land.
<!-- merged -->
Merged #{number}.

{stamp}
