import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export type SourceMetadata = Record<string, string>;

const OVERRIDE_KEYS = new Set([
  "repo_identity",
  "repo_owner",
  "repo_name",
  "source_type",
  "service_name",
  "project_slug",
  "environment",
  "observability_owner",
]);

function nonGitMetadata(): SourceMetadata {
  return {
    source_type: "non-git",
    metadata_source: "non-git",
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export function sanitizeGitRemote(remoteUrl: string): Partial<Pick<SourceMetadata, "git_remote_host" | "git_remote_path">> {
  const raw = firstLine(remoteUrl).replace(/\.git$/i, "");
  if (!raw) {
    return {};
  }

  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
    return parsed.hostname && path ? { git_remote_host: parsed.hostname, git_remote_path: path } : {};
  } catch {
    // Continue with scp-like SSH syntax, for example git@github.com:owner/repo.git.
  }

  const scpLike = raw.match(/^(?:[^@\s/:]+@)?([^:\s]+):(.+)$/);
  if (scpLike) {
    const host = scpLike[1];
    const path = scpLike[2].replace(/^\/+/, "").replace(/\.git$/i, "");
    return host && path && !path.includes("@") ? { git_remote_host: host, git_remote_path: path } : {};
  }

  return {};
}

function deriveIdentity(remotePath: string | undefined): Partial<Pick<SourceMetadata, "repo_identity" | "repo_owner" | "repo_name">> {
  if (!remotePath) {
    return {};
  }
  const parts = remotePath.split("/").filter(Boolean);
  if (parts.length < 2) {
    return {};
  }
  const repoName = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (!repoName || !owner || repoName.includes("/")) {
    return {};
  }
  return {
    repo_identity: `${owner}/${repoName}`,
    repo_owner: owner,
    repo_name: repoName,
  };
}

function findRepoMetadataFile(cwd: string, gitRoot: string): string | undefined {
  let current = cwd;
  const root = gitRoot;
  while (true) {
    const candidate = join(current, ".omp-langfuse.metadata.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (current === root) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function readWhitelistedOverrides(cwd: string, gitRoot: string): SourceMetadata {
  const path = findRepoMetadataFile(cwd, gitRoot);
  if (!path) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const output: SourceMetadata = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (OVERRIDE_KEYS.has(key) && typeof value === "string" && value.trim()) {
        output[key] = value.trim();
      }
    }
    if (output.repo_name?.includes("/")) {
      delete output.repo_name;
    }
    return output;
  } catch {
    return {};
  }
}

export function collectSourceMetadata(cwd: string): SourceMetadata {
  try {
    const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      return nonGitMetadata();
    }

    const gitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const commit = runGit(cwd, ["rev-parse", "HEAD"]);
    const branch = runGit(cwd, ["branch", "--show-current"]);
    const remote = runGit(cwd, ["config", "--get", "remote.origin.url"]);
    const remoteMetadata = sanitizeGitRemote(remote);
    const derivedIdentity = deriveIdentity(remoteMetadata.git_remote_path);
    const overrides = readWhitelistedOverrides(cwd, gitRoot);

    const metadata: SourceMetadata = {
      source_type: "git-repo",
      repo_root_name: basename(gitRoot),
      ...(branch ? { git_branch: branch } : {}),
      git_commit: commit,
      ...remoteMetadata,
      ...derivedIdentity,
      ...overrides,
      metadata_source: Object.keys(overrides).length > 0 ? "repo-file" : "git-detection",
    };

    if (metadata.repo_name?.includes("/")) {
      delete metadata.repo_name;
    }
    if (!metadata.repo_identity && metadata.repo_owner && metadata.repo_name) {
      metadata.repo_identity = `${metadata.repo_owner}/${metadata.repo_name}`;
    }
    return metadata;
  } catch {
    return nonGitMetadata();
  }
}
