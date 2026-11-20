import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ResourceLoader } from "../resource-loader.ts";
import type { SourceInfo } from "../source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	type SystemPromptSections,
} from "../system-prompt.ts";
import {
	beginMutationProviderAttempt,
	beginMutation as beginTrustedMutation,
	MUTATION_CALLBACK,
	type MutationCallbackMarker,
	type MutationSystemToolContext,
	type MutationToolDefinition,
	observeMutation,
} from "./mutation-interceptor.ts";
import type { Extension, ExtensionError, ExtensionRuntime, ToolDefinition } from "./types.ts";

type SystemMessage = Extract<AgentMessage, { role: "system" }>;
type HandlerStage = "before_agent_start" | "context_with_system" | "before_provider_request";

interface StableSystemMessage {
	position: number;
	content: unknown;
	sections: Readonly<Record<string, string | null>>;
	toolsAdded: readonly unknown[];
	toolsRemoved: readonly unknown[];
}

export interface MutationProviderSystemMessage {
	container: "messages" | "input";
	position: number;
	role: "system" | "developer";
	content: unknown;
}

export interface MutationProviderContext {
	fields: Readonly<Record<string, unknown>>;
	systemMessages: readonly MutationProviderSystemMessage[];
}

export interface MutationNormalizedContext {
	systemInstructions: string;
	tools: readonly unknown[];
}

function callbackMarker(value: unknown): MutationCallbackMarker | null {
	return typeof value === "function" ? MUTATION_CALLBACK : null;
}

export function projectToolDefinition(
	definition: ToolDefinition,
	ownerInfo: SourceInfo | null,
): MutationToolDefinition {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		promptSnippet: definition.promptSnippet ?? null,
		promptGuidelines: definition.promptGuidelines ?? [],
		exposure: definition.exposure ?? null,
		defaultActive: definition.defaultActive ?? null,
		namespace: definition.namespace ?? null,
		annotations: definition.annotations ?? null,
		execute: MUTATION_CALLBACK,
		prepareArguments: callbackMarker(definition.prepareArguments),
		prepareLoadout: callbackMarker(definition.prepareLoadout),
		reachesTools: callbackMarker(definition.reachesTools),
		ownerInfo,
	};
}

export function applyToolDefinition(definition: ToolDefinition, accepted: MutationToolDefinition): ToolDefinition {
	return {
		...definition,
		name: accepted.name,
		label: accepted.label,
		description: accepted.description,
		parameters: accepted.parameters as ToolDefinition["parameters"],
		promptSnippet: accepted.promptSnippet ?? undefined,
		promptGuidelines: [...accepted.promptGuidelines],
		exposure: (accepted.exposure ?? undefined) as ToolDefinition["exposure"],
		defaultActive: accepted.defaultActive ?? undefined,
		namespace: (accepted.namespace ?? undefined) as ToolDefinition["namespace"],
		annotations: (accepted.annotations ?? undefined) as ToolDefinition["annotations"],
	};
}

function projectSystemMessages(messages: readonly AgentMessage[]): StableSystemMessage[] {
	const projected: StableSystemMessage[] = [];
	for (const [position, message] of messages.entries()) {
		if (message.role !== "system") continue;
		projected.push({
			position,
			content: message.content,
			sections: message.sections ?? {},
			toolsAdded: message.toolsAdded ?? [],
			toolsRemoved: message.toolsRemoved ?? [],
		});
	}
	return projected;
}

function restoreSystemMessages(
	messages: readonly AgentMessage[],
	accepted: readonly StableSystemMessage[],
): AgentMessage[] {
	const templates = messages.filter((message): message is SystemMessage => message.role === "system");
	const restored: AgentMessage[] = messages.filter((message) => message.role !== "system");
	for (const [index, stable] of [...accepted].sort((left, right) => left.position - right.position).entries()) {
		const template = templates[index];
		const message = {
			...(template ?? { role: "system", timestamp: Date.now() }),
			content: stable.content,
			sections: stable.sections,
			toolsAdded: stable.toolsAdded,
			toolsRemoved: stable.toolsRemoved,
		} as SystemMessage;
		restored.splice(Math.min(stable.position, restored.length), 0, message);
	}
	return restored;
}

