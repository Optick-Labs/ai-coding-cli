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

export async function snapshotCommit(repoDir: string): Promise<string> {
  const indexFile = join(repoDir, ".git", `hi-submission-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile, ...SNAPSHOT_IDENTITY };
  try {
    await execa("git", ["read-tree", "HEAD"], { cwd: repoDir, env });
    await execa("git", ["add", "-A"], { cwd: repoDir, env });
    const { stdout: tree } = await execa("git", ["write-tree"], { cwd: repoDir, env });
    const { stdout: commit } = await execa(
      "git",
      ["commit-tree", tree.trim(), "-p", "HEAD", "-m", "hello-interview submission snapshot"],
      { cwd: repoDir, env },
    );
    return commit.trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

export async function bundle(repoDir: string, outPath: string, ref: string): Promise<void> {
  await execa("git", ["bundle", "create", outPath, ref], { cwd: repoDir });
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
