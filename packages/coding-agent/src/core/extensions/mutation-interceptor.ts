/** Trusted synchronous interception of candidate prompt, message, and provider state. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SourceInfo } from "../source-info.ts";
import type { NormalizedBuildSystemPromptOptions, SystemPromptSections } from "../system-prompt.ts";

export interface MutationStateByStage {
	system_prompt_sections: SystemPromptSections;
	before_agent_start: NormalizedBuildSystemPromptOptions;
	context: AgentMessage[];
	context_with_system: AgentMessage[];
	before_provider_request: unknown;
}

export type MutationStage = keyof MutationStateByStage;

/** Stage discriminates the complete state accepted at that boundary. */
export type MutationInterceptEvent = {
	[S in MutationStage]: {
		stage: S;
		sourceInfo: SourceInfo;
		before: MutationStateByStage[S];
		after: MutationStateByStage[S];
	};
}[MutationStage];

/** Return accepted state synchronously; asynchronous results fail the operation. */
export type MutationInterceptor = (event: MutationInterceptEvent) => unknown;

/** Committed registration owned by one extension runtime. */
export interface MutationInterceptorRegistration {
	sourceInfo: SourceInfo;
	interceptor: MutationInterceptor;
}

declare module "./types.ts" {
	interface ExtensionAPI {
		/** Register the runtime's single trusted synchronous interceptor. User-scope extensions only. */
		registerMutationInterceptor(interceptor: MutationInterceptor): void;
	}
	interface ExtensionRuntimeState {
		/** Committed only after the registering factory succeeds. */
		mutationInterceptor?: MutationInterceptorRegistration;
	}
}

/** Stable attribution for Pi's assembled prompt sections, not an extension resource. */
export const BUILTIN_SYSTEM_PROMPT_SOURCE: SourceInfo = {
	path: "builtin:system_prompt_sections",
	source: "builtin",
	scope: "temporary",
	origin: "top-level",
};

/** Check both at registration and commit, so concurrent factory loads cannot replace the winner. */
export function assertMutationInterceptorRegistration(
	sourceInfo: SourceInfo,
	current: MutationInterceptorRegistration | undefined,
): void {
	if (sourceInfo.scope !== "user") {
		throw new Error(
			`Mutation interceptor registration requires user scope: ${sourceInfo.path} (${sourceInfo.scope})`,
		);
	}
	if (current) {
		throw new Error(`Mutation interceptor already registered by ${current.sourceInfo.path}`);
	}
}

function mutationError(
	registration: MutationInterceptorRegistration,
	stage: MutationStage,
	sourceInfo: SourceInfo,
	cause: unknown,
): Error {
	return new Error(`Mutation interceptor ${registration.sourceInfo.path} failed at ${stage} for ${sourceInfo.path}`, {
		cause,
	});
}

/** Snapshot failures are privileged boundary failures too, never an unchecked fallback. */
export function snapshotMutationState<T>(
	registration: MutationInterceptorRegistration | undefined,
	stage: MutationStage,
	sourceInfo: SourceInfo,
	state: T,
): T {
	if (!registration) return state;
	try {
		return structuredClone(state);
	} catch (cause) {
		throw mutationError(registration, stage, sourceInfo, cause);
	}
}

