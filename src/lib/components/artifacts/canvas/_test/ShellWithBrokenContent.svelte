<script lang="ts">
// A block's shell, as a node component draws it, around content that cannot be
// drawn: what keeps one bad block from taking the board down is measured here.
import NodeShell from "../NodeShell.svelte";
import BrokenContent from "./BrokenContent.svelte";

let { id = "broken-1", selected = false }: { id?: string; selected?: boolean } =
	$props();
</script>

<NodeShell {id} kind="chart" {selected} minWidth={240} minHeight={160} title="Budget">
	<BrokenContent />
</NodeShell>
