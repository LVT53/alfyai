import { describe, expect, it } from "vitest";
import { readListView, writeListView } from "./list-view-preference";

describe("a list's view preference", () => {
	const memory = () => {
		const store = new Map<string, string>();
		return {
			store,
			storage: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
			},
		};
	};

	it("reads and writes the view under the key it is given, falling back to the list", () => {
		const { store, storage } = memory();
		expect(readListView("someList", storage)).toBe("list");
		writeListView("someList", "grid", storage);
		expect(store.get("someList")).toBe("grid");
		expect(readListView("someList", storage)).toBe("grid");
		expect(readListView("otherList", storage)).toBe("list");
		store.set("someList", "carousel");
		expect(readListView("someList", storage)).toBe("list");
	});

	it("never throws when storage is blocked or missing", () => {
		const blocked = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(readListView("someList", blocked)).toBe("list");
		expect(() => writeListView("someList", "grid", blocked)).not.toThrow();
		expect(readListView("someList", null)).toBe("list");
	});
});
