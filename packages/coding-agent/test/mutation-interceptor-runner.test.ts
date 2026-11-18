import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type {
	MutationInterceptEvent,
	MutationInterceptor,
	MutationStage,
} from "../src/core/extensions/mutation-interceptor.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ContextEvent,
	ContextEventResult,
	ContextWithSystemEvent,
	ExtensionAPI,
	ExtensionFactory,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-mutation-runner-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const message = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const stages = ["before_agent_start", "context", "context_with_system", "before_provider_request"] as const;

function onMessages(
	pi: ExtensionAPI,
	stage: "context" | "context_with_system",
	handler: (event: ContextEvent | ContextWithSystemEvent) => ContextEventResult | undefined,
) {
	if (stage === "context") pi.on("context", handler);
	else pi.on("context_with_system", handler);
}

function onStage(pi: ExtensionAPI, stage: (typeof stages)[number], handler: () => void) {
	switch (stage) {
		case "before_agent_start":
			pi.on("before_agent_start", handler);
			break;
		case "context":
			pi.on("context", handler);
			break;
		case "context_with_system":
			pi.on("context_with_system", handler);
			break;
		case "before_provider_request":
			pi.on("before_provider_request", handler);
			break;
	}
}

async function runnerFor(factories: ExtensionFactory[], interceptor?: MutationInterceptor) {
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extensions = await Promise.all(
		factories.map((factory, index) => loadExtensionFromFactory(factory, dir, eventBus, runtime, `inline:${index}`)),
	);
	const sources: SourceInfo[] = extensions.map((extension, index) => {
		const source: SourceInfo = {
			path: extension.path,
			source: "fixture",
			scope: index === 0 ? "project" : "temporary",
			origin: "top-level",
		};
		extension.sourceInfo = source;
		return source;
	});
	if (interceptor)
		runtime.mutationInterceptor = {
			sourceInfo: { path: "fixture:user-interceptor", source: "fixture", scope: "user", origin: "top-level" },
			interceptor,
		};
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner(extensions, runtime, dir, SessionManager.inMemory(), registry);
	return { runner, sources };
}

async function trigger(runner: ExtensionRunner, stage: MutationStage) {
	if (stage === "before_agent_start")
		return runner.emitBeforeAgentStart({ messageType: "user", prompt: "hello" }, { cwd: dir, customPrompt: "base" });
	if (stage === "before_provider_request") return runner.emitBeforeProviderRequest({ value: "base" });
	return runner.emitContext([message("base")]);
}

