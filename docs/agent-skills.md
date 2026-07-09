# Agent Skills

Dynobox publishes AI agent skills that help create and debug dynos. Use them
when you want an agent to write Dynobox test files, adapt examples to your
workflow, or investigate a failed run.

Install the skills with [skills.sh](https://www.skills.sh/dynobox/skills):

```bash
npx skills add dynobox/skills
```

The source lives at [`dynobox/skills`](https://github.com/dynobox/skills).

## Included Skills

- `dyno-create`: author or scaffold Dynobox test files for agent and skill
  workflow testing.
- `dyno-debug`: debug failed or flaky Dynobox runs, including matrix runs,
  transcripts, artifacts, and failed assertions.

## When To Use Them

Use `dyno-create` when you have a workflow you want to turn into a repeatable
Dynobox scenario. It is useful for choosing assertions, laying out fixtures, and
creating JavaScript, TypeScript, or YAML dynos.

Use `dyno-debug` when a Dynobox run fails and you need help reading the output,
preserving useful artifacts, deciding what to rerun, or identifying whether the
failure is in the agent behavior, the test setup, or the assertions.

## Example Prompts

After installing the skills, ask your agent for the specific workflow you want:

```text
Use the dyno-create skill to write a Dynobox test for this agent workflow.
```

```text
Use the dyno-debug skill to investigate this failed Dynobox run.
```

## Related Links

- [Browse Dynobox skills on skills.sh](https://www.skills.sh/dynobox/skills)
- [View the skills source on GitHub](https://github.com/dynobox/skills)
- [Config Authoring](./config-authoring.md)
- [CI Integration](./ci.md)
