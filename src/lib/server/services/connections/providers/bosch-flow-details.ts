import { boschFieldGroups } from "./bosch-flow-fields";

export const boschDetailActions = [
	"bike_profile",
	"bike_pass",
	"bike_registration",
	"service_history",
	"software_updates",
	"battery_capacity",
	"ride_detail",
	"ride_stream",
	"ride_fitness",
	"ride_route",
] as const;
type Action = (typeof boschDetailActions)[number];
export type BoschDetailGrant = "details" | "location" | "fitness";
export type BoschDetailQuery = {
	action: Action;
	id: string;
	offset?: number;
	field?: string;
	textOffset?: number;
	batteryIndex?: number;
};
type Field = {
	path: string;
	value: string | number | boolean | null;
	nextTextOffset?: number;
};
export type BoschDetailResult = { fields: Field[]; nextOffset: number | null };

export function requiredBoschGrant(query: BoschDetailQuery): BoschDetailGrant {
	if (query.action === "ride_route") return "location";
	if (query.action === "ride_fitness") return "fitness";
	return "details";
}

function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}
const allowed = new Map<
	Action,
	{ leaves: Set<string>; branches: Set<string> }
>();
for (const action of boschDetailActions) {
	const leaves = new Set<string>(),
		branches = new Set<string>([""]);
	for (const row of boschFieldGroups[action].trim().split("\n")) {
		const [parent, ...names] = row.trim().split(/\s+/);
		for (const name of names) {
			const path = parent === "-" ? name : `${parent}.${name}`;
			const parts = path.replaceAll("[]", ".#").split(".");
			leaves.add(parts.join("."));
			for (let i = 1; i < parts.length; i++)
				branches.add(parts.slice(0, i).join("."));
		}
	}
	allowed.set(action, { leaves, branches });
}

const maxOffset = 2000000,
	maxFields = 48,
	maxText = 1024,
	pageChars = 6500;
const normal = (path: string) => path.replace(/(?:^|\.)\d+(?=\.|$)/g, ".#");
const matchesField = (path: string, field?: string) =>
	!field || path === field || path.startsWith(`${field}.`);
export function parseBoschDetailQuery(raw: unknown): BoschDetailQuery | null {
	if (
		!record(raw) ||
		!boschDetailActions.some((a) => a === raw.action) ||
		typeof raw.id !== "string" ||
		!/^[A-Za-z0-9_-]{1,150}$/.test(raw.id) ||
		Object.keys(raw).some(
			(k) =>
				![
					"action",
					"id",
					"offset",
					"field",
					"textOffset",
					"batteryIndex",
				].includes(k),
		)
	)
		return null;
	const action = raw.action as Action;
	const rules = allowed.get(action);
	if (
		raw.offset !== undefined &&
		(typeof raw.offset !== "number" ||
			!Number.isSafeInteger(raw.offset) ||
			raw.offset < 0 ||
			raw.offset > maxOffset)
	)
		return null;
	if (
		raw.batteryIndex !== undefined &&
		(action !== "battery_capacity" ||
			typeof raw.batteryIndex !== "number" ||
			!Number.isSafeInteger(raw.batteryIndex) ||
			raw.batteryIndex < 0 ||
			raw.batteryIndex >= 50)
	)
		return null;
	if (
		raw.field !== undefined &&
		(typeof raw.field !== "string" ||
			raw.field.length > 240 ||
			!/^[A-Za-z][A-Za-z0-9]*(?:\.(?:[A-Za-z][A-Za-z0-9]*|0|[1-9]\d{0,6}))*$/.test(
				raw.field,
			) ||
			!(
				rules?.leaves.has(normal(raw.field)) ||
				rules?.branches.has(normal(raw.field))
			))
	)
		return null;
	if (
		raw.textOffset !== undefined &&
		(typeof raw.textOffset !== "number" ||
			!Number.isSafeInteger(raw.textOffset) ||
			raw.textOffset < 0 ||
			raw.textOffset > 12 * 1024 * 1024 ||
			raw.offset ||
			typeof raw.field !== "string" ||
			!rules?.leaves.has(normal(raw.field)))
	)
		return null;
	return {
		action,
		id: raw.id,
		...(raw.offset ? { offset: raw.offset } : {}),
		...(raw.field ? { field: raw.field } : {}),
		...(raw.textOffset ? { textOffset: raw.textOffset } : {}),
		...(raw.batteryIndex ? { batteryIndex: raw.batteryIndex } : {}),
	};
}