const providerFieldPaths = [
	["system", "system"],
	["systemPrompt", "systemPrompt"],
	["instructions", "instructions"],
	["tools", "tools"],
	["toolChoice", "toolChoice"],
	["tool_choice", "tool_choice"],
	["config.systemInstruction", "config", "systemInstruction"],
	["config.tools", "config", "tools"],
	["config.toolConfig", "config", "toolConfig"],
] as const;

const providerInstructionFields = new Set(["system", "systemPrompt", "instructions", "config.systemInstruction"]);

function providerSystemMessage(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const role = (value as Record<string, unknown>).role;
	return role === "system" || role === "developer";
}

function projectProviderInstructionContent(value: unknown): unknown {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return null;
	const projected: unknown[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			projected.push(item);
			continue;
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		const stable: Record<string, string> = {};
		if (typeof record.type === "string") stable.type = record.type;
		if (typeof record.text === "string") stable.text = record.text;
		if (Object.keys(stable).length > 0) projected.push(stable);
	}
	return projected;
}

function restoreProviderInstructionContent(original: unknown, accepted: unknown): unknown {
	const stable = projectProviderInstructionContent(accepted);
	if (!Array.isArray(stable)) return stable;
	const originalItems = Array.isArray(original) ? original : [];
	return stable.map((item, index) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
		const template = originalItems[index];
		return typeof template === "object" && template !== null && !Array.isArray(template)
			? { ...(template as Record<string, unknown>), ...item }
			: item;
	});
}

function projectProviderInstruction(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return projectProviderInstructionContent(value);
	}
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.parts)) return projectProviderInstructionContent(value);
	return {
		...(typeof record.role === "string" ? { role: record.role } : {}),
		parts: projectProviderInstructionContent(record.parts),
	};
}

function restoreProviderInstruction(original: unknown, accepted: unknown): unknown {
	if (
		typeof original === "object" &&
		original !== null &&
		!Array.isArray(original) &&
		typeof accepted === "object" &&
		accepted !== null &&
		!Array.isArray(accepted) &&
		Array.isArray((accepted as Record<string, unknown>).parts)
	) {
		const originalRecord = original as Record<string, unknown>;
		const acceptedRecord = accepted as Record<string, unknown>;
		return {
			...originalRecord,
			...(typeof acceptedRecord.role === "string" ? { role: acceptedRecord.role } : {}),
			parts: restoreProviderInstructionContent(originalRecord.parts, acceptedRecord.parts),
		};
	}
	return restoreProviderInstructionContent(original, accepted);
}

function projectProviderPayload(payload: unknown): MutationProviderContext {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return { fields: {}, systemMessages: [] };
	}
	const record = payload as Record<string, unknown>;
	const fields: Record<string, unknown> = {};
	for (const [name, first, second] of providerFieldPaths) {
		if (second === undefined) {
			if (first in record) {
				fields[name] = providerInstructionFields.has(name)
					? projectProviderInstruction(record[first])
					: record[first];
			}
			continue;
		}
		const parent = record[first];
		if (typeof parent === "object" && parent !== null && !Array.isArray(parent) && second in parent) {
			const value = (parent as Record<string, unknown>)[second];
			fields[name] = providerInstructionFields.has(name) ? projectProviderInstruction(value) : value;
		}
	}
	const systemMessages: MutationProviderSystemMessage[] = [];
	for (const container of ["messages", "input"] as const) {
		const messages = record[container];
		if (!Array.isArray(messages)) continue;
		for (const [position, value] of messages.entries()) {
			if (!providerSystemMessage(value)) continue;
			const record = value as Record<string, unknown>;
			systemMessages.push({
				container,
				position,
				role: record.role as "system" | "developer",
				content: projectProviderInstructionContent(record.content),
			});
		}
	}
	return { fields, systemMessages };
}

