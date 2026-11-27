<script lang="ts">
import { t } from "$lib/i18n";
</script>

<details class="bosch-steps">
	<summary>{$t('connections.wizard.bosch.steps')}</summary>
	<ol>
		<li><a href="https://portal.bosch-ebike.com/data-act" target="_blank" rel="noopener noreferrer">Bosch Partner Portal</a> — {$t('connections.wizard.bosch.register')}</li>
		<li>
			{$t('connections.wizard.bosch.client')}
			<dl>
				<dt>Login URL</dt><dd><code>https://ai.alfydesign.com/settings</code></dd>
				<dt>Redirect URI</dt><dd><code>http://127.0.0.1:47831/callback</code></dd>
			</dl>
			{$t('connections.wizard.bosch.submitClient')}
		</li>
		<li><a href="https://flow.bosch-ebike.com/data-act" target="_blank" rel="noopener noreferrer">Bosch Flow</a> — {$t('connections.wizard.bosch.enable')}</li>
		<li>{$t('connections.wizard.bosch.pair')}<p>{$t('connections.wizard.bosch.authorize')}</p></li>
		<li><a href="https://flow.bosch-ebike.com/data-act" target="_blank" rel="noopener noreferrer">Manage Access</a> — {$t('connections.wizard.bosch.bikeAccess')}</li>
	</ol>
	<p>{$t('connections.wizard.bosch.hosting')}</p>
</details>

<style>
	.bosch-steps { margin-block: var(--space-md); font-size: 0.875rem; line-height: 1.5; }
	summary { cursor: pointer; font-weight: 600; }
	ol { list-style: decimal; padding-inline-start: 1.5rem; }
	li, p { margin-block-start: var(--space-sm); }
	dl { margin-block: var(--space-sm); }
	dt { font-weight: 600; }
	dd { margin: 0; overflow-wrap: anywhere; }
	a { text-decoration: underline; text-underline-offset: 0.15em; }
</style>
