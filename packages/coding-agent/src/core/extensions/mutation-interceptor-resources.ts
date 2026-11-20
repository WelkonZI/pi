import type { PromptTemplate } from "../prompt-templates.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { Skill } from "../skills.ts";
import type { SourceInfo } from "../source-info.ts";
import { beginMutation, observeMutation } from "./mutation-interceptor.ts";
import type { ExtensionRuntime } from "./types.ts";

export interface MutationNativeResource {
	kind: "system_prompt" | "append_system_prompt" | "context_file" | "skill" | "prompt";
	key: string;
	path: string | null;
	name: string | null;
	index: number;
	ownerInfo: SourceInfo | null;
	causeCallId: string | null;
}

export interface MutationNativeResourceDiagnostic {
	type: "warning" | "error" | "collision";
	path: string | null;
	resourceType: string | null;
	name: string | null;
	winnerPath: string | null;
	loserPath: string | null;
	sourceInfo: SourceInfo | null;
	causeCallId: string | null;
}

export interface MutationLoadedResources {
	systemPrompt: string | null;
	appendSystemPrompt: readonly string[];
	contextFiles: readonly { path: string; content: string }[];
	skills: readonly { name: string; description: string; path: string; ownerInfo: SourceInfo }[];
	prompts: readonly { name: string; description: string; content: string; path: string; ownerInfo: SourceInfo }[];
}

function projectLoadedResources(loader: ResourceLoader): MutationLoadedResources {
	return {
		systemPrompt: loader.getSystemPrompt() ?? null,
		appendSystemPrompt: loader.getAppendSystemPrompt(),
		contextFiles: loader.getAgentsFiles().agentsFiles,
		skills: loader.getSkills().skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			path: skill.filePath,
			ownerInfo: skill.sourceInfo,
		})),
		prompts: loader.getPrompts().prompts.map((prompt) => ({
			name: prompt.name,
			description: prompt.description,
			content: prompt.content,
			path: prompt.filePath,
			ownerInfo: prompt.sourceInfo,
		})),
	};
}

export function beginLoadedResourcesMutation(
	runtime: ExtensionRuntime,
	loader: ResourceLoader,
	reason: string,
): { accepted: MutationLoadedResources; applied(): void } {
	const resources = projectLoadedResources(loader);
	const mutation = beginMutation(runtime, "loaded_resources", resources, { reason });
	return {
		accepted: mutation?.candidate(resources) ?? resources,
		applied(): void {
			mutation?.applied(projectLoadedResources(loader));
		},
	};
}

export function applyAcceptedSkills(skills: readonly Skill[], accepted: MutationLoadedResources["skills"]): Skill[] {
	const acceptedByPath = new Map(accepted.map((skill) => [skill.path, skill]));
	return skills.flatMap((skill) => {
		const value = acceptedByPath.get(skill.filePath);
		return value ? [{ ...skill, name: value.name, description: value.description }] : [];
	});
}

export function applyAcceptedPrompts(
	prompts: readonly PromptTemplate[],
	accepted: MutationLoadedResources["prompts"],
): PromptTemplate[] {
	const acceptedByPath = new Map(accepted.map((prompt) => [prompt.path, prompt]));
	return prompts.flatMap((prompt) => {
		const value = acceptedByPath.get(prompt.filePath);
		return value ? [{ ...prompt, name: value.name, description: value.description, content: value.content }] : [];
	});
}

export function applyResourceOverride<T>(
	runtime: ExtensionRuntime,
	reason: string,
	before: T,
	override: ((value: T) => T) | undefined,
	apply: (value: T) => T,
): T {
	if (!override) return apply(before);
	const mutation = beginMutation(runtime, "resource_override", before, { reason });
	if (!mutation) return apply(override(before));
	let candidate: T;
	try {
		candidate = override(before);
	} catch (error) {
		const accepted = mutation?.candidate(before, error) ?? before;
		const applied = apply(accepted);
		mutation?.applied(applied, "applied_after_error", error);
		throw error;
	}
	const accepted = mutation?.candidate(candidate) ?? candidate;
	const applied = apply(accepted);
	mutation?.applied(applied);
	return applied;
}

interface MutationNativeResourceCause {
	callId: string;
	sourceInfo: SourceInfo;
}

