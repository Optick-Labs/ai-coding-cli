import { execa } from "execa";

export async function clone(source: string, dest: string): Promise<void> {
  await execa("git", ["clone", source, dest], { stdio: "inherit" });
}

export async function commitCount(repoDir: string, baselineSha: string): Promise<number> {
  const { stdout } = await execa("git", ["rev-list", "--count", `${baselineSha}..HEAD`], {
    cwd: repoDir,
  });
  return Number.parseInt(stdout.trim(), 10) || 0;
}

export async function bundle(repoDir: string, outPath: string): Promise<void> {
  await execa("git", ["bundle", "create", outPath, "HEAD"], { cwd: repoDir });
}

export async function headSha(repoDir: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd: repoDir });
  return stdout.trim();
}

export async function diffStat(repoDir: string, baselineSha: string): Promise<string> {
  const { stdout } = await execa(
    "git",
    ["diff", "--stat", `${baselineSha}..HEAD`],
    { cwd: repoDir },
  );
  return stdout;
}

export async function diff(repoDir: string, baselineSha: string): Promise<string> {
  const { stdout } = await execa("git", ["diff", `${baselineSha}..HEAD`], {
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

export async function diffNameStatus(
  repoDir: string,
  baselineSha: string,
): Promise<string> {
  const { stdout } = await execa(
    "git",
    ["diff", "--name-status", `${baselineSha}..HEAD`],
    { cwd: repoDir },
  );
  return stdout;
}
