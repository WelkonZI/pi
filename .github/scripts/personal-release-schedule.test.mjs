import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../workflows/personal-release.yml", import.meta.url), "utf8"));
const gate = workflow.jobs.release.steps.find((step) => step.id === "schedule").run;

function runGate(event, instant) {
	const dir = mkdtempSync(join(tmpdir(), "pi-release-schedule-"));
	try {
		const output = join(dir, "output");
		const clock = instant === undefined ? "return 1" : `printf '%s\\n' ${Math.floor(Date.parse(instant) / 1000)}`;
		const result = spawnSync("bash", ["-c", `date() { ${clock}; }\n${gate}`], {
			encoding: "utf8",
			env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output },
		});
		assert.ifError(result.error);
		return { status: result.status, output: result.status === 0 ? readFileSync(output, "utf8") : undefined };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const [start, end] of [
	["2026-01-27T06:17:00Z", "2026-03-03T06:17:00Z"],
	["2026-12-28T06:17:00Z", "2027-01-04T06:17:00Z"],
	["2028-02-26T06:17:00Z", "2028-03-04T06:17:00Z"],
]) {
	test(`scheduled release checks stay 48 hours apart from ${start} to ${end}`, () => {
		const accepted = [];
		for (let now = Date.parse(start); now <= Date.parse(end); now += 86400000) {
			const result = runGate("schedule", new Date(now).toISOString());
			assert.equal(result.status, 0);
			assert.ok(["should_run=true\n", "should_run=false\n"].includes(result.output));
			if (result.output === "should_run=true\n") accepted.push(now);
		}
		assert.ok(accepted.length >= 2);
		for (let index = 1; index < accepted.length; index++) assert.equal(accepted[index] - accepted[index - 1], 48 * 3600000);
	});
}

test("manual releases bypass the interval, even if the clock is unavailable", () => {
	assert.deepEqual(runGate("workflow_dispatch"), { status: 0, output: "should_run=true\n" });
});

test("a scheduled clock failure stops before accepting the release check", () => {
	assert.notEqual(runGate("schedule").status, 0);
});
