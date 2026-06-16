ALTER TABLE `provider_models` ADD `estimated_tokens_per_second` integer;
--> statement-breakpoint
UPDATE `provider_models` SET `guide_badge` = 'simple' WHERE `guide_badge` = 'fast';
