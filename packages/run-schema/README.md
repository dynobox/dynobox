# @dynobox-internal/run-schema

Shared Dynobox run upload schemas and API response types.

## Registry

This package is published to GitHub Packages under the `@dynobox-internal` scope.

Use this npm config in consuming repos:

```ini
@dynobox-internal:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Local installs require `GITHUB_TOKEN` with `read:packages`. Publishing requires `write:packages`.

## Publishing

Update the package version, then run:

```sh
pnpm --filter @dynobox/run-schema build
pnpm --filter @dynobox/run-schema publish --no-git-checks
```

The package publishes built `dist/` output from the local build. Do not commit `dist/`.
