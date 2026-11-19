import chalk from "chalk";
import { valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

export const PERSONAL_FORK_RELEASE_URL = "https://github.com/WelkonZI/pi/releases/latest/download/latest.json";
const PERSONAL_FORK_DOWNLOAD_URL = "https://github.com/WelkonZI/pi/releases/download";

export interface PersonalForkRelease {
	version: string;
	installSpec: string;
	packageName?: string;
	note?: string;
}

export async function getPersonalForkRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<PersonalForkRelease | undefined> {
	const response = await fetchWithRetry(
		PERSONAL_FORK_RELEASE_URL,
		{ headers: { "User-Agent": getPiUserAgent(currentVersion), accept: "application/json" } },
		{ maxRetries: options.retry ? 2 : 0, timeoutMs: options.timeoutMs ?? 10000 },
	);
	return response.ok ? parsePersonalForkRelease(await response.json()) : undefined;
}

export function parsePersonalForkRelease(data: unknown): PersonalForkRelease {
	const manifest = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
	const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
	if (!valid(version)) throw new Error("Invalid fork release manifest: version must be a valid semantic version.");

	const expectedInstallSpec = `${PERSONAL_FORK_DOWNLOAD_URL}/v${version}/pi-coding-agent-${version}.tgz`;
	const installSpec = typeof manifest.installSpec === "string" ? manifest.installSpec.trim() : "";
	if (installSpec !== expectedInstallSpec) {
		throw new Error(`Invalid fork release manifest: installSpec must be ${expectedInstallSpec}.`);
	}

	const packageName =
		typeof manifest.packageName === "string" && manifest.packageName.trim() ? manifest.packageName.trim() : undefined;
	const note = typeof manifest.note === "string" && manifest.note.trim() ? manifest.note.trim() : undefined;
	return { version, installSpec, ...(packageName ? { packageName } : {}), ...(note ? { note } : {}) };
}

export function failPersonalForkVersionMismatch(
	appName: string,
	command: string,
	installedVersion: string | undefined,
	expectedVersion: string,
): true {
	console.error(
		chalk.red(
			`Ran ${command}, but \`${appName} --version\` reports ${installedVersion ?? "no version"}, not ${expectedVersion}.`,
		),
	);
	process.exitCode = 1;
	return true;
}
