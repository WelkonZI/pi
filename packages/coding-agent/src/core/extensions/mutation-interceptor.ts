/** Trusted synchronous interception of stable system and tool context. */
import type { SourceInfo } from "../source-info.ts";
import type { ExtensionFactory, ExtensionRuntime, ToolLoadoutChanges } from "./types.ts";

export type MutationPhase = "before" | "candidate" | "applied";

export interface MutationCallbackMarker {
	kind: "callback";
}

export const MUTATION_CALLBACK: MutationCallbackMarker = { kind: "callback" };

export interface MutationErrorFact {
	type: "error" | "non_error";
}

export interface MutationIdentity {
	operationId: string;
	callId: string;
	parentCallId: string | null;
	causeCallId: string | null;
	sessionId: string | null;
	runId: string | null;
	turnId: string | null;
	providerAttemptId: string | null;
	sourceInfo: SourceInfo | null;
	ownerInfo: SourceInfo | null;
	reason: string | null;
}

export type MutationFact = MutationIdentity;

export interface MutationInterceptionCall<T = unknown> extends MutationIdentity {
	type: "interception";
	operation: string;
	phase: MutationPhase;
	value: T;
	error: MutationErrorFact | null;
}

export interface MutationObservationCall<T = unknown> extends MutationIdentity {
	type: "observation";
	operation: string;
	outcome: string;
	value: T | null;
	error: MutationErrorFact | null;
}

export interface MutationInterceptor {
	intercept<T>(call: MutationInterceptionCall<T>): T;
	observe(call: MutationObservationCall): void;
}

export interface MutationInterceptorRegistration {
	sourceInfo: SourceInfo;
	interceptor: MutationInterceptor;
}

export interface MutationLoadoutTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
}

export interface MutationLoadoutInput {
	declared: readonly MutationLoadoutTool[];
	callable: readonly MutationLoadoutTool[];
	registered: readonly MutationLoadoutTool[];
	getExposure: MutationCallbackMarker;
	getNamespace: MutationCallbackMarker;
	getPromptGuidelines: MutationCallbackMarker;
}

export type MutationPrepareLoadoutValue =
	| { kind: "input"; tool: MutationToolDefinition; input: MutationLoadoutInput }
	| { kind: "changes"; tool: MutationToolDefinition; changes: ToolLoadoutChanges | null }
	| {
			kind: "merged";
			tool: MutationToolDefinition;
			changes: ToolLoadoutChanges | null;
			descriptions: Readonly<Record<string, string>>;
			hiddenDeclarations: readonly string[];
			declared: readonly MutationLoadoutTool[];
	  };

export interface MutationToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	promptSnippet: string | null;
	promptGuidelines: readonly string[];
	exposure: string | null;
	defaultActive: boolean | null;
	namespace: unknown;
	annotations: unknown;
	execute: MutationCallbackMarker;
	prepareArguments: MutationCallbackMarker | null;
	prepareLoadout: MutationCallbackMarker | null;
	reachesTools: MutationCallbackMarker | null;
	ownerInfo: SourceInfo | null;
}

export interface MutationSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	disableModelInvocation: boolean;
	ownerInfo: SourceInfo;
}

export interface MutationSystemToolContext {
	systemPrompt: string | null;
	sections: Readonly<Record<string, string | null>>;
	tools: readonly MutationToolDefinition[];
	selectedTools: readonly string[];
	hiddenTools: readonly string[];
	callableTools: readonly string[];
	modelDeclaredTools: readonly string[];
	toolSnippets: Readonly<Record<string, string>>;
	toolGuidelines: Readonly<Record<string, readonly string[]>>;
	promptGuidelines: readonly string[];
	appendSystemPrompt: string;
	contextFiles: readonly { path: string; content: string }[];
	skills: readonly MutationSkill[];
}

