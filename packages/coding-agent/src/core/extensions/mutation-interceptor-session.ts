import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import type { ResourceLoader } from "../resource-loader.ts";
import type { SourceInfo } from "../source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	type SystemPromptSections,
} from "../system-prompt.ts";
import {
	beginMutation,
	MUTATION_CALLBACK,
	type MutationActiveToolsContext,
	type MutationLoadoutTool,
	type MutationPrepareLoadoutValue,
	type MutationSystemToolContext,
	setMutationSessionId,
} from "./mutation-interceptor.ts";
import { applyToolDefinition, projectToolDefinition, projectTurnContext } from "./mutation-interceptor-hooks.ts";
import type { ToolDefinition, ToolLoadout, ToolLoadoutChanges } from "./types.ts";

interface StableToolEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function runtime(loader: ResourceLoader) {
	return loader.getExtensions().runtime;
}

export function setMutationSessionIdentity(loader: ResourceLoader, sessionId: string): void {
	setMutationSessionId(runtime(loader), sessionId);
}

export function beginToolRegistryMutation(
	loader: ResourceLoader,
	registry: Map<string, StableToolEntry>,
): { accepted: Map<string, StableToolEntry>; applied(value: Map<string, StableToolEntry>): void } {
	const extensionRuntime = runtime(loader);
	if (!extensionRuntime.mutationInterceptor) return { accepted: new Map(registry), applied(): void {} };
	const entries = [...registry.values()];
	const before = entries.map(({ definition, sourceInfo }) => projectToolDefinition(definition, sourceInfo));
	const mutation = beginMutation(extensionRuntime, "tool_registry", before, { reason: "registry_refresh" });
	const accepted = mutation?.candidate(before) ?? before;
	const byName = new Map(entries.map((entry) => [entry.definition.name, entry]));
	const definitions = new Map<string, StableToolEntry>();
	for (const tool of accepted) {
		const entry = byName.get(tool.name);
		if (!entry) continue;
		const definition = applyToolDefinition(entry.definition, tool);
		definitions.set(definition.name, { definition, sourceInfo: entry.sourceInfo });
	}
	return {
		accepted: definitions,
		applied(value): void {
			mutation?.applied(
				[...value.values()].map(({ definition, sourceInfo }) => projectToolDefinition(definition, sourceInfo)),
			);
		},
	};
}

export function beginActiveToolsMutation(
	loader: ResourceLoader,
	before: MutationActiveToolsContext,
	candidate: MutationActiveToolsContext,
	reason: string,
	sourceInfo: SourceInfo | null,
	parentCallId: string | null = null,
): { accepted: string[]; callId: string | null; applied(value: MutationActiveToolsContext): void } {
	const mutation = beginMutation(runtime(loader), "active_tools", before, { reason, sourceInfo, parentCallId });
	const accepted = mutation?.candidate(candidate) ?? candidate;
	return {
		accepted: [...accepted.activeTools],
		callId: mutation?.callId ?? null,
		applied(value): void {
			mutation?.applied(value);
		},
	};
}

function projectLoadoutTool(tool: AgentTool): MutationLoadoutTool {
	return { name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters };
}

export function applyLoadoutDescriptions(
	tools: readonly AgentTool[],
	descriptions: ReadonlyMap<string, string>,
): AgentTool[] {
	return tools.map((tool) => {
		const description = descriptions.get(tool.name);
		return description === undefined ? tool : { ...tool, description };
	});
}

export function beginPrepareLoadoutMutation(
	loader: ResourceLoader,
	definition: ToolDefinition,
	sourceInfo: SourceInfo,
	loadout: ToolLoadout,
	parentCallId: string | null,
) {
	const tool = projectToolDefinition(definition, sourceInfo);
	const mutation = beginMutation<MutationPrepareLoadoutValue>(
		runtime(loader),
		"prepare_loadout",
		{
			kind: "input",
			tool,
			input: {
				declared: loadout.declared.map(projectLoadoutTool),
				callable: loadout.callable.map(projectLoadoutTool),
				registered: loadout.registered.map(projectLoadoutTool),
				getExposure: MUTATION_CALLBACK,
				getNamespace: MUTATION_CALLBACK,
				getPromptGuidelines: MUTATION_CALLBACK,
			},
		},
		{ parentCallId, sourceInfo, ownerInfo: sourceInfo },
	);
	return {
		candidate(changes: ToolLoadoutChanges | undefined, error?: unknown): ToolLoadoutChanges | undefined {
			if (!mutation) return changes;
			const accepted = mutation.candidate({ kind: "changes", tool, changes: changes ?? null }, error) as Extract<
				MutationPrepareLoadoutValue,
				{ kind: "changes" }
			>;
			return accepted.changes ?? undefined;
		},
		applied(
			changes: ToolLoadoutChanges | undefined,
			descriptions: ReadonlyMap<string, string>,
			hiddenDeclarations: ReadonlySet<string>,
			declared: readonly AgentTool[],
			error?: unknown,
		): void {
			mutation?.applied(
				{
					kind: "merged",
					tool,
					changes: changes ?? null,
					descriptions: Object.fromEntries(descriptions),
					hiddenDeclarations: [...hiddenDeclarations],
					declared: declared.map(projectLoadoutTool),
				},
				error === undefined ? "merged" : "merged_after_error",
				error,
			);
		},
	};
}

