import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./publish-personal-release.sh", import.meta.url).pathname;

function run(mode) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-release-publish-"));
	const assets = join(cwd, "assets");
	mkdirSync(assets);
	writeFileSync(join(assets, "latest.json"), "{}");
	writeFileSync(join(assets, "pi-coding-agent-1.2.3-welkonzi.1.tgz"), "tgz");
	writeFileSync(
		join(cwd, "gh"),
		`#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "$LOG"
if [[ "$*" == *"--method POST repos/WelkonZI/pi/releases --input -"* ]]; then
  printf '%s\n' '{"id":123}'
elif [[ "$*" == *"releases/123/assets?per_page=100"* ]]; then
  printf '%s\n' 'latest.json'
  if [[ "$MODE" != "missing-asset" ]]; then printf '%s\n' 'pi-coding-agent-1.2.3-welkonzi.1.tgz'; fi
elif [[ "$*" == *"api repos/WelkonZI/pi/releases/123"* ]]; then
  printf '%s\n' '{"id":123,"body":"<!-- personal-release:1:1 -->","draft":true}'
fi
`,
	);
	writeFileSync(
		join(cwd, "curl"),
		`#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> "$LOG"
if [[ "$MODE" == "upload-error" ]]; then exit 1; fi
`,
	);
	chmodSync(join(cwd, "gh"), 0o755);
	chmodSync(join(cwd, "curl"), 0o755);
	const log = join(cwd, "commands.log");
	const result = spawnSync(
		"bash",
		[script, "WelkonZI/pi", "v1.2.3-welkonzi.1", "a".repeat(40), "1.2.3-welkonzi.1", "v1.2.3", "personal-release:1:1", assets],
		{
			cwd: new URL("../..", import.meta.url).pathname,
			env: { ...process.env, GH_TOKEN: "token", LOG: log, MODE: mode, PATH: `${cwd}:${process.env.PATH}` },
			encoding: "utf8",
		},
	);
	const commands = readFileSync(log, "utf8");
	rmSync(cwd, { force: true, recursive: true });
	return { commands, result };
}

test("uploads and publishes the exact created release id", () => {
	const { commands, result } = run("success");
	assert.equal(result.status, 0, result.stderr);
	assert.match(commands, /releases\/123\/assets\?name=latest\.json/);
	assert.match(commands, /releases\/123\/assets\?name=pi-coding-agent-1\.2\.3-welkonzi\.1\.tgz/);
	assert.match(commands, /--method PATCH repos\/WelkonZI\/pi\/releases\/123 --input -/);
	assert.doesNotMatch(commands, /gh release/);
});

test("cleans up the exact draft id after an upload failure", () => {
	const { commands, result } = run("upload-error");
	assert.notEqual(result.status, 0);
	assert.match(commands, /--method DELETE repos\/WelkonZI\/pi\/releases\/123/);
	assert.doesNotMatch(commands, /gh release/);
});

test("cleans up the exact draft id when an asset is missing", () => {
	const { commands, result } = run("missing-asset");
	assert.notEqual(result.status, 0);
	assert.match(commands, /--method DELETE repos\/WelkonZI\/pi\/releases\/123/);
	assert.doesNotMatch(commands, /--method PATCH/);
});
