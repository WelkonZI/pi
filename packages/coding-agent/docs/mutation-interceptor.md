# Trusted mutation interceptor

[Extension API](extensions.md) · `pi.registerMutationInterceptor(interceptor)`

Register the single trusted, synchronous interceptor for this extension runtime. Only extensions with authoritative `sourceInfo.scope === "user"` may register it. Project extensions, inline factories, and paths without authoritative user metadata cannot register. Duplicate registration throws and preserves the first committed interceptor. Registration during a factory commits only when that factory succeeds.

```typescript
pi.registerMutationInterceptor((event) => {
  // event.stage narrows the state; event.sourceInfo identifies the contributor.
  // Return the accepted state, including when nothing should change.
  return event.after;
});
```

`MutationStage`, `MutationInterceptEvent`, and `MutationInterceptor` are public types. The callback receives `{ stage, sourceInfo, before, after }`. `before` is an isolated `structuredClone` snapshot; `after` includes in-place edits and returned replacements. If state cannot be cloned (for example, a payload contains a function), the operation fails before the handler runs. The error identifies the stage, contributor, and interceptor and preserves the cloning error as its cause. The accepted state feeds the next handler or core operation. The interceptor is called directly, not through extension events.

| Stage | State | Contributor |
|-------|-------|-------------|
| `before_agent_start` | Normalized `systemPromptOptions` | Each successful handler's extension |
| `context` | Message array without system messages | Each successful handler's extension |
| `context_with_system` | Full message array | Each successful handler's extension |
| `before_provider_request` | Opaque provider payload (`unknown`) | Each successful handler's extension |
| `system_prompt_sections` | Complete structured prompt sections, before diff and persistence | Stable `builtin:system_prompt_sections` source |

Return the accepted state synchronously: `event.after` accepts the contribution, `event.before` reverts it, and a fresh replacement object or array replaces it. Returning `undefined` fails the operation, including at the provider stage: existing provider callbacks interpret that value as keeping the original payload. Promises, thenables, thrown errors, and invalid known stage shapes also fail closed at runtime instead of logging the error and accepting the contribution. Errors identify the stage, contributor, and interceptor and preserve the original cause. Provider payloads are not parsed or provider-validated.

Without a registered interceptor, existing mutation behavior is unchanged and no interceptor snapshots are made. Pi supplies no content policy. This trusted hook is not an OS sandbox: extensions still execute arbitrary code with your user's privileges.
