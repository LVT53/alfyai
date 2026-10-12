<script lang="ts">
// Test-only: renders AppBody with ONE prop that changes, `alfyActivity`, the way
// the panel hands it down (the testing library's own `rerender` replaces every
// prop at once, which re-runs the body's load effect and so cannot tell a reload
// the activity caused from one the rerender did).
import type { DocumentAlfyActivity } from "$lib/components/artifacts/document/alfy-activity";
import AppBody from "./AppBody.svelte";

let { controller }: { controller: { set?: (a: DocumentAlfyActivity | null) => void } } = $props();
let activity = $state.raw<DocumentAlfyActivity | null>(null);
// A plain assignment on the object the test holds; no prop is reassigned.
// svelte-ignore state_referenced_locally
controller.set = (next) => {
	activity = next;
};
</script>

<AppBody
	artifactId="app-1"
	kind="app"
	title="Habit tracker"
	body={null}
	alfyActivity={activity}
/>
