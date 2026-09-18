# Security

## Reporting a vulnerability

Report it privately through GitHub: [open a private vulnerability report](https://github.com/Team1-dev/Team1-Factory/security/advisories/new). Please do not open a public issue for a security problem.

Say what you did, what happened, and what an attacker could gain. We fix problems in the latest release.

## What to expect from Team1

Team1 runs Claude Code unattended with permission checks off, and it runs commands from the repositories it manages. That is by design, and it is why the README tells you to run it on a server of its own with a dedicated GitHub account. Code running with Team1's permissions on that server is not a vulnerability.

These are: a GitHub token or Claude credential reaching the model or a gate command, text from an untrusted account being followed as instructions, hidden instructions that escape the `attack` label, and anything that lets Team1 merge what its gates, review or approval settings should have stopped.
