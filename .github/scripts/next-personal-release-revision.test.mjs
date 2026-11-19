import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const script = fileURLToPath(new URL("./next-personal-release-revision.mjs", import.meta.url));

test("increments the greatest published revision across gaps", () => {
	const result = spawnSync(process.execPath, [script, "1.5.3"], {
		input: "v1.5.3-welkonzi.2\nv1.5.3-welkonzi.4\nv1.5.2-welkonzi.9\n",
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout.trim(), "5");
});
