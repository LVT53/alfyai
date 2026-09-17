// Sanitizing a file-production failure message before it leaves the server.
//
// Two different routes carry the same text outwards: the `produce_file` tool
// result (normal-chat-tools/produce-file.ts) and, on the next turn, the
// "File Jobs" prompt-context section (chat-turn/context-selection.ts) reading
// `errorMessage` straight off the ledger. Both need the same treatment, so it
// lives in a leaf module with no imports rather than in either caller.

// Not every failure message comes from inside the sandbox. `document_render_-
// failed`, `pdf_font_missing`, `generated_document_source_persistence_failed`,
// `program_output_storage_failed` and the sandbox adapter's own catch tail
// (`Execution failed: ${dockerodeError.message}`) are HOST-side Node errors,
// and Node puts the absolute path in the message: `ENOENT ... open
// '/opt/alfyai/node_modules/pdfjs-dist/...'`, `connect ENOENT
// /var/run/docker.sock`. That message is handed to the model AND replayed in
// the next turn's prompt, so it must not describe the deployment's filesystem.
//
// Only host roots are scrubbed. The container's own paths are what make a
// traceback actionable, so `/output/report.xlsx`, `/usr/lib/python3.11/...`
// and `/app/main.py` are deliberately left intact.
const HOST_PATH_PATTERNS: RegExp[] = [
	// Absolute paths under a root that only exists on the host. The lookahead
	// anchors the whole segment, so `/optional` is not mistaken for `/opt`.
	/\/(?:Users|home|root|private|var|opt|srv|etc|mnt|media|snap)(?=\/)[^\s'"`)\]]*/g,
	// The deployment checkout's own dependencies, wherever they live.
	/[^\s'"`)\]]*\/node_modules\/[^\s'"`)\]]*/g,
];

/** Replaces host filesystem paths with `<path>` so a deployment's directory
 * layout never reaches the model or the prompt. */
export function redactHostPathsFromFileProductionMessage(
	message: string,
): string {
	let redacted = message;
	for (const pattern of HOST_PATH_PATTERNS) {
		redacted = redacted.replace(pattern, "<path>");
	}
	return redacted;
}
