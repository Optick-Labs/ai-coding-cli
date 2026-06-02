import { rm } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export async function clone(source: string, dest: string): Promise<void> {
  await execa("git", ["clone", source, dest], { stdio: "inherit" });
}

export async function headSha(repoDir: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoDir });
  return stdout.trim();
}

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "hello-interview",
  GIT_AUTHOR_EMAIL: "submit@hellointerview.com",
  GIT_COMMITTER_NAME: "hello-interview",
  GIT_COMMITTER_EMAIL: "submit@hellointerview.com",
};

const SUBMISSION_BRANCH = "refs/heads/hi-submission";

// The recorder writes only this ref. It never touches the candidate's HEAD, branch, or real index.
export const TIMELINE_REF = "refs/hi/timeline";

// A per-process scratch index lets us stage the full working tree without disturbing the candidate's
// real index. The label keeps the submit and recorder indexes from ever colliding.
function snapshotEnv(repoDir: string, label: string): { env: NodeJS.ProcessEnv; indexFile: string } {
  const indexFile = join(repoDir, ".git", `hi-${label}-index-${process.pid}`);
  return { env: { ...process.env, GIT_INDEX_FILE: indexFile, ...SNAPSHOT_IDENTITY }, indexFile };
}

// Stage the full working tree (committed + staged + unstaged + untracked, minus .gitignore) into the
// scratch index and return its tree object. Shared by the submit snapshot and the recorder.
async function writeTreeFromWorktree(repoDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  await execa("git", ["read-tree", "HEAD"], { cwd: repoDir, env });
  await execa("git", ["add", "-A"], { cwd: repoDir, env });
  const { stdout: tree } = await execa("git", ["write-tree"], { cwd: repoDir, env });
  return tree.trim();
}

async function revParse(repoDir: string, ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repoDir });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function treeOf(repoDir: string, commit: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", `${commit}^{tree}`], { cwd: repoDir });
  return stdout.trim();
}

export async function snapshotCommit(repoDir: string): Promise<string> {
  const { env, indexFile } = snapshotEnv(repoDir, "submission");
  try {
    const tree = await writeTreeFromWorktree(repoDir, env);
    const { stdout: commit } = await execa(
      "git",
      ["commit-tree", tree, "-p", "HEAD", "-m", "hello-interview submission snapshot"],
      { cwd: repoDir, env },
    );
    return commit.trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

export interface TimelineTickResult {
  committed: boolean;
  commitSha?: string;
  treeSha: string;
  parentSha: string;
}

// Append one snapshot to refs/hi/timeline, chained on the previous tick (or HEAD/baseline for the
// first one). Skips the commit entirely when nothing changed since the parent, so empty intervals
// cost nothing and the timeline holds only real deltas.
export async function commitTimelineTick(
  repoDir: string,
  meta: { tick: number; elapsedSec: number },
): Promise<TimelineTickResult> {
  const { env, indexFile } = snapshotEnv(repoDir, "timeline");
  try {
    const parent = (await revParse(repoDir, TIMELINE_REF)) ?? (await revParse(repoDir, "HEAD"));
    if (!parent) throw new Error("no commit to anchor the timeline on");
    const tree = await writeTreeFromWorktree(repoDir, env);
    if (tree === (await treeOf(repoDir, parent))) {
      return { committed: false, treeSha: tree, parentSha: parent };
    }
    const message = `hi-timeline tick\n\nHI-Tick: ${meta.tick}\nHI-Elapsed-Sec: ${meta.elapsedSec}\n`;
    const { stdout: commit } = await execa("git", ["commit-tree", tree, "-p", parent, "-m", message], {
      cwd: repoDir,
      env,
    });
    const commitSha = commit.trim();
    await execa("git", ["update-ref", TIMELINE_REF, commitSha], { cwd: repoDir });
    return { committed: true, commitSha, treeSha: tree, parentSha: parent };
  } finally {
    await rm(indexFile, { force: true });
  }
}

export async function bundleSnapshot(repoDir: string, outPath: string, snapshotSha: string): Promise<void> {
  const { stdout: originalHead } = await execa("git", ["symbolic-ref", "HEAD"], { cwd: repoDir });
  await execa("git", ["update-ref", SUBMISSION_BRANCH, snapshotSha], { cwd: repoDir });
  const hasTimeline = (await revParse(repoDir, TIMELINE_REF)) !== undefined;
  try {
    await execa("git", ["symbolic-ref", "HEAD", SUBMISSION_BRANCH], { cwd: repoDir });
    const refs = ["HEAD", SUBMISSION_BRANCH, ...(hasTimeline ? [TIMELINE_REF] : [])];
    await execa("git", ["bundle", "create", outPath, ...refs], { cwd: repoDir });
  } finally {
    await execa("git", ["symbolic-ref", "HEAD", originalHead.trim()], { cwd: repoDir });
    await execa("git", ["update-ref", "-d", SUBMISSION_BRANCH], { cwd: repoDir });
  }
}

export async function diffStat(repoDir: string, baselineSha: string, to = "HEAD"): Promise<string> {
  const { stdout } = await execa("git", ["diff", "--stat", baselineSha, to], { cwd: repoDir });
  return stdout;
}

export async function diff(repoDir: string, baselineSha: string, to = "HEAD"): Promise<string> {
  const { stdout } = await execa("git", ["diff", baselineSha, to], {
    cwd: repoDir,
    stripFinalNewline: false,
  });
  return stdout;
}

export async function log(repoDir: string, baselineSha: string): Promise<string> {
  const { stdout } = await execa("git", ["log", `${baselineSha}..HEAD`], {
    cwd: repoDir,
    stripFinalNewline: false,
  });
  return stdout;
}

export async function diffNameStatus(repoDir: string, baselineSha: string, to = "HEAD"): Promise<string> {
  const { stdout } = await execa("git", ["diff", "--name-status", baselineSha, to], { cwd: repoDir });
  return stdout;
}