/** Invoke the committed handler without awaiting; never fall back to rejected candidate state. */
export function invokeMutationInterceptor<E extends MutationInterceptEvent>(
	registration: MutationInterceptorRegistration | undefined,
	event: E,
): E["after"] {
	if (!registration) return event.after;
	try {
		// Extension results are a trust boundary even when the extension is written in TypeScript.
		const result: unknown = registration.interceptor(event);
		if (result === undefined) throw new Error("Mutation interceptor must return accepted state, not undefined");
		if (
			result !== null &&
			(typeof result === "object" || typeof result === "function") &&
			"then" in result &&
			typeof result.then === "function"
		) {
			if (result instanceof Promise) void result.catch(() => {});
			throw new Error("Mutation interceptor must return synchronously, not a thenable");
		}
		if (!isValidMutationState(event.stage, result)) {
			throw new Error(`Invalid mutation interceptor result for ${event.stage}`);
		}
		// Stage validation above establishes the state shape for this discriminated event.
		return result as E["after"];
	} catch (cause) {
		throw mutationError(registration, event.stage, event.sourceInfo, cause);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isStringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isMessageContent(value: unknown, types: readonly string[], allowString = false): boolean {
	if (typeof value === "string") return allowString;
	return (
		Array.isArray(value) &&
		value.every((block: unknown) => {
			if (!isRecord(block) || typeof block.type !== "string" || !types.includes(block.type)) return false;
			switch (block.type) {
				case "text":
					return typeof block.text === "string";
				case "image":
					return typeof block.data === "string" && typeof block.mimeType === "string";
				case "thinking":
					return typeof block.thinking === "string";
				case "toolCall":
					return typeof block.id === "string" && typeof block.name === "string" && isRecord(block.arguments);
				default:
					return false;
			}
		})
	);
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	const cost = value.cost;
	return (
		["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => typeof value[key] === "number") &&
		["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => typeof cost[key] === "number")
	);
}

function isValidMessage(value: unknown): boolean {
	if (!isRecord(value) || typeof value.role !== "string" || typeof value.timestamp !== "number") return false;
	switch (value.role) {
		case "system":
			return (
				isMessageContent(value.content, ["text"], true) &&
				(value.sections === undefined ||
					(isRecord(value.sections) &&
						Object.values(value.sections).every((section) => section === null || typeof section === "string"))) &&
				(value.toolsAdded === undefined ||
					(Array.isArray(value.toolsAdded) &&
						value.toolsAdded.every(
							(tool: unknown) =>
								isRecord(tool) &&
								typeof tool.name === "string" &&
								typeof tool.description === "string" &&
								isRecord(tool.parameters),
						))) &&
				(value.toolsRemoved === undefined ||
					(Array.isArray(value.toolsRemoved) &&
						value.toolsRemoved.every((tool: unknown) => isRecord(tool) && typeof tool.name === "string")))
			);
		case "user":
			return isMessageContent(value.content, ["text", "image"], true);
		case "assistant":
			return (
				isMessageContent(value.content, ["text", "thinking", "toolCall"]) &&
				typeof value.api === "string" &&
				typeof value.provider === "string" &&
				typeof value.model === "string" &&
				isUsage(value.usage) &&
				typeof value.stopReason === "string" &&
				["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(value.stopReason)
			);
		case "toolResult":
			return (
				isMessageContent(value.content, ["text", "image"]) &&
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string" &&
				typeof value.isError === "boolean"
			);
		case "custom":
			return (
				typeof value.customType === "string" &&
				typeof value.display === "boolean" &&
				isMessageContent(value.content, ["text", "image"], true)
			);
		case "bashExecution":
			return (
				typeof value.command === "string" &&
				typeof value.output === "string" &&
				(value.exitCode === undefined || typeof value.exitCode === "number") &&
				typeof value.cancelled === "boolean" &&
				typeof value.truncated === "boolean"
			);
		case "branchSummary":
			return typeof value.summary === "string" && (value.fromId === null || typeof value.fromId === "string");
		case "compactionSummary":
			return typeof value.summary === "string" && typeof value.tokensBefore === "number";
		// Extensions can add roles through AgentMessage declaration merging.
		default:
			return true;
	}
}

function isValidMutationState(stage: MutationStage, value: unknown): boolean {
	switch (stage) {
		case "before_provider_request":
			return true;
		case "system_prompt_sections":
			return isStringRecord(value);
		case "context":
		case "context_with_system":
			return Array.isArray(value) && value.every(isValidMessage);
		case "before_agent_start":
			return (
				isRecord(value) &&
				typeof value.cwd === "string" &&
				(value.customPrompt === undefined || typeof value.customPrompt === "string") &&
				(value.forceSystemPrompt === undefined || typeof value.forceSystemPrompt === "string") &&
				isStringArray(value.selectedTools) &&
				isStringArray(value.hiddenTools) &&
				isStringRecord(value.toolSnippets) &&
				isRecord(value.toolGuidelines) &&
				Object.values(value.toolGuidelines).every(isStringArray) &&
				isStringArray(value.promptGuidelines) &&
				typeof value.appendSystemPrompt === "string" &&
				isStringRecord(value.sections) &&
				Array.isArray(value.contextFiles) &&
				value.contextFiles.every(
					(file: unknown) => isRecord(file) && typeof file.path === "string" && typeof file.content === "string",
				) &&
				Array.isArray(value.skills) &&
				value.skills.every(
					(skill: unknown) =>
						isRecord(skill) &&
						typeof skill.name === "string" &&
						typeof skill.description === "string" &&
						typeof skill.filePath === "string" &&
						typeof skill.baseDir === "string" &&
						typeof skill.disableModelInvocation === "boolean" &&
						isRecord(skill.sourceInfo) &&
						typeof skill.sourceInfo.path === "string" &&
						typeof skill.sourceInfo.source === "string" &&
						(skill.sourceInfo.scope === "user" ||
							skill.sourceInfo.scope === "project" ||
							skill.sourceInfo.scope === "temporary") &&
						(skill.sourceInfo.origin === "package" || skill.sourceInfo.origin === "top-level"),
				)
			);
	}
}
