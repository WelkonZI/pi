import type { PathMetadata } from "../package-manager.ts";
import { createSourceInfo } from "../source-info.ts";
import { assertMutationInterceptorRegistration, type MutationInterceptor, type MutationInterceptorRegistration } from "./mutation-interceptor.ts";
import type { Extension, ExtensionAPI, ExtensionRuntime } from "./types.ts";

export type FactorySources = ReadonlyMap<string, PathMetadata>;
type ExtensionLoad = { api: ExtensionAPI; commit: () => void; discard: () => void };
const factorySources = new WeakSet<Extension>();

// Keep factory metadata identity through the legacy post-load attribution pass.
export function hasFactorySource(extension: Extension): boolean {
	return factorySources.has(extension);
}

export function mutationLoad(extension: Extension, runtime: ExtensionRuntime, sources: FactorySources | undefined, create: () => ExtensionLoad): ExtensionLoad {
	const metadata = sources?.get(extension.path) ?? sources?.get(extension.resolvedPath);
	if (metadata) extension.sourceInfo = createSourceInfo(extension.path, metadata);
	factorySources.add(extension);
	const load = create();
	let state: "loading" | "active" | "failed" = "loading";
	let pending: MutationInterceptorRegistration | undefined;
	Object.assign(load.api, {
		registerMutationInterceptor(interceptor: MutationInterceptor): void {
			if (state === "failed") throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
			runtime.assertActive();
			assertMutationInterceptorRegistration(extension.sourceInfo, pending ?? runtime.mutationInterceptor);
			const registration = { sourceInfo: extension.sourceInfo, interceptor };
			if (state === "loading") pending = registration;
			else runtime.mutationInterceptor = registration;
		},
	});
	return {
		api: load.api,
		commit(): void {
			if (state !== "loading") return;
			runtime.assertActive();
			if (pending) assertMutationInterceptorRegistration(pending.sourceInfo, runtime.mutationInterceptor);
			load.commit();
			if (pending) runtime.mutationInterceptor = pending;
			pending = undefined;
			state = "active";
		},
		discard(): void {
			pending = undefined;
			state = "failed";
			load.discard();
		},
	};
}
