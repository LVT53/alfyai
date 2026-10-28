<!--
	Test-only fixture for DocumentWorkspace.history.test.ts: a body that shows the
	marks the panel hands it and hands marks back (the Image body's Mark does,
	plan 2b T6). Not a real kind body.
-->
<script lang="ts">
import type { ArtifactBodyProps } from "$lib/components/artifacts/artifact-bodies";

let { marks = null, onMarksChange }: ArtifactBodyProps = $props();
</script>

<div data-testid="fake-marks-body" data-letters={(marks?.marks ?? []).map((mark) => mark.letter).join(',')}>
	<button
		type="button"
		data-testid="fake-draw-mark"
		onclick={() =>
			onMarksChange?.({
				imageFileId: 'file-2',
				marks: [{ letter: 'A', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
			})}
	>
		Draw
	</button>
</div>
