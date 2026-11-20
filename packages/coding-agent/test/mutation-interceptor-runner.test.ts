import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	getCurrentSystemMessage,
	getSystemMessageText,
	normalizeContext,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type {
	MutationInterceptionCall,
	MutationInterceptor,
	MutationObservationCall,
} from "../src/core/extensions/mutation-interceptor.ts";
import type { MutationProviderContext } from "../src/core/extensions/mutation-interceptor-hooks.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-mutation-runner-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runnerFor(factory: ExtensionFactory, interceptor: MutationInterceptor) {
	const runtime = createExtensionRuntime();
	runtime.mutationInterceptor = {
		sourceInfo: { path: "/hook.ts", source: "fixture", scope: "user", origin: "top-level" },
		interceptor,
	};
	const extension = await loadExtensionFromFactory(factory, dir, createEventBus(), runtime, "inline:fixture");
	extension.sourceInfo = { path: extension.path, source: "fixture", scope: "temporary", origin: "top-level" };
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return new ExtensionRunner([extension], runtime, dir, sessionManager, modelRegistry);
}

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

describe("runner trusted mutation boundaries", () => {
	it("projects only provider system/tool context and restores unrelated payload fields", async () => {
		const calls: MutationInterceptionCall[] = [];
		const runner = await runnerFor(
			(pi) => {
				pi.on("before_provider_request", (event) => ({
					...(event.payload as Record<string, unknown>),
					system: "ordinary",
					apiKey: "ordinary-secret",
				}));
			},
			recordingInterceptor(calls, (call) => {
				if (call.operation !== "before_provider_request" || call.phase !== "candidate") return call.value;
				const projection = call.value as MutationProviderContext;
				return {
					...projection,
					fields: { ...projection.fields, system: "accepted" },
					systemMessages: projection.systemMessages.map((message) => ({
						...message,
						content: "accepted message",
					})),
				};
			}),
		);
		const payload = {
			system: "base",
			apiKey: "private",
			messages: [
				{
					role: "system",
					content: "system",
					timestamp: 1,
					sessionMetadata: "system-message-private-metadata",
				},
				{ role: "user", content: "user-secret", timestamp: 1 },
			],
		};
		const result = (await runner.emitBeforeProviderRequest(payload)) as typeof payload;
		expect(result.system).toBe("accepted");
		expect(result.apiKey).toBe("ordinary-secret");
		expect(result.messages[0]).toEqual({
			role: "system",
			content: "accepted message",
			timestamp: 1,
			sessionMetadata: "system-message-private-metadata",
		});
		expect(result.messages[1].content).toBe("user-secret");
		const exposed = JSON.stringify(calls.map((call) => call.value));
		expect(exposed).not.toContain("user-secret");
		expect(exposed).not.toContain("apiKey");
		expect(exposed).not.toContain("system-message-private-metadata");
		expect(exposed).not.toContain("timestamp");
		expect(calls.some((call) => call.operation === "final_provider_context")).toBe(true);
	});

	it("projects real Responses and Google provider fields without changing identity payloads", async () => {
		const calls: MutationInterceptionCall[] = [];
		const runner = await runnerFor(
			() => {},
			recordingInterceptor(calls, (call) => {
				if (call.operation !== "final_provider_context" || call.phase !== "candidate") return call.value;
				const projection = call.value as MutationProviderContext;
				return {
					...projection,
					fields: {
						...projection.fields,
						...(Array.isArray(projection.fields.system)
							? { system: [{ type: "text", text: "accepted-system" }] }
							: {}),
						...(projection.fields["config.systemInstruction"] !== undefined
							? { "config.systemInstruction": "accepted-google" }
							: {}),
					},
				};
			}),
		);
		const anthropic = {
			system: [{ type: "text", text: "anthropic-system", cache_control: "private-cache-metadata" }],
			messages: [{ role: "user", content: "anthropic-secret" }],
		};
		const anthropicResult = (await runner.emitBeforeProviderRequest(anthropic)) as typeof anthropic;
		expect(anthropicResult.system).toEqual([
			{ type: "text", text: "accepted-system", cache_control: "private-cache-metadata" },
		]);
		const responses = {
			input: [
				{ role: "system", content: "responses-system" },
				{ role: "user", content: "responses-secret" },
			],
			tools: [{ type: "function", name: "sample" }],
			tool_choice: "auto",
			apiKey: "responses-key",
		};
		const responsesResult = await runner.emitBeforeProviderRequest(responses);
		expect(responsesResult).toEqual(responses);
		const google = {
			contents: [{ role: "user", parts: [{ text: "google-secret" }] }],
			config: {
				systemInstruction: "google-system",
				tools: [{ functionDeclarations: [{ name: "sample" }] }],
				toolConfig: { functionCallingConfig: { mode: "AUTO" } },
				abortSignal: "private-signal",
			},
			apiKey: "google-key",
		};
		const googleResult = (await runner.emitBeforeProviderRequest(google)) as typeof google;
		expect(googleResult.config.systemInstruction).toBe("accepted-google");
		expect(googleResult.config.abortSignal).toBe("private-signal");
		expect(googleResult.contents).toEqual(google.contents);
		const exposed = JSON.stringify(calls.map((call) => call.value));
		expect(exposed).not.toContain("anthropic-secret");
		expect(exposed).not.toContain("private-cache-metadata");
		expect(exposed).not.toContain("responses-secret");
		expect(exposed).not.toContain("responses-key");
		expect(exposed).not.toContain("google-secret");
		expect(exposed).not.toContain("google-key");
		expect(exposed).not.toContain("private-signal");
	});

	it("removes provider instructions and applies tools-only late mutations without changing unrelated payload", async () => {
		const runner = await runnerFor(
			() => {},
			recordingInterceptor([], (call) => {
				if (call.operation !== "final_provider_context" || call.phase !== "candidate") return call.value;
				const projection = call.value as MutationProviderContext;
				const { system: _system, ...fields } = projection.fields;
				projection.fields = { ...fields, tools: [{ name: "accepted" }] };
				return projection;
			}),
		);
		const result = (await runner.emitBeforeProviderRequest({
			system: "remove me",
			tools: [{ name: "original" }],
			metadata: { secret: "preserved outside projection" },
		})) as Record<string, unknown>;
		expect(result).not.toHaveProperty("system");
		expect(result.tools).toEqual([{ name: "accepted" }]);
		expect(result.metadata).toEqual({ secret: "preserved outside projection" });
	});

	it("preserves normalized meaning and dialogue when the trusted candidate is unchanged", async () => {
		const runner = await runnerFor(() => {}, {
			intercept<T>(call: MutationInterceptionCall<T>): T {
				return call.value;
			},
			observe(): void {},
		});
		const context = {
			messages: [
				{ role: "system", content: "first", timestamp: 1 },
				{ role: "user", content: "private dialogue", timestamp: 2 },
				{ role: "system", content: "second", timestamp: 3 },
			],
		} as TranscriptContext;
		const result = runner.emitNormalizedFinal(context);
		expect(getSystemMessageText(getCurrentSystemMessage(result.messages)!)).toBe("first\n\nsecond");
		expect(result.messages.find((message) => message.role === "user")).toBe(context.messages[1]);
	});

	it("accepts an explicitly empty normalized system/tool context without removing dialogue", async () => {
		const runner = await runnerFor(
			() => {},
			recordingInterceptor([], (call) =>
				call.operation === "normalized_context" && call.phase === "candidate"
					? { systemInstructions: "", tools: [] }
					: call.value,
			),
		);
		const result = runner.emitNormalizedFinal(
			normalizeContext({
				systemPrompt: "remove me",
				tools: [{ name: "sample", description: "sample", parameters: Type.Object({}) }],
				messages: [{ role: "user", content: "private dialogue", timestamp: 1 }],
			}),
		);
		expect(getCurrentSystemMessage(result.messages)).toBeUndefined();
		expect(result.messages).toEqual([{ role: "user", content: "private dialogue", timestamp: 1 }]);
	});

	it("replaces normalized system/tool context and emits one FINAL per provider attempt", async () => {
		const calls: MutationInterceptionCall[] = [];
		const observations: MutationObservationCall[] = [];
		const runner = await runnerFor(
			() => {},
			recordingInterceptor(
				calls,
				(call) => {
					if (call.operation !== "normalized_context" || call.phase !== "candidate") return call.value;
					const value = call.value as { systemInstructions: string; tools: readonly unknown[] };
					value.systemInstructions = `${value.systemInstructions}\nTrusted final.`;
					return value;
				},
				observations,
			),
		);
		const context: TranscriptContext = normalizeContext({
			messages: [
				{ role: "system", content: "base", timestamp: 1 },
				{ role: "user", content: "private dialogue", timestamp: 1 },
			],
		});
		const first = runner.emitNormalizedFinal(context);
		await runner.emitBeforeProviderRequest({ system: "first" });
		const second = runner.emitNormalizedFinal(context);
		await runner.emitBeforeProviderRequest({ system: "second" });
		for (const result of [first, second]) {
			expect(getSystemMessageText(getCurrentSystemMessage(result.messages)!)).toContain("Trusted final.");
			expect(result.messages.some((message) => message.role === "user")).toBe(true);
		}
		const finals = observations.filter((call) => call.operation === "final_context" && call.outcome === "final");
		expect(finals).toHaveLength(2);
		expect(new Set(finals.map((call) => call.providerAttemptId)).size).toBe(2);
		const providerAttempts = calls
			.filter((call) => call.operation === "final_provider_context" && call.phase === "candidate")
			.map((call) => call.providerAttemptId);
		expect(providerAttempts).toEqual(finals.map((call) => call.providerAttemptId));
		expect(JSON.stringify(calls.map((call) => call.value))).not.toContain("private dialogue");
	});

	it("reports empty handler sets as factual skipped outcomes", async () => {
		const observations: MutationObservationCall[] = [];
		const runner = await runnerFor(() => {}, recordingInterceptor([], undefined, observations));
		await runner.emitContext([{ role: "system", content: "system", timestamp: 1 }]);
		await runner.emitResourcesDiscover(dir, "startup");
		await runner.emitBeforeProviderRequest({ system: "system" });
		expect(
			observations
				.filter((call) => call.outcome === "skipped")
				.map((call) => call.operation)
				.sort(),
		).toEqual(["before_provider_request", "context", "context_with_system", "resources_discover"]);
	});

	it("reports ordinary handler errors while intercepting the retained stable state", async () => {
		const calls: MutationInterceptionCall[] = [];
		const runner = await runnerFor((pi) => {
			pi.on("context_with_system", () => {
				throw new Error("ordinary failed");
			});
		}, recordingInterceptor(calls));
		const messages: AgentMessage[] = [
			{ role: "system", content: "system", timestamp: 1 },
			{ role: "user", content: "private dialogue", timestamp: 1 },
		];
		const result = await runner.emitContext(messages);
		expect(result.map((message) => [message.role, "content" in message ? message.content : null])).toEqual([
			["system", "system"],
			["user", "private dialogue"],
		]);
		const operationCalls = calls.filter((call) => call.operation === "context_with_system");
		expect(operationCalls.map((call) => call.phase)).toEqual(["before", "candidate", "applied"]);
		expect(operationCalls[1].error).toEqual({ type: "error" });
		expect(JSON.stringify(operationCalls)).not.toContain("private dialogue");
	});

	it("lets the trusted hook supply a resource candidate after an ordinary error", async () => {
		const calls: MutationInterceptionCall[] = [];
		const runner = await runnerFor(
			(pi) => {
				pi.on("resources_discover", () => {
					throw new Error("discovery failed");
				});
			},
			recordingInterceptor(calls, (call) => {
				if (call.operation === "resources_discover" && call.phase === "candidate") {
					return { skillPaths: ["/accepted/SKILL.md"], promptPaths: [], themePaths: [] };
				}
				return call.value;
			}),
		);
		const result = await runner.emitResourcesDiscover(dir, "startup");
		expect(result.skillPaths).toEqual([{ path: "/accepted/SKILL.md", extensionPath: "inline:fixture" }]);
		expect(
			calls.find((call) => call.operation === "resources_discover" && call.phase === "candidate")?.error,
		).toEqual({ type: "error" });
	});
});
