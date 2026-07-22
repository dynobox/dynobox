# Agent Skills

Dynobox publishes AI agent skills that assess test fit, create dynos from
`SKILL.md` files, and diagnose failed runs.

Install the skills with [skills.sh](https://www.skills.sh/dynobox/skills):

```bash
npx skills add dynobox/skills
```

The source lives at [`dynobox/skills`](https://github.com/dynobox/skills).

## Included Skills

- `dyno-from-skill`: create a Dynobox test from an agent skill's `SKILL.md`.
- `dyno-run-debug`: diagnose a failed Dynobox run and propose a verified fix.
- `dyno-skill-fit`: assess whether a skill is a good candidate for Dynobox
  coverage before writing tests.

## When To Use Them

Use `dyno-from-skill` when you want to turn a `SKILL.md` into a repeatable
Dynobox scenario with appropriate assertions and fixtures.

Use `dyno-run-debug` when a Dynobox run fails and you need help reading the
output, identifying the root cause, or proposing a dyno change. It waits for
approval before editing and validates any approved dyno change.

Use `dyno-skill-fit` before authoring tests when you want a coverage assessment,
example assertions, and a High, Partial, or Low fit rating.

## Example Prompts

After installing the skills, ask your agent for the specific workflow you want:

```text
Use the dyno-from-skill skill to create a Dynobox test for this skill.
```

```text
Use the dyno-run-debug skill to diagnose this failed Dynobox run.
```

```text
Use the dyno-skill-fit skill to assess this skill for Dynobox coverage.
```

## Related Links

- [Browse Dynobox skills on skills.sh](https://www.skills.sh/dynobox/skills)
- [View the skills source on GitHub](https://github.com/dynobox/skills)
- [Config Authoring](./config-authoring.md)
- [CI Integration](./ci.md)
