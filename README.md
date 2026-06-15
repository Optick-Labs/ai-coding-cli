# @hellointerview/ai-coding

The local CLI for Hello Interview coding practice. It clones your session's starter repo, sets up the runtime, runs a timed session, and bundles your work for submission. Everything runs on your own machine.

Requires **Node.js 22+**. No install needed — run it with `npx`.

## Usage

Start a session using the token from your session page on hellointerview.com:

```
npx @hellointerview/ai-coding start --token <token>
```

Your timer starts when you run `start`, not when the token is minted.

Check time remaining and what's changed since the starting point:

```
npx @hellointerview/ai-coding status
```

Bundle your diff, re-run the tests, and finalize the session:

```
npx @hellointerview/ai-coding submit
```

## Options

- `--token <token>` — session token from hellointerview.com (required for a real session).
- `--token-stdin` — read the token from stdin instead, e.g. `pbpaste | npx @hellointerview/ai-coding start --token-stdin`. Keeps the token out of your shell history and process list.
- `--lang <python|java|typescript|go|csharp|any>` — language for offline mode.
- `--seed <url-or-path>` — override the starter repo source (offline / dev).

## Environment

- `HI_API_URL` — override the API base (defaults to `https://www.hellointerview.com`).
- `HI_TOKEN` — supply the session token via the environment instead of `--token`.
- `HI_TELEMETRY=0` or `DO_NOT_TRACK=1` — turn off setup diagnostics (see Privacy below).
- `HI_TRANSFER_TIMEOUT_MS` — timeout for seed/artifact/chat transfers (defaults to 120000).

## Privacy & what runs on your machine

Everything happens locally on your machine. A few things are worth calling out explicitly:

- **Setup diagnostics (opt-out).** When you run `start` against a real session, the CLI reports the outcome to hellointerview.com so we can fix provisioning failures: your OS, architecture, Node and CLI version, per-phase timings, and — only on failure — the error and up to 8 KB of the failing command's output. Your home directory is rewritten to `~` and the session token is stripped before anything is sent. It's best-effort and never blocks setup. Turn it off with `HI_TELEMETRY=0` or `DO_NOT_TRACK=1`. Offline sessions report nothing.
- **AI chat capture (you choose).** `submit` (and the standalone `chat` command) look for Claude Code and Codex session logs that belong to this repo — under `~/.claude/projects` and `~/.codex/sessions`, matched by the working directory recorded in each log — and let you pick which, if any, to upload to your grader. Nothing uploads without your selection. Override the search roots with `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
- **Background recorder.** `start` spawns a detached helper that snapshots your progress every 2 minutes so your debrief can reference how you built things. It writes only to a private `refs/hi/timeline` ref and the gitignored `.hi/` folder — never your HEAD, branch, or staged changes. It stops when you `submit` and self-terminates after the deadline.
- **Toolchain install.** For a managed-runtime task, if `uv` (Python) or `mise` (other languages) isn't already installed, `start` runs that tool's official install script (pinned to a known version) into an isolated location under `~/.local`. It won't change your system runtime or global PATH. Tools you already have installed are reused as-is.

## Local development (run `ai-coding` from anywhere)

Teammates with the repo can get a global `ai-coding` command that points at their local source, so changes show up without publishing anything.

One-time setup, from the repo root:

```
yarn link:ai-coding
```

That installs the CLI's deps (it lives outside the root workspaces, so it needs its own install), builds it, and links a global `ai-coding` onto your PATH. Now `ai-coding` runs from any directory. The command is a symlink back into `packages/cli/dist`, so it tracks the repo — pull, rebuild, and the global `ai-coding` reflects the latest code. It's safe to re-run `yarn link:ai-coding` anytime; it just repoints the same link.

While actively editing the CLI, run a watch build so every save rebuilds:

```
cd packages/cli && yarn dev
```

To remove the global command:

```
yarn unlink:ai-coding
```

Note: the link is tied to the Node version that was active when you ran it. If you switch Node versions (nvm), re-run `yarn link:ai-coding` under the new one.

## Publishing (maintainers)

This package is published to the public npm registry as `@hellointerview/ai-coding` (a scoped, public package — `publishConfig.access` is `public`). Only `dist/` ships (see `files`), and runtime deps are installed by npm when the package is fetched.

Publish with the guided script, from the repo root:

```
yarn publish:ai-coding
```

You must be logged in to npm (`npm login`) as a member of the `@hellointerview` org, with your 2FA/OTP ready. The script walks the whole release safely:

1. Checks you're authenticated and that `packages/cli` has no uncommitted changes (a published version should map to a commit).
2. Shows the current vs. on-npm version and lets you keep it (first release) or bump patch/minor/major/explicit. It refuses to reuse a version already on npm.
3. Builds a clean bundle and prints exactly what will ship, aborting unless it's precisely the four expected files (`LICENSE`, `README.md`, `dist/cli.js`, `package.json`).
4. Requires you to **type the version** to confirm, then runs `npm publish --access public` (npm prompts for your OTP here). If you abort or it fails, any version bump it made is rolled back.

The CLI's `--version` is injected from `package.json` at build time (see `tsup.config.ts`), so the version lives in exactly one place. After a publish that bumped the version, commit the `package.json` change. Verify a release from a clean directory with `npx @hellointerview/ai-coding@latest --help`.
