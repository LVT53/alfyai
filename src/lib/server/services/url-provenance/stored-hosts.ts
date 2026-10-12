/**
 * Whether a host is one a tool returned to this user, for a caller that runs
 * outside the chat turn.
 *
 * A report's favicons are fetched by the file-production worker, which can run
 * after a restart (the ledger is in memory and starts empty) and before the turn
 * that asked for the report has been stored. So a host counts when the ledger
 * has it, or when a tool call stored on this conversation returned it; what the
 * stored calls say is written into the ledger, so the next question is answered
 * from memory.
 */
import { listConversationProvenanceSources } from "$lib/server/services/messages";
import { toolSourceHosts } from "$lib/shared/url-provenance";
import { ledgerHasHost, recordLedgerHosts } from "./ledger";

export async function hostsWithKnownSource(params: {
	userId: string;
	conversationId: string;
	/** Hosts in the favicon proxy's form: lowercase, without a leading `www.`. */
	hosts: readonly string[];
}): Promise<Set<string>> {
	const known = new Set<string>();
	const unknown: string[] = [];
	for (const host of params.hosts) {
		if (ledgerHasHost(params.userId, host)) known.add(host);
		else unknown.push(host);
	}
	if (unknown.length === 0) return known;

	let storedHosts: Set<string>;
	try {
		const sources = await listConversationProvenanceSources({
			conversationId: params.conversationId,
			userId: params.userId,
		});
		storedHosts = toolSourceHosts(sources.toolCalls);
	} catch {
		// The read failed: say what the ledger knew, never more.
		return known;
	}
	recordLedgerHosts(params.userId, storedHosts);
	for (const host of unknown) {
		if (storedHosts.has(host)) known.add(host);
	}
	return known;
}
