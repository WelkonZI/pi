# Trusted mutation interceptor

[Extension API](extensions.md) · [personal `coding-agent` fork](personal-fork.md) only

The trusted mutation interceptor is a separately configured, synchronous hook for observing and accepting stable system/tool context changes. It is initialized before ordinary extension factories. Ordinary factories still run in their configured order.

Declare the hook on an extension factory:

```typescript
import {
  withMutationInterceptor,
  type MutationInterceptor,
} from "@earendil-works/pi-coding-agent";

const interceptor: MutationInterceptor = {
  intercept(call) {
    // Return the candidate Pi should apply.
    return call.value;
  },
  observe(call) {
    // Record lifecycle/outcome facts outside Pi if needed.
  },
};

const extension = (pi) => {
  // Optional ordinary extension behavior.
};

export default withMutationInterceptor(extension, interceptor);
```

Configure that module only in global user settings. An absolute path avoids working-directory-dependent resolution:

```json
{
  "trustedMutationHook": "/absolute/path/to/provenance-extension.ts",
  "extensions": ["/absolute/path/to/provenance-extension.ts"]
}
```

`trustedMutationHook` imports the module and initializes its declared hook. Listing the same path in `extensions` is optional and controls whether its ordinary factory also runs. Project-scoped or metadata-free hooks are rejected. Only one hook may be installed in an extension runtime.

## Direct contract

`intercept(call)` receives correlated `before`, `candidate`, and `applied` calls for an operation. `operationId` correlates the phases; `callId` identifies each direct callback. Returning the `candidate` value controls the stable value propagated to the next handler or core boundary.

`observe(call)` reports lifecycle and outcome facts that do not have a replaceable candidate. Both methods are called directly, not through extension events. They must return synchronously. Throws and promises fail the current operation closed and preserve the original error as the cause.

Pi does not clone, validate, diff, journal, replay, or assign policy to these values. A consumer that records provenance owns snapshots, validation, attribution policy, comparisons, and completeness decisions.

Identity fields are factual. Known source, owner, reason, session, operation, call, parent, and cause identifiers are included. Pi assigns turn and provider-attempt identifiers at the coding-agent boundaries it owns; unavailable run identifiers remain `null`.

## Covered boundaries

The hook covers:

- trusted-hook initialization and ordinary factory start/success/failure, including module reuse;
- extension tool registration and committed/discarded registration outcomes;
- complete built-in, extension, MCP, and SDK tool registry refreshes with source ownership;
- active-tool selection with distinct host, Extension API, handler-selection, transcript-restore, registry-refresh, initial-default, and resource-reload reasons; each applied value reports requested, active, callable, hidden, and model-declared tools;
- every `prepareLoadout` callback, including stable shared input, source/parent identity, recovery after ordinary callback errors, and the native merged result;
- extension resource discovery, empty/skipped/applied outcomes, direct stable override calls with normalized applied state, aggregate loaded resources including file-backed prompt content, and native loaded/added/replaced/removed/duplicate/rejected/reload outcomes with discovery cause links when known;
- `before_agent_start`, `context`, `context_with_system`, and system-prompt section changes, including empty handler sets;
- every fresh turn through `turn_preparation`;
- replaceable `normalized_context` after common conversion/normalization, followed by a `final_context` observation for each provider attempt;
- every late `before_provider_request` transformation, followed by `final_provider_context` with the same provider-attempt identity.

Ordinary extension errors keep their existing behavior. The trusted hook still receives the retained candidate and a safe `{ "type": "error" }` or `{ "type": "non_error" }` fact before normal flow continues; arbitrary exception text is not exposed. A trusted-hook error is not downgraded to an ordinary extension warning.

## Stable privacy boundary

The trusted hook receives only system/tool context needed for provenance:

- system instructions and structured sections;
- tool definitions, ownership, selection, visibility, callability, and model declarations;
- prompt snippets, tool and prompt guidelines, append prompt, context files, skills, resources, and normalized system-prompt options;
- executable fields represented as `{ "kind": "callback" }` markers.

It does not receive dialogue messages, tool results, credentials, UI/session metadata, timestamps, or complete provider payloads. At provider time Pi projects only known system/tool fields, including stable `role`/`content` from system or developer messages, string instructions, text content blocks stripped to `type`/`text`, OpenAI Responses `input`/`tool_choice`, and Google `config.systemInstruction`/`config.tools`/`config.toolConfig`. It applies accepted stable fields onto the original private templates, so unexposed block/message metadata and unrelated payload fields remain unchanged.

This is a trusted in-process hook, not an OS sandbox. The extension module still executes with the user's privileges.
