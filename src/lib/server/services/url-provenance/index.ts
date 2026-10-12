/**
 * Where an address came from: the server's half of the rule that an address the
 * app requests without a click comes from the user's own messages or from a
 * tool's result, never from the model's words (docs/plans/exfil-channels; the
 * browser's half, and the vocabulary both compare in, is
 * `$lib/shared/url-provenance`).
 *
 * The one entrance for callers outside this directory, mirroring the artifacts
 * and chat-turn facades:
 * - the per-user source ledger, in memory (`ledger.ts`), asked by the favicon and
 *   thumbnail routes, written by `sources.ts`'s writers;
 * - the per-turn check of the addresses `fetch_url` and `produce_file` are asked
 *   to open (`turn.ts`);
 * - the hosts a report may fetch icons for (`stored-hosts.ts`);
 * - what a tool tells the model when it refuses (`refusal-text.ts`).
 */
import { listConversationProvenanceSources } from "$lib/server/services/messages";
import { resetLedgerForTests } from "./ledger";
import { resetPrefetchNotesForTests } from "./prefetch";
import { createTurnProvenance, type TurnUrlProvenance } from "./turn";

export {
	ledgerHasHost as hasSourceHost,
	ledgerHasThumbnail as hasSourceThumbnail,
} from "./ledger";
export { logRefusedAddresses } from "./log";
export {
	allAddressesRefusedMessage,
	imagesLeftOutWarning,
	type ProvenanceLanguage,
	someAddressesRefusedNote,
} from "./refusal-text";
export {
	noteAtlasJobSources,
	noteAtlasProgressSources,
	noteMessageSources,
	noteSourceUrls,
	noteToolEntrySources,
	noteWebPrefetch,
} from "./sources";
export { hostsWithKnownSource } from "./stored-hosts";
export {
	type AddressPartition,
	NON_PROVENANCE_RESULT_TOOLS,
	PROVENANCE_RESULT_TOOLS,
	type ToolResultObservation,
	type TurnUrlProvenance,
} from "./turn";

/**
 * The provenance of one chat turn's addresses. Cheap to make: the conversation's
 * stored messages are read only when an address first needs them.
 */
export function createTurnUrlProvenance(params: {
	userId: string;
	conversationId: string;
	/** The turn's own user message: it is not stored while the turn runs. */
	requestText?: string;
}): TurnUrlProvenance {
	return createTurnProvenance({
		...params,
		loadStored: () =>
			listConversationProvenanceSources({
				conversationId: params.conversationId,
				userId: params.userId,
			}),
	});
}

/** Forgets the ledger and the prefetch notes. Tests only. */
export function resetUrlProvenanceForTests(): void {
	resetLedgerForTests();
	resetPrefetchNotesForTests();
}