export interface MutationActiveToolsContext {
	requestedTools: readonly string[];
	activeTools: readonly string[];
	callableTools: readonly string[];
	hiddenTools: readonly string[];
	modelDeclaredTools: readonly string[];
}

declare module "./types.ts" {
	interface ExtensionRuntimeState {
		mutationInterceptor?: MutationInterceptorRegistration;
		mutationSequence?: number;
		mutationSessionId?: string;
		mutationTurnSequence?: number;
		mutationTurnId?: string;
		mutationProviderAttemptSequence?: number;
		mutationProviderAttemptId?: string;
		mutationCurrentCallId?: string;
		mutationActiveContribution?: { callId: string; sourceInfo: SourceInfo };
		mutationResourceContributions?: Map<string, { callId: string; sourceInfo: SourceInfo }>;
	}
}

const interceptorProperty = "__piTrustedMutationInterceptor";

type InterceptorFactory = ExtensionFactory & { [interceptorProperty]?: MutationInterceptor };

/** Declare the trusted bootstrap beside an ordinary factory without executing that factory early. */
export function withMutationInterceptor<T extends ExtensionFactory>(factory: T, interceptor: MutationInterceptor): T {
	Object.defineProperty(factory, interceptorProperty, { value: interceptor });
	return factory;
}

export function getDeclaredMutationInterceptor(factory: ExtensionFactory): MutationInterceptor | undefined {
	return (factory as InterceptorFactory)[interceptorProperty];
}

export function setMutationSessionId(runtime: ExtensionRuntime, sessionId: string): void {
	runtime.mutationSessionId = sessionId;
}

export function beginMutationTurn(runtime: ExtensionRuntime): string {
	const sequence = (runtime.mutationTurnSequence ?? 0) + 1;
	runtime.mutationTurnSequence = sequence;
	runtime.mutationTurnId = `turn:${sequence}`;
	runtime.mutationProviderAttemptId = undefined;
	return runtime.mutationTurnId;
}

export function beginMutationProviderAttempt(runtime: ExtensionRuntime): string {
	const sequence = (runtime.mutationProviderAttemptSequence ?? 0) + 1;
	runtime.mutationProviderAttemptSequence = sequence;
	runtime.mutationProviderAttemptId = `provider-attempt:${sequence}`;
	return runtime.mutationProviderAttemptId;
}

export function errorFact(error: unknown): MutationErrorFact {
	return { type: error instanceof Error ? "error" : "non_error" };
}

function nextIdentity(
	runtime: ExtensionRuntime,
	operation: string,
	facts: Partial<Omit<MutationIdentity, "operationId" | "callId">>,
	operationId?: string,
): MutationIdentity {
	const sequence = (runtime.mutationSequence ?? 0) + 1;
	runtime.mutationSequence = sequence;
	return {
		operationId: operationId ?? `${operation}:${sequence}`,
		callId: `${operation}:${sequence}`,
		parentCallId: facts.parentCallId ?? runtime.mutationCurrentCallId ?? null,
		causeCallId: facts.causeCallId ?? null,
		sessionId: facts.sessionId ?? runtime.mutationSessionId ?? null,
		runId: facts.runId ?? null,
		turnId: facts.turnId ?? runtime.mutationTurnId ?? null,
		providerAttemptId: facts.providerAttemptId ?? runtime.mutationProviderAttemptId ?? null,
		sourceInfo: facts.sourceInfo ?? null,
		ownerInfo: facts.ownerInfo ?? null,
		reason: facts.reason ?? null,
	};
}

function assertSynchronous(value: unknown): void {
	if (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	) {
		throw new Error("Trusted mutation interceptor must be synchronous");
	}
}

export class TrustedMutationInterceptorError extends Error {}

export function rethrowTrustedMutationInterceptorError(error: unknown): void {
	if (error instanceof TrustedMutationInterceptorError) throw error;
}

