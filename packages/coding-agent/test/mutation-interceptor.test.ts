import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	clearExtensionCache,
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensionsCached,
} from "../src/core/extensions/loader.ts";
import {
	beginMutation,
	getDeclaredMutationInterceptor,
	type MutationInterceptionCall,
	type MutationInterceptor,
	type MutationObservationCall,
	withMutationInterceptor,
} from "../src/core/extensions/mutation-interceptor.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import type { PathMetadata } from "../src/core/package-manager.ts";

const identity: MutationInterceptor = {
	intercept<T>(call: MutationInterceptionCall<T>): T {
		return call.value;
	},
	observe(_call: MutationObservationCall): void {},
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-trusted-mutation-"));
	clearExtensionCache();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("trusted mutation interceptor kernel", () => {
	it("declares the hook beside an ordinary factory without wrapping the factory", () => {
		const factory: ExtensionFactory = () => {};
		expect(withMutationInterceptor(factory, identity)).toBe(factory);
		expect(getDeclaredMutationInterceptor(factory)).toBe(identity);
	});

	it("calls before, candidate, and applied directly with one operation id", () => {
		const calls: MutationInterceptionCall[] = [];
		const runtime = createExtensionRuntime();
		runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: {
				intercept<T>(call: MutationInterceptionCall<T>): T {
					calls.push(call);
					return call.phase === "candidate" ? ({ accepted: true } as T) : call.value;
				},
				observe(): void {},
			},
		};
		const before = { accepted: false };
		const operation = beginMutation(runtime, "fixture", before);
		expect(operation).toBeDefined();
		const accepted = operation?.candidate({ accepted: false });
		operation?.applied(accepted ?? before);
		expect(calls.map((call) => call.phase)).toEqual(["before", "candidate", "applied"]);
		expect(calls[0].value).toBe(before);
		expect(calls[1].operationId).toBe(calls[0].operationId);
		expect(calls[2].value).toBe(accepted);
		expect(calls[0]).toMatchObject({ sessionId: null, runId: null, turnId: null, providerAttemptId: null });
	});

	it("tracks repeated registrations and discards pending registrations from failed factories", async () => {
		const calls: MutationInterceptionCall[] = [];
		const observations: MutationObservationCall[] = [];
		const runtime = createExtensionRuntime();
		runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: {
				intercept<T>(call: MutationInterceptionCall<T>): T {
					calls.push(call);
					return call.value;
				},
				observe(call): void {
					observations.push(call);
				},
			},
		};
		const register = (pi: Parameters<ExtensionFactory>[0]) => {
			pi.registerTool({
				name: "sample",
				label: "sample",
				description: "first",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
			pi.registerTool({
				name: "sample",
				label: "sample",
				description: "second",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};
		const loaded = await loadExtensionFromFactory(register, dir, createEventBus(), runtime);
		expect(loaded.tools.get("sample")?.definition.description).toBe("second");
		expect(calls.filter((call) => call.operation === "tool_registration" && call.phase === "candidate")).toHaveLength(
			2,
		);
		expect(
			observations.filter((call) => call.operation === "tool_registration:outcome" && call.outcome === "registered"),
		).toHaveLength(2);
		const registrations = calls.filter((call) => call.operation === "tool_registration" && call.phase === "before");
		expect(registrations.map((call) => call.parentCallId)).toEqual([null, null]);
		const afterFactory = beginMutation(runtime, "after_factory", null);
		expect(calls.at(-1)).toMatchObject({ operation: "after_factory", phase: "before", parentCallId: null });
		afterFactory?.applied(null);
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					register(pi);
					throw new Error("factory failed");
				},
				dir,
				createEventBus(),
				runtime,
				"<failed>",
			),
		).rejects.toThrow("factory failed");
		expect(
			observations.filter((call) => call.operation === "tool_registration:outcome" && call.outcome === "discarded"),
		).toHaveLength(2);
	});

	it("fails closed on thrown and asynchronous trusted hooks", () => {
		const runtime = createExtensionRuntime();
		runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: {
				intercept<T>(call: MutationInterceptionCall<T>): T {
					if (call.phase === "candidate") throw new Error("denied");
					return call.value;
				},
				observe(): void {},
			},
		};
		expect(() => beginMutation(runtime, "fixture", {})?.candidate({})).toThrow(
			"Mutation interceptor /hook.ts failed at fixture:candidate",
		);
		runtime.mutationInterceptor.interceptor.intercept = <T>() => Promise.resolve({}) as T;
		try {
			beginMutation(runtime, "fixture", {});
			expect.fail("expected asynchronous hook rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("Mutation interceptor /hook.ts failed at fixture:before");
			expect((error as Error & { cause?: Error }).cause?.message).toBe(
				"Trusted mutation interceptor must be synchronous",
			);
		}
	});
});

