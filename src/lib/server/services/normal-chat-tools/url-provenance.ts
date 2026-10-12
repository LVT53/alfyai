/**
 * Puts the provenance rule (docs/plans/exfil-channels) on a turn's tool recorder.
 *
 * Every tool of a turn records through one recorder, so wrapping it is the one
 * place that sees every call: it tells the turn's provenance what each result
 * the model reads contained, and it writes what each call returned into the
 * user's source ledger (the candidates whose source the turn knows). Both
 * happen before the call's result reaches the model and before any event about
 * it reaches the browser, so a favicon or a picture the result names never
 * races its own entry.
 *
 * It must never break a tool call: a failure here is logged without content and
 * the call goes on (the address check then refuses what it did not learn, which
 * is the safe side).
 */
import {
	type AddressPartition,
	noteToolEntrySources,
	type TurnUrlProvenance,
} from "$lib/server/services/url-provenance";
import type { NormalizedProduceFileInput } from "./produce-file";
import type { ToolCallRecorder } from "./shared";

export function withUrlProvenance(
	base: ToolCallRecorder,
	params: { userId: string; provenance: TurnUrlProvenance },
): ToolCallRecorder {
	return {
		record(entry) {
			try {
				// A candidate counts only once the turn knows where its address came
				// from: a result the call returned, or an address the user gave. A
				// search that merely returns the address the model wrote into its
				// own query does not make that host one a tool returned.
				noteToolEntrySources(params.userId, entry, {
					keepCandidate: (candidate) =>
						params.provenance.isKnown(candidate.url),
				});
			} catch {
				console.warn("[URL_PROVENANCE] Could not note a tool call's sources");
			}
			return base.record(entry);
		},
		getEntries: () => base.getEntries(),
		observeResult(result) {
			try {
				params.provenance.noteToolResult(result);
			} catch {
				console.warn(
					"[URL_PROVENANCE] Could not note a tool result's addresses",
				);
			}
			base.observeResult?.(result);
		},
	};
}

/** The address of an `https` picture block, "" when it has none, null for any other block. */
function httpsImageAddress(block: unknown): string | null {
	if (!block || typeof block !== "object") return null;
	const { type, source } = block as { type?: unknown; source?: unknown };
	if (type !== "image" || !source || typeof source !== "object") return null;
	const { kind, url } = source as { kind?: unknown; url?: unknown };
	if (kind !== "https") return null;
	return typeof url === "string" ? url : "";
}

/**
 * A produce_file request without the pictures whose address came from neither
 * the user nor a tool (docs/plans/exfil-channels). A document renderer fetches an
 * `https` picture (the PDF) or embeds it as a remote `<img>` (HTML, Markdown),
 * and the model chooses the address, so a picture nobody supplied is left out
 * and the model is told how many. An inline picture, one from the conversation's
 * own files and every other block are not touched. The result is what is
 * produced and what the same-turn dedupe keys on, so a resend that differs only
 * in a left-out address is the same request.
 */
export async function dropUnsourcedImages(
	input: NormalizedProduceFileInput,
	partition: (urls: readonly string[]) => Promise<AddressPartition>,
): Promise<{
	input: NormalizedProduceFileInput;
	/** How many picture blocks were left out. */
	leftOut: number;
	/** How many `https` pictures stay. */
	kept: number;
}> {
	const blocks = input.documentSource?.blocks;
	if (!input.documentSource || !Array.isArray(blocks)) {
		return { input, leftOut: 0, kept: 0 };
	}
	const addresses = blocks.flatMap((block) => {
		const address = httpsImageAddress(block);
		return address === null ? [] : [address];
	});
	if (addresses.length === 0) return { input, leftOut: 0, kept: 0 };

	const { allowed } = await partition(addresses);
	const allowedAddresses = new Set(allowed);
	const keptBlocks = blocks.filter((block) => {
		const address = httpsImageAddress(block);
		return address === null || allowedAddresses.has(address);
	});
	const leftOut = blocks.length - keptBlocks.length;
	const kept = addresses.length - leftOut;
	if (leftOut === 0) return { input, leftOut: 0, kept };
	return {
		input: {
			...input,
			documentSource: { ...input.documentSource, blocks: keptBlocks },
		},
		leftOut,
		kept,
	};
}
