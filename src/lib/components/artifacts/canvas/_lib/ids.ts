/**
 * One way to mint an id on a board, for everything the board creates: a
 * stroke, a block, a connection, a pin's reply. `${prefix}-${base36 time}-
 * ${base36 counter}`: short, readable in the board JSON, and unique within a
 * session (the counter) and across them (the time). The body's limit is 128
 * characters; a prefix is a word, so nothing here comes near it.
 */
let counter = 0;

export function newId(prefix: string): string {
	counter += 1;
	return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
