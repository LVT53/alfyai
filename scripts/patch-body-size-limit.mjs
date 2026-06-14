import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BUILD_HANDLER_PATH = join(process.cwd(), "build", "handler.js");
const DEFAULT_BODY_SIZE_LIMIT = "100M";
const TARGET =
	"const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '512K'));";
const REPLACEMENT = `const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '${DEFAULT_BODY_SIZE_LIMIT}'));`;

async function main() {
	const source = await readFile(BUILD_HANDLER_PATH, "utf8");

	if (source.includes(REPLACEMENT)) {
		console.log(
			`[build] BODY_SIZE_LIMIT already defaults to ${DEFAULT_BODY_SIZE_LIMIT}`,
		);
		return;
	}

	if (!source.includes(TARGET)) {
		throw new Error(
			`Could not find BODY_SIZE_LIMIT target in ${BUILD_HANDLER_PATH}`,
		);
	}

	await writeFile(
		BUILD_HANDLER_PATH,
		source.replace(TARGET, REPLACEMENT),
		"utf8",
	);
	console.log(
		`[build] Patched adapter-node BODY_SIZE_LIMIT default to ${DEFAULT_BODY_SIZE_LIMIT}`,
	);
}

main().catch((error) => {
	console.error("[build] Failed to patch BODY_SIZE_LIMIT default:", error);
	process.exit(1);
});
