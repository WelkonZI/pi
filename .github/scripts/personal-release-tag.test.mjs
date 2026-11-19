import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./check-personal-release-tag.sh", import.meta.url).pathname;
const sourceCommit = "a".repeat(40);

function run(mode) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-release-tag-"));
	writeFileSync(
		join(cwd, "gh"),
		`#!/usr/bin/env bash
set -euo pipefail
[[ "$MODE" == "api-error" ]] && exit 1
if [[ "$MODE" == "draft" ]]; then
  printf '%s\n' '{"tag_name":"v1.2.3-welkonzi.1","draft":true}'
fi
`,
	);
	writeFileSync(
		join(cwd, "git"),
		`#!/usr/bin/env bash
set -euo pipefail
if [[ "$MODE" == "same-tag" ]]; then
  printf '%s\t%s\n' "${sourceCommit}" 'refs/tags/v1.2.3-welkonzi.1'
elif [[ "$MODE" == "other-tag" ]]; then
  printf '%s\t%s\n' "${"b".repeat(40)}" 'refs/tags/v1.2.3-welkonzi.1'
fi
`,
	);
	chmodSync(join(cwd, "gh"), 0o755);
	chmodSync(join(cwd, "git"), 0o755);
	try {
		return spawnSync("bash", [script, "WelkonZI/pi", "v1.2.3-welkonzi.1", sourceCommit, "remote"], {
			env: { ...process.env, MODE: mode, PATH: `${cwd}:${process.env.PATH}` },
			encoding: "utf8",
		});
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
}

test("allows retrying a same-source orphan tag", () => {
	const result = run("same-tag");
	assert.equal(result.status, 0);
	assert.equal(result.stdout.trim(), sourceCommit);
});

test("allows reserving an absent tag", () => {
	const result = run("no-tag");
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "\n");
});

test("rejects a draft using the tag", () => {
	assert.notEqual(run("draft").status, 0);
});

test("rejects a tag at another source commit", () => {
	assert.notEqual(run("other-tag").status, 0);
});

test("fails closed when releases cannot be listed", () => {
	assert.notEqual(run("api-error").status, 0);
});