function applyTurnContext(
	options: NormalizedBuildSystemPromptOptions,
	tools: readonly AgentTool[],
	accepted: MutationSystemToolContext,
	originalSections: MutationSystemToolContext["sections"],
	currentSystemPrompt: string,
	resolveCallableTools: (selectedTools: readonly string[]) => readonly string[],
): { sections: SystemPromptSections; tools: AgentTool[]; hiddenTools: string[]; applied: MutationSystemToolContext } {
	if (accepted.systemPrompt !== currentSystemPrompt) options.forceSystemPrompt = accepted.systemPrompt ?? undefined;
	options.hiddenTools = [...accepted.hiddenTools];
	options.toolSnippets = { ...accepted.toolSnippets };
	options.toolGuidelines = Object.fromEntries(
		Object.entries(accepted.toolGuidelines).map(([name, guidelines]) => [name, [...guidelines]]),
	);
	options.promptGuidelines = [...accepted.promptGuidelines];
	options.appendSystemPrompt = accepted.appendSystemPrompt;
	options.contextFiles = accepted.contextFiles.map((file) => ({ ...file }));
	options.skills = accepted.skills.map(({ ownerInfo, ...skill }) => ({ ...skill, sourceInfo: ownerInfo }));
	const available = new Map(tools.map((tool) => [tool.name, tool]));
	const definitions = new Map(accepted.tools.map((tool) => [tool.name, tool]));
	const appliedTools = accepted.selectedTools.flatMap((name) => {
		const tool = available.get(name);
		const definition = definitions.get(name);
		return tool && definition
			? [
					{
						...tool,
						label: definition.label,
						description: definition.description,
						parameters: definition.parameters as AgentTool["parameters"],
					},
				]
			: [];
	});
	options.selectedTools = appliedTools.map((tool) => tool.name);
	const sections =
		accepted.sections === originalSections
			? buildSystemPromptSections(options)
			: Object.fromEntries(
					Object.entries(accepted.sections).filter((entry): entry is [string, string] => entry[1] !== null),
				);
	const actualSystemPrompt =
		options.forceSystemPrompt ?? getSystemMessageText({ role: "system", content: "", sections, timestamp: 0 });
	const selected = new Set(options.selectedTools);
	const hidden = new Set(options.hiddenTools);
	const actualCallableTools = [...resolveCallableTools(options.selectedTools)];
	return {
		sections,
		tools: appliedTools,
		hiddenTools: [...options.hiddenTools],
		applied: {
			...accepted,
			systemPrompt: actualSystemPrompt,
			sections,
			tools: accepted.tools.filter((tool) => selected.has(tool.name)),
			selectedTools: options.selectedTools,
			hiddenTools: options.hiddenTools,
			callableTools: actualCallableTools,
			modelDeclaredTools: options.selectedTools.filter((name) => !hidden.has(name)),
		},
	};
}

export function interceptTurnContext(
	loader: ResourceLoader,
	options: NormalizedBuildSystemPromptOptions,
	tools: readonly AgentTool[],
	definitions: readonly StableToolEntry[],
	callableTools: readonly string[],
	modelDeclaredTools: readonly string[],
	resolveCallableTools: (selectedTools: readonly string[]) => readonly string[],
): { sections: SystemPromptSections; tools: AgentTool[]; hiddenTools: string[] } {
	const currentSystemPrompt = buildSystemPrompt(options);
	const extensionRuntime = runtime(loader);
	if (!extensionRuntime.mutationInterceptor) {
		return { sections: buildSystemPromptSections(options), tools: [...tools], hiddenTools: [...options.hiddenTools] };
	}
	const effectiveTools = new Map(tools.map((tool) => [tool.name, tool]));
	let context = projectTurnContext(
		options,
		definitions.map(({ definition, sourceInfo }) => {
			const projected = projectToolDefinition(definition, sourceInfo);
			const effective = effectiveTools.get(definition.name);
			return effective
				? {
						...projected,
						label: effective.label,
						description: effective.description,
						parameters: effective.parameters,
					}
				: projected;
		}),
		callableTools,
		modelDeclaredTools,
	);
	const originalSections = context.sections;
	const mutation = beginMutation(extensionRuntime, "turn_preparation", context, { reason: "fresh_turn" });
	if (mutation) context = mutation.candidate(context);
	const result = applyTurnContext(
		options,
		tools,
		context,
		originalSections,
		currentSystemPrompt,
		resolveCallableTools,
	);
	mutation?.applied(result.applied);
	return result;
}
