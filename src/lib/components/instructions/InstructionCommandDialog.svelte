<script lang="ts">
/**
 * The dialog `/instruction` opens, hosted by the surface that owns the
 * composer.
 *
 * The command's argument is not a new instruction: it is a line to append to
 * the text the user already has, which is why this goes through the same
 * dialog as everything else rather than saving anything directly. The surface
 * that knows where the user is standing (a project page, a chat inside a
 * project, the home board) hands that in as `projectId` and gets back the one
 * call it needs.
 */
import { onMount } from "svelte";
import {
	type InstructionDialogSeed,
	type OpenInstructionDialog,
	loadInstructionDialogSeed,
	saveInstructionScope,
} from "$lib/client/instruction-command";
import InstructionsDialog from "$lib/components/instructions/InstructionsDialog.svelte";
import { t } from "$lib/i18n";
import {
	type InstructionScope,
	instructionScopeKey,
} from "$lib/shared/instructions";
import { showToast } from "$lib/stores/toast";

interface Props {
	/** The project the surface is standing in, or null outside one. */
	projectId?: string | null;
	/**
	 * Called once on mount with the function that opens the dialog, the same
	 * `onComposeReady` pattern the composer uses to hand its own call up.
	 */
	onOpenReady?: ((openWith: OpenInstructionDialog) => void) | undefined;
}

let { projectId = null, onOpenReady }: Props = $props();

let dialogOpen = $state(false);
// Kept after a close so the instance is not rebuilt per open: the dialog
// re-seeds itself from these props on every `open` transition.
let seed = $state<InstructionDialogSeed | null>(null);
let appendedLine = $state<string | null>(null);
// The one thing Review needs that `/instruction` does not: after the save
// succeeded, say that the user answered the offer they were shown. It is
// deliberately not run for a failed save.
let afterSave: (() => void | Promise<void>) | null = $state(null);

async function openWith(
	text: string,
	options?: Parameters<OpenInstructionDialog>[1],
) {
	const trimmed = text.trim();
	if (!trimmed) return;
	try {
		// Read before opening, never during: the dialog seeds its buffers once,
		// from the text in hand at that moment, so a slower read would let Save
		// write the appended line over text the user never saw.
		const next = await loadInstructionDialogSeed(projectId);
		// A suggestion names the scope it targets. It is honoured only when this
		// surface really offers that scope: an offer made in a project that has
		// since been deleted leaves Personal, which is the scope the seed still
		// has text for.
		const requested = options?.scope;
		const scope = requested
			? (next.scopes.find(
					(entry) =>
						instructionScopeKey(entry) === instructionScopeKey(requested),
				) ?? next.scope)
			: next.scope;
		seed = { ...next, scope };
		appendedLine = trimmed;
		afterSave = options?.onSaved ?? null;
		dialogOpen = true;
	} catch {
		// Nothing is opened on a failed read — an editor seeded with blanks
		// would offer to save the appended line as the whole instruction.
		showToast({
			type: "error",
			message: $t("instructions.loadFailed"),
		});
	}
}

async function handleSave(payload: { scope: InstructionScope; text: string }) {
	const result = await saveInstructionScope(payload.scope, payload.text);
	if (!result.ok) {
		return {
			ok: false as const,
			error: result.missing ? $t("projects.missing") : "",
		};
	}
	const onSaved = afterSave;
	afterSave = null;
	dialogOpen = false;
	if (onSaved) {
		// The surface owns what a failed follow-up means (the instruction text
		// is already saved either way), so its error must not reject the save.
		try {
			await onSaved();
		} catch {
			// Ignored on purpose: see above.
		}
	}
	return { ok: true as const };
}

onMount(() => {
	onOpenReady?.((text, options) => void openWith(text, options));
});
</script>

{#if seed}
	<InstructionsDialog
		open={dialogOpen}
		scope={seed.scope}
		scopes={seed.scopes}
		initialText={seed.initialText}
		{appendedLine}
		appendedScope={seed.scope}
		onSave={handleSave}
		onClose={() => (dialogOpen = false)}
	/>
{/if}
