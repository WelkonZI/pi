import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { MutationInterceptionCall, MutationObservationCall } from "../src/core/extensions/mutation-interceptor.ts";
import { applyResourceOverride } from "../src/core/extensions/mutation-interceptor-resources.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-mutation-resources-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete (globalThis as typeof globalThis & { __resourceMutationCalls?: MutationInterceptionCall[] })
		.__resourceMutationCalls;
	delete (globalThis as Record<string, unknown>).__mutationResourceFacts;
	delete (globalThis as Record<string, unknown>).__resourceReloadFacts;
});

describe("resource trusted mutation boundaries", () => {
	it("applies the trusted recovery candidate before preserving an ordinary override error", () => {
		const calls: MutationInterceptionCall[] = [];
		const observations: MutationObservationCall[] = [];
		const runtime = createExtensionRuntime();
		runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: {
				intercept<T>(call: MutationInterceptionCall<T>): T {
					calls.push(call);
					if (call.operation === "resource_override" && call.phase === "candidate" && call.error) {
						return "recovered" as T;
					}
					return call.value;
				},
				observe(call): void {
					observations.push(call);
				},
			},
		};
		let applied = "unset";
		expect(() =>
			applyResourceOverride<string>(
				runtime,
				"fixture_override",
				"before",
				() => {
					throw new Error("ordinary failure");
				},
				(value) => {
					applied = `normalized:${value}`;
					return applied;
				},
			),
		).toThrow("ordinary failure");
		expect(applied).toBe("normalized:recovered");
		expect(calls.map((call) => call.phase)).toEqual(["before", "candidate", "applied"]);
		expect(calls[1].error).toEqual({ type: "error" });
		expect(calls[2].error).toEqual({ type: "error" });
		expect(calls[2].value).toBe("normalized:recovered");
		expect(observations).toEqual([
			expect.objectContaining({ operation: "resource_override:outcome", outcome: "applied_after_error" }),
		]);
	});

	it("preserves stored override state when a no-hook reload override fails", async () => {
		let fail = false;
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory(),
			systemPrompt: "base",
			systemPromptOverride: () => {
				if (fail) throw new Error("ordinary override failure");
				return "stored";
			},
		});
		await loader.reload();
		expect(loader.getSystemPrompt()).toBe("stored");
		fail = true;
		await expect(loader.reload()).rejects.toThrow("ordinary override failure");
		expect(loader.getSystemPrompt()).toBe("stored");
	});

	it("persists trusted skills and prompts recovery before rethrowing ordinary override errors", async () => {
		const source = resolve("src/core/extensions/mutation-interceptor.ts");
		const hook = join(dir, "recovery-hook.ts");
		const sourceInfo = { path: "/recovered", source: "fixture", scope: "user", origin: "top-level" };
		writeFileSync(
			hook,
			`import { withMutationInterceptor } from ${JSON.stringify(source)};
const sourceInfo = ${JSON.stringify(sourceInfo)};
globalThis.__resourceReloadFacts = [];
const interceptor = {
 intercept(call) {
  if (call.operation !== "resource_override" || call.phase !== "candidate" || !call.error) return call.value;
  if (call.reason === "skills_override") return { skills: [{ name: "recovered-skill", description: "recovered", filePath: "/recovered/SKILL.md", baseDir: "/recovered", disableModelInvocation: false, sourceInfo }], diagnostics: [] };
  if (call.reason === "prompts_override") return { prompts: [{ name: "recovered-prompt", description: "recovered", content: "recovered", filePath: "/recovered/prompt.md", sourceInfo }], diagnostics: [] };
  return call.value;
 },
 observe(call) { globalThis.__resourceReloadFacts.push(call); }
};
export default withMutationInterceptor(() => {}, interceptor);`,
		);
		const skillsLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ trustedMutationHook: hook }),
			skillsOverride: () => {
				throw new Error("ordinary skills failure");
			},
		});
		await expect(skillsLoader.reload()).rejects.toThrow("ordinary skills failure");
		expect(skillsLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["recovered-skill"]);
		expect(
			(globalThis as typeof globalThis & { __resourceReloadFacts: MutationObservationCall[] }).__resourceReloadFacts,
		).toContainEqual(expect.objectContaining({ operation: "resource_reload", outcome: "failed", reason: "startup" }));

		const promptsLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ trustedMutationHook: hook }),
			promptsOverride: () => {
				throw new Error("ordinary prompts failure");
			},
		});
		await expect(promptsLoader.reload()).rejects.toThrow("ordinary prompts failure");
		expect(promptsLoader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual(["recovered-prompt"]);
	});

	it("fails closed when trusted registration fails inside inline and built-in factories", async () => {
		const source = resolve("src/core/extensions/mutation-interceptor.ts");
		const hook = join(dir, "fail-closed-hook.ts");
		writeFileSync(
			hook,
			`import { withMutationInterceptor } from ${JSON.stringify(source)};
globalThis.__resourceReloadFacts = [];
const interceptor = {
 intercept(call) {
  if (call.operation === "tool_registration" && call.phase === "candidate") throw new Error("trusted stop");
  return call.value;
 },
 observe(call) { globalThis.__resourceReloadFacts.push(call); }
};
export default withMutationInterceptor(() => {}, interceptor);`,
		);
		const factory = (pi: Parameters<ExtensionFactory>[0]) => {
			pi.registerTool({
				name: "fixture",
				label: "fixture",
				description: "fixture",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};
		for (const extensionFactories of [[factory], [{ name: "fixture", builtin: true as const, factory }]]) {
			const loader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				settingsManager: SettingsManager.inMemory({ trustedMutationHook: hook }),
				extensionFactories,
			});
			await expect(loader.reload()).rejects.toThrow("Mutation interceptor");
			expect(
				(globalThis as typeof globalThis & { __resourceReloadFacts: MutationObservationCall[] })
					.__resourceReloadFacts,
			).toContainEqual(
				expect.objectContaining({ operation: "resource_reload", outcome: "failed", reason: "startup" }),
			);
		}
	});

	it("reports a failed reload through the newly bootstrapped hook runtime", async () => {
		const source = resolve("src/core/extensions/mutation-interceptor.ts");
		const hook = join(dir, "reload-failure-hook.ts");
		writeFileSync(
			hook,
			`import { withMutationInterceptor } from ${JSON.stringify(source)};
globalThis.__resourceReloadFacts = [];
const interceptor = {
 intercept(call) {
  if (call.operation === "tool_registration" && call.phase === "candidate") throw new Error("trusted stop");
  return call.value;
 },
 observe(call) { globalThis.__resourceReloadFacts.push(call); }
};
export default withMutationInterceptor(() => {}, interceptor);`,
		);
		let register = false;
		const factory = (pi: Parameters<ExtensionFactory>[0]) => {
			if (!register) return;
			pi.registerTool({
				name: "fixture",
				label: "fixture",
				description: "fixture",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ trustedMutationHook: hook }),
			extensionFactories: [factory],
		});
		await loader.reload();
		register = true;
		await expect(loader.reload()).rejects.toThrow("Mutation interceptor");
		expect(
			(globalThis as typeof globalThis & { __resourceReloadFacts: MutationObservationCall[] }).__resourceReloadFacts,
		).toContainEqual(expect.objectContaining({ operation: "resource_reload", outcome: "failed", reason: "reload" }));
	});

	it("reports native resource outcomes and correlates an effective discovered path", async () => {
		const source = resolve("src/core/extensions/mutation-interceptor.ts");
		const hook = join(dir, "native-resource-hook.ts");
		writeFileSync(
			hook,
			`import { withMutationInterceptor } from ${JSON.stringify(source)};
globalThis.__mutationResourceFacts = [];
const interceptor = {
 intercept(call) { return call.value; },
 observe(call) { globalThis.__mutationResourceFacts.push(call); }
};
export default withMutationInterceptor(() => {}, interceptor);`,
		);
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ trustedMutationHook: hook }),
		});
		await loader.reload();
		const skillDir = join(dir, "discovered-skill");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: discovered-skill\ndescription: discovered skill\n---\nUse the discovered skill.",
		);
		loader.getExtensions().runtime.mutationResourceContributions = new Map([
			[
				skillDir,
				{
					callId: "resources-discover-call",
					sourceInfo: { path: "/extension.ts", source: "fixture", scope: "user", origin: "top-level" },
				},
			],
		]);
		await loader.extendResources({
			skillPaths: [
				{
					path: skillDir,
					metadata: { source: "extension:/extension.ts", scope: "user", origin: "top-level" },
				},
			],
		});
		const facts = (globalThis as Record<string, unknown>).__mutationResourceFacts as MutationObservationCall[];
		expect(facts).toContainEqual(
			expect.objectContaining({
				operation: "native_resource",
				outcome: "added",
				causeCallId: "resources-discover-call",
				value: expect.objectContaining({ kind: "skill", path: join(skillDir, "SKILL.md") }),
			}),
		);

		const collisionDirs = [join(dir, "collision-one"), join(dir, "collision-two")];
		for (const collisionDir of collisionDirs) {
			mkdirSync(collisionDir);
			writeFileSync(join(collisionDir, "SKILL.md"), "---\nname: collision\ndescription: collision\n---\nCollision.");
		}
		loader.getExtensions().runtime.mutationResourceContributions = new Map(
			collisionDirs.map((path, index) => [
				path,
				{
					callId: `collision-${index + 1}`,
					sourceInfo: { path: "/extension.ts", source: "fixture", scope: "user", origin: "top-level" },
				},
			]),
		);
		await loader.extendResources({
			skillPaths: collisionDirs.map((path) => ({
				path,
				metadata: { source: "extension:/extension.ts", scope: "user", origin: "top-level" },
			})),
		});
		const collision = facts.find(
			(call) => call.operation === "native_resource_diagnostic" && call.outcome === "duplicate_loser",
		);
		expect(collision?.causeCallId).toMatch(/^collision-[12]$/);
		expect(collision?.sourceInfo?.path).toBe("/extension.ts");
	});

	it("intercepts stable overrides and applies accepted file-backed prompt content", async () => {
		const source = resolve("src/core/extensions/mutation-interceptor.ts");
		const hook = join(dir, "hook.ts");
		const promptPath = join(dir, "fixture-prompt.md");
		writeFileSync(promptPath, "---\nname: fixture-prompt\ndescription: fixture prompt\n---\nOriginal body.");
		writeFileSync(
			hook,
			`import { withMutationInterceptor } from ${JSON.stringify(source)};
const interceptor = {
 intercept(call) {
  globalThis.__resourceMutationCalls.push(call);
  if (call.operation === "resource_override" && call.phase === "candidate" && call.reason === "system_prompt_override") return "trusted system";
  if (call.operation === "loaded_resources" && call.phase === "candidate") return { ...call.value, prompts: [...call.value.prompts.map(prompt => ({ ...prompt, content: "Trusted body." })), { name: "unknown", description: "unknown", content: "unknown", path: "/unknown.md", ownerInfo: null }] };
  return call.value;
 },
 observe() {}
};
export default withMutationInterceptor(() => {}, interceptor);`,
		);
		const calls: MutationInterceptionCall[] = [];
		(
			globalThis as typeof globalThis & { __resourceMutationCalls: MutationInterceptionCall[] }
		).__resourceMutationCalls = calls;
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ trustedMutationHook: hook }),
			additionalPromptTemplatePaths: [promptPath],
			agentsFilesOverride: () => ({ agentsFiles: [{ path: "/context.md", content: "context" }] }),
			systemPromptOverride: () => "ordinary system",
			appendSystemPromptOverride: () => ["append"],
		});
		await loader.reload();
		expect(loader.getSystemPrompt()).toBe("trusted system");
		expect(loader.getAppendSystemPrompt()).toEqual(["append"]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([{ path: "/context.md", content: "context" }]);
		expect(loader.getPrompts().prompts).toEqual([
			expect.objectContaining({ name: "fixture-prompt", content: "Trusted body." }),
		]);
		for (const reason of ["context_files_override", "system_prompt_override", "append_system_prompt_override"]) {
			expect(
				calls
					.filter((call) => call.operation === "resource_override" && call.reason === reason)
					.map((call) => call.phase),
			).toEqual(["before", "candidate", "applied"]);
		}
	});
});
