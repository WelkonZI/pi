import {
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BUILTIN_SYSTEM_PROMPT_SOURCE } from "../src/core/extensions/mutation-interceptor.ts";
import { buildSystemPromptSections, type SystemPromptSections } from "../src/core/system-prompt.ts";
import type { MutationInterceptEvent, MutationInterceptor } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

async function harnessWith(interceptor: MutationInterceptor) {
	const resourceLoader = createTestResourceLoader();
	resourceLoader.getExtensions().runtime.mutationInterceptor = {
		sourceInfo: { path: "fixture:user-interceptor", source: "fixture", scope: "user", origin: "top-level" },
		interceptor,
	};
	return createHarness({ resourceLoader });
}

describe("system prompt section interception", () => {
	it("omits docs before persistence and provider projection while preserving other sections", async () => {
		const seen: MutationInterceptEvent[] = [];
		const proposed: SystemPromptSections[] = [];
		const harness = await harnessWith((event) => {
			seen.push(event);
			if (event.stage === "system_prompt_sections") {
				proposed.push({ ...event.after });
				delete event.after.docs;
			}
			return event.after;
		});
		try {
			const requests: TranscriptContext[] = [];
			harness.setResponses(
				["one", "two"].map((text) => (request: TranscriptContext) => {
					requests.push(request);
					return fauxAssistantMessage(text);
				}),
			);
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			expect(seen).toHaveLength(2);
			expect(
				seen.every(
					(event) => event.stage === "system_prompt_sections" && event.sourceInfo === BUILTIN_SYSTEM_PROMPT_SOURCE,
				),
			).toBe(true);
			expect(seen[0].before).toEqual({});
			const { docs, ...accepted } = proposed[0];
			expect(docs).toBeTruthy();
			expect(seen[1].before).toEqual(accepted);
			expect(getCurrentSystemMessage(harness.session.messages)?.sections).toEqual(accepted);
			expect(requests.map((request) => getCurrentSystemMessage(request.messages)?.sections)).toEqual([
				accepted,
				accepted,
			]);
			const persisted = harness.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "system" ? [entry.message] : []));
			expect(persisted).toHaveLength(1);
			expect(persisted[0].sections).toEqual(accepted);
		} finally {
			harness.cleanup();
		}
	});

	it.each(["remove", "replace"] as const)(
		"emits only the docs patch when the interceptor chooses to %s it",
		async (action) => {
			let turn = 0;
			let previous: unknown;
			const replacement = "<docs>Replacement guidance.</docs>";
			const harness = await harnessWith((event) => {
				if (event.stage === "system_prompt_sections" && ++turn === 2) {
					previous = structuredClone(event.before);
					if (action === "remove") delete event.after.docs;
					else return { ...event.after, docs: replacement };
				}
				return event.after;
			});
			try {
				const requests: TranscriptContext[] = [];
				harness.setResponses(
					["one", "two"].map((text) => (request: TranscriptContext) => {
						requests.push(request);
						return fauxAssistantMessage(text);
					}),
				);
				await harness.session.prompt("one");
				const initial = getCurrentSystemMessage(harness.session.messages)?.sections;
				await harness.session.prompt("two");
				expect(previous).toEqual(initial);
				const patches = harness.session.messages.filter((message) => message.role === "system");
				expect(patches).toHaveLength(2);
				expect(patches[1].sections).toEqual({ docs: action === "remove" ? null : replacement });
				const expected = { ...initial };
				if (action === "remove") delete expected.docs;
				else expected.docs = replacement;
				expect(getCurrentSystemMessage(harness.session.messages)?.sections).toEqual(expected);
				expect(getCurrentSystemMessage(requests[1].messages)?.sections).toEqual(expected);
				const persisted = harness.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "system" ? [entry.message.sections] : [],
					);
				expect(persisted).toEqual([initial, patches[1].sections]);
			} finally {
				harness.cleanup();
			}
		},
	);

	it("fails closed before prompt persistence or provider requests", async () => {
		const harness = await harnessWith(() => {
			throw new Error("stop sections");
		});
		try {
			harness.setResponses([fauxAssistantMessage("must not run")]);
			await expect(harness.session.prompt("one")).rejects.toThrow(
				"failed at system_prompt_sections for builtin:system_prompt_sections",
			);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.messages.some((message) => message.role === "system")).toBe(false);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "system"),
			).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("uses unchanged builder output when no interceptor is registered", async () => {
		let expected: SystemPromptSections | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						expected = buildSystemPromptSections(event.systemPromptOptions);
					});
				},
			],
		});
		try {
			harness.setResponses([fauxAssistantMessage("one")]);
			await harness.session.prompt("one");
			expect(expected?.docs).toBeTruthy();
			expect(getCurrentSystemMessage(harness.session.messages)?.sections).toEqual(expected);
			expect(harness.session.systemPrompt).toBe(
				getSystemMessageText({ role: "system", content: "", sections: expected, timestamp: 0 }),
			);
		} finally {
			harness.cleanup();
		}
	});
});
