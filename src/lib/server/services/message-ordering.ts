import { asc, desc } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { messages } from "$lib/server/db/schema";

function messageSequenceOrder() {
	if (!messages.messageSequence) {
		return messages.createdAt ?? messages.id;
	}
	return messages.messageSequence;
}

function messageRowidAsc() {
	if (!messages.messageSequence) {
		return asc(messages.id ?? messages.createdAt);
	}
	return sql`messages.rowid ASC`;
}

function messageRowidDesc() {
	if (!messages.messageSequence) {
		return desc(messages.id ?? messages.createdAt);
	}
	return sql`messages.rowid DESC`;
}

function messageIdAsc() {
	return asc(messages.id ?? messages.createdAt);
}

function messageIdDesc() {
	return desc(messages.id ?? messages.createdAt);
}

export function messageOrderAsc() {
	return [
		asc(messageSequenceOrder()),
		asc(messages.createdAt),
		messageRowidAsc(),
		messageIdAsc(),
	];
}

export function messageOrderDesc() {
	return [
		desc(messageSequenceOrder()),
		desc(messages.createdAt),
		messageRowidDesc(),
		messageIdDesc(),
	];
}

export function messageTimestampOrderAsc() {
	return [
		asc(messages.createdAt),
		asc(messageSequenceOrder()),
		messageRowidAsc(),
		messageIdAsc(),
	];
}

export function messageTimestampOrderDesc() {
	return [
		desc(messages.createdAt),
		desc(messageSequenceOrder()),
		messageRowidDesc(),
		messageIdDesc(),
	];
}
