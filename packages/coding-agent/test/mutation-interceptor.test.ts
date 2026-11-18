import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensions } from "../src/core/extensions/loader.ts";
import {
	BUILTIN_SYSTEM_PROMPT_SOURCE,
	invokeMutationInterceptor,
	type MutationInterceptor,
	type MutationInterceptorRegistration,
} from "../src/core/extensions/mutation-interceptor.ts";
import type { PathMetadata } from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../src/core/source-info.ts";
import { normalizeBuildSystemPromptOptions } from "../src/core/system-prompt.ts";

const userSource: SourceInfo = {
	path: "/user/interceptor.ts",
	source: "local",
	scope: "user",
	origin: "top-level",
};
const contributionSource = createSyntheticSourceInfo("inline:contributor", { source: "inline" });
const identity: MutationInterceptor = (event) => event.after;

function registration(interceptor: MutationInterceptor = identity): MutationInterceptorRegistration {
	return { sourceInfo: userSource, interceptor };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-mutation-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function extension(name: string, body: string): string {
	const path = join(dir, `${name}.ts`);
	writeFileSync(path, `export default (pi) => { ${body} };`);
	return path;
}

function metadata(scope: PathMetadata["scope"], origin: PathMetadata["origin"] = "top-level"): PathMetadata {
	return { source: "local", scope, origin, baseDir: dir };
}

describe("mutation interceptor kernel", () => {
	it("keeps the zero-registration fast path and exact state references", () => {
		const after = { docs: "unchanged" };
		expect(
			invokeMutationInterceptor(undefined, {
				stage: "system_prompt_sections",
				sourceInfo: BUILTIN_SYSTEM_PROMPT_SOURCE,
				before: {},
				after,
			}),
		).toBe(after);
	});

	it("passes exact attribution and can remove or replace a section", () => {
		const before = { docs: "old", tools: "same" };
		const after = { docs: "new", tools: "same" };
		const seen: unknown[] = [];
		const interceptor: MutationInterceptor = (event) => {
			seen.push(event);
			if (event.stage === "system_prompt_sections") delete event.after.docs;
			return event.after;
		};
		expect(
			invokeMutationInterceptor(registration(interceptor), {
				stage: "system_prompt_sections",
				sourceInfo: BUILTIN_SYSTEM_PROMPT_SOURCE,
				before,
				after,
			}),
		).toEqual({ tools: "same" });
		expect(seen).toEqual([
			{ stage: "system_prompt_sections", sourceInfo: BUILTIN_SYSTEM_PROMPT_SOURCE, before, after },
		]);
		expect(before).toEqual({ docs: "old", tools: "same" });
	});

	it("preserves original errors and includes stage and both sources", () => {
		const cause = new Error("policy failed");
		try {
			invokeMutationInterceptor(
				registration(() => {
					throw cause;
				}),
				{
					stage: "context",
					sourceInfo: contributionSource,
					before: [],
					after: [],
				},
			);
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("context");
			expect((error as Error).message).toContain(userSource.path);
			expect((error as Error).message).toContain(contributionSource.path);
			expect((error as Error).cause).toBe(cause);
		}
	});

	it.each([
		["system_prompt_sections", { docs: 1 }],
		["before_agent_start", {}],
		["context", {}],
		["context_with_system", [{}]],
	] as const)("rejects invalid %s state", (stage, invalid) => {
		const interceptor = (() => invalid) as MutationInterceptor;
		expect(() =>
			invokeMutationInterceptor(registration(interceptor), {
				stage,
				sourceInfo: contributionSource,
				before: [],
				after: [],
			} as Parameters<MutationInterceptor>[0]),
		).toThrow("failed at");
	});

	it("rejects undefined instead of restoring a rejected provider payload", () => {
		expect(() =>
			invokeMutationInterceptor(
				registration(() => undefined),
				{
					stage: "before_provider_request",
					sourceInfo: contributionSource,
					before: {},
					after: {},
				},
			),
		).toThrow("failed at before_provider_request");
	});

	it.each([
		"system",
		"user",
		"assistant",
		"toolResult",
		"custom",
		"bashExecution",
		"branchSummary",
		"compactionSummary",
	])("rejects missing required fields in %s messages", (role) => {
		expect(() =>
			invokeMutationInterceptor(
				registration(() => [{ role, timestamp: 1 }]),
				{
					stage: "context",
					sourceInfo: contributionSource,
					before: [],
					after: [],
				},
			),
		).toThrow("failed at context");
	});

	it("accepts valid built-in messages and extension-defined envelopes", () => {
		const messages = [
			{ role: "system", content: "", sections: { docs: null }, timestamp: 1 },
			{ role: "user", content: [{ type: "image", data: "base64", mimeType: "image/png" }], timestamp: 1 },
			fauxAssistantMessage("answer"),
			{ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 1 },
			{ role: "vendor", timestamp: 1, vendorState: true },
		];
		expect(
			invokeMutationInterceptor(
				registration(() => messages),
				{
					stage: "context",
					sourceInfo: contributionSource,
					before: [],
					after: [],
				},
			),
		).toBe(messages);
	});

	it("accepts fresh replacement arrays through the public callback type", () => {
		const replace: MutationInterceptor = (event) => (event.stage === "context" ? [] : event.after);
		expect(
			invokeMutationInterceptor(registration(replace), {
				stage: "context",
				sourceInfo: contributionSource,
				before: [],
				after: [{ role: "user", content: "discard", timestamp: 1 }],
			}),
		).toEqual([]);
	});

	it("accepts normalized options and extensible message envelopes", () => {
		const options = normalizeBuildSystemPromptOptions({ cwd: dir });
		expect(
			invokeMutationInterceptor(registration(), {
				stage: "before_agent_start",
				sourceInfo: contributionSource,
				before: options,
				after: options,
			}),
		).toBe(options);
		const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
		expect(
			invokeMutationInterceptor(registration(), {
				stage: "context_with_system",
				sourceInfo: contributionSource,
				before: [],
				after: messages,
			}),
		).toBe(messages);
	});

	it.each([null, 42, "opaque", { vendor: true }])("keeps provider payload opaque: %j", (after) => {
		expect(
			invokeMutationInterceptor(registration(), {
				stage: "before_provider_request",
				sourceInfo: contributionSource,
				before: undefined,
				after,
			}),
		).toBe(after);
	});

	// biome-ignore lint/suspicious/noThenProperty: deliberately test an untrusted thenable result.
	it.each([() => Promise.resolve({}), () => Promise.reject(new Error("async rejection")), () => ({ then() {} })])(
		"rejects async results without awaiting",
		(makeResult) => {
			expect(() =>
				invokeMutationInterceptor(registration(makeResult as MutationInterceptor), {
					stage: "before_provider_request",
					sourceInfo: contributionSource,
					before: {},
					after: {},
				}),
			).toThrow("failed at before_provider_request");
		},
	);
});

describe("transactional trusted registration", () => {
	it.each(["top-level", "package"] as const)(
		"registers authoritative user %s metadata before factory completion",
		async (origin) => {
			const path = extension(
				"user",
				'pi.registerMutationInterceptor(event => event.after); pi.registerCommand("owner", { handler: async () => {} });',
			);
			const result = await loadExtensions(
				[path],
				dir,
				undefined,
				undefined,
				new Map([[path, metadata("user", origin)]]),
			);
			expect(result.errors).toEqual([]);
			const loaded = result.extensions[0];
			expect(loaded.sourceInfo).toMatchObject(metadata("user", origin));
			expect(result.runtime.mutationInterceptor?.sourceInfo).toBe(loaded.sourceInfo);
			expect(loaded.commands.get("owner")?.sourceInfo).toBe(loaded.sourceInfo);
		},
	);

	it.each(["project", "temporary"] as const)("rejects %s registration", async (scope) => {
		const path = extension(scope, "pi.registerMutationInterceptor(event => event.after);");
		const result = await loadExtensions([path], dir, undefined, undefined, new Map([[path, metadata(scope)]]));
		expect(result.extensions).toEqual([]);
		expect(result.errors[0].error).toContain("requires user scope");
		expect(result.runtime.mutationInterceptor).toBeUndefined();
	});

	it("does not infer authority from an unknown path", async () => {
		const path = extension("unknown", "pi.registerMutationInterceptor(event => event.after);");
		const result = await loadExtensions([path], dir);
		expect(result.errors[0].error).toContain("requires user scope");
		expect(result.runtime.mutationInterceptor).toBeUndefined();
	});

	it("discards registration from failed or duplicate-registering factories", async () => {
		for (const body of [
			'pi.registerMutationInterceptor(event => event.after); throw new Error("factory failed");',
			"pi.registerMutationInterceptor(event => event.after); pi.registerMutationInterceptor(event => event.after);",
		]) {
			const path = extension("failed", body);
			const result = await loadExtensions([path], dir, undefined, undefined, new Map([[path, metadata("user")]]));
			expect(result.errors).toHaveLength(1);
			expect(result.runtime.mutationInterceptor).toBeUndefined();
		}
	});

	it("permits post-load registration but rejects registration after runtime invalidation", async () => {
		const bus = createEventBus();
		let register: () => void = () => { throw new Error("factory not observed"); };
		bus.on("capture", (callback) => { if (typeof callback !== "function") throw new Error("expected callback"); register = () => callback(); });
		const path = extension("active", 'pi.events.emit("capture", () => pi.registerMutationInterceptor(event => event.after));');
		const result = await loadExtensions([path], dir, bus, undefined, new Map([[path, metadata("user")]]));
		expect(result.errors).toEqual([]);
		expect(result.runtime.mutationInterceptor).toBeUndefined();
		register();
		expect(result.runtime.mutationInterceptor?.sourceInfo).toBe(result.extensions[0].sourceInfo);
		result.runtime.invalidate("fixture invalidated");
		expect(register).toThrow("fixture invalidated");
	});

	it("rejects an escaped registration callback after its factory fails", async () => {
		const bus = createEventBus();
		let register: () => void = () => { throw new Error("factory not observed"); };
		bus.on("capture", (callback) => { if (typeof callback !== "function") throw new Error("expected callback"); register = () => callback(); });
		const path = extension("escaped", 'pi.events.emit("capture", () => pi.registerMutationInterceptor(event => event.after)); throw new Error("factory failed");');
		const result = await loadExtensions([path], dir, bus, undefined, new Map([[path, metadata("user")]]));
		expect(result.errors).toHaveLength(1);
		expect(register).toThrow("failed to load and its API is no longer active");
		expect(result.runtime.mutationInterceptor).toBeUndefined();
	});

	it("rechecks concurrent registrations before committing any queued runtime changes", async () => {
		const bus = createEventBus();
		const runtime = createExtensionRuntime();
		const releases = new Map<string, () => void>();
		let ready: () => void = () => {};
		const bothPending = new Promise<void>((resolve) => { ready = resolve; });
		for (const key of ["first", "second"]) bus.on(`pending:${key}`, (release) => {
			if (typeof release !== "function") throw new Error("expected release");
			releases.set(key, () => release());
			if (releases.size === 2) ready();
		});
		const body = (key: string) => `pi.registerMutationInterceptor(event => event.after); await new Promise(resolve => pi.events.emit("pending:${key}", resolve));`;
		const first = join(dir, "concurrent-first.ts");
		const second = join(dir, "concurrent-second.ts");
		writeFileSync(first, `export default async pi => { ${body("first")} };`);
		writeFileSync(second, `export default async pi => { pi.registerFlag("blocked-flag", { type: "boolean", default: true }); ${body("second")} };`);
		const sources = new Map([[first, metadata("user")], [second, metadata("user")]]);
		const firstLoad = loadExtensions([first], dir, bus, runtime, sources);
		const secondLoad = loadExtensions([second], dir, bus, runtime, sources);
		await bothPending;
		expect(runtime.mutationInterceptor).toBeUndefined();
		releases.get("first")?.();
		const committed = await firstLoad;
		releases.get("second")?.();
		const rejected = await secondLoad;
		expect(committed.errors).toEqual([]);
		expect(rejected.errors[0].error).toContain("already registered");
		expect(runtime.mutationInterceptor?.sourceInfo).toBe(committed.extensions[0].sourceInfo);
		expect(runtime.flagValues.has("blocked-flag")).toBe(false);
	});

	it("preserves the first committed interceptor after a duplicate factory", async () => {
		const first = extension("first", "pi.registerMutationInterceptor(event => event.after);");
		const second = extension("second", "pi.registerMutationInterceptor(event => event.after);");
		const result = await loadExtensions(
			[first, second],
			dir,
			undefined,
			undefined,
			new Map([
				[first, metadata("user")],
				[second, metadata("user")],
			]),
		);
		expect(result.extensions.map((loaded) => loaded.path)).toEqual([first]);
		expect(result.errors[0].error).toContain("already registered");
		expect(result.runtime.mutationInterceptor?.sourceInfo).toBe(result.extensions[0].sourceInfo);
	});
});

describe("DefaultResourceLoader attribution", () => {
	it("supplies user metadata before factory execution in a final-only load", async () => {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		mkdirSync(cwd);
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "user.ts"),
			"export default pi => { pi.registerMutationInterceptor(event => event.after); };",
		);
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		await loader.reload();
		expect(loader.getExtensions().runtime.mutationInterceptor?.sourceInfo.scope).toBe("user");
		expect(loader.getExtensions().errors).toEqual([]);
	});

	it("commits user authority in pre-trust and reuses it in final loading", async () => {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "user.ts"),
			"export default pi => { pi.registerMutationInterceptor(event => event.after); };",
		);
		writeFileSync(
			join(cwd, ".pi", "extensions", "project.ts"),
			"export default pi => { pi.registerMutationInterceptor(event => event.after); };",
		);
		const loader = new DefaultResourceLoader({ cwd, agentDir });
		let preTrust: MutationInterceptorRegistration | undefined;
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				preTrust = extensionsResult.runtime.mutationInterceptor;
				expect(preTrust?.sourceInfo.scope).toBe("user");
				return true;
			},
		});
		const final = loader.getExtensions();
		expect(preTrust).toBeDefined();
		expect(final.runtime.mutationInterceptor).toBe(preTrust);
		expect(final.errors).toEqual(
			expect.arrayContaining([expect.objectContaining({ error: expect.stringContaining("requires user scope") })]),
		);
		expect(final.extensions.find((loaded) => loaded.sourceInfo.scope === "user")?.sourceInfo).toBe(
			preTrust?.sourceInfo,
		);
	});

	it("preserves discovered user authority when the same path is also passed via CLI", async () => {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		mkdirSync(cwd);
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		const path = join(agentDir, "extensions", "user.ts");
		writeFileSync(path, "export default pi => { pi.registerMutationInterceptor(event => event.after); };");
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [path] });
		let preTrust: MutationInterceptorRegistration | undefined;
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				preTrust = extensionsResult.runtime.mutationInterceptor;
				expect(preTrust?.sourceInfo.scope).toBe("user");
				expect(extensionsResult.errors).toEqual([]);
				return true;
			},
		});
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().runtime.mutationInterceptor).toBe(preTrust);
		expect(loader.getExtensions().extensions).toHaveLength(1);
	});

	it("rejects an unowned CLI-only extension during pre-trust", async () => {
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const path = extension("cli", "pi.registerMutationInterceptor(event => event.after);");
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [path] });
		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				expect(extensionsResult.runtime.mutationInterceptor).toBeUndefined();
				return true;
			},
		});
		expect(loader.getExtensions().runtime.mutationInterceptor).toBeUndefined();
		expect(loader.getExtensions().errors.some((error) => error.error.includes("requires user scope"))).toBe(true);
	});
});
