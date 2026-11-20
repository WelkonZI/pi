import type { PathMetadata } from "../package-manager.ts";
import { createSourceInfo } from "../source-info.ts";
import {
	beginMutation,
	getDeclaredMutationInterceptor,
	type MutationInterceptorRegistration,
	type MutationOperation,
	type MutationToolDefinition,
	observeMutation,
} from "./mutation-interceptor.ts";
import { applyToolDefinition, projectToolDefinition } from "./mutation-interceptor-hooks.ts";
import type { Extension, ExtensionAPI, ExtensionFactory, ExtensionRuntime, ToolDefinition } from "./types.ts";

export type FactorySources = ReadonlyMap<string, PathMetadata>;
type ExtensionLoad = { api: ExtensionAPI; commit: () => void; discard: (error?: unknown) => void };
const factorySources = new WeakSet<Extension>();

export function hasFactorySource(extension: Extension): boolean {
	return factorySources.has(extension);
}

export function bootstrapMutationInterceptor(
	extensionPath: string,
	resolvedPath: string,
	factory: ExtensionFactory,
	runtime: ExtensionRuntime,
	sources: FactorySources | undefined,
): void {
	const interceptor = getDeclaredMutationInterceptor(factory);
	if (!interceptor) throw new Error(`Trusted mutation hook is not declared by ${extensionPath}`);
	const metadata = sources?.get(extensionPath) ?? sources?.get(resolvedPath);
	if (!metadata) throw new Error(`Trusted mutation hook has no configured source metadata: ${extensionPath}`);
	const sourceInfo = createSourceInfo(extensionPath, metadata);
	if (sourceInfo.scope !== "user") {
		throw new Error(`Trusted mutation hook requires user scope: ${extensionPath} (${sourceInfo.scope})`);
	}
	if (runtime.mutationInterceptor) {
		if (runtime.mutationInterceptor.sourceInfo.path === sourceInfo.path) return;
		throw new Error(`Trusted mutation hook already configured by ${runtime.mutationInterceptor.sourceInfo.path}`);
	}
	const registration: MutationInterceptorRegistration = { sourceInfo, interceptor };
	runtime.mutationInterceptor = registration;
	observeMutation(runtime, "trusted_hook", "initialized", null, { sourceInfo });
}

interface PendingToolMutation {
	mutation: MutationOperation<MutationToolDefinition>;
	value: MutationToolDefinition;
}

export function mutationLoad(
	extension: Extension,
	runtime: ExtensionRuntime,
	sources: FactorySources | undefined,
	moduleReused: boolean,
	create: () => ExtensionLoad,
): ExtensionLoad {
	const metadata = sources?.get(extension.path) ?? sources?.get(extension.resolvedPath);
	if (metadata) extension.sourceInfo = createSourceInfo(extension.path, metadata);
	factorySources.add(extension);
	observeMutation(runtime, "extension_factory", "started", { moduleReused }, { sourceInfo: extension.sourceInfo });
	const load = create();
	const registerTool = load.api.registerTool.bind(load.api);
	let state: "loading" | "active" | "failed" = "loading";
	const pendingTools: PendingToolMutation[] = [];
	Object.assign(load.api, {
		registerTool(definition: ToolDefinition): void {
			if (!runtime.mutationInterceptor) {
				registerTool(definition);
				return;
			}
			const before = projectToolDefinition(definition, extension.sourceInfo);
			const mutation = beginMutation(runtime, "tool_registration", before, {
				sourceInfo: extension.sourceInfo,
				ownerInfo: extension.sourceInfo,
				reason: state === "loading" ? "factory" : "runtime",
			});
			const accepted = mutation?.candidate(before) ?? before;
			try {
				registerTool(applyToolDefinition(definition, accepted));
			} catch (error) {
				mutation?.applied(before, "rejected", error);
				throw error;
			}
			if (!mutation) return;
			mutation.release();
			if (state === "loading") pendingTools.push({ mutation, value: accepted });
			else mutation.applied(accepted, "registered");
		},
	});
	return {
		api: load.api,
		commit(): void {
			if (state !== "loading") return;
			load.commit();
			state = "active";
			for (const pending of pendingTools) pending.mutation.applied(pending.value, "registered");
			pendingTools.length = 0;
			observeMutation(runtime, "extension_factory", "succeeded", null, { sourceInfo: extension.sourceInfo });
		},
		discard(error?: unknown): void {
			if (state !== "loading") return;
			state = "failed";
			for (const pending of pendingTools) pending.mutation.applied(pending.value, "discarded", error);
			pendingTools.length = 0;
			load.discard();
			observeMutation(runtime, "extension_factory", "failed", null, { sourceInfo: extension.sourceInfo }, error);
		},
	};
}
