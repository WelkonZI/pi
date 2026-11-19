import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./cleanup-personal-release.sh", import.meta.url).pathname;

function run(mode, releaseId = "123") {
	const cwd = mkdtempSync(join(tmpdir(), "pi-release-cleanup-"));
	const gh = join(cwd, "gh");
	writeFileSync(
		gh,
		`#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "$LOG"
if [[ "$MODE" == "lookup-error" ]]; then exit 1; fi
if [[ "$1" == "api" && "$*" == *"releases?per_page=100"* ]]; then
  printf '%s\n' '{"id":123,"tag_name":"v1.2.3-welkonzi.1","body":"<!-- personal-release:1:1 -->","draft":true}'
elif [[ "$1" == "api" && "$*" == *"releases/123"* && "$*" != *"--method DELETE"* ]]; then
  if [[ "$MODE" == "foreign" ]]; then
    printf '%s\n' '{"id":123,"body":"other","draft":true}'
  else
    printf '%s\n' '{"id":123,"body":"<!-- personal-release:1:1 -->","draft":true}'
  fi
fi
`,
	);
	chmodSync(gh, 0o755);
	const log = join(cwd, "commands.log");
	try {
		execFileSync("bash", [script, "WelkonZI/pi", releaseId, "v1.2.3-welkonzi.1", "personal-release:1:1"], {
			env: { ...process.env, LOG: log, MODE: mode, PATH: `${cwd}:${process.env.PATH}` },
		});
		return readFileSync(log, "utf8");
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
}

test("deletes the exact owned draft release id", () => {
	const log = run("owned");
	assert.match(log, /gh api repos\/WelkonZI\/pi\/releases\/123/);
	assert.match(log, /gh api --method DELETE repos\/WelkonZI\/pi\/releases\/123/);
	assert.doesNotMatch(log, /release delete/);
});

test("recovers an ambiguously created owned draft by marker", () => {
	const log = run("owned", "");
	assert.match(log, /releases\?per_page=100/);
	assert.match(log, /--method DELETE repos\/WelkonZI\/pi\/releases\/123/);
});

test("preserves the release when exact lookup fails", () => {
	const log = run("lookup-error");
	assert.doesNotMatch(log, /--method DELETE/);
});

test("preserves a replacement release with the same tag", () => {
	const log = run("foreign");
	assert.doesNotMatch(log, /--method DELETE/);
});
