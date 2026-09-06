// Deliberate no-op hook. Every `selectCommand` path in MessageInput.svelte
// calls this so a later analytics task can wire up real instrumentation
// (an event bus call, a beacon, whatever the analytics slice picks) without
// touching the composer command-selection call sites again.
export function recordComposerCommandUsed(commandId: string): void {
	void commandId;
}
