# @dynobox/run-schema

Shared Dynobox run upload schemas and API response types.

## Registry

This package is published to GitHub Packages under the `@dynobox` scope.

Use this npm config in consuming repos:

```ini
@dynobox:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Local installs require `GITHUB_TOKEN` with `read:packages`. Publishing requires `write:packages`.

## Run Uploads

`RUN_UPLOAD_SCHEMA_VERSION` identifies the current upload contract. Validate a
current CLI payload with `RunUploadV4`, or accept every supported version with
the discriminated `RunUpload` schema:

```ts
import {
  RUN_UPLOAD_SCHEMA_VERSION,
  RunUpload,
  RunUploadV4,
  type RunUploadGitV4,
} from '@dynobox/run-schema';
```

Schema v4 retains the legacy nullable `gitHash` field and adds nullable
structured `git` metadata:

```ts
type RunUploadGitV4 = {
  commit: string | null;
  branch: string | null;
  userName: string | null;
  userEmail: string | null;
  dirty: boolean | null;
};
```

The top-level `git` value is `null` when metadata cannot be collected. The CLI
collects it from the directory where the CLI process was started.

## Publishing

See `RELEASES.md` for the full release flow. After updating the package version,
changelog, and release tag, publish with:

```sh
pnpm --filter @dynobox/run-schema build
pnpm --filter @dynobox/run-schema publish --no-git-checks
```

The package publishes built `dist/` output from the local build. Do not commit `dist/`.
