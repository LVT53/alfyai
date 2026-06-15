ALTER TABLE `provider_models` ADD `fallback_provider_model_id` text REFERENCES `provider_models`(`id`) ON UPDATE no action ON DELETE set null;