export function projectNativeResourceState(
	loader: ResourceLoader,
	ownerInfoForPath: (path: string, kind: MutationNativeResource["kind"]) => SourceInfo | null,
	causeForPath: (path: string) => MutationNativeResourceCause | undefined,
): { resources: MutationNativeResource[]; diagnostics: MutationNativeResourceDiagnostic[] } {
	let index = 0;
	const project = (
		kind: MutationNativeResource["kind"],
		key: string,
		path: string | null,
		name: string | null,
		ownerInfo: SourceInfo | null,
	): MutationNativeResource => ({
		kind,
		key,
		path,
		name,
		index: index++,
		ownerInfo,
		causeCallId: path ? (causeForPath(path)?.callId ?? null) : null,
	});
	const resources: MutationNativeResource[] = [];
	const systemPrompt = loader.getSystemPrompt();
	if (systemPrompt !== undefined) {
		const path = loader.getSystemPromptSource()?.path ?? null;
		resources.push(
			project("system_prompt", "system_prompt", path, null, path ? ownerInfoForPath(path, "system_prompt") : null),
		);
	}
	const appendSources = loader.getAppendSystemPromptSources();
	for (const [appendIndex, content] of loader.getAppendSystemPrompt().entries()) {
		const path = appendSources[appendIndex]?.path ?? null;
		resources.push(
			project(
				"append_system_prompt",
				`append_system_prompt:${path ?? appendIndex}:${content}`,
				path,
				null,
				path ? ownerInfoForPath(path, "append_system_prompt") : null,
			),
		);
	}
	for (const file of loader.getAgentsFiles().agentsFiles) {
		resources.push(
			project(
				"context_file",
				`context_file:${file.path}`,
				file.path,
				null,
				ownerInfoForPath(file.path, "context_file"),
			),
		);
	}
	for (const skill of loader.getSkills().skills) {
		resources.push(project("skill", `skill:${skill.name}`, skill.filePath, skill.name, skill.sourceInfo));
	}
	for (const prompt of loader.getPrompts().prompts) {
		resources.push(project("prompt", `prompt:${prompt.name}`, prompt.filePath, prompt.name, prompt.sourceInfo));
	}
	const diagnostics = [...loader.getSkills().diagnostics, ...loader.getPrompts().diagnostics].map((diagnostic) => {
		const path = diagnostic.path ?? diagnostic.collision?.loserPath ?? diagnostic.collision?.winnerPath ?? null;
		const contribution = path ? causeForPath(path) : undefined;
		return {
			type: diagnostic.type,
			path: diagnostic.path ?? null,
			resourceType: diagnostic.collision?.resourceType ?? null,
			name: diagnostic.collision?.name ?? null,
			winnerPath: diagnostic.collision?.winnerPath ?? null,
			loserPath: diagnostic.collision?.loserPath ?? null,
			sourceInfo: contribution?.sourceInfo ?? null,
			causeCallId: contribution?.callId ?? null,
		};
	});
	return { resources, diagnostics };
}

export function observeNativeResources(
	runtime: ExtensionRuntime,
	before: readonly MutationNativeResource[],
	after: readonly MutationNativeResource[],
	diagnostics: readonly MutationNativeResourceDiagnostic[],
	reason: string,
): void {
	const previous = new Map(before.map((resource) => [resource.key, resource]));
	const current = new Map(after.map((resource) => [resource.key, resource]));
	for (const resource of after) {
		const old = previous.get(resource.key);
		const outcome = old === undefined ? "added" : old.path === resource.path ? "loaded" : "replaced";
		observeMutation(runtime, "native_resource", outcome, resource, {
			reason,
			ownerInfo: resource.ownerInfo,
			causeCallId: resource.causeCallId,
		});
	}
	for (const resource of before) {
		if (current.has(resource.key)) continue;
		observeMutation(runtime, "native_resource", "removed", resource, {
			reason,
			ownerInfo: resource.ownerInfo,
			causeCallId: resource.causeCallId,
		});
	}
	for (const diagnostic of diagnostics) {
		observeMutation(
			runtime,
			"native_resource_diagnostic",
			diagnostic.type === "collision" ? "duplicate_loser" : "rejected_or_missing",
			diagnostic,
			{ reason, sourceInfo: diagnostic.sourceInfo, causeCallId: diagnostic.causeCallId },
		);
	}
	if (after.length === 0 && diagnostics.length === 0) {
		observeMutation(runtime, "native_resource", "empty", null, { reason });
	}
}

export function observeResourceReload(
	runtime: ExtensionRuntime | undefined,
	outcome: string,
	reason: string,
	error?: unknown,
): void {
	if (!runtime) return;
	observeMutation(runtime, "resource_reload", outcome, null, { reason }, error);
}
