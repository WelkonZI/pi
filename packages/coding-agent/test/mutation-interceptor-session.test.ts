import {
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
	MutationActiveToolsContext,
	MutationInterceptionCall,
	MutationInterceptor,
	MutationObservationCall,
	MutationSystemToolContext,
	MutationToolDefinition,
} from "../src/core/extensions/mutation-interceptor.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function recordingInterceptor(
	calls: MutationInterceptionCall[],
	change?: (call: MutationInterceptionCall<unknown>) => unknown,
	observations: MutationObservationCall[] = [],
): MutationInterceptor {
	return {
		intercept<T>(call: MutationInterceptionCall<T>): T {
			calls.push(call);
			return (change?.(call as MutationInterceptionCall<unknown>) ?? call.value) as T;
		},
		observe(call: MutationObservationCall): void {
			observations.push(call);
		},
	};
}

async function harnessWith(interceptor: MutationInterceptor) {
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				pi.registerTool({
					name: "sample",
					label: "sample",
					description: "original",
					parameters: Type.Object({}),
					prepareLoadout: () => {
						throw new Error("loadout-secret");
					},
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				pi.registerTool({
					name: "mutator",
					label: "mutator",
					description: "mutator",
					parameters: Type.Object({}),
					prepareLoadout: () => ({ descriptions: { sample: "second callback" } }),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				pi.registerTool({
					name: "deferred",
					label: "deferred",
					description: "deferred callable",
					parameters: Type.Object({}),
					exposure: "deferred",
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				pi.on("context_with_system", (event) => ({ messages: event.messages }));
				pi.on("before_provider_request", (event) => event.payload);
			},
		],
		process.cwd(),
	);
	extensionsResult.runtime.mutationInterceptor = {
		sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
		interceptor,
	};
	const baseResourceLoader = createTestResourceLoader({ extensionsResult });
	const resourceLoader = {
		...baseResourceLoader,
		getSkills: () => ({
			skills: [
				{
					name: "fixture-skill",
					description: "fixture skill",
					filePath: "/skill/SKILL.md",
					baseDir: "/skill",
					disableModelInvocation: false,
					sourceInfo: {
						path: "/skill/SKILL.md",
						source: "fixture",
						scope: "user" as const,
						origin: "top-level" as const,
					},
				},
			],
			diagnostics: [],
		}),
		getAgentsFiles: () => ({ agentsFiles: [{ path: "/context.md", content: "fixture context" }] }),
		getAppendSystemPrompt: () => ["fixture append"],
	};
	return createHarness({ resourceLoader, initialActiveToolNames: ["sample", "mutator"] });
}

describe("session trusted mutation boundaries", () => {
	it("preserves optional tool namespace behavior without a trusted hook", async () => {
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.registerTool({
						name: "sample",
						label: "sample",
						description: "original",
						parameters: Type.Object({}),
						prepareLoadout: (loadout) => {
							if (loadout.getNamespace("sample") !== undefined) throw new Error("unexpected namespace");
							return { descriptions: { sample: "prepared" } };
						},
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				},
			],
			process.cwd(),
		);
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["sample"],
		});
		try {
			expect(harness.session.agent.state.tools.find((tool) => tool.name === "sample")?.description).toBe("prepared");
		} finally {
			harness.cleanup();
		}
	});

	it("intercepts registry, active tools, and each prepareLoadout callback with stable markers", async () => {
		const calls: MutationInterceptionCall[] = [];
		const harness = await harnessWith(
			recordingInterceptor(calls, (call) => {
				if (call.operation === "active_tools" && call.phase === "candidate") {
					const value = call.value as MutationActiveToolsContext;
					return { ...value, activeTools: [...value.activeTools, "missing"] };
				}
				if (
					call.operation === "prepare_loadout" &&
					call.phase === "candidate" &&
					(call.value as { tool?: { name?: string } }).tool?.name === "sample"
				) {
					return { ...(call.value as object), changes: { descriptions: { sample: "trusted recovery" } } };
				}
				if (call.operation !== "tool_registry" || call.phase !== "candidate") return call.value;
				const registry = call.value as readonly MutationToolDefinition[];
				return registry.map((tool) =>
					tool.name === "sample" ? { ...tool, description: "trusted registry" } : tool,
				);
			}),
		);
		try {
			expect(harness.session.getActiveToolNames()).toEqual(["sample", "mutator"]);
			expect(harness.session.getToolDefinition("sample")?.description).toBe("trusted registry");
			expect(calls.some((call) => call.operation === "tool_registry")).toBe(true);
			expect(calls.find((call) => call.operation === "active_tools" && call.phase === "applied")?.value).toEqual(
				expect.objectContaining({
					requestedTools: ["sample", "mutator"],
					activeTools: ["sample", "mutator"],
					callableTools: expect.arrayContaining(["sample", "mutator", "deferred"]),
				}),
			);
			const loadoutCalls = calls.filter((call) => call.operation === "prepare_loadout");
			expect((loadoutCalls[0].value as { kind: string }).kind).toBe("input");
			expect(loadoutCalls.find((call) => call.phase === "candidate")?.error).toEqual({ type: "error" });
			expect((loadoutCalls.find((call) => call.phase === "applied")?.value as { kind: string }).kind).toBe("merged");
			expect(harness.session.agent.state.tools[0].description).toBe("second callback");
			harness.setResponses([() => fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			expect(harness.session.agent.state.tools[0].description).toBe("second callback");
			expect(
				calls.filter((call) => call.operation === "turn_preparation" && call.phase === "before").at(-1)?.value,
			).toEqual(
				expect.objectContaining({
					tools: expect.arrayContaining([
						expect.objectContaining({ name: "sample", description: "second callback" }),
					]),
				}),
			);
			harness.session.setActiveToolsByName(["sample", "mutator"]);
			expect(calls.some((call) => call.operation === "active_tools" && call.reason === "host_api")).toBe(true);
			expect(JSON.stringify(loadoutCalls)).not.toContain("loadout-secret");
			expect(calls.every((call) => call.sessionId === harness.session.sessionId)).toBe(true);
			const registry = calls.find((call) => call.operation === "tool_registry" && call.phase === "candidate")
				?.value as readonly MutationToolDefinition[];
			const sample = registry.find((tool) => tool.name === "sample");
			expect(sample?.execute).toEqual({ kind: "callback" });
			expect(sample?.prepareLoadout).toEqual({ kind: "callback" });
			expect(JSON.stringify(registry)).not.toContain("async ()");
		} finally {
			harness.cleanup();
		}
	});

	it("attributes nested Extension API activation to its source and parent handler", async () => {
		const calls: MutationInterceptionCall[] = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				{
					path: "/extension.ts",
					factory: (pi) => {
						pi.registerTool({
							name: "sample",
							label: "sample",
							description: "sample",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
						pi.on("before_agent_start", () => {
							pi.setActiveTools(["sample"]);
						});
					},
				},
			],
			process.cwd(),
		);
		extensionsResult.runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: recordingInterceptor(calls),
		};
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["sample"],
		});
		try {
			harness.setResponses([() => fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			const parent = calls.find(
				(call) =>
					call.operation === "before_agent_start" &&
					call.phase === "before" &&
					call.sourceInfo?.path === "/extension.ts",
			);
			const active = calls.find(
				(call) => call.operation === "active_tools" && call.phase === "before" && call.reason === "extension_api",
			);
			expect(active?.sourceInfo?.path).toBe("/extension.ts");
			expect(active?.parentCallId).toBe(parent?.callId);
		} finally {
			harness.cleanup();
		}
	});

	it("attributes handler-selected active tools to the changing handler", async () => {
		const calls: MutationInterceptionCall[] = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				{
					path: "/handler-selection.ts",
					factory: (pi) => {
						pi.registerTool({
							name: "sample",
							label: "sample",
							description: "sample",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
						pi.on("before_agent_start", (event) => {
							event.systemPromptOptions.selectedTools = ["sample"];
						});
					},
				},
			],
			process.cwd(),
		);
		extensionsResult.runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: recordingInterceptor(calls),
		};
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["read"],
		});
		try {
			harness.setResponses([() => fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			const parent = calls.find(
				(call) =>
					call.operation === "before_agent_start" &&
					call.phase === "before" &&
					call.sourceInfo?.path === "/handler-selection.ts",
			);
			const active = calls.find(
				(call) =>
					call.operation === "active_tools" && call.phase === "before" && call.reason === "handler_selection",
			);
			expect(active?.sourceInfo?.path).toBe("/handler-selection.ts");
			expect(active?.parentCallId).toBe(parent?.callId);
			expect(
				(
					calls.find(
						(call) =>
							call.operation === "active_tools" &&
							call.phase === "applied" &&
							call.reason === "handler_selection",
					)?.value as MutationActiveToolsContext
				).activeTools,
			).toEqual(["sample"]);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["before", "candidate"] as const)(
		"attributes trusted %s-phase selected-tool changes to the current handler",
		async (phase) => {
			const calls: MutationInterceptionCall[] = [];
			const extensionsResult = await createTestExtensionsResult(
				[
					{
						path: "/trusted-selection.ts",
						factory: (pi) => {
							pi.registerTool({
								name: "sample",
								label: "sample",
								description: "sample",
								parameters: Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
							});
							pi.on("before_agent_start", () => {});
						},
					},
				],
				process.cwd(),
			);
			extensionsResult.runtime.mutationInterceptor = {
				sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
				interceptor: recordingInterceptor(calls, (call) =>
					call.operation === "before_agent_start" && call.phase === phase
						? Object.assign(call.value as MutationSystemToolContext, { selectedTools: ["sample"] })
						: call.value,
				),
			};
			const harness = await createHarness({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				initialActiveToolNames: ["read"],
			});
			try {
				harness.setResponses([() => fauxAssistantMessage("ok")]);
				await harness.session.prompt("hello");
				const parent = calls.find(
					(call) =>
						call.operation === "before_agent_start" &&
						call.phase === "before" &&
						call.sourceInfo?.path === "/trusted-selection.ts",
				);
				const active = calls.find(
					(call) =>
						call.operation === "active_tools" && call.phase === "before" && call.reason === "handler_selection",
				);
				expect(active?.sourceInfo?.path).toBe("/trusted-selection.ts");
				expect(active?.parentCallId).toBe(parent?.callId);
			} finally {
				harness.cleanup();
			}
		},
	);

	it("keeps the earlier attribution when a later handler change is rejected", async () => {
		const calls: MutationInterceptionCall[] = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				{
					path: "/accepted-selection.ts",
					factory: (pi) => {
						pi.registerTool({
							name: "sample",
							label: "sample",
							description: "sample",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
						pi.on("before_agent_start", (event) => {
							event.systemPromptOptions.selectedTools = ["sample"];
						});
					},
				},
				{
					path: "/rejected-selection.ts",
					factory: (pi) => {
						pi.on("before_agent_start", (event) => {
							event.systemPromptOptions.selectedTools = ["read"];
						});
					},
				},
			],
			process.cwd(),
		);
		extensionsResult.runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: recordingInterceptor(calls, (call) =>
				call.operation === "before_agent_start" &&
				call.phase === "candidate" &&
				call.sourceInfo?.path === "/rejected-selection.ts"
					? { ...(call.value as MutationSystemToolContext), selectedTools: ["sample"] }
					: call.value,
			),
		};
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["read"],
		});
		try {
			harness.setResponses([() => fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			const parent = calls.find(
				(call) =>
					call.operation === "before_agent_start" &&
					call.phase === "before" &&
					call.sourceInfo?.path === "/accepted-selection.ts",
			);
			const active = calls.find(
				(call) =>
					call.operation === "active_tools" && call.phase === "before" && call.reason === "handler_selection",
			);
			expect(active?.sourceInfo?.path).toBe("/accepted-selection.ts");
			expect(active?.parentCallId).toBe(parent?.callId);
		} finally {
			harness.cleanup();
		}
	});

	it("does not downgrade a trusted nested Extension API failure to an ordinary handler error", async () => {
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "sample",
					label: "sample",
					description: "sample",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				pi.on("before_agent_start", () => pi.setActiveTools(["sample"]));
			},
		]);
		extensionsResult.runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: recordingInterceptor([], (call) => {
				if (call.operation === "active_tools" && call.phase === "candidate" && call.reason === "extension_api") {
					throw new Error("trusted stop");
				}
				return call.value;
			}),
		};
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["sample"],
		});
		try {
			await expect(harness.session.prompt("hello")).rejects.toThrow("failed at active_tools:candidate");
		} finally {
			harness.cleanup();
		}
	});

	it("does not downgrade a trusted Extension API failure inside prepareLoadout", async () => {
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "sample",
					label: "sample",
					description: "sample",
					parameters: Type.Object({}),
					prepareLoadout: () => {
						pi.setActiveTools(["sample"]);
					},
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		]);
		extensionsResult.runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: recordingInterceptor([], (call) => {
				if (call.operation === "active_tools" && call.phase === "candidate" && call.reason === "extension_api") {
					throw new Error("trusted stop");
				}
				return call.value;
			}),
		};
		await expect(
			createHarness({
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				initialActiveToolNames: ["sample"],
			}),
		).rejects.toThrow("failed at active_tools:candidate");
	});

	it("clears restored pending tools when Extension API deactivates an active tool", async () => {
		let registerFuture: (() => void) | undefined;
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "sample",
					label: "sample",
					description: "sample",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				pi.registerTool({
					name: "mutator",
					label: "mutator",
					description: "mutator",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
				registerFuture = () =>
					pi.registerTool({
						name: "future",
						label: "future",
						description: "future",
						parameters: Type.Object({}),
						defaultActive: false,
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				pi.on("before_agent_start", () => pi.setActiveTools(["sample"]));
			},
		]);
		extensionsResult.runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: recordingInterceptor([]),
		};
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["sample", "mutator", "future"],
		});
		try {
			expect(harness.session.getActiveToolNames()).toEqual(["sample", "mutator"]);
			harness.setResponses([() => fauxAssistantMessage("ok")]);
			await harness.session.prompt("hello");
			expect(harness.session.getActiveToolNames()).toEqual(["sample"]);
			registerFuture?.();
			expect(harness.session.getActiveToolNames()).toEqual(["sample"]);
		} finally {
			harness.cleanup();
		}
	});

	it("restores the built-in registry winner after a conflicting extension is removed", async () => {
		const calls: MutationInterceptionCall[] = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.registerTool({
						name: "read",
						label: "extension read",
						description: "extension winner",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				},
			],
			process.cwd(),
		);
		extensionsResult.runtime.mutationInterceptor = {
			sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
			interceptor: recordingInterceptor(calls),
		};
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: ["read"],
		});
		try {
			expect(harness.session.getToolDefinition("read")?.description).toBe("extension winner");
			extensionsResult.extensions.length = 0;
			await harness.session.reload();
			expect(harness.session.getToolDefinition("read")?.description).not.toBe("extension winner");
			const applied = calls.filter((call) => call.operation === "tool_registry" && call.phase === "applied").at(-1)
				?.value as readonly MutationToolDefinition[];
			expect(applied.find((tool) => tool.name === "read")?.ownerInfo?.source).toBe("builtin");
		} finally {
			harness.cleanup();
		}
	});

	it("applies trusted hidden declarations while retaining inactive deferred callable tools", async () => {
		const calls: MutationInterceptionCall[] = [];
		const harness = await harnessWith(
			recordingInterceptor(calls, (call) => {
				if (call.operation !== "turn_preparation" || call.phase !== "candidate") return call.value;
				return { ...(call.value as object), hiddenTools: ["sample"], appendSystemPrompt: "trusted append" };
			}),
		);
		try {
			let request: TranscriptContext | undefined;
			harness.setResponses([
				(context) => {
					request = context;
					return fauxAssistantMessage("ok");
				},
			]);
			await harness.session.prompt("hello");
			const applied = calls.find((call) => call.operation === "turn_preparation" && call.phase === "applied")
				?.value as MutationSystemToolContext;
			expect(applied.hiddenTools).toContain("sample");
			expect(applied.modelDeclaredTools).not.toContain("sample");
			expect(applied.callableTools).toContain("deferred");
			expect(applied.systemPrompt).toContain("trusted append");
			const system = getCurrentSystemMessage(request?.messages ?? []);
			expect(system?.toolsAdded?.map((tool) => tool.name)).not.toContain("sample");
			expect(getSystemMessageText(system ?? { role: "system", content: "", timestamp: 0 })).toContain(
				"trusted append",
			);
		} finally {
			harness.cleanup();
		}
	});

	it("reports and sends accepted forced prompts including an empty string", async () => {
		const calls: MutationInterceptionCall[] = [];
		const forcedPrompts = ["forced prompt", ""];
		let candidateIndex = 0;
		const harness = await harnessWith(
			recordingInterceptor(calls, (call) => {
				if (call.operation !== "turn_preparation" || call.phase !== "candidate") return call.value;
				return { ...(call.value as object), systemPrompt: forcedPrompts[candidateIndex++] };
			}),
		);
		try {
			const requests: TranscriptContext[] = [];
			harness.setResponses(
				forcedPrompts.map(() => (request: TranscriptContext) => {
					requests.push(request);
					return fauxAssistantMessage("ok");
				}),
			);
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			const applied = calls
				.filter((call) => call.operation === "turn_preparation" && call.phase === "applied")
				.map((call) => (call.value as MutationSystemToolContext).systemPrompt);
			expect(applied).toEqual(forcedPrompts);
			expect(
				requests.map((request) =>
					getSystemMessageText(
						getCurrentSystemMessage(request.messages) ?? { role: "system", content: "", timestamp: 0 },
					),
				),
			).toEqual(forcedPrompts);
		} finally {
			harness.cleanup();
		}
	});

	it("covers every fresh turn and excludes dialogue from trusted values", async () => {
		const calls: MutationInterceptionCall[] = [];
		const harness = await harnessWith(recordingInterceptor(calls));
		try {
			const requests: TranscriptContext[] = [];
			harness.setResponses(
				["one", "two"].map((text) => (request: TranscriptContext) => {
					requests.push(request);
					return fauxAssistantMessage(text);
				}),
			);
			await harness.session.prompt("private dialogue one");
			await harness.session.prompt("private dialogue two");
			const preparations = calls.filter(
				(call) => call.operation === "turn_preparation" && call.phase === "candidate",
			);
			expect(preparations).toHaveLength(2);
			expect(preparations[0].value).toEqual(
				expect.objectContaining({
					appendSystemPrompt: "fixture append",
					contextFiles: [{ path: "/context.md", content: "fixture context" }],
					skills: [expect.objectContaining({ name: "fixture-skill", ownerInfo: expect.any(Object) })],
					toolSnippets: expect.any(Object),
					toolGuidelines: expect.any(Object),
					promptGuidelines: expect.any(Array),
				}),
			);
			expect(
				requests.map(
					(request) =>
						getSystemMessageText(
							getCurrentSystemMessage(request.messages) ?? { role: "system", content: "", timestamp: 0 },
						).length > 0,
				),
			).toEqual([true, true]);
			const exposed = JSON.stringify(calls.map((call) => call.value));
			expect(exposed).not.toContain("private dialogue one");
			expect(exposed).not.toContain("private dialogue two");
		} finally {
			harness.cleanup();
		}
	});
});
