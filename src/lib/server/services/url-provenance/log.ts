/**
 * The one log line the provenance rule writes: that an address was refused, and
 * how many. Counts only, never an address, a host or a query: a refused address
 * is the model's own words and may carry exactly the private data the rule
 * exists to keep in (docs/plans/exfil-channels). The `[URL_PROVENANCE]` prefix
 * keeps the line greppable, like the other `[...]` prefixes of the server log.
 */
export function logRefusedAddresses(counts: {
	/** Which tool was asked: `fetch_url` or `produce_file`. */
	tool: string;
	allowed: number;
	refused: number;
}): void {
	if (counts.refused <= 0) return;
	console.info("[URL_PROVENANCE] Refused addresses without a source", {
		tool: counts.tool,
		allowed: counts.allowed,
		refused: counts.refused,
	});
}
