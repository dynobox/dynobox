# CI Integration

CI support is still a work in progress. The CLI can already run in automation,
write machine-readable reports, and return failure exit codes, but the full
recommended CI workflow is not finalized yet.

## Coming Soon

Our recommended approach will likely be a standard CI matrix that:

- Runs one harness per job.
- Writes an NDJSON report for each harness.
- Uploads reports as build artifacts and summarizes the final `summary` record.

We are still refining this pattern before publishing copy-pasteable workflows.
