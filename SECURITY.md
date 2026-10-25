# Security policy

## Scope

`dsh-tower-enhanced` is an experimental, independently maintained prototype
plugin for DeepSeek Harness. It is not a security boundary and must not be
treated as one.

## What review does and does not give you

Tower reviews are a *process* constraint, not a sandbox:

- Reviewers are instructed to be read-only, but this is enforced by
  instructions only. There is currently no restricted-tool preset or
  privilege separation behind it.
- Mission worktrees isolate writes by convention, not by sandboxing. A
  worker runs with the same host access as the controller Session that
  spawned it.
- The merge gate checks process state (dependencies, scope, clean
  worktrees, review bindings). It does not audit code for malicious
  content; the reviewer is another LLM agent, and LLM review can be
  incomplete or wrong.

Do not point Tower at repositories or environments whose compromise would
matter, and do not treat an `approved` verdict as a security certification.

## Secrets

Never place real credentials in prompts, mission descriptions, code,
documentation, or anywhere in this repository. This includes API keys,
tokens, passwords, and private endpoints. Workers and reviewers inherit the
host's runtime; anything you paste into a mission can end up in transcripts,
state files under `.dsh-tower/`, worktrees, or logs. Use throwaway
credentials and local temp directories instead.

## Reporting a vulnerability

This prototype has no remote repository or dedicated security inbox yet.
Please report suspected vulnerabilities by opening a GitHub issue on this
repository's tracker with details and reproduction steps. If the project
gains a security contact, this section will be updated with it.
