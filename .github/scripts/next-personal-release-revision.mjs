import { readFileSync } from "node:fs";

const prefix = `v${process.argv[2]}-welkonzi.`;
let maximum = 0;
for (const tag of readFileSync(0, "utf8").split(/\s+/)) {
	if (!tag.startsWith(prefix)) continue;
	const revision = tag.slice(prefix.length);
	if (/^\d+$/.test(revision)) maximum = Math.max(maximum, Number(revision));
}
console.log(maximum + 1);
