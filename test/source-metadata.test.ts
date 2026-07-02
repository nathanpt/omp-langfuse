import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { collectSourceMetadata, sanitizeGitRemote } from "../src/source-metadata.js";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function withTempDir(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "pi-langfuse-source-metadata-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createRepo(root: string) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(join(repo, "README.md"), "test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

test("collectSourceMetadata applies whitelist overrides in valid Git repos", () => {
  withTempDir((root) => {
    const repo = createRepo(root);
    git(repo, ["remote", "add", "origin", "https://token:secret@github.com/zyahav/Google-Calendar.git"]);
    writeFileSync(
      join(repo, ".omp-langfuse.metadata.json"),
      JSON.stringify(
        {
          repo_identity: "zyahav/Google-Calendar",
          repo_owner: "zyahav",
          repo_name: "Google-Calendar",
          source_type: "git-repo",
          service_name: "calendar-supervisor",
          raw_path: "/Users/private/project",
          token: "secret-token",
          unknown_key: "must-not-pass",
          git_remote_path: "evil/override",
        },
        null,
        2,
      ),
    );

    const metadata = collectSourceMetadata(repo);
    assert.equal(metadata.repo_identity, "zyahav/Google-Calendar");
    assert.equal(metadata.repo_owner, "zyahav");
    assert.equal(metadata.repo_name, "Google-Calendar");
    assert.equal(metadata.service_name, "calendar-supervisor");
    assert.equal(metadata.source_type, "git-repo");
    assert.equal(metadata.git_remote_host, "github.com");
    assert.equal(metadata.git_remote_path, "zyahav/Google-Calendar");
    assert.ok(!metadata.repo_name.includes("/"));
    assert.ok(!("raw_path" in metadata));
    assert.ok(!("token" in metadata));
    assert.ok(!("unknown_key" in metadata));
  });
});

test("sanitizeGitRemote strips credentials, protocols, and git suffixes", () => {
  for (const remote of [
    "https://token:secret@github.com/zyahav/Google-Calendar.git",
    "git@github.com:zyahav/Google-Calendar.git",
    "https://github.com/zyahav/Google-Calendar.git",
  ]) {
    const sanitized = sanitizeGitRemote(remote);
    const serialized = JSON.stringify(sanitized);
    assert.equal(sanitized.git_remote_host, "github.com");
    assert.equal(sanitized.git_remote_path, "zyahav/Google-Calendar");
    assert.ok(!serialized.includes("token"));
    assert.ok(!serialized.includes("secret"));
    assert.ok(!serialized.includes("https://"));
    assert.ok(!serialized.includes("git@"));
    assert.ok(!serialized.includes(".git"));
  }
});

test("collectSourceMetadata keeps repo_name repo-only", () => {
  withTempDir((root) => {
    const repo = createRepo(root);
    git(repo, ["remote", "add", "origin", "https://github.com/zyahav/Google-Calendar.git"]);
    const metadata = collectSourceMetadata(repo);
    assert.equal(metadata.repo_identity, "zyahav/Google-Calendar");
    assert.equal(metadata.repo_owner, "zyahav");
    assert.equal(metadata.repo_name, "Google-Calendar");
    assert.ok(!metadata.repo_name.includes("/"));
  });
});

test("collectSourceMetadata isolates non-Git folders even with metadata files", () => {
  withTempDir((root) => {
    const nonGit = join(root, "non-git");
    mkdirSync(nonGit);
    assert.deepEqual(Object.keys(collectSourceMetadata(nonGit)).sort(), ["metadata_source", "source_type"]);
    writeFileSync(
      join(nonGit, ".omp-langfuse.metadata.json"),
      JSON.stringify({ repo_identity: "should/not-pass", repo_owner: "should", repo_name: "not-pass" }),
    );
    const nonGitWithFile = collectSourceMetadata(nonGit);
    assert.deepEqual(Object.keys(nonGitWithFile).sort(), ["metadata_source", "source_type"]);
    assert.equal(nonGitWithFile.source_type, "non-git");
    assert.equal(nonGitWithFile.metadata_source, "non-git");
  });
});
