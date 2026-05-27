# hello-interview

The local CLI for Hello Interview coding practice. It clones your session's starter repo, sets up the runtime, runs a timed session, and bundles your work for submission. Everything runs on your own machine.

Requires **Node.js 22+**. No install needed — run it with `npx`.

## Usage

Start a session using the token from your session page on hellointerview.com:

```
npx hello-interview start --token <token>
```

Your timer starts when you run `start`, not when the token is minted.

Check time remaining and what's changed since the starting point:

```
npx hello-interview status
```

Bundle your diff, re-run the tests, and finalize the session:

```
npx hello-interview submit
```

## Options

- `--token <token>` — session token from hellointerview.com (required for a real session).
- `--lang <python|java>` — language for offline mode.
- `--seed <url-or-path>` — override the starter repo source (offline / dev).

## Environment

- `HI_API_URL` — override the API base (defaults to `https://www.hellointerview.com`).

## Publishing (maintainers)

This package is published to the public npm registry as `hello-interview`. Only `dist/` ships (see `files`), and runtime deps are installed by npm when the package is fetched.

1. Bump the version in `package.json` (and the `--version` string in `src/cli.ts` if you keep them in sync). npm publishes are effectively permanent and `npx hello-interview` always grabs the latest, so treat each publish as a release.
2. Build the bundle:
   ```
   cd packages/cli && yarn install --immutable && yarn build
   ```
3. Inspect exactly what will ship — confirm it's only `README.md`, `dist/cli.js`, `package.json`:
   ```
   cd packages/cli && npm pack --dry-run
   ```
4. Smoke-test the packed artifact in isolation before publishing:
   ```
   cd packages/cli && npm pack
   npx ./hello-interview-<version>.tgz --help
   npx ./hello-interview-<version>.tgz start --help
   ```
5. Publish (must be logged in to the npm account that owns `hello-interview`; have your 2FA/OTP ready). `publishConfig.access` is already set to `public`:
   ```
   npm login
   cd packages/cli && npm publish
   ```
6. Confirm it's live from a clean directory:
   ```
   npx hello-interview@latest --help
   ```