export function projectBoschDetail(
	query: BoschDetailQuery,
	source: unknown,
): BoschDetailResult {
	const result: BoschDetailResult = { fields: [], nextOffset: null };
	const rules = allowed.get(query.action);
	if (!rules) return result;
	let seen = 0,
		chars = 0;
	const offset = query.offset ?? 0;
	function visit(value: unknown, path: string, pattern: string) {
		if (result.nextOffset !== null || !rules) return;
		if (
			rules.leaves.has(pattern) &&
			matchesField(path, query.field) &&
			(value === null ||
				typeof value === "boolean" ||
				typeof value === "string" ||
				(typeof value === "number" && Number.isFinite(value)))
		) {
			if (seen++ < offset) return;
			const entry: Field = { path, value };
			const from = query.textOffset ?? 0;
			if (from && (typeof value !== "string" || value.length <= from)) return;
			if (typeof value === "string") {
				entry.value = value.slice(from, from + maxText);
				if (from + maxText < value.length)
					entry.nextTextOffset = from + maxText;
			}
			const size = JSON.stringify(entry).length;
			if (result.fields.length >= maxFields || chars + size > pageChars) {
				result.nextOffset = offset + result.fields.length;
				return;
			}
			chars += size;
			result.fields.push(entry);
			return;
		}
		if (!rules.branches.has(pattern)) return;
		if (
			query.field &&
			path &&
			!matchesField(path, query.field) &&
			!matchesField(query.field, path)
		)
			return;
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length && result.nextOffset === null; i++)
				visit(value[i], `${path}.${i}`, `${pattern}.#`);
		} else if (record(value)) {
			for (const key of Object.keys(value).sort()) {
				if (result.nextOffset !== null) break;
				if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) continue;
				visit(
					value[key],
					path ? `${path}.${key}` : key,
					pattern ? `${pattern}.${key}` : key,
				);
			}
		}
	}
	visit(source, "", "");
	return result;
}

export function parseBoschDetailResult(
	query: BoschDetailQuery,
	raw: unknown,
): BoschDetailResult | null {
	if (
		!record(raw) ||
		Object.keys(raw).length !== 2 ||
		!Array.isArray(raw.fields) ||
		raw.fields.length > maxFields
	)
		return null;
	const fields: Field[] = [];
	let totalChars = 0;
	const seen = new Set<string>();
	const rules = allowed.get(query.action);
	for (const f of raw.fields) {
		if (
			!record(f) ||
			Object.keys(f).some(
				(k) => !["path", "value", "nextTextOffset"].includes(k),
			) ||
			typeof f.path !== "string" ||
			f.path.length > 240 ||
			!/^[a-zA-Z][a-zA-Z0-9]*(?:\.(?:[a-zA-Z][a-zA-Z0-9]*|0|[1-9]\d{0,6}))*$/.test(
				f.path,
			) ||
			!rules?.leaves.has(normal(f.path)) ||
			!matchesField(f.path, query.field) ||
			seen.has(f.path)
		)
			return null;
		const v = f.value;
		if (query.textOffset && typeof v !== "string") return null;
		if (
			v !== null &&
			typeof v !== "boolean" &&
			!(typeof v === "number" && Number.isFinite(v)) &&
			!(typeof v === "string" && v.length <= maxText)
		)
			return null;
		if (
			f.nextTextOffset !== undefined &&
			(f.nextTextOffset !== (query.textOffset ?? 0) + maxText ||
				typeof v !== "string" ||
				v.length !== maxText)
		)
			return null;
		fields.push({
			path: f.path,
			value: v,
			...(typeof f.nextTextOffset === "number"
				? { nextTextOffset: f.nextTextOffset }
				: {}),
		});
		totalChars += JSON.stringify(fields[fields.length - 1]).length;
		if (totalChars > pageChars) return null;
		seen.add(f.path);
	}
	const next = raw.nextOffset;
	if (
		next !== null &&
		(typeof next !== "number" ||
			fields.length === 0 ||
			next !== (query.offset ?? 0) + fields.length ||
			next > maxOffset)
	)
		return null;
	return { fields, nextOffset: next };
}
