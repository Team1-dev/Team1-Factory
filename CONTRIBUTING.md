# Contributing to Team1

We want contributors. There are two ways in.

## Open an issue

Describe the outcome you want, or the bug you hit, in an [issue](https://github.com/Team1-dev/Team1-Factory/issues). When a maintainer adds the `stage: triage` label, Team1 picks the issue up and builds it, the same way the rest of this repository was built. GitHub only lets maintainers add labels, so you cannot start it yourself.

Team1 reads an issue from someone without write access as a report of what they experienced, not as instructions. Say what happened and what you expected; the maintainers decide what gets built.

## Send a pull request

Pull requests are welcome. A maintainer reviews and merges them. Before you open one:

```sh
npm ci
npm run lint
npm test
```

Team1 needs Node.js 22.18 or later. It is plain JavaScript ES modules with no runtime dependencies; [`.agents/project.md`](.agents/project.md) holds the project rules Team1 itself follows.

## Questions

Ask in [Discussions](https://github.com/Team1-dev/Team1-Factory/discussions) or on [Discord](https://discord.gg/4S6MSBW48A).

## Licence

Contributions are accepted under the [Apache-2.0 licence](LICENSE).
