// How a picture's or a clip's panel body reads its item: once when it opens,
// and again whenever the page hears of a newer version than the one it shows
// (a take landing late, Use this, a restore: F23), one read at a time. A read
// that fails, or a body it cannot parse, leaves what is shown; only a body that
// never read anything says it could not open the item.
//
// Call it while the body component initialises: it starts the first read and
// follows `versionNumber` with effects of its own.
import { untrack } from "svelte";
import { fetchArtifact } from "$lib/client/api/artifacts";

export type ItemReader<T> = {
	readonly status: "loading" | "ready" | "error";
	/** The body as last read, or null before the first read. */
	readonly item: T | null;
	/** Reads the item (and whatever `alsoRead` reads with it) again. */
	reload(): void;
};

export function createItemReader<T>(options: {
	artifactId: () => string;
	conversationId: () => string | null;
	/** The newest version the page knows of for this item, or null. */
	versionNumber: () => number | null;
	/** The version body, or null when it is not this kind's. */
	parse: (body: string | null) => T | null;
	/** Each new body, before it is shown, with the one it replaces. */
	onRead?: (next: T, previous: T | null) => void;
	/** Read beside the item on every read (the picture's version strip). */
	alsoRead?: () => void;
}): ItemReader<T> {
	let status = $state<"loading" | "ready" | "error">("loading");
	let item = $state.raw<T | null>(null);
	/** The version `item` is: the page's own number rising past it reads the item again. */
	let loadedVersion = $state(0);
	let loading = false;
	/** A read was asked for while one was out (a restore landing mid-read): one more runs when it answers. */
	let loadAgain = false;

	/** Reads the stored item once and shows it; never throws. */
	async function readOnce(): Promise<void> {
		try {
			const detail = await fetchArtifact(
				options.artifactId(),
				options.conversationId(),
			);
			const parsed = options.parse(detail.artifact.body ?? null);
			const previous = untrack(() => item);
			if (!parsed) {
				if (!previous) status = "error";
				return;
			}
			options.onRead?.(parsed, previous);
			item = parsed;
			loadedVersion = detail.artifact.versionNumber;
			status = "ready";
		} catch {
			if (!untrack(() => item)) status = "error";
		}
	}

	/** One read at a time; a read asked for while one is out runs once that one answers. */
	async function load(): Promise<void> {
		if (loading) {
			loadAgain = true;
			return;
		}
		loading = true;
		do {
			loadAgain = false;
			await readOnce();
		} while (loadAgain);
		loading = false;
	}

	function reload(): void {
		void load();
		options.alsoRead?.();
	}

	// The body is mounted per item (`DocumentWorkspace` keys it), so this runs once.
	$effect(() => {
		untrack(reload);
	});

	// A newer version the page heard of (the poll's rows, any response that
	// announced one) is read here too. Waits for the first read: before it there
	// is nothing to be behind.
	$effect(() => {
		const heard = options.versionNumber();
		if (status !== "ready" || heard === null || heard <= loadedVersion) return;
		untrack(reload);
	});

	return {
		get status() {
			return status;
		},
		get item() {
			return item;
		},
		reload,
	};
}