describe("trusted mutation interceptor bootstrap", () => {
	it("initializes before factories while preserving ordinary factory order and cache reuse", async () => {
		const source = resolve("src/core/extensions/mutation-interceptor.ts");
		const first = join(dir, "first.ts");
		const hook = join(dir, "hook.ts");
		writeFileSync(first, `export default () => { globalThis.__mutationEvents.push("factory:first"); };`);
		writeFileSync(
			hook,
			`import { withMutationInterceptor } from ${JSON.stringify(source)};
const interceptor = {
 intercept(call) { globalThis.__mutationEvents.push(call.operation + ":" + call.phase); return call.value; },
 observe(call) { globalThis.__mutationEvents.push(call.operation + ":" + call.outcome); }
};
const factory = () => { globalThis.__mutationEvents.push("factory:hook"); };
export default withMutationInterceptor(factory, interceptor);`,
		);
		const metadata: PathMetadata = { source: "fixture", scope: "user", origin: "top-level", baseDir: dir };
		const sources = new Map([
			[first, metadata],
			[hook, metadata],
		]);
		(globalThis as typeof globalThis & { __mutationEvents: string[] }).__mutationEvents = [];
		const result = await loadExtensionsCached([first, hook], dir, createEventBus(), undefined, sources, hook);
		expect(result.errors).toEqual([]);
		const events = (globalThis as typeof globalThis & { __mutationEvents: string[] }).__mutationEvents;
		expect(events.indexOf("extension_factory:started")).toBeLessThan(events.indexOf("factory:first"));
		expect(events.indexOf("factory:first")).toBeLessThan(events.indexOf("factory:hook"));

		events.length = 0;
		await loadExtensionsCached([first, hook], dir, createEventBus(), undefined, sources, hook);
		expect(events).toContain("extension_factory:started");
		expect(events).toContain("factory:first");
	});

	it("fails closed instead of converting trusted hook failures into extension errors", async () => {
		const source = resolve("src/core/extensions/mutation-interceptor.ts");
		const hook = join(dir, "hook.ts");
		const next = join(dir, "next.ts");
		writeFileSync(
			hook,
			`import { withMutationInterceptor } from ${JSON.stringify(source)};
const interceptor = {
 intercept(call) { return call.value; },
 observe(call) { if (call.operation === "extension_factory") throw new Error("denied"); }
};
export default withMutationInterceptor(() => { globalThis.__mutationEvents.push("factory:hook"); }, interceptor);`,
		);
		writeFileSync(next, `export default () => { globalThis.__mutationEvents.push("factory:next"); };`);
		const metadata: PathMetadata = { source: "fixture", scope: "user", origin: "top-level", baseDir: dir };
		const sources = new Map([
			[hook, metadata],
			[next, metadata],
		]);
		(globalThis as typeof globalThis & { __mutationEvents: string[] }).__mutationEvents = [];
		await expect(loadExtensionsCached([hook, next], dir, createEventBus(), undefined, sources, hook)).rejects.toThrow(
			"Mutation interceptor",
		);
		expect((globalThis as typeof globalThis & { __mutationEvents: string[] }).__mutationEvents).toEqual([]);
	});

	it("rejects a project-scoped configured hook before ordinary factories", async () => {
		const hook = join(dir, "hook.ts");
		writeFileSync(hook, "export default Object.assign(() => {}, { __piTrustedMutationInterceptor: {} });");
		const sources = new Map<string, PathMetadata>([
			[hook, { source: "fixture", scope: "project", origin: "top-level", baseDir: dir }],
		]);
		await expect(loadExtensionsCached([hook], dir, createEventBus(), undefined, sources, hook)).rejects.toThrow(
			"Trusted mutation hook requires user scope",
		);
	});
});
