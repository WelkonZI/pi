import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./rebase-personal-release.sh", import.meta.url).pathname;

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, file, content, message) {
	writeFileSync(join(cwd, file), content);
	git(cwd, "add", file);
	git(cwd, "commit", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

test("rebases only personal patches and safely retries a pushed candidate", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-personal-rebase-"));
	try {
		git(cwd, "init", "--initial-branch=main");
		git(cwd, "config", "user.name", "Test");
		git(cwd, "config", "user.email", "test@example.com");
		const upstreamA = commit(cwd, "upstream.txt", "A\n", "upstream A");
		git(cwd, "branch", "personal", upstreamA);
		const upstreamB = commit(cwd, "upstream.txt", "B\n", "upstream B");
		const upstreamC = commit(cwd, "upstream.txt", "C\n", "upstream C");
		git(cwd, "branch", "upstream-main", upstreamC);
		git(cwd, "switch", "personal");
		commit(cwd, "personal.txt", "patch\n", "personal patch");

		execFileSync("bash", [script, "personal", "upstream-main", upstreamB, "vB"], { cwd, stdio: "pipe" });
		assert.equal(git(cwd, "merge-base", "--is-ancestor", upstreamB, "HEAD"), "");
		assert.equal(readFileSync(join(cwd, "upstream.txt"), "utf8"), "B\n");
		assert.equal(readFileSync(join(cwd, "personal.txt"), "utf8"), "patch\n");
		const firstCandidate = git(cwd, "rev-parse", "HEAD");
		git(cwd, "branch", "--force", "personal", firstCandidate);

		execFileSync("bash", [script, "personal", "upstream-main", upstreamB, "vB"], { cwd, stdio: "pipe" });
		assert.equal(git(cwd, "rev-parse", "HEAD"), firstCandidate);
		git(cwd, "branch", "--force", "personal", firstCandidate);

		execFileSync("bash", [script, "personal", "upstream-main", upstreamC, "vC"], { cwd, stdio: "pipe" });
		assert.equal(git(cwd, "merge-base", "--is-ancestor", upstreamC, "HEAD"), "");
		assert.equal(readFileSync(join(cwd, "upstream.txt"), "utf8"), "C\n");
		assert.equal(readFileSync(join(cwd, "personal.txt"), "utf8"), "patch\n");
		assert.equal(Number(git(cwd, "rev-list", "--count", `${upstreamC}..HEAD`)), 1);

		git(cwd, "switch", "--force-create", "personal-newer", upstreamC);
		commit(cwd, "personal.txt", "newer patch\n", "personal patch on newer upstream");
		execFileSync("bash", [script, "personal-newer", "upstream-main", upstreamB, "vB"], { cwd, stdio: "pipe" });
		assert.equal(readFileSync(join(cwd, "upstream.txt"), "utf8"), "B\n");
		assert.equal(readFileSync(join(cwd, "personal.txt"), "utf8"), "newer patch\n");
		assert.equal(Number(git(cwd, "rev-list", "--count", `${upstreamB}..HEAD`)), 1);
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});