function restoreProviderMessages(
	original: readonly unknown[],
	projected: readonly MutationProviderSystemMessage[],
	accepted: readonly MutationProviderSystemMessage[],
	container: "messages" | "input",
): unknown[] {
	const restored = original.filter((value) => !providerSystemMessage(value));
	for (const message of accepted
		.filter((value) => value.container === container)
		.sort((left, right) => left.position - right.position)) {
		const template = original[message.position];
		const templateRecord =
			typeof template === "object" && template !== null && !Array.isArray(template)
				? (template as Record<string, unknown>)
				: {};
		const previous = projected.find((value) => value.container === container && value.position === message.position);
		const content =
			previous?.content === null && message.content === null
				? templateRecord.content
				: restoreProviderInstructionContent(templateRecord.content, message.content);
		restored.splice(Math.min(message.position, restored.length), 0, {
			...templateRecord,
			role: message.role === "developer" ? "developer" : "system",
			content,
		});
	}
	return restored;
}

function restoreProviderPayload(
	payload: unknown,
	projected: MutationProviderContext,
	accepted: MutationProviderContext,
): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
	const restored = { ...(payload as Record<string, unknown>) };
	for (const [, first, second] of providerFieldPaths) {
		if (second === undefined) {
			delete restored[first];
			continue;
		}
		const parent = restored[first];
		if (typeof parent === "object" && parent !== null && !Array.isArray(parent)) {
			restored[first] = { ...(parent as Record<string, unknown>) };
			delete (restored[first] as Record<string, unknown>)[second];
		}
	}
	for (const [name, value] of Object.entries(accepted.fields)) {
		const path = providerFieldPaths.find(([candidate]) => candidate === name);
		if (!path) continue;
		const [, first, second] = path;
		const originalParent = (payload as Record<string, unknown>)[first];
		const originalValue =
			second === undefined
				? originalParent
				: typeof originalParent === "object" && originalParent !== null && !Array.isArray(originalParent)
					? (originalParent as Record<string, unknown>)[second]
					: undefined;
		const restoredValue =
			providerInstructionFields.has(name) && !(projected.fields[name] === null && value === null)
				? restoreProviderInstruction(originalValue, value)
				: projected.fields[name] === null && value === null
					? originalValue
					: value;
		if (second === undefined) {
			restored[first] = restoredValue;
			continue;
		}
		const parent = restored[first];
		restored[first] =
			typeof parent === "object" && parent !== null && !Array.isArray(parent)
				? { ...(parent as Record<string, unknown>), [second]: restoredValue }
				: { [second]: restoredValue };
	}
	for (const container of ["messages", "input"] as const) {
		const messages = restored[container];
		if (Array.isArray(messages)) {
			restored[container] = restoreProviderMessages(
				messages,
				projected.systemMessages,
				accepted.systemMessages,
				container,
			);
		}
	}
	return restored;
}

function projectHandlerState(stage: HandlerStage, state: unknown): unknown {
	if (stage === "context_with_system") return projectSystemMessages(state as AgentMessage[]);
	if (stage === "before_provider_request") return projectProviderPayload(state);
	return state;
}

function restoreHandlerState(stage: HandlerStage, state: unknown, accepted: unknown): unknown {
	if (stage === "context_with_system") {
		return restoreSystemMessages(state as AgentMessage[], accepted as StableSystemMessage[]);
	}
	if (stage === "before_provider_request") {
		return restoreProviderPayload(state, projectProviderPayload(state), accepted as MutationProviderContext);
	}
	return accepted;
}

