import { describe, expect, it } from "vitest";
import { parsePersonalForkRelease } from "../src/utils/personal-fork-release.ts";
import { personalForkInstallSpec, personalForkRelease } from "./personal-fork-release-fixture.ts";

describe("personal fork releases", () => {
	it("accepts only the canonical release tarball", () => {
		expect(parsePersonalForkRelease(personalForkRelease("1.5.3-welkonzi.1", { note: " release " }))).toEqual({
			version: "1.5.3-welkonzi.1",
			installSpec: personalForkInstallSpec("1.5.3-welkonzi.1"),
			note: "release",
		});
	});

	it.each([
		{},
		{ version: "invalid", installSpec: "https://github.com/WelkonZI/pi/releases/download/vinvalid/pi.tgz" },
		{ version: "1.5.3-welkonzi.1" },
		{ version: "1.5.3-welkonzi.1", installSpec: "http://github.com/WelkonZI/pi/releases/download/x.tgz" },
		{ version: "1.5.3-welkonzi.1", installSpec: "https://github.com/earendil-works/pi/releases/download/x.tgz" },
		{ version: "1.5.3-welkonzi.1", installSpec: personalForkInstallSpec("1.5.3-welkonzi.2") },
	])("rejects an invalid manifest", (manifest) => {
		expect(() => parsePersonalForkRelease(manifest)).toThrow("Invalid fork release manifest");
	});
});
