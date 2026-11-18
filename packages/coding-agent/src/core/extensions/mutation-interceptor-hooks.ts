import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ResourceLoader } from "../resource-loader.ts";
import type { SystemPromptSections } from "../system-prompt.ts";
import { BUILTIN_SYSTEM_PROMPT_SOURCE, invokeMutationInterceptor, snapshotMutationState, type MutationInterceptEvent, type MutationStage, type MutationStateByStage } from "./mutation-interceptor.ts";
import type { Extension, ExtensionError, ExtensionRuntime } from "./types.ts";

type HandlerStage = Exclude<MutationStage, "context" | "system_prompt_sections">;

export function beginMutation<S extends HandlerStage>(runtime: ExtensionRuntime, stage: S, ext: Extension, state: MutationStateByStage[S]) {
	const registration = runtime.mutationInterceptor;
	if (!registration) return undefined;
	const before = snapshotMutationState(registration, stage, ext.sourceInfo, state);
	const hadLeadingSystem = stage === "context_with_system" && (state as AgentMessage[])[0]?.role === "system";
	let succeeded = false;
	return {
		succeed() { succeeded = true; },
		finish(after: MutationStateByStage[S], report?: (error: ExtensionError) => void): MutationStateByStage[S] {
			if (!succeeded) return after;
			const accepted = invokeMutationInterceptor(registration, { stage, sourceInfo: ext.sourceInfo, before, after } as MutationInterceptEvent) as MutationStateByStage[S];
			if (hadLeadingSystem && (accepted as AgentMessage[])[0]?.role !== "system") {
				report?.({ extensionPath: ext.path, event: "context_with_system", error: "Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage()." });
			}
			return accepted;
		},
	};
}

export function contextMutation(runtime: ExtensionRuntime, ext: Extension, current: AgentMessage[], restore: (current: AgentMessage[], visible: AgentMessage[], returned: AgentMessage[]) => AgentMessage[]) {
	const registration = runtime.mutationInterceptor;
	if (!registration) return undefined;
	const before = snapshotMutationState(registration, "context", ext.sourceInfo, current.filter((message) => message.role !== "system"));
	let candidate: { visible: AgentMessage[]; after: AgentMessage[] } | undefined;
	return {
		capture(visible: AgentMessage[], after: AgentMessage[]) { candidate = { visible, after }; },
		finish(after: AgentMessage[]): AgentMessage[] {
			if (!candidate) return after;
			const accepted = invokeMutationInterceptor(registration, { stage: "context", sourceInfo: ext.sourceInfo, before, after: candidate.after });
			return restore(current, candidate.visible, accepted);
		},
	};
}

export function interceptSections(loader: ResourceLoader, messages: AgentMessage[], after: SystemPromptSections): SystemPromptSections {
	const registration = loader.getExtensions().runtime.mutationInterceptor;
	if (!registration) return after;
	// Replaying system messages has already removed null section patches.
	const previous = getCurrentSystemMessage(messages)?.sections ?? {};
	const before = snapshotMutationState(registration, "system_prompt_sections", BUILTIN_SYSTEM_PROMPT_SOURCE, previous) as SystemPromptSections;
	return invokeMutationInterceptor(registration, { stage: "system_prompt_sections", sourceInfo: BUILTIN_SYSTEM_PROMPT_SOURCE, before, after });
}
