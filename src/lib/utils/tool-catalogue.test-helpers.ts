import { readFileSync } from "node:fs";

// The model's tool catalogue, as the frozen snapshot holds it
// (`normal-chat-tools/index.test.ts` writes the file). A test that needs "every tool
// the model can call" reads the names from it, so a new tool fails the test that
// owns its words the day it is added to the catalogue.
const CATALOGUE_SNAPSHOT = `${process.cwd()}/src/lib/server/services/normal-chat-tools/tool-catalogue.en.snapshot.txt`;

function readSnapshot(): string {
	return readFileSync(CATALOGUE_SNAPSHOT, "utf8");
}

/** The names of the tools the model is offered, in the order its request sends them. */
export function catalogueToolNames(): string[] {
	return [...readSnapshot().matchAll(/^ {6}"name": "([a-z_]+)"/gm)].map(
		(match) => match[1],
	);
}

/**
 * The values of a tool's `action` input, as the model's catalogue offers them: the
 * enum of the property named `action`. A tool with no such property has none.
 */
export function catalogueToolActions(tool: string): string[] {
	const snapshot = readSnapshot();
	const start = snapshot.search(new RegExp(`^ {6}"name": "${tool}"`, "m"));
	if (start < 0) return [];
	const rest = snapshot.slice(start + 1);
	const next = rest.search(/^ {6}"name": "/m);
	const section = next < 0 ? rest : rest.slice(0, next);
	const enumBlock = section.match(/"action": \{[\s\S]*?"enum": \[([\s\S]*?)\]/);
	if (!enumBlock) return [];
	return [...enumBlock[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}
