import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Which tools tell the envelope that they only read. A tool that does says its
// thrown errors (a timeout, an upstream error) are settled failures the model
// reads and answers from; every other tool's throw stays "uncertain" and ends
// the turn, because a tool that can write anything may have written before it
// threw. So the list is held here, and a new entry is a decision: add a tool only
// when running it twice changes nothing a person could lose (it reads, searches or
// fetches; at most it fills a cache or counts a call), never one that proposes or
// makes a write, a file, a picture, an artifact or a skill session, and never a
// connection tool, whose one call can read or write.
const READ_ONLY_TOOLS = [
	"fetch_url",
	"image_search",
	"memory_context",
	"read_generated_file",
	"research_web",
];

// A tool that looks like a read and is not, with what it writes. Kept off the list
// on purpose.
const READS_THAT_RECORD: Record<string, string> = {
	read_artifact:
		'reading a Document writes the snapshot that "your words win" compares against (ruling 53)',
};

// The tools that run through the envelope in `index.ts` and can write, propose a
// write or make a thing: each one is found below, and keeps the default.
const ENVELOPE_WRITERS = [
	"produce_file",
	"run_python",
	"files",
	"calendar",
	"email",
	"photos",
	"media",
	"contacts",
	"repos",
	"tasks",
	"map_route",
	"location",
];

const here = dirname(fileURLToPath(import.meta.url));

/** Every file of the tools, in every folder of it, tests and their helpers left out. */
const sources = readdirSync(here, { recursive: true })
	.map(String)
	.filter(
		(file) => file.endsWith(".ts") && !/\.test(-helpers)?\.ts$/.test(file),
	)
	.map((file) => ({ file, text: readFileSync(join(here, file), "utf8") }));

/** Every envelope call that names its tool: the tool, and what it says about reading. */
function envelopeCalls(): {
	toolName: string;
	readOnly: boolean;
	mentionsReadOnly: boolean;
}[] {
	return sources.flatMap(({ text }) =>
		text
			.split("executeToolWithEnvelope")
			.slice(1)
			.flatMap((chunk) => {
				// The call's own settings come before its `run:`.
				const run = chunk.search(/\brun:/);
				const head = chunk.slice(0, run === -1 ? 400 : run);
				const toolName = /toolName:\s*"([a-z_]+)"/.exec(head)?.[1];
				return toolName
					? [
							{
								toolName,
								readOnly: /\breadOnly: true,/.test(head),
								mentionsReadOnly: /\breadOnly\b/.test(head),
							},
						]
					: [];
			}),
	);
}

it("lets exactly the tools that only read say so to the envelope", () => {
	const calls = envelopeCalls();

	const sayingSo = calls
		.filter((call) => call.readOnly)
		.map((call) => call.toolName)
		.sort();
	expect(sayingSo).toEqual(READ_ONLY_TOOLS);

	// A renamed or moved call must not leave the list passing on nothing: every tool
	// on it is found, and found once.
	for (const name of READ_ONLY_TOOLS)
		expect(calls.filter((call) => call.toolName === name)).toHaveLength(1);

	// Written any other way (a variable, a shorthand, `!0`) it is not read as an
	// opt-in above, so it is refused here: say it as the literal `readOnly: true,`.
	expect(
		calls.filter((call) => call.mentionsReadOnly && !call.readOnly),
	).toEqual([]);
});

it("finds no opt-in anywhere that the list does not name", () => {
	// A call whose tool name is not written out, one built from an options object,
	// or a flag placed after `run:` would say so unseen above. The envelope's own
	// file defines the option, so it is the one file left out: every other mention
	// of `readOnly` in the tools' source is one of the literal opt-ins counted above.
	const rest = sources
		.filter(({ file }) => file !== "shared.ts")
		.map(({ text }) => text)
		.join("\n");

	expect(rest.match(/\breadOnly\b/g) ?? []).toHaveLength(
		READ_ONLY_TOOLS.length,
	);
	expect(rest.match(/\breadOnly: true,/g) ?? []).toHaveLength(
		READ_ONLY_TOOLS.length,
	);
});

it("keeps every tool that can write, propose a write or make a thing on the default", () => {
	const calls = envelopeCalls();
	const keepsDefault = [...ENVELOPE_WRITERS, ...Object.keys(READS_THAT_RECORD)];

	for (const name of keepsDefault) {
		const found = calls.filter((call) => call.toolName === name);
		expect(found, `${name} runs through the envelope once`).toHaveLength(1);
		expect(found[0]?.readOnly, `${name} keeps the default`).toBe(false);
		expect(READ_ONLY_TOOLS).not.toContain(name);
	}
});