describe("runner mutation boundaries", () => {
	it("combines in-place and returned prompt changes, snapshots before, propagates replacement state", async () => {
		const seen: MutationInterceptEvent[] = [];
		const next: unknown[] = [];
		const { runner, sources } = await runnerFor(
			[
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.sections.guidance = "in-place";
						return { systemPrompt: "returned" };
					});
					pi.on("before_agent_start", (event, ctx) => {
						next.push(event.systemPromptOptions, ctx.getSystemPrompt());
					});
				},
			],
			(event) => {
				seen.push(event);
				if (seen.length === 1) return event.before;
				return event.after;
			},
		);
		const result = await trigger(runner, "before_agent_start");
		expect(seen).toHaveLength(2);
		expect(seen[0].stage).toBe("before_agent_start");
		expect(seen[0].sourceInfo).toBe(sources[0]);
		if (seen[0].stage !== "before_agent_start") throw new Error("wrong stage");
		expect(seen[0].before.sections.guidance).not.toBe("in-place");
		expect(seen[0].after.sections.guidance).toBe("in-place");
		expect(seen[0].after.forceSystemPrompt).toBe("returned");
		expect(next[0]).toBe(seen[0].before);
		expect(next[1]).toBe(buildSystemPrompt(seen[0].before));
		expect(result).toMatchObject({ systemPromptOptions: seen[0].before });
	});

	it.each(["context", "context_with_system"] as const)(
		"intercepts %s handlers in order, including void returns and in-place edits",
		async (stage) => {
			const seen: MutationInterceptEvent[] = [];
			const next: AgentMessage[][] = [];
			const { runner, sources } = await runnerFor(
				[
					(pi) => {
						onMessages(pi, stage, (event) => {
							event.messages.push(message("in-place"));
						});
						onMessages(pi, stage, (event) => {
							next.push(event.messages);
							return { messages: [message("replacement")] };
						});
					},
					(pi) => {
						onMessages(pi, stage, (event) => {
							next.push(event.messages);
						});
					},
				],
				(event) => {
					seen.push(event);
					return seen.length === 1 ? event.before : event.after;
				},
			);
			const result = await runner.emitContext([message("base")]);
			expect(seen.map((event) => event.stage)).toEqual([stage, stage, stage]);
			expect(seen.map((event) => event.sourceInfo)).toEqual([sources[0], sources[0], sources[1]]);
			expect(seen[0].sourceInfo).toBe(sources[0]);
			expect(seen[2].sourceInfo).toBe(sources[1]);
			expect(seen[0].before).toEqual([message("base")]);
			expect(seen[0].after).toEqual([message("base"), message("in-place")]);
			expect(next[0]).toEqual([message("base")]);
			expect(next[1]).toEqual([message("replacement")]);
			expect(result).toEqual([message("replacement")]);
		},
	);

	it("gives context only conversation and context_with_system the accepted complete transcript", async () => {
		const seen: MutationInterceptEvent[] = [];
		const system: AgentMessage = { role: "system", content: "", sections: { docs: "docs" }, timestamp: 0 };
		const { runner } = await runnerFor(
			[
				(pi) => {
					pi.on("context", () => ({ messages: [message("new")] }));
					pi.on("context_with_system", () => {});
				},
			],
			(event) => {
				seen.push(event);
				return event.after;
			},
		);
		expect(await runner.emitContext([system, message("base")])).toEqual([system, message("new")]);
		expect(seen[0].before).toEqual([message("base")]);
		expect(seen[1].before).toEqual([system, message("new")]);
	});

	it("preserves handler-returned system entries in the context candidate and accepted result", async () => {
		const original: AgentMessage = { role: "system", content: "", sections: { docs: "original" }, timestamp: 0 };
		const injected: AgentMessage = { role: "system", content: "injected", timestamp: 1 };
		let candidate: unknown;
		const { runner } = await runnerFor([(pi) => {
			pi.on("context", () => ({ messages: [injected, message("new")] }));
		}], (event) => { candidate = event.after; return event.after; });
		expect(await runner.emitContext([original, message("base")])).toEqual([original, injected, message("new")]);
		expect(candidate).toEqual([injected, message("new")]);
	});

	it.each([true, false])("reports a missing leading system only for accepted state (revert: %s)", async (revert) => {
		const system: AgentMessage = { role: "system", content: "", sections: { docs: "docs" }, timestamp: 0 };
		const errors = vi.fn();
		const { runner } = await runnerFor([(pi) => {
			pi.on("context_with_system", (event) => ({ messages: revert ? [] : event.messages }));
		}], (event) => revert ? event.before : []);
		runner.onError(errors);
		expect(await runner.emitContext([system, message("base")])).toEqual(revert ? [system, message("base")] : []);
		expect(errors).toHaveBeenCalledTimes(revert ? 0 : 1);
	});

	it("propagates an accepted opaque null payload without restoring the candidate", async () => {
		const seen: unknown[] = [];
		const { runner } = await runnerFor([(pi) => {
			pi.on("before_provider_request", () => ({ rejected: true }));
			pi.on("before_provider_request", (event) => { seen.push(event.payload); });
		}], () => null);
		expect(await runner.emitBeforeProviderRequest({ base: true })).toBeNull();
		expect(seen).toEqual([null]);
	});

	it("intercepts opaque payloads after in-place and returned edits without recursion", async () => {
		const seen: MutationInterceptEvent[] = [];
		const next: unknown[] = [];
		const { runner, sources } = await runnerFor(
			[
				(pi) => {
					pi.on("before_provider_request", (event) => {
						(event.payload as { value: string }).value = "mutated";
					});
					pi.on("before_provider_request", (event) => {
						next.push(event.payload);
						return 42;
					});
					pi.on("before_provider_request", (event) => {
						next.push(event.payload);
					});
				},
			],
			(event) => {
				seen.push(event);
				return seen.length === 1 ? event.before : event.after;
			},
		);
		expect(await trigger(runner, "before_provider_request")).toBe(42);
		expect(seen).toHaveLength(3);
		expect(seen.every((event) => event.stage === "before_provider_request" && event.sourceInfo === sources[0])).toBe(
			true,
		);
		expect(seen[0].before).toEqual({ value: "base" });
		expect(seen[0].after).toEqual({ value: "mutated" });
		expect(next).toEqual([{ value: "base" }, 42]);
	});

	it.each(stages)("propagates interceptor failures outside %s error recovery", async (stage) => {
		let later = false;
		const { runner } = await runnerFor(
			[
				(pi) => {
					onStage(pi, stage, () => {});
					onStage(pi, stage, () => {
						later = true;
					});
				},
			],
			() => {
				throw new Error("interception failed");
			},
		);
		const errors = vi.fn();
		runner.onError(errors);
		await expect(trigger(runner, stage)).rejects.toThrow(`failed at ${stage}`);
		expect(errors).not.toHaveBeenCalled();
		expect(later).toBe(false);
	});

	it.each(stages)("keeps ordinary %s errors recoverable", async (stage) => {
		let intercepted = 0;
		let later = false;
		const { runner } = await runnerFor(
			[
				(pi) => {
					onStage(pi, stage, () => {
						throw new Error("ordinary error");
					});
					onStage(pi, stage, () => {
						later = true;
					});
				},
			],
			(event) => {
				intercepted++;
				return event.after;
			},
		);
		const errors = vi.fn();
		runner.onError(errors);
		await trigger(runner, stage);
		expect(errors).toHaveBeenCalledOnce();
		expect(later).toBe(true);
		expect(intercepted).toBe(1);
	});

	it("fails closed with attributed cause before running a handler on noncloneable payloads", async () => {
		const handler = vi.fn();
		const interceptor = vi.fn((event: MutationInterceptEvent) => event.after);
		const { runner, sources } = await runnerFor(
			[
				(pi) => {
					pi.on("before_provider_request", handler);
				},
			],
			interceptor,
		);
		const failure = await runner.emitBeforeProviderRequest({ callback() {} }).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		if (!(failure instanceof Error)) throw new Error("expected snapshot failure");
		expect(failure.message).toContain(`failed at before_provider_request for ${sources[0].path}`);
		expect(failure.message).toContain("fixture:user-interceptor");
		expect(failure.cause).toMatchObject({ name: "DataCloneError" });
		expect(handler).not.toHaveBeenCalled();
		expect(interceptor).not.toHaveBeenCalled();
	});

	it("does not return an in-place rejected payload when the interceptor returns undefined", async () => {
		let later = false;
		const { runner } = await runnerFor(
			[
				(pi) => {
					pi.on("before_provider_request", (event) => {
						(event.payload as { value: string }).value = "rejected";
					});
					pi.on("before_provider_request", () => {
						later = true;
					});
				},
			],
			() => undefined,
		);
		await expect(runner.emitBeforeProviderRequest({ value: "base" })).rejects.toThrow(
			"failed at before_provider_request",
		);
		expect(later).toBe(false);
	});

	it("propagates a fresh replacement array to the next handler", async () => {
		const seen: AgentMessage[][] = [];
		const { runner } = await runnerFor(
			[
				(pi) => {
					pi.on("context", () => ({ messages: [message("candidate")] }));
					pi.on("context", (event) => {
						seen.push(event.messages);
					});
				},
			],
			(event) => (event.stage === "context" ? [] : event.after),
		);
		expect(await runner.emitContext([message("base")])).toEqual([]);
		expect(seen).toEqual([[]]);
	});

	it("makes no new snapshots without registration and retains existing provider behavior", async () => {
		const { runner } = await runnerFor([
			(pi) => {
				pi.on("before_provider_request", () => undefined);
				pi.on("before_agent_start", () => ({ systemPrompt: "unchanged behavior" }));
			},
		]);
		const clone = vi.spyOn(globalThis, "structuredClone");
		try {
			const payload = { callback() {} };
			expect(await runner.emitBeforeProviderRequest(payload)).toBe(payload);
			await trigger(runner, "before_agent_start");
			expect(clone).not.toHaveBeenCalled();
		} finally {
			clone.mockRestore();
		}
	});
});