function hookError(
	registration: MutationInterceptorRegistration,
	operation: string,
	phase: MutationPhase | "observe",
	cause: unknown,
): TrustedMutationInterceptorError {
	return new TrustedMutationInterceptorError(
		`Mutation interceptor ${registration.sourceInfo.path} failed at ${operation}:${phase}`,
		{ cause },
	);
}

export interface MutationOperation<T> {
	operationId: string;
	callId: string;
	candidate(value: T, error?: unknown): T;
	release(): void;
	applied(value: T, outcome?: string, error?: unknown): void;
}

/** Invoke `before` immediately; the consumer owns snapshots and comparison. */
export function beginMutation<T>(
	runtime: ExtensionRuntime,
	operation: string,
	before: T,
	facts: Partial<Omit<MutationIdentity, "operationId" | "callId">> = {},
): MutationOperation<T> | undefined {
	const registration = runtime.mutationInterceptor;
	if (!registration) return undefined;
	const previousCallId = runtime.mutationCurrentCallId;
	const scopedFacts = { ...facts, parentCallId: facts.parentCallId ?? previousCallId ?? null };
	const beforeIdentity = nextIdentity(runtime, operation, scopedFacts);
	try {
		assertSynchronous(
			registration.interceptor.intercept({
				...beforeIdentity,
				type: "interception",
				operation,
				phase: "before",
				value: before,
				error: null,
			}),
		);
	} catch (cause) {
		throw hookError(registration, operation, "before", cause);
	}
	runtime.mutationCurrentCallId = beforeIdentity.callId;
	let scopeActive = true;
	return {
		operationId: beforeIdentity.operationId,
		callId: beforeIdentity.callId,
		candidate(value, error) {
			try {
				const accepted = registration.interceptor.intercept({
					...nextIdentity(runtime, operation, scopedFacts, beforeIdentity.operationId),
					type: "interception",
					operation,
					phase: "candidate",
					value,
					error: error === undefined ? null : errorFact(error),
				});
				assertSynchronous(accepted);
				return accepted;
			} catch (cause) {
				runtime.mutationCurrentCallId = previousCallId;
				throw hookError(registration, operation, "candidate", cause);
			}
		},
		release() {
			if (!scopeActive) return;
			if (runtime.mutationCurrentCallId === beforeIdentity.callId) {
				runtime.mutationCurrentCallId = previousCallId;
			}
			scopeActive = false;
		},
		applied(value, outcome = "applied", error) {
			const currentCallId = runtime.mutationCurrentCallId;
			runtime.mutationCurrentCallId = beforeIdentity.callId;
			try {
				assertSynchronous(
					registration.interceptor.intercept({
						...nextIdentity(runtime, operation, scopedFacts, beforeIdentity.operationId),
						type: "interception",
						operation,
						phase: "applied",
						value,
						error: error === undefined ? null : errorFact(error),
					}),
				);
				observeMutation(runtime, `${operation}:outcome`, outcome, value, scopedFacts, error, beforeIdentity.callId);
			} catch (cause) {
				throw hookError(registration, operation, "applied", cause);
			} finally {
				runtime.mutationCurrentCallId = scopeActive ? previousCallId : currentCallId;
				scopeActive = false;
			}
		},
	};
}

export function observeMutation<T>(
	runtime: ExtensionRuntime,
	operation: string,
	outcome: string,
	value: T | null = null,
	facts: Partial<Omit<MutationIdentity, "operationId" | "callId">> = {},
	error?: unknown,
	causeCallId?: string,
): void {
	const registration = runtime.mutationInterceptor;
	if (!registration) return;
	try {
		const result = registration.interceptor.observe({
			...nextIdentity(runtime, operation, { ...facts, causeCallId: causeCallId ?? facts.causeCallId }),
			type: "observation",
			operation,
			outcome,
			value,
			error: error === undefined ? null : errorFact(error),
		});
		assertSynchronous(result);
	} catch (cause) {
		throw hookError(registration, operation, "observe", cause);
	}
}
