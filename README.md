# @hellointerview/byoe

The local CLI for Hello Interview coding practice. It clones your session's starter repo, sets up the runtime, runs a timed session, and bundles your work for submission. Everything runs on your own machine.

Requires **Node.js 22+**. No install needed — run it with `npx`.

## Usage

Start a session using the token from your session page on hellointerview.com:

```
npx @hellointerview/byoe start --token <token>
```

Your timer starts when you run `start`, not when the token is minted.

Check time remaining and what's changed since the starting point:

```
npx @hellointerview/byoe status
```

Bundle your diff, re-run the tests, and finalize the session:

```
npx @hellointerview/byoe submit
```

## Options

- `--token <token>` — session token from hellointerview.com (required for a real session).
- `--lang <python|java>` — language for offline mode.
- `--seed <url-or-path>` — override the starter repo source (offline / dev).

## Environment

- `HI_API_URL` — override the API base (defaults to `https://www.hellointerview.com`).

## Local development (run `byoe` from anywhere)

Teammates with the repo can get a global `byoe` command that points at their local source, so changes show up without publishing anything.

One-time setup, from the repo root:

```
yarn link:byoe-cli
```

That installs the CLI's deps (it lives outside the root workspaces, so it needs its own install), builds it, and links a global `byoe` onto your PATH. Now `byoe` runs from any directory. The command is a symlink back into `packages/cli/dist`, so it tracks the repo — pull, rebuild, and the global `byoe` reflects the latest code. It's safe to re-run `yarn link:byoe-cli` anytime; it just repoints the same link.

While actively editing the CLI, run a watch build so every save rebuilds:

```
cd packages/cli && yarn dev
```

To remove the global command:

```
yarn unlink:byoe-cli
```

Note: the link is tied to the Node version that was active when you ran it. If you switch Node versions (nvm), re-run `yarn link:byoe-cli` under the new one.

## Publishing (maintainers)

This package is published to the public npm registry as `@hellointerview/byoe` (a scoped, public package — `publishConfig.access` is set to `public`). Only `dist/` ships (see `files`), and runtime deps are installed by npm when the package is fetched.

1. Bump the version in `package.json` (and the `--version` string in `src/cli.ts` if you keep them in sync). npm publishes are effectively permanent and `npx @hellointerview/byoe` always grabs the latest, so treat each publish as a release.
2. Build the bundle:
   ```
   cd packages/cli && yarn install --immutable && yarn build
   ```
3. Inspect exactly what will ship — confirm it's only `README.md`, `LICENSE`, `dist/cli.js`, `package.json`:
   ```
   cd packages/cli && npm pack --dry-run
   ```
4. Smoke-test the packed artifact in isolation before publishing:
   ```
   cd packages/cli && npm pack
   npx ./hellointerview-byoe-<version>.tgz --help
   npx ./hellointerview-byoe-<version>.tgz start --help
   ```
5. Publish (must be logged in to an npm account that's a member of the `@hellointerview` org; have your 2FA/OTP ready). `publishConfig.access` is already set to `public`:
   ```
   npm login
   cd packages/cli && npm publish
   ```
6. Confirm it's live from a clean directory:
   ```
   npx @hellointerview/byoe@latest --help
   ```
