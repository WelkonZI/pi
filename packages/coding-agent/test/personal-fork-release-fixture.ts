export function personalForkInstallSpec(version: string): string {
	return `https://github.com/WelkonZI/pi/releases/download/v${version}/pi-coding-agent-${version}.tgz`;
}

export function personalForkRelease(version: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return { version, installSpec: personalForkInstallSpec(version), ...fields };
}