export function beginMutation<S>(runtime: ExtensionRuntime, stage: HandlerStage, ext: Extension, state: S) {
	const selectedToolsBefore =
		stage === "before_agent_start" ? [...(state as NormalizedBuildSystemPromptOptions).selectedTools] : undefined;
	const before = projectHandlerState(stage, state);
	const mutation = beginTrustedMutation(runtime, stage, before, {
		sourceInfo: ext.sourceInfo,
		ownerInfo: ext.sourceInfo,
	});
	if (!mutation) return undefined;
	const hadLeadingSystem = stage === "context_with_system" && (state as AgentMessage[])[0]?.role === "system";
	let error: unknown;
	return {
		fail(cause: unknown): void {
			error = cause;
		},
		finish(after: S, report?: (error: ExtensionError) => void): S {
			const accepted = mutation.candidate(projectHandlerState(stage, after), error);
			const restored = restoreHandlerState(stage, after, accepted) as S;
			mutation.applied(
				projectHandlerState(stage, restored),
				error === undefined ? "applied" : "retained_after_error",
				error,
			);
			if (stage === "before_agent_start") {
				const previous = selectedToolsBefore ?? [];
				const selected = (restored as NormalizedBuildSystemPromptOptions).selectedTools;
				if (selected.length !== previous.length || selected.some((tool, index) => tool !== previous[index])) {
					runtime.mutationActiveContribution = { callId: mutation.callId, sourceInfo: ext.sourceInfo };
				}
			}
			if (hadLeadingSystem && (restored as AgentMessage[])[0]?.role !== "system") {
				report?.({
					extensionPath: ext.path,
					event: "context_with_system",
					error: "Handler removed the leading system message; the request has no prompt or initial tool declarations. Keep it at index 0 or replace a dropped prefix with getCurrentSystemMessage().",
				});
			}
			return restored;
		},
	};
}

export function contextMutation(
	runtime: ExtensionRuntime,
	ext: Extension,
	current: AgentMessage[],
	restore: (current: AgentMessage[], visible: AgentMessage[], returned: AgentMessage[]) => AgentMessage[],
) {
	const mutation = beginTrustedMutation(runtime, "context", projectSystemMessages(current), {
		sourceInfo: ext.sourceInfo,
		ownerInfo: ext.sourceInfo,
	});
	if (!mutation) return undefined;
	let candidate: { visible: AgentMessage[]; after: AgentMessage[] } | undefined;
	let error: unknown;
	return {
		capture(visible: AgentMessage[], after: AgentMessage[]): void {
			candidate = { visible, after };
		},
		fail(cause: unknown): void {
			error = cause;
		},
		finish(after: AgentMessage[]): AgentMessage[] {
			const currentState = candidate ? restore(current, candidate.visible, candidate.after) : after;
			const accepted = mutation.candidate(projectSystemMessages(currentState), error);
			const restored = restoreSystemMessages(currentState, accepted);
			mutation.applied(
				projectSystemMessages(restored),
				error === undefined ? "applied" : "retained_after_error",
				error,
			);
			return restored;
		},
	};
}

export function interceptSections(
	loader: ResourceLoader,
	messages: AgentMessage[],
	after: SystemPromptSections,
): SystemPromptSections {
	const runtime = loader.getExtensions().runtime;
	const previous: Readonly<Record<string, string | null>> = getCurrentSystemMessage(messages)?.sections ?? {};
	const mutation = beginTrustedMutation(runtime, "system_prompt_sections", previous, { reason: "turn_preparation" });
	if (!mutation) return after;
	const accepted = mutation.candidate(after);
	const applied = Object.fromEntries(
		Object.entries(accepted).filter((entry): entry is [string, string] => entry[1] !== null),
	);
	mutation.applied(applied);
	return applied;
}

function projectNormalizedContext(context: TranscriptContext): MutationNormalizedContext {
	const system = getCurrentSystemMessage(context.messages);
	return {
		systemInstructions: system ? getSystemMessageText(system) : "",
		tools: system?.toolsAdded ?? [],
	};
}

function restoreNormalizedContext(context: TranscriptContext, accepted: MutationNormalizedContext): TranscriptContext {
	const messages = context.messages.filter((message) => message.role !== "system");
	if (accepted.systemInstructions.length === 0 && accepted.tools.length === 0) return { ...context, messages };
	const previous = getCurrentSystemMessage(context.messages);
	const system: SystemMessage = {
		role: "system",
		content: accepted.systemInstructions,
		...(accepted.tools.length > 0 ? { toolsAdded: accepted.tools as SystemMessage["toolsAdded"] } : {}),
		timestamp: previous?.timestamp ?? 0,
	};
	return { ...context, messages: [system, ...messages] };
}

export function interceptNormalizedFinal(runtime: ExtensionRuntime, context: TranscriptContext): TranscriptContext {
	const providerAttemptId = beginMutationProviderAttempt(runtime);
	const before = projectNormalizedContext(context);
	const mutation = beginTrustedMutation(runtime, "normalized_context", before, {
		reason: "provider_boundary",
		providerAttemptId,
	});
	if (!mutation) return context;
	const accepted = mutation.candidate(before);
	const restored = restoreNormalizedContext(context, accepted);
	const applied = projectNormalizedContext(restored);
	mutation.applied(applied);
	observeMutation(runtime, "final_context", "final", applied, {
		reason: "normalized_common",
		providerAttemptId,
	});
	return restored;
}

export function interceptFinalProviderPayload(runtime: ExtensionRuntime, payload: unknown): unknown {
	const projected = projectProviderPayload(payload);
	const mutation = beginTrustedMutation(runtime, "final_provider_context", projected, {
		reason: "provider_boundary",
	});
	if (!mutation) return payload;
	const accepted = mutation.candidate(projected);
	const restored = restoreProviderPayload(payload, projected, accepted);
	mutation.applied(projectProviderPayload(restored));
	return restored;
}

export interface MutationDiscoveredResources {
	skillPaths: readonly string[];
	promptPaths: readonly string[];
	themePaths: readonly string[];
}

export function beginResourcesDiscoverMutation(runtime: ExtensionRuntime, ext: Extension, reason: string) {
	const empty: MutationDiscoveredResources = { skillPaths: [], promptPaths: [], themePaths: [] };
	const mutation = beginTrustedMutation(runtime, "resources_discover", empty, {
		sourceInfo: ext.sourceInfo,
		ownerInfo: ext.sourceInfo,
		reason,
	});
	return {
		finish(candidate: MutationDiscoveredResources | undefined, error?: unknown): MutationDiscoveredResources {
			const accepted = mutation?.candidate(candidate ?? empty, error) ?? candidate ?? empty;
			mutation?.applied(accepted, error === undefined ? "applied" : "retained_after_error", error);
			if (mutation) {
				runtime.mutationResourceContributions ??= new Map();
				const contributions = runtime.mutationResourceContributions;
				for (const path of [...accepted.skillPaths, ...accepted.promptPaths, ...accepted.themePaths]) {
					contributions.set(path, { callId: mutation.callId, sourceInfo: ext.sourceInfo });
				}
			}
			return accepted;
		},
	};
}

export function observeResourcesDiscoverSkipped(runtime: ExtensionRuntime, reason: string): void {
	observeMutation(runtime, "resources_discover", "skipped", null, { reason });
}

export function observeResourcesApplied(
	runtime: ExtensionRuntime,
	value: MutationDiscoveredResources,
	outcome: string,
): void {
	observeMutation(runtime, "resources_apply", outcome, value);
}

export function observeHandlerSetSkipped(runtime: ExtensionRuntime, operation: string): void {
	observeMutation(runtime, operation, "skipped", null, { reason: "no_handlers" });
}

export function observeProviderTransformSkipped(runtime: ExtensionRuntime): void {
	observeHandlerSetSkipped(runtime, "before_provider_request");
}

export function projectTurnContext(
	options: NormalizedBuildSystemPromptOptions,
	tools: readonly MutationToolDefinition[],
	callableTools: readonly string[],
	modelDeclaredTools: readonly string[],
): MutationSystemToolContext {
	return {
		systemPrompt: buildSystemPrompt(options),
		sections: buildSystemPromptSections(options),
		tools,
		selectedTools: options.selectedTools,
		hiddenTools: options.hiddenTools,
		callableTools,
		modelDeclaredTools,
		toolSnippets: options.toolSnippets,
		toolGuidelines: options.toolGuidelines,
		promptGuidelines: options.promptGuidelines,
		appendSystemPrompt: options.appendSystemPrompt,
		contextFiles: options.contextFiles,
		skills: options.skills.map(({ sourceInfo, ...skill }) => ({ ...skill, ownerInfo: sourceInfo })),
	};
}
