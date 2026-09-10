// Settings-related i18n strings

const settingsDict = {
	en: {
		"admin.activeSessions": "Active sessions",
		"admin.addModel": "Add Model",
		"admin.addModelAlias": "Add alias",
		"admin.addProvider": "Add Provider",
		"admin.admin": "Admin",
		"admin.admins": "Admins",
		"admin.allRoles": "All roles",
		"admin.apiKey": "API Key",
		"admin.apiKeyPlaceholder": "sk-...",
		"admin.appVersion": "Application version",
		"admin.appVersionOverride": "App version override",
		"admin.appVersionOverrideDescription": `Leave empty to display the package version. Set a value to silently override the app version badge without publishing a campaign.`,
		"admin.atlas": "Atlas",
		"admin.atlasAuditModel": "Atlas Audit Model",
		"admin.atlasAuditModelDescription":
			"Reviews the assembled Atlas against accepted sources and produces Claim Basis data for Basis Markers.",
		"admin.atlasDescription":
			"Long-running Atlas research turns, source search, quality gates, and completion worker settings.",
		"admin.atlasGlobalActiveLimit": "Global Active Atlas Limit",
		"admin.atlasLimitsDescription":
			"Global active limit caps concurrent Atlas jobs across the server. Search concurrency and batch delay control web-search pressure during each Atlas run.",
		"admin.atlasSearchBatchDelayMs": "Search Batch Delay (ms)",
		"admin.atlasSearchConcurrency": "Search Concurrency",
		"admin.atlasParallelDependency":
			"Atlas also requires a Parallel API Key in Web Research. Without Parallel, the chat composer shows Atlas as unavailable.",
		"admin.atlasSynthesisModel": "Atlas Synthesis Model",
		"admin.atlasSynthesisModelDescription":
			"Writes the staged Atlas findings, outline, and report body.",
		"admin.atlasWebPushDescription":
			"Browser push is optional. When VAPID keys are configured, Atlas can notify users after a report finishes while they are away from the app.",
		"admin.atlasWorkerDescription":
			"Controls whether Atlas jobs can be started and processed by the background worker.",
		"admin.atlasWorkerEnabled": "Enable Atlas Worker",
		"admin.basePromptDescription":
			"Base prompt for that language. Leave empty to rely on few-shot examples only.",
		"admin.baseUrl": "Base URL",
		"admin.baseUrlPlaceholder": "e.g. https://api.openai.com/v1",
		"admin.braveSearchApiKey": "Brave Search API Key",
		"admin.braveSearchApiKeyDescription":
			"API key for the Brave Search image-search service. Leave empty to disable Brave-backed image search.",
		"admin.campaigns.actionLabelEn": "English action label",
		"admin.campaigns.actionLabelHu": "Hungarian action label",
		"admin.campaigns.actionUrl": "Action URL",
		"admin.campaigns.addSetupSlide": "Add setup slide",
		"admin.campaigns.addStandardSlide": "Add standard slide",
		"admin.campaigns.altEn": "English image alt text",
		"admin.campaigns.altHu": "Hungarian image alt text",
		"admin.campaigns.analytics": "Views / actions",
		"admin.campaigns.analyticsAutoShown": "{count} shown",
		"admin.campaigns.analyticsCompleted": "{count} finished",
		"admin.campaigns.archive": "Archive",
		"admin.campaigns.archiveConfirm": "Archive this campaign?",
		"admin.campaigns.assetAttached": "Attached: {id}",
		"admin.campaigns.assetMissing": "No crop attached.",
		"admin.campaigns.bodyEn": "English body",
		"admin.campaigns.bodyHu": "Hungarian body",
		"admin.campaigns.create": "Create campaign",
		"admin.campaigns.createName": "New campaign",
		"admin.campaigns.createNamePlaceholder": "Campaign name",
		"admin.campaigns.createdAt": "Created",
		"admin.campaigns.cropTitle": "Crop campaign screenshot",
		"admin.campaigns.dateMissing": "Not set",
		"admin.campaigns.deleteDraft": "Delete draft",
		"admin.campaigns.deleteDraftConfirm":
			"Delete this draft campaign? This cannot be undone.",
		"admin.campaigns.description": `Author first-run and release campaign modals with localized copy, screenshots, publishing checks, and exact user-facing previews.`,
		"admin.campaigns.desktopAsset": "Desktop screenshot",
		"admin.campaigns.duplicate": "Duplicate",
		"admin.campaigns.editorLabel": "Campaign editor",
		"admin.campaigns.empty": "No campaigns yet.",
		"admin.campaigns.errors.archive": "Failed to archive campaign.",
		"admin.campaigns.errors.assetUpload":
			"Failed to upload campaign screenshot.",
		"admin.campaigns.errors.create": "Failed to create campaign.",
		"admin.campaigns.errors.delete": "Failed to delete campaign draft.",
		"admin.campaigns.errors.detail": "Failed to load campaign.",
		"admin.campaigns.errors.duplicate": "Failed to duplicate campaign.",
		"admin.campaigns.errors.load": "Failed to load campaigns.",
		"admin.campaigns.errors.publish": "Failed to publish campaign.",
		"admin.campaigns.errors.save": "Failed to save campaign.",
		"admin.campaigns.errors.seed": "Failed to seed first-run campaign.",
		"admin.campaigns.history": "History",
		"admin.campaigns.listLabel": "Campaign list",
		"admin.campaigns.loading": "Loading campaigns…",
		"admin.campaigns.loadingDetail": "Loading campaign…",
		"admin.campaigns.messages.archived": "Campaign archived.",
		"admin.campaigns.messages.created": "Campaign created.",
		"admin.campaigns.messages.deleted": "Campaign draft deleted.",
		"admin.campaigns.messages.duplicated": "Campaign duplicated.",
		"admin.campaigns.messages.published": "Campaign published.",
		"admin.campaigns.messages.saved": "Campaign draft saved.",
		"admin.campaigns.messages.seedExists": "First-run campaign already exists.",
		"admin.campaigns.messages.seeded": "First-run campaign seeded.",
		"admin.campaigns.mobileAsset": "Mobile screenshot",
		"admin.campaigns.moveDownA11y": "Move {title} down",
		"admin.campaigns.moveUpA11y": "Move {title} up",
		"admin.campaigns.name": "Name",
		"admin.campaigns.noSlides": "Add at least one slide before publishing.",
		"admin.campaigns.noValidationErrors": "No backend validation errors.",
		"admin.campaigns.preview": "Preview",
		"admin.campaigns.previewLabel": "Campaign preview and history",
		"admin.campaigns.previewLanguage": "Preview language",
		"admin.campaigns.previewNote":
			"Admin preview only. No analytics or user state is written.",
		"admin.campaigns.publish": "Publish",
		"admin.campaigns.publishChecklist": "Publish checklist",
		"admin.campaigns.publishedAt": "Published",
		"admin.campaigns.releaseVersion": "Release",
		"admin.campaigns.saveDraft": "Save draft",
		"admin.campaigns.seedFirstRun": "Seed first-run",
		"admin.campaigns.seedFirstRunHelp":
			"Creates the standard first-run onboarding campaign as a draft you can edit.",
		"admin.campaigns.selectCampaign": "Select a campaign to edit.",
		"admin.campaigns.slideCount":
			"{count} slide{count, plural, one {} other {s}}",
		"admin.campaigns.slideEditorLabel": "Slide {number} editor",
		"admin.campaigns.slideKind": "Slide kind",
		"admin.campaigns.slideKind.setup": "Setup",
		"admin.campaigns.slideKind.standard": "Standard",
		"admin.campaigns.slideNumber": "Slide {number}",
		"admin.campaigns.slides": "Slides",
		"admin.campaigns.status.archived": "Archived",
		"admin.campaigns.status.draft": "Draft",
		"admin.campaigns.status.published": "Published",
		"admin.campaigns.title": "Campaigns",
		"admin.campaigns.titleEn": "English title",
		"admin.campaigns.titleHu": "Hungarian title",
		"admin.campaigns.type": "Type",
		"admin.campaigns.type.feature": "Feature",
		"admin.campaigns.type.firstRun": "First-run",
		"admin.campaigns.type.release": "Release",
		"admin.campaigns.type.standard": "Standard",
		"admin.campaigns.updatedAt": "Updated",
		"admin.campaigns.uploadDesktop": "Upload desktop crop",
		"admin.campaigns.uploadMobile": "Upload mobile crop",
		"admin.campaigns.uploadingAsset": "Uploading screenshot…",
		"admin.campaigns.validation.actionDestinationInvalid":
			"Action destination must be an allowlisted internal route.",
		"admin.campaigns.validation.actionLabelsRequired":
			"Action labels are required in English and Hungarian when an action is configured.",
		"admin.campaigns.validation.dataDisclosureRequired":
			"First-run onboarding requires at least one data-disclosure standard slide.",
		"admin.campaigns.validation.desktopAssetRequired":
			"Desktop crop asset is required.",
		"admin.campaigns.validation.imageAltRequired":
			"Localized EN/HU alt text is required when an image is uploaded.",
		"admin.campaigns.validation.localizedContentRequired":
			"Localized EN/HU title and body are required.",
		"admin.campaigns.validation.mobileAssetRequired":
			"Mobile crop asset is required.",
		"admin.campaigns.validation.nameRequired": "Campaign name is required.",
		"admin.campaigns.validation.releaseVersionRequired":
			"Release/update campaigns require a linked app version.",
		"admin.campaigns.validation.semanticRoleInvalid":
			"Slide semantic role is invalid.",
		"admin.campaigns.validation.setupControlsPlacementInvalid":
			"Setup controls are only allowed on first-run setup slides.",
		"admin.campaigns.validation.setupControlsUnsupported":
			"Setup controls include an unsupported preference control.",
		"admin.campaigns.validation.setupSlideRequired":
			"First-run onboarding requires exactly one setup slide.",
		"admin.campaigns.validation.slideLayoutInvalid":
			"Slide layout must be setup or standard.",
		"admin.campaigns.validation.slideRequired":
			"At least one slide is required.",
		"admin.campaigns.validation.sortOrderInvalid":
			"Slide order must use unique positive integers.",
		"admin.campaigns.validation.typeInvalid":
			"Campaign type must be first-run onboarding or release update.",
		"admin.campaigns.versionShort": "v{version}",
		"admin.capability.chat": "Chat",
		"admin.capability.fileMessageParts": "Files",
		"admin.capability.imageMessageParts": "Images",
		"admin.capability.modelsEndpoint": "Models API",
		"admin.capability.reasoningControls": "Reasoning",
		"admin.capability.streaming": "Streaming",
		"admin.capability.structuredOutput": "Structured output",
		"admin.capability.tools": "Tools",
		"admin.capability.usageReporting": "Usage",
		"admin.capabilityState.detected": "Detected",
		"admin.capabilityState.manualOverride": "Manual override",
		"admin.capabilityState.manualOverrideSupported":
			"Manual override: supported",
		"admin.capabilityState.manualOverrideUnsupported":
			"Manual override: not supported",
		"admin.capabilityState.notDetected": "Not detected",
		"admin.capabilityState.unknown": "Unknown",
		"admin.checkConnection": "Check Connection",
		"admin.checking": "Checking…",
		"admin.codeAppendixDescription":
			"Optional extra lines appended only when the conversation looks code-related.",
		"admin.compactionUiThreshold": "Compaction UI Threshold (tokens)",
		"admin.completionTokens": "Completion tokens",
		"admin.composerCommandRegistry": "Composer Command Registry",
		"admin.composerCommandRegistryDescription":
			"Expose the Normal Chat command registry shell. Runtime skill behavior stays inactive until later slices are enabled.",
		"admin.composerCommandRegistryEnabled": "Enable Composer Command Registry",
		"admin.connected": "Connected",
		"admin.contextLimits": "Context Limits",
		"admin.contextLimitsDescription": "Leave empty to use global defaults.",
		"admin.contextLimitsDescriptionBuiltIn":
			"Leave empty to use global defaults.",
		"admin.contextLimitsDescriptionProvider":
			"Max Model Context is required for third-party providers.",
		"admin.contextSummarizer": "Context Summarizer",
		"admin.contextSummarizerModel": "Context Summarizer Model",
		"admin.contextSummarizerUrl": "Context Summarizer URL",
		"admin.conversations": "Conversations",
		"admin.createUser": "Create User",
		"admin.createUserDescription":
			"Create a new local account and optionally grant it admin access immediately.",
		"admin.createUserTitle": "Create User",
		"admin.creating": "Creating…",
		"admin.defaultNewUserModel": "Default model for new users",
		"admin.defaultNewUserModelDescription": `Choose the initial preferred model assigned to newly created users. Enabled providers are listed first; built-in models remain available.`,
		"admin.deleteAccount": "Delete Account",
		"admin.deleteAccountDescription": `This permanently deletes your account, chats, Knowledge Base, memories, generated files, profile preferences, and avatar. Historical analytics remain as immutable usage records. This cannot be undone.`,
		"admin.deletePermanently": "Delete permanently",
		"admin.deleteProviderConfirm": 'Delete provider "{name}"?',
		"admin.deleteUser": "Delete User",
		"admin.deleteUserConfirmButton": "Delete User",
		"admin.deleteUserConfirmMessage":
			"This will permanently delete the selected user account, chats, and stored data. This cannot be undone.",
		"admin.deleteUserConfirmTitle": "Delete User",
		"admin.deleting": "Deleting…",
		"admin.demoteToUser": "Demote to User",
		"admin.disabled": "Disabled",
		"admin.disconnected": "Disconnected",
		"admin.discoverModels": "Discover models",
		"admin.displayName": "Display Name",
		"admin.displayNamePlaceholder": "e.g. Model 1",
		"admin.doNotSend": "Do not send",
		"admin.editModel": "Edit Model",
		"admin.editProvider": "Edit Provider",
		"admin.email": "Email",
		"admin.emailPlaceholder": "user@example.com",
		"admin.enabled": "Enabled",
		"admin.enterPasswordConfirm": "Enter your password to confirm:",
		"admin.failedDeleteProvider": "Failed to delete provider.",
		"admin.failedLoadProviders": "Failed to load providers.",
		"admin.failedSave": "Failed to save.",
		"admin.failedValidateProvider": "Failed to validate provider.",
		"admin.favoriteModel": "Favorite model",
		"admin.fillRequiredBuiltIn":
			"Fill in display name, base URL, and model name.",
		"admin.fillRequiredFields": "Fill in all required provider fields.",
		"admin.fillRequiredProviderContext":
			"Set Max Model Context for this provider.",
		"admin.fillRequiredRateLimitFallback":
			"Fill in all enabled rate-limit fallback fields.",
		"admin.hide": "Hide",
		"admin.high": "High",
		"admin.invalidRateLimitFallbackTimeout":
			"Fallback timeout must be a whole number of at least 1000 ms.",
		"admin.joined": "Joined",
		"admin.lastActive": "Last active",
		"admin.loadingModels": "Loading models...",
		"admin.loadingUsers": "Loading users…",
		"admin.local": "Local",
		"admin.low": "Low",
		"admin.max": "Max",
		"admin.maxFileUploadDescription":
			"Maximum file upload size in bytes (default 104857600 = 100MB).",
		"admin.maxFileUploadSize": "Max File Upload Size (bytes)",
		"admin.maxMessageLength": "Max Message Length (characters)",
		"admin.maxMessageLengthDescription": `Global fallback used before a model-specific cap is known. Leave empty to use the lowest enabled model's max message length.`,
		"admin.maxMessageLengthLabel": "Max Message Length (chars)",
		"admin.maxModelContext": "Max Model Context (tokens)",
		"admin.maxModelContextLabel": "Max Model Context (tokens)",
		"admin.autoCalculatedFromMaxContext":
			"Auto-calculated from Max Model Context",
		"admin.maxModelContextRequired":
			"Required for third-party providers. This is the total input plus output context window.",
		"admin.maxTokens": "Max Tokens",
		"admin.maxTokensDescription": `Passed to the selected model as \`max_tokens\`. Leave empty to use the provider default.`,
		"admin.maxTokensPlaceholder": "Use provider default",
		"admin.medium": "Medium",
		"admin.memory": "Memory",
		"admin.memoryConsolidationModel": "Memory consolidation model",
		"admin.memoryConsolidationModelDescription": `Runs the nightly clean-up and writes the "What I remember about you" summary.`,
		"admin.memoryJudgeModel": "Memory judge model",
		"admin.memoryJudgeModelDescription":
			"Runs the judge that decides what to remember from each conversation. Defaults to your primary chat model.",
		"admin.minimal": "Minimal",
		"admin.messages": "Messages",
		"admin.mineruApiDescription": `MinerU API server endpoint. Run \`docker run -d --name mineru -p 8001:8001 opendatalab/mineru:latest\` to start the service.`,
		"admin.mineruApiUrl": "MinerU API URL",
		"admin.mineruDocumentExtraction": "MinerU Document Extraction",
		"admin.mineruTimeoutDescription":
			"Maximum time to wait for a response from MinerU. Increase for large documents.",
		"admin.mineruTimeoutMs": "MinerU Timeout (ms)",
		"admin.model1": "Model 1",
		"admin.model1ApiKey": "Model 1 API Key",
		"admin.model1BaseUrl": "Model 1 Base URL",
		"admin.model1CompactionThreshold": "Model 1 Compaction Threshold",
		"admin.model1DisplayName": "Model 1 Display Name",
		"admin.model1IconAssetId": "Model 1 Icon Asset ID",
		"admin.model1MaxMessageLength": "Model 1 Max Message Length",
		"admin.model1MaxModelContext": "Model 1 Max Context",
		"admin.model1Name": "Model 1 Name",
		"admin.model1SystemPrompt": "Model 1 System Prompt",
		"admin.model1TargetContext": "Model 1 Target Context",
		"admin.model2": "Model 2",
		"admin.model2ApiKey": "Model 2 API Key",
		"admin.model2BaseUrl": "Model 2 Base URL",
		"admin.model2CompactionThreshold": "Model 2 Compaction Threshold",
		"admin.model2DisplayName": "Model 2 Display Name",
		"admin.model2Enabled": "Enable Model 2",
		"admin.model2IconAssetId": "Model 2 Icon Asset ID",
		"admin.model2MaxMessageLength": "Model 2 Max Message Length",
		"admin.model2MaxModelContext": "Model 2 Max Context",
		"admin.model2Name": "Model 2 Name",
		"admin.model2SystemPrompt": "Model 2 System Prompt",
		"admin.model2TargetContext": "Model 2 Target Context",
		"admin.model2Visibility": "Model 2 Visibility",
		"admin.model2VisibilityDescription":
			"Hide model 2 from the app and force fallbacks to model 1",
		"admin.modelCapabilities": "Capabilities",
		"admin.modelAliasCanonicalCollision":
			"Alias cannot match the canonical model name.",
		"admin.modelAliasInputA11y": "Alias {number}",
		"admin.modelAliasPlaceholder": "e.g. accounts/fireworks/models/qwen3p7-max",
		"admin.modelAliases": "Model aliases",
		"admin.modelAliasesDescription":
			"Alternative provider model IDs for gateways such as Fireworks AI.",
		"admin.modelIcon": "Model Icon",
		"admin.modelIconCropTitle": "Crop model icon",
		"admin.modelIconProviderMissing":
			"Could not find the provider for this icon upload. Close the form and try again.",
		"admin.modelIconReadFailed": "Could not read the selected image.",
		"admin.modelIconSelected": "Selected: {name}",
		"admin.modelIconSquareRequired": "Model icon must use a 1:1 image ratio.",
		"admin.modelIconUpdated": "Model icon updated.",
		"admin.modelIconUploadFailed": "Failed to upload model icon.",
		"admin.modelIconUploading": "Uploading...",
		"admin.modelName": "Model Name",
		"admin.modelNamePlaceholderBuiltIn": "e.g. model-1",
		"admin.modelNamePlaceholderProvider":
			"e.g. accounts/fireworks/models/llama-v3-70b",
		"admin.modelFallbackLabel": "Model-specific fallback",
		"admin.modelFallbackNone": "No model-specific fallback",
		"admin.modelFallbackNoCompatibleOptions":
			"No compatible model-specific fallback is available for this model.",
		"admin.modelFallbackProviderWarning":
			"Some models have no compatible fallback",
		"admin.modelFallbackModelWarning": "No compatible fallback",
		"admin.modelFallbackReasonDisabledTarget": "Model is disabled.",
		"admin.modelFallbackReasonCapabilitySource":
			"Source model needs {capability}.",
		"admin.modelFallbackReasonCapabilityFallback":
			"Fallback model needs {capability}.",
		"admin.modelFallbackReasonUnknownSourceCapability":
			"Source model capability {capability} is unknown.",
		"admin.modelFallbackReasonGeneric": "Incompatible",
		"admin.modelTimeoutFailoverDescription": `Used when the selected provider model has no compatible model-specific fallback. Retryable model failures can retry once with this global fallback model.`,
		"admin.modelTimeoutFailoverEnabled": "Enable global model fallback",
		"admin.modelTimeoutFailoverTargetModel": "Global fallback model",
		"admin.modelTimeoutFailoverTimeoutMs": "Fallback timeout (ms)",
		"admin.manageModels": "Manage models",
		"admin.models": "Models",
		"admin.modelGuide": "Model guide",
		"admin.modelGuideBadge": "Guide badge",
		"admin.modelGuideDescription":
			"Short user-facing guidance only. These fields do not affect routing, fallback, prompts, or costs.",
		"admin.modelGuideNoCost": "Show as no cost",
		"admin.modelGuideNoCostDescription":
			"Use for local or bundled models where the guide should not show unknown cost.",
		"admin.modelEstimatedSpeed": "Estimated speed",
		"admin.modelEstimatedSpeedDescription":
			"Optional tokens/sec estimate used only to infer the guide speed badge.",
		"admin.modelEstimatedSpeedPlaceholder": "e.g. 150",
		"admin.modelGuideNoteEn": "English guide note",
		"admin.modelGuideNoteHu": "Hungarian guide note",
		"admin.modelGuideNotePlaceholder": "Best for long document work.",
		"admin.mostChats": "Most chats",
		"admin.mostMessages": "Most messages",
		"admin.mostRecent": "Most recent",
		"admin.mostTokens": "Most tokens",
		"admin.nameId": "Name (ID)",
		"admin.nameIdDescription": "Immutable identifier used in model selection.",
		"admin.nameIdPlaceholder": "e.g. fireworks-ai",
		"admin.noModelsYet": "No models yet.",
		"admin.noProvidersYet": "No providers yet.",
		"admin.noUsersMatch": "No users match the current filters.",
		"admin.none": "None",
		"admin.pricing": "Pricing",
		"admin.pricingMicroDollars": "Micro-dollars per 1M tokens",
		"admin.pricingPer1m": "USD per 1M tokens",
		"admin.advancedCachePricing": "Advanced cache pricing",
		"admin.advancedCachePricingDescription":
			"Use this only for providers that bill cache writes or cache misses at a different rate. Leave it empty to use the regular input price.",
		"admin.cacheWriteMissPrice": "Cache write / miss",
		"admin.cacheWriteMissPlaceholder": "Use input price",
		"admin.inputPrice": "Input",
		"admin.cachedInputPrice": "Cached Input",
		"admin.cacheHitPrice": "Cache Hit",
		"admin.cacheMissPrice": "Cache Miss",
		"admin.outputPrice": "Output",
		"admin.openAiCompatible": "OpenAI-compatible",
		"admin.optionalDisplayName": "Optional display name",
		"admin.parallelApiKey": "Parallel API Key",
		"admin.parallelApiKeyDescription":
			"API key for the Parallel web search and research service. Leave empty to disable Parallel-backed web research.",
		"admin.password": "Password",
		"admin.passwordPlaceholder": "At least 8 characters",
		"admin.profileTabNote": `Use the Profile tab for your own account changes. Admin role, session revocation, and deletion are disabled here for the current user.`,
		"admin.promoteToAdmin": "Promote to Admin",
		"admin.providerAdded": "Provider added.",
		"admin.providerDefault": "Provider default",
		"admin.providerDeleted": "Provider deleted.",
		"admin.providerUpdated": "Provider updated.",
		"admin.providerValid": '"{name}" is valid.',
		"admin.providerPrivacyPolicy": "Privacy policy URL",
		"admin.providerPrivacyPolicyDescription":
			"Optional link shown from the model guide, not in the compact selector.",
		"admin.providerPrivacyPolicyPlaceholder":
			"https://provider.example/privacy",
		"admin.providerProcessingRegion": "Processing region",
		"admin.providerProcessingRegionDescription":
			"Optional two-letter country code used as a compact privacy cue.",
		"admin.providerProcessingRegionPlaceholder": "CN",
		"admin.providers": "Providers",
		"admin.rateLimitFallback": "Rate-limit Fallback",
		"admin.rateLimitFallbackApiKey": "Fallback API Key",
		"admin.rateLimitFallbackBaseUrl": "Fallback Base URL",
		"admin.rateLimitFallbackDescription":
			"Retry provider rate-limit responses through a separate OpenAI-compatible endpoint.",
		"admin.rateLimitFallbackEnabled": "Enable rate-limit fallback",
		"admin.rateLimitFallbackModelName": "Fallback Model Name",
		"admin.rateLimitFallbackProvider": "Fallback Provider",
		"admin.rateLimitFallbackProviderDesc":
			"Select an existing provider to use as fallback when rate-limited.",
		"admin.rateLimitFallbackTimeoutMs": "Fallback Timeout (ms)",
		"admin.selectModel": "Select a model...",
		"admin.selectProvider": "Select a provider...",
		"admin.rateSizeLimits": "Rate & Size Limits",
		"admin.reasoningEffort": "Reasoning Effort",
		"admin.reasoningTokens": "Reasoning tokens",
		"admin.refresh": "Refresh",
		"admin.removeModelAliasA11y": "Remove alias {number}",
		"admin.requestTimeoutDescription": `HTTP request and stream timeout in milliseconds (default 300000 = 5 minutes). Increase for multi-round search workloads.`,
		"admin.requestTimeoutMs": "Request Timeout (ms)",
		"admin.resetAccount": "Reset Account",
		"admin.resetAccountButton": "Reset account",
		"admin.resetAccountDescription": `This wipes your chats, Knowledge Base, memories, and generated files, but keeps your login credentials, profile preferences, avatar, and historical analytics. You will need to sign in again after the reset finishes.`,
		"admin.resetting": "Resetting…",
		"admin.revokeSessions": "Revoke Sessions",
		"admin.role": "Role",
		"admin.saveChanges": "Save Changes",
		"admin.saveConfiguration": "Save Configuration",
		"admin.searchByNameOrEmail": "Search by name or email",
		"admin.selectUser": "Select a user to view account details and actions.",
		"admin.secretConfigured": "Secret is already configured",
		"admin.show": "Show",
		"admin.summarizerModelDescription":
			"Model name served by the endpoint above.",
		"admin.summarizerUrlDescription":
			"OpenAI-compatible endpoint. Uses the same vLLM server as the title generator. Leave empty to disable.",
		"admin.systemPrompt": "System Prompt",
		"admin.systemPromptDescription": `Set the system prompt used for all models. You can paste a full system prompt or use a reference key like \`alfyai-nemotron\`. Leave empty to use per-model defaults.`,
		"admin.systemPromptLabel": "System Prompt",
		"admin.systemSkills.createTitle": "Create Skill",
		"admin.systemSkills.created": "Skill created.",
		"admin.systemSkills.description":
			"Manage admin-defined skills. Users can see enabled, published summaries, but only admins can edit instructions.",
		"admin.systemSkills.descriptionPlaceholder": "Short purpose shown to users",
		"admin.systemSkills.displayNamePlaceholder": "Review partner",
		"admin.systemSkills.editTitle": "Edit Skill",
		"admin.systemSkills.empty": "No Skills yet.",
		"admin.systemSkills.errors.load": "Failed to load Skills.",
		"admin.systemSkills.errors.save": "Failed to save Skill.",
		"admin.systemSkills.instructionsPlaceholder":
			"Admin-only instructions for this Skill",
		"admin.systemSkills.loading": "Loading Skills...",
		"admin.systemSkills.new": "New Skill",
		"admin.systemSkills.publish": "Publish",
		"admin.systemSkills.publishA11y": "Publish {name}",
		"admin.systemSkills.published": "Published",
		"admin.systemSkills.save": "Save Skill",
		"admin.systemSkills.status.draft": "Draft",
		"admin.systemSkills.status.published": "Published",
		"admin.systemSkills.title": "Skills",
		"admin.systemSkills.updated": "Skill updated.",
		"admin.targetConstructedContext": "Target Constructed Context (tokens)",
		"admin.thinkingType": "thinking.type",
		"admin.thirdPartyDescription":
			"Third-party models use the same OpenAI-compatible chat runtime and connected tools as built-in models.",
		"admin.titleGenCodeAppendixEn": "Title Generator Code Appendix (English)",
		"admin.titleGenCodeAppendixHu": "Title Generator Code Appendix (Hungarian)",
		"admin.titleGenModel": "Title Generator Model",
		"admin.titleGenPromptEn": "Title Generator Prompt (English)",
		"admin.titleGenPromptHu": "Title Generator Prompt (Hungarian)",
		"admin.titleGenUrl": "Title Generator URL",
		"admin.titleGenerator": "Title Generator",
		"admin.totalTokens": "Total tokens",
		"admin.unchanged": "(unchanged)",
		"admin.uploadModelIcon": "Upload icon",
		"admin.uploadModelIconDescription": "Leave empty to keep the current icon.",
		"admin.user": "User",
		"admin.users": "Users",
		"admin.usersDescription":
			"Create accounts, manage admin access, revoke sessions, and remove users when needed.",
		"admin.usersRole": "Users",
		"admin.validationFailed": "Validation failed: {error}",
		"admin.routingRegions.title": "Routing coverage",
		"admin.routingRegions.description":
			"Map regions available to the map_route tool. Regions are downloaded from Geofabrik and built into their own OpenRouteService container the first time a route needs them; idle regions are stopped and restart on demand.",
		"admin.routingRegions.notConfigured":
			"Routing is not configured (set ORS_BASE_URL or ROUTING_ON_DEMAND_ENABLED).",
		"admin.routingRegions.refresh": "Refresh",
		"admin.routingRegions.request": "Prepare region",
		"admin.routingRegions.requested": "Region queued for download and build.",
		"admin.routingRegions.unknownId": "Unknown Geofabrik region id.",
		"admin.routingRegions.idPlaceholder":
			"Geofabrik id, e.g. austria or bayern",
		"admin.routingRegions.catalogue": "Region catalogue",
		"admin.routingRegions.colRegion": "Region",
		"admin.routingRegions.colStatus": "Status",
		"admin.routingRegions.colGeocoder": "Geocoder",
		"admin.routingRegions.colTransit": "Timetables",
		"admin.routingRegions.refreshTransit": "Refresh timetable",
		"admin.routingRegions.retryFeed": "Retry feed",
		"admin.routingRegions.feedCount": "{ready}/{total} feeds",
		"admin.routingRegions.transitQueued":
			"Timetable rebuild queued; the region restarts once its new public-transport graph is built.",
		"admin.routingRegions.colResident": "Resident",
		"admin.routingRegions.viaSource": "via {source}",
		"admin.routingRegions.retryAt": "retry {time} (attempt {attempts})",
		"admin.routingRegions.attempts": "{attempts} attempts",
		"admin.routingRegions.colSize": "Extract",
		"admin.routingRegions.colEndpoint": "Endpoint",
		"admin.routingRegions.colLastUsed": "Last used",
		"admin.routingRegions.legacy": "fixed instance",
		"admin.routingRegions.retry": "Retry",
		"admin.routingRegions.remove": "Remove",
		"admin.routingRegions.confirmRemove":
			"Remove this region? Its container and downloaded data will be deleted.",
		"admin.routingRegions.empty": "No regions yet.",
		"admin.effectiveConfig.columns.key": "Key",
		"admin.effectiveConfig.columns.override": "Admin override",
		"admin.effectiveConfig.columns.source": "Source",
		"admin.effectiveConfig.columns.value": "Effective value",
		"admin.effectiveConfig.description":
			"Where each running value comes from: an admin override saved here, the server environment, or the built-in default. Secrets are masked.",
		"admin.effectiveConfig.empty": "No configuration keys match the filter.",
		"admin.effectiveConfig.errors.load":
			"Failed to load effective configuration.",
		"admin.effectiveConfig.filter": "Filter keys or values",
		"admin.effectiveConfig.filterA11y": "Filter configuration keys",
		"admin.effectiveConfig.generatedAt": "Generated {time}",
		"admin.effectiveConfig.loading": "Loading effective configuration…",
		"admin.effectiveConfig.models.enabled": "providers row enabled",
		"admin.effectiveConfig.models.disabled": "providers row disabled",
		"admin.effectiveConfig.models.missing": "no providers row",
		"admin.effectiveConfig.models.resolvedFrom.admin_config_env":
			"resolved from admin config / env",
		"admin.effectiveConfig.models.resolvedFrom.providers_table":
			"resolved from the providers table",
		"admin.effectiveConfig.models.resolvedFrom.unresolved": "could not resolve",
		"admin.effectiveConfig.models.resolvesTo": "resolves to {model}",
		"admin.effectiveConfig.models.shadowed": "Shadowed admin overrides: {keys}",
		"admin.effectiveConfig.models.title": "Built-in model resolution",
		"admin.effectiveConfig.notSet": "not set",
		"admin.effectiveConfig.refresh": "Reload",
		"admin.effectiveConfig.source.admin_config": "admin override",
		"admin.effectiveConfig.source.default": "default",
		"admin.effectiveConfig.source.env": "environment",
		"admin.effectiveConfig.title": "Effective configuration",
		"admin.toolHealth.columns.backend": "Backend",
		"admin.toolHealth.columns.checked": "Last checked",
		"admin.toolHealth.columns.detail": "Detail",
		"admin.toolHealth.columns.latency": "Latency",
		"admin.toolHealth.columns.status": "Status",
		"admin.toolHealth.columns.tool": "Tool",
		"admin.toolHealth.description":
			"Reachability of the services behind each chat tool. Probes run with a 5 second timeout and are cached for a few minutes.",
		"admin.toolHealth.empty": "No tools registered.",
		"admin.toolHealth.errors.load": "Failed to load tool health.",
		"admin.toolHealth.lastChecked": "Last checked {time}",
		"admin.toolHealth.loading": "Checking tool health…",
		"admin.toolHealth.refresh": "Refresh",
		"admin.toolHealth.refreshing": "Checking…",
		"admin.toolHealth.status.degraded": "Degraded",
		"admin.toolHealth.status.healthy": "Healthy",
		"admin.toolHealth.status.unconfigured": "Not configured",
		"admin.toolHealth.title": "Tool health",
		"admin.webResearch": "Web Research",
		"admin.webResearchDescription":
			"Server-owned web search and research keys. Parallel powers web search and page research; Brave is used separately for image search.",
		"admin.webPushVapidPrivateKey": "Web Push VAPID Private Key",
		"admin.webPushVapidPublicKey": "Web Push VAPID Public Key",
		"admin.webPushVapidSubject": "Web Push VAPID Subject",
		"admin.working": "Working…",
		"admin.xHigh": "X-High",
		"admin.yourPassword": "Your password",
		"analytics.allTime": "All time",
		"analytics.avgResponseTime": "Avg response time",
		"analytics.avgTime": "Avg Time",
		"analytics.chartConversations": "Conversations",
		"analytics.chartCostUsd": "Cost (USD)",
		"analytics.chartMessages": "Messages",
		"analytics.chats": "Chats",
		"analytics.comparisonVsMonth": "{direction} {percent}% vs {month}",
		"analytics.conversations": "Conversations",
		"analytics.cost": "Cost",
		"analytics.costByModel": "Cost by model",
		"analytics.favoriteModel": "Favorite model",
		"analytics.loadingAnalytics": "Loading analytics...",
		"analytics.messagesSent": "Messages sent",
		"analytics.model": "Model",
		"analytics.modelUsage": "Model usage",
		"analytics.msgs": "Msgs",
		"analytics.nextMonth": "Next month",
		"analytics.nextPerUserMonth": "Next per-user month",
		"analytics.nextSystemMonth": "Next system month",
		"analytics.noData": "No analytics data yet.",
		"analytics.output": "Output",
		"analytics.perUserBreakdown": "Per-User Breakdown",
		"analytics.previousMonth": "Previous month",
		"analytics.previousPerUserMonth": "Previous per-user month",
		"analytics.previousSystemMonth": "Previous system month",
		"analytics.prompt": "Prompt",
		"analytics.reasoning": "Reasoning",
		"analytics.reasoningTokens": "Reasoning tokens",
		"analytics.retry": "Retry",
		"analytics.systemOverview": "System Overview",
		"analytics.timelineMonthly": "Monthly",
		"analytics.timelineWeekly": "Weekly",
		"analytics.timelineYearly": "Yearly",
		"analytics.tokenUsage": "Token usage",
		"analytics.tokensUsed": "Tokens used",
		"analytics.tooltipMessages": "messages",
		"analytics.totalConversations": "Total conversations",
		"analytics.totalMessages": "Total messages",
		"analytics.totalTokens": "Total tokens",
		"analytics.totalUsers": "Total users",
		"analytics.user": "User",
		"analytics.userActivity": "User Activity",
		"analytics.usageByModel": "Usage by model",
		"analytics.yourActivity": "Your Activity",
		"analytics.excludedUsers": "Excluded Users",
		"analytics.excludedUsersDescription":
			"Excluded users are hidden from the System Overview and Per-User Breakdown sections. Your personal analytics are not affected.",
		"analytics.saving": "Saving\u2026",
		"analytics.saved": "Saved",
		"analytics.saveFailed": "Save failed",
		"analytics.overview": "Overview",
		"analytics.byUser": "By user",
		"analytics.parallelApi": "Parallel API",
		"analytics.provider": "Provider",
		"analytics.calls": "Calls",
		"analytics.messages": "Messages",
		"analytics.month": "Month",
		"analytics.turbo": "Turbo",
		"analytics.extract": "Extract",
		"analytics.total": "Total",
		"analytics.webCalls": "Web calls",
		"analytics.activeUsers": "Active users",
		"analytics.turboSearches": "Turbo searches",
		"analytics.extractFetches": "Extract fetches",
		"analytics.parallelCost": "Parallel cost",
		"analytics.totalCalls": "Total calls",
		"analytics.llmParallelSplit": "LLM {llm} \u00b7 Parallel {parallel}",
		"analytics.parallelUsage": "Turbo vs Extract usage",
		"analytics.monthlyBreakdown": "Monthly breakdown",
		"analytics.monthlyCost": "Monthly cost",
		"analytics.filterModels": "Filter models\u2026",
		"analytics.filterUsers": "Filter users\u2026",
		"analytics.allUsers": "All users",
		"analytics.allProviders": "All providers",
		"analytics.allModels": "All models",
		"analytics.showRetired": "Show retired",
		"analytics.modelCalls": "Model calls",
		"analytics.firstTokenMedian": "First token median",
		"analytics.firstTokenP50": "First token p50",
		"analytics.firstTokenP90": "First token p90",
		"analytics.generationP50": "Generation p50",
		"analytics.modelsActiveConfigured": "Models active / configured",
		"analytics.status": "Status",
		"analytics.statusActive": "Active",
		"analytics.statusDisabled": "Disabled",
		"analytics.statusRemoved": "Removed",
		"analytics.retiredGroupLabel":
			"Retired \u00b7 no longer offered by any provider",
		"analytics.toolsAndLatency": "Tools & latency",
		"analytics.tools": "Tools",
		"analytics.tool": "Tool",
		"analytics.failedPercent": "Failed %",
		"analytics.cachedPercent": "Served from cache %",
		"analytics.durationP50": "Duration p50",
		"analytics.commandsSkillsActions": "Commands, skills and actions",
		"analytics.name": "Name",
		"analytics.kind": "Kind",
		"analytics.uses": "Uses",
		"analytics.kindCommand": "Command",
		"analytics.kindSkill": "Skill",
		"analytics.kindClick": "Click",
		"analytics.latencyByPromptSize": "Latency by prompt size",
		"analytics.promptBucket": "Prompt size",
		"analytics.turns": "Turns",
		"analytics.reasoningTokensMedian": "Reasoning tokens median",
		"analytics.showingOfTotal": "Showing {shown} of {total}",
		"analytics.viewAllCount": "View all {total} \u2192",
		"analytics.showFewer": "Show fewer",
		"campaignCrop.backdropClose": "Close campaign screenshot cropper",
		"campaignCrop.cropAreaLabel": "Campaign screenshot crop area",
		"campaignCrop.desktopMetadata": "16:10 desktop crop",
		"campaignCrop.mobileMetadata": "9:16 mobile crop",
		"campaignCrop.modelIconMetadata": "1:1 model icon crop",
		"campaignCrop.prepareError": "Unable to prepare campaign screenshot crop.",
		"campaignCrop.previewLabel": "Crop preview",
		"campaignCrop.reset": "Reset",
		"campaignCrop.save": "Save crop",
		"campaignCrop.saveError": "Failed to save campaign screenshot crop.",
		"campaignCrop.title": "Crop campaign screenshot",
		"campaignCrop.zoom": "Zoom",
		"campaignModal.announcement": "Announcement",
		"campaignModal.back": "Back",
		"campaignModal.empty": "No campaign slides to preview.",
		"campaignModal.finish": "Finish",
		"campaignModal.label": "Campaign announcement",
		"campaignModal.next": "Next",
		"campaignModal.noImage": "No screenshot attached",
		"campaignModal.preview": "Preview",
		"campaignModal.previewLabel": "Campaign announcement preview",
		"campaignModal.previous": "Previous",
		"campaignModal.progressLabel": "Campaign progress",
		"campaignModal.progressSlide": "Slide {current} of {total}",
		"campaignModal.setup.label": "Setup preferences",
		"campaignModal.skip": "Skip",
		"campaignModal.slideCount": "{current} of {total}",
		"campaignModal.untitled": "Untitled campaign",
		settings_admin: "Admin",
		settings_appearance: "Appearance",
		settings_atLeast8Chars: "At least 8 characters",
		settings_autoDetect: "Auto-detect",
		settings_avatar: "Avatar",
		// ADR-0043 slice 18a — Profile grouped sections, icon buttons, jargon clearing.
		settings_conversationStyle: "Conversation style",
		settings_conversationStyleNote: "How AlfyAI responds by default.",
		settings_interfaceLanguage: "Interface language",
		settings_interfaceLanguageNote:
			"The language used for menus and buttons. Title language can be set separately below.",
		settings_removePhotoA11y: "Remove photo",
		settings_sectionAccount: "Account",
		settings_sectionAssistant: "Assistant",
		settings_sectionDataPrivacy: "Data & privacy",
		// Task 14: sticky in-page nav landmark label (jumps between the groups).
		settings_sectionNavA11yLabel: "Profile sections",
		settings_sectionPreferences: "Preferences",
		// ADR-0043 slice 18c: 5th Profile section (personal analytics merged in).
		settings_sectionYourActivity: "Your Activity",
		settings_systemAnalyticsTab: "System analytics",
		// ADR-0043 slice 18b: Skills summary card + full-screen manager.
		settings_skillsManagerBack: "Back to settings",
		settings_skillsManagerOpenA11y: "Open skills manager",
		settings_skillsManagerStatus: "{active} active · {disabled} disabled",
		settings_skillsManagerSummaryLabel: "Skills",
		settings_skillsManagerTitle: "Skills",
		settings_uploadPhotoA11y: "Upload photo",
		settings_campaignsTab: "Campaigns",
		settings_changePassword: "Change Password",
		settings_confirmNewPassword: "Confirm new password",
		settings_createUserBtn: "Create User",
		settings_createUserDescription:
			"Create a new local account and optionally grant it admin access immediately.",
		settings_createUserTitle: "Create User",
		settings_creating: "Creating…",
		settings_currentPassword: "Current password",
		settings_archiveDescription:
			"Confirm your password to prepare a transient ZIP archive for your signed-in account.",
		settings_archiveDownloaded: "Your data archive download has started.",
		settings_clearMemoryAndKnowledge: "Clear memory and knowledge",
		settings_clearMemoryDescription:
			"This clears remembered context, Knowledge Base documents, document-derived context, continuity state, embeddings, working-set/context status, and stored evidence traces. Your chats stay available and you stay signed in.",
		settings_clearMemorySuccess:
			"Memory and knowledge have been cleared. Your chats are still available.",
		settings_clearWorkspaceData: "Clear workspace data",
		settings_clearWorkspaceDescription:
			"This clears chats, Knowledge Base content, app-controlled memory, generated files, and workspace continuity while keeping your login, profile settings, avatar, and historical analytics. You will be signed out after it finishes.",
		settings_clearing: "Clearing...",
		settings_dangerZone: "Danger Zone",
		settings_dark: "Dark",
		settings_defaultModel: "Default model",
		settings_deleteAccount: "Delete Account",
		settings_deleteAccountDescription: `This permanently deletes your account, chats, Knowledge Base, memories, generated files, profile preferences, and avatar. Historical analytics remain as immutable usage records. This cannot be undone.`,
		settings_deleteAccountTitle: "Delete Account",
		settings_deletePermanently: "Delete permanently",
		settings_deleteUserBtn: "Delete User",
		settings_deleteUserMessage:
			"This will permanently delete the selected user account, chats, and stored data. This cannot be undone.",
		settings_deleteUserTitle: "Delete User",
		settings_deleting: "Deleting…",
		settings_displayName: "Display Name",
		settings_done: "Done",
		settings_emailAddress: "Email Address",
		settings_emailExample: "example@example.com",
		settings_english: "English",
		settings_enterPasswordConfirm: "Enter your password to confirm:",
		settings_hidePassword: "Hide password",
		settings_hungarian: "Hungarian",
		settings_light: "Light",
		settings_memory: "Memory",
		settings_memoryHelp:
			"When on, AlfyAI learns and remembers facts about you across chats to personalize replies. Turn off to pause all learning — your existing memories are kept but nothing new is added.",
		settings_newPassword: "New password",
		settings_optionalDisplayName: "Optional display name",
		settings_passwordChanged: "Password changed.",
		settings_passwordLabel: "Password",
		settings_passwordMismatch: "New passwords do not match.",
		settings_passwordTooShort: "Password must be at least 8 characters.",
		settings_preferences: "Preferences",
		settings_privacyPolicy: "Privacy policy",
		settings_privacyControls: "Privacy and Data Controls",
		settings_privacyControlsDescription:
			"Download your account archive or clear data from this workspace. Each action requires your password before anything changes.",
		settings_deleteAccountPrivacy: "Delete account",
		settings_deleteAccountPrivacyDescription:
			"This permanently deletes your account and personal workspace data after stopping user-owned running work. Only anonymous aggregate usage and cost totals may remain. You will be signed out after it finishes.",
		settings_downloadBeforeDestructive:
			"You can download your data before continuing. The destructive action is still available whether or not you download an archive.",
		settings_downloadMyData: "Download my data",
		settings_downloadingData: "Preparing download...",
		settings_profileInformation: "Profile Information",
		settings_profileUpdated: "Profile updated.",
		settings_removePhoto: "Remove photo",
		settings_removing: "Removing...",
		settings_resetAccount: "Reset Account",
		settings_resetAccountDescription: `This wipes your chats, Knowledge Base, memories, and generated files, but keeps your login credentials, profile preferences, avatar, and historical analytics. You will need to sign in again after the reset finishes.`,
		settings_resetAccountTitle: "Reset Account",
		settings_resetDescription: `Resetting wipes your chats, Knowledge Base, memories, and generated files, but keeps your login, profile settings, and avatar. Deletion permanently removes your account too.`,
		settings_resetMemory: "Reset Memory",
		settings_resetMemoryMessage: `Forget everything in the Knowledge Base? This removes persona memory, task continuity, across-chat continuity, documents, results, workflows, and stored evidence traces, but keeps the chat conversations themselves.`,
		settings_resetting: "Resetting...",
		settings_role: "Role",
		settings_save: "Save",
		settings_saving: "Saving...",
		settings_showPassword: "Show password",
		settings_system: "System",
		settings_systemTab: "System",
		settings_theme: "Theme",
		settings_titleLanguage: "Title language",
		settings_uploadPhoto: "Upload photo",
		settings_user: "User",
		settings_userEmailPlaceholder: "user@example.com",
		settings_usersTab: "Users",
		settings_yourName: "Your name",
		settings_yourPasswordPlaceholder: "Your password",
		// --- BEGIN admin Users & Campaigns redesign keys ---
		"admin.users.accountSummary":
			"{total} accounts · {admins} admins · {never} never signed in",
		"admin.users.actionNote":
			"Promotion and deletion ask for confirmation. Revoking sessions signs {name} out everywhere and does not.",
		"admin.users.actions": "Actions",
		"admin.users.adminGrantsNote":
			"An admin can read every conversation's metadata, change models for everyone and delete accounts.",
		"admin.users.column.email": "Email",
		"admin.users.column.lastActive": "Last active",
		"admin.users.column.messages": "Messages",
		"admin.users.column.name": "Name",
		"admin.users.column.role": "Role",
		"admin.users.column.tokens": "Tokens",
		"admin.users.createUserDescription":
			"They can change their name, password and model afterwards. There is no invite email — hand them the password yourself.",
		"admin.users.detailsColumn": "Details",
		"admin.users.generatePassword": "Generate",
		"admin.users.errors.action": "User action failed.",
		"admin.users.errors.create": "Failed to create user.",
		"admin.users.errors.load": "Failed to load users.",
		"admin.users.hiddenByFilter":
			"This account is hidden by the current filters. Clear them to find it in the table again.",
		"admin.users.lastActive.days": "{count} d ago",
		"admin.users.lastActive.hours": "{count} h ago",
		"admin.users.lastActive.minutes": "{count} min ago",
		"admin.users.lastActive.never": "Never",
		"admin.users.lastActive.now": "Just now",
		"admin.users.lastActive.yesterday": "Yesterday",
		"admin.users.nextPage": "Next",
		"admin.users.pageOf": "{page} / {pageCount}",
		"admin.users.passwordLongEnough": "{count} characters — long enough",
		"admin.users.passwordTooShort": "At least {count} characters",
		"admin.users.previousPage": "Previous",
		"admin.users.messages.deleted": "User deleted.",
		"admin.users.messages.demoted": "Admin access removed.",
		"admin.users.messages.promoted": "Admin access granted.",
		"admin.users.messages.sessionsRevoked": "Active sessions revoked.",
		"admin.users.promoteMessage":
			"An admin can change the models and system prompt for every user, read account-level analytics for everyone, create and delete accounts, and promote other admins. You can demote {name} again at any time.",
		"admin.users.promoteTitle": "Make {name} an admin?",
		"admin.users.rowsPerPage": "Rows per page",
		"admin.users.showingNone": "Nothing to show",
		"admin.users.showingRange": "Showing {from}–{to} of {total}",
		"admin.users.sortAscending": "sorted ascending",
		"admin.users.sortColumn": "sort by this column",
		"admin.users.sortCustom": "Custom order",
		"admin.users.sortDescending": "sorted descending",
		"admin.users.sortLabel": "Sort",
		"admin.users.tokenSplit": "{completion} completion · {reasoning} reasoning",
		"admin.users.tokensAllTime": "Tokens used, all time",
		"admin.users.you": "you",
		"admin.campaigns.actionDestination": "Action destination",
		"admin.campaigns.actionLabel": "Action label",
		"admin.campaigns.actionLabelPlaceholder": "Try a report",
		"admin.campaigns.addSlide": "Add slide",
		"admin.campaigns.analyticsCompletedLabel": "Completed",
		"admin.campaigns.analyticsReplayed": "Replayed",
		"admin.campaigns.analyticsShown": "Shown",
		"admin.campaigns.analyticsSkipped": "Skipped",
		"admin.campaigns.archivedOn": "archived {date}",
		"admin.campaigns.archivedReadOnly":
			"Archived campaigns can't change. Duplicate as draft to edit.",
		"admin.campaigns.assetAdd": "Add",
		"admin.campaigns.assetAttachedShort": "Attached screenshot",
		"admin.campaigns.assetRecrop": "Re-crop",
		"admin.campaigns.assetRecropUnavailable":
			"The original upload for this crop is no longer available. Replace the screenshot to crop it again.",
		"admin.campaigns.assetRemove": "Remove",
		"admin.campaigns.assetReplace": "Replace",
		"admin.campaigns.campaignMenuLabel": "Campaign",
		"admin.campaigns.campaignMenuTrigger": "Campaign actions",
		"admin.campaigns.checklist.allPass": "{passed} of {total} checks pass ·",
		"admin.campaigns.checklist.fail.actionDestination": "Action destination",
		"admin.campaigns.checklist.fail.actionLabel": "Action label in {language}",
		"admin.campaigns.checklist.fail.alt": "{language} alt text",
		"admin.campaigns.checklist.fail.dataDisclosure": "A data-disclosure slide",
		"admin.campaigns.checklist.fail.layout": "Slide layout",
		"admin.campaigns.checklist.fail.localizedBody": "{language} body",
		"admin.campaigns.checklist.fail.localizedTitle": "{language} title",
		"admin.campaigns.checklist.fail.localizedTitleAndBody":
			"{language} title and body",
		"admin.campaigns.checklist.fail.name": "Campaign name",
		"admin.campaigns.checklist.fail.order": "Slide order",
		"admin.campaigns.checklist.fail.purpose": "Slide purpose",
		"admin.campaigns.checklist.fail.releaseVersion": "Release version",
		"admin.campaigns.checklist.fail.setupControls": "Setup controls",
		"admin.campaigns.checklist.fail.setupSlide": "Exactly one setup slide",
		"admin.campaigns.checklist.fail.slides": "At least one slide",
		"admin.campaigns.checklist.fail.type": "Campaign type",
		"admin.campaigns.checklist.failing":
			"{count} check{count, plural, one {} other {s}} failing",
		"admin.campaigns.checklist.inSlideMenu": "in the slide ⋯ menu",
		"admin.campaigns.checklist.passing": "{count} pass",
		"admin.campaigns.checklist.readyToPublish": "Ready to publish",
		"admin.campaigns.checklist.rule.actionDestination":
			"Action destinations are allowed ones",
		"admin.campaigns.checklist.rule.actionLabel":
			"Action labels in both languages",
		"admin.campaigns.checklist.rule.alt": "Alt text for every image",
		"admin.campaigns.checklist.rule.dataDisclosure": "A data-disclosure slide",
		"admin.campaigns.checklist.rule.layout": "Every slide has a layout",
		"admin.campaigns.checklist.rule.localized":
			"Title and body in both languages",
		"admin.campaigns.checklist.rule.name": "Campaign name",
		"admin.campaigns.checklist.rule.order": "Slides are in a valid order",
		"admin.campaigns.checklist.rule.purpose": "Every slide has a purpose",
		"admin.campaigns.checklist.rule.releaseVersion": "Release version",
		"admin.campaigns.checklist.rule.setupControls":
			"Setup controls are placed correctly",
		"admin.campaigns.checklist.rule.setupSlide": "Exactly one setup slide",
		"admin.campaigns.checklist.rule.slides": "At least one slide",
		"admin.campaigns.checklist.rule.type": "Campaign type",
		"admin.campaigns.checklist.slideHasIssues": "This slide has failing checks",
		"admin.campaigns.cropMetadata":
			"Slide {number} · {ratio} · saved as WebP {size}",
		"admin.campaigns.destination.admin": "Administration",
		"admin.campaigns.destination.chat": "New chat",
		"admin.campaigns.destination.home": "Home",
		"admin.campaigns.destination.knowledge": "Knowledge",
		"admin.campaigns.destination.none": "No action button",
		"admin.campaigns.destination.notAllowed": "not an allowed destination",
		"admin.campaigns.destination.profile": "Profile",
		"admin.campaigns.destination.settings": "Settings",
		"admin.campaigns.duplicateAsDraft": "Duplicate as draft",
		"admin.campaigns.editDetailsTitle": "Campaign details",
		"admin.campaigns.fieldError.actionLabel": "{language} label is empty.",
		"admin.campaigns.fieldError.alt": "{language} alt text is empty.",
		"admin.campaigns.fieldError.body": "{language} body is empty.",
		"admin.campaigns.fieldError.title": "{language} title is empty.",
		"admin.campaigns.finishedAllSlides": "Finished all {count} slides",
		"admin.campaigns.howItPerformed": "How it performed",
		"admin.campaigns.language.en": "English",
		"admin.campaigns.language.hu": "Magyar",
		"admin.campaigns.liveSince": "live since {date}",
		"admin.campaigns.menu.copyEnToHu": "Copy English to Magyar",
		"admin.campaigns.menu.deleteSlide": "Delete slide",
		"admin.campaigns.menu.layout": "Layout — {value}",
		"admin.campaigns.menu.moveDown": "Move down",
		"admin.campaigns.menu.moveUp": "Move up",
		"admin.campaigns.menu.purpose": "Purpose — {value}",
		"admin.campaigns.menu.setupControls": "Setup controls — {count}",
		"admin.campaigns.menu.setupControlsNone": "Setup controls — none",
		"admin.campaigns.mobileFallsBack": "Uses the desktop crop",
		"admin.campaigns.mobileFallsBackHelp":
			"Without its own 9:16 crop, phones show the desktop screenshot letterboxed.",
		"admin.campaigns.newCampaign": "New campaign",
		"admin.campaigns.newCampaignDescription":
			"Name it, pick what it is for, and add slides afterwards.",
		"admin.campaigns.previewDesktop": "Desktop preview",
		"admin.campaigns.previewDevice": "Preview size",
		"admin.campaigns.previewMobile": "Phone preview",
		"admin.campaigns.publishedReadOnly":
			"Published slides can't change. Duplicate as draft to edit.",
		"admin.campaigns.purpose.dataDisclosure": "Data disclosure",
		"admin.campaigns.purpose.feature": "Feature",
		"admin.campaigns.saveDetails": "Save details",
		"admin.campaigns.serverIssues": "The server rejected this campaign:",
		"admin.campaigns.setupControl.aiStyle": "AI style",
		"admin.campaigns.setupControl.modelDefault": "Default model",
		"admin.campaigns.setupControl.theme": "Theme",
		"admin.campaigns.setupControl.uiLanguage": "Interface language",
		"admin.campaigns.setupControls": "Setup controls",
		"admin.campaigns.setupControlsHelp":
			"Controls shown on this slide so people can set them up straight away.",
		"admin.campaigns.setupControlsStray":
			"This slide is no longer a first-run setup slide, so these controls block publishing — clear them.",
		"admin.campaigns.setupControlsUnavailable":
			"Setup controls only work on the setup slide of a first-run campaign.",
		"admin.campaigns.slideAction": "Action",
		"admin.campaigns.slideActionHelp":
			"An optional button on the slide. Destinations are restricted to pages inside the app, and the label is required in both languages once a destination is set.",
		"admin.campaigns.slideAlt": "Alt text",
		"admin.campaigns.slideAltHelp":
			"Describes the screenshot for screen readers. Required in both languages once an image is attached.",
		"admin.campaigns.slideBody": "Body",
		"admin.campaigns.slideLayout": "Layout",
		"admin.campaigns.slideLayoutHelp":
			"A setup slide carries the first-run setup controls; a standard slide is content only.",
		"admin.campaigns.slideMenuLabel": "Slide",
		"admin.campaigns.slideMenuTrigger": "Slide {number} actions",
		"admin.campaigns.slideOptionsDescription":
			"Layout, purpose and setup controls are validated when the campaign is published.",
		"admin.campaigns.slideOptionsTitle": "Slide {number} options",
		"admin.campaigns.slidePurpose": "Purpose",
		"admin.campaigns.slidePurposeHelp":
			"A first-run campaign needs at least one data-disclosure slide, which is what tells people what the app stores.",
		"admin.campaigns.slideTitle": "Title",
		"admin.campaigns.typeHelp":
			"A first-run campaign greets new accounts once; a release update announces a version to everyone.",
		"admin.campaigns.untitledCampaign": "Untitled campaign v{version}",
		"admin.campaigns.updatedOn": "updated {date}",
		// --- END admin Users & Campaigns redesign keys ---
		// ---------------------------------------------------------------
		// Admin System screen redesign. Appended as one block so the three
		// redesign branches do not collide in the middle of the file.
		// ---------------------------------------------------------------
		"admin.system.nav.title": "System configuration",
		"admin.system.nav.readOnly": "Read-only",
		"admin.system.nav.a11y": "System configuration pages",
		"admin.system.pages.general": "General",
		"admin.system.pages.models": "Models & providers",
		"admin.system.pages.aiTasks": "AI tasks",
		"admin.system.pages.integrations": "Integrations & keys",
		"admin.system.pages.limits": "Limits",
		"admin.system.pages.skills": "Skills",
		"admin.system.pages.advanced": "Advanced",
		"admin.system.pages.diagnostics": "Diagnostics",
		"admin.system.search.placeholder": "Search every setting, key or provider",
		"admin.system.search.a11y": "Search system settings",
		"admin.system.search.empty": "Nothing matches “{query}”.",
		"admin.system.search.results": "{count} settings match",
		"admin.system.search.goTo": "Go to {page}",
		"admin.system.appliesImmediately": "Applies immediately",
		"admin.system.appliesImmediatelyLegend":
			"marks the controls that write the moment you change them — everything else waits for Save.",
		"admin.system.unsaved": "Unsaved",
		"admin.system.unsavedRow": "{label} has unsaved changes",
		"admin.system.defaultLabel": "Default",
		"admin.system.valueLabel": "Value",
		"admin.system.settingLabel": "Setting",
		"admin.system.takesEffect": "Takes effect",
		"admin.system.effect.live": "live",
		"admin.system.effect.nextRun": "next run",
		"admin.system.effect.restart": "restart",
		"admin.system.effect.liveHint":
			"Read fresh on the next call — saving is enough.",
		"admin.system.effect.nextRunHint":
			"Applied when the scheduler computes its next run.",
		"admin.system.effect.restartHint": "Read at start-up — needs a restart.",
		"admin.system.effect.unwired": "no effect yet",
		"admin.system.effect.unwiredHint":
			"Saved and kept, but nothing reads this value yet — a later release will.",
		"admin.system.resetToDefault": "Reset to default",
		"admin.system.resetToDefaultA11y": "Reset {label} to its default",
		"admin.system.emptyValue": "not set",
		"admin.system.invalid.number": "Whole number required.",
		"admin.system.invalid.min": "Must be at least {limit}.",
		"admin.system.invalid.max": "Must be at most {limit}.",
		"admin.system.invalid.option": "Pick one of the listed values.",
		"admin.system.invalid.url": "Must be a full http:// or https:// address.",
		"admin.system.invalidCount": "{count} value cannot be saved",
		"admin.system.invalidCountPlural": "{count} values cannot be saved",
		"admin.discoverNone": "No models discovered.",
		"admin.discoverFound": "Found {count} models. Creating…",
		"admin.discoverCreated": "Created {count} models.",
		"admin.discoverFailed": "Could not discover models from this provider.",
		"admin.reorderFailed": "Could not change the failover order.",
		"admin.providerTestOk": "Connection works.",
		"admin.providerTestFailed": "Connection failed.",
		"admin.system.unit.ms": "ms",
		"admin.system.unit.s": "s",
		"admin.system.unit.min": "min",
		"admin.system.unit.days": "days",
		"admin.system.unit.months": "months",
		"admin.system.unit.mb": "MB",
		"admin.system.unit.chars": "chars",
		"admin.system.unit.tokens": "tok",
		"admin.system.unit.words": "words",
		"admin.system.save.allSaved": "All changes saved",
		"admin.system.save.lastSaved": "Last saved {time}",
		"admin.system.save.pendingOne": "1 unsaved change",
		"admin.system.save.pendingMany": "{count} unsaved changes",
		"admin.system.save.button": "Save {count} changes",
		"admin.system.save.buttonOne": "Save 1 change",
		"admin.system.save.nothing": "Save",
		"admin.system.save.discard": "Discard",
		"admin.system.save.savingOne": "Saving 1 change…",
		"admin.system.save.savingMany": "Saving {count} changes…",
		"admin.system.save.savingDetail":
			"Writing admin_config, then reloading the shell",
		"admin.system.save.pageBreakdown": "{page} · {count}",
		"admin.system.leave.titleOne": "Leave 1 unsaved change?",
		"admin.system.leave.titleMany": "Leave {count} unsaved changes?",
		"admin.system.leave.description":
			"They are listed so you can decide, rather than being described as “changes”.",
		"admin.system.leave.keepEditing": "Keep editing",
		"admin.system.leave.discardAndLeave": "Discard and leave",
		"admin.system.leave.saveAndLeave": "Save and leave",
		"admin.system.secret.set": "Set",
		"admin.system.secret.notSet": "Not set",
		"admin.system.secret.replace": "Replace",
		"admin.system.secret.add": "Add key",
		"admin.system.secret.cancel": "Keep current",
		"admin.system.secret.lastChanged": "last changed {date}",
		"admin.system.secret.writeOnly":
			"Write-only — it is never sent back to the browser.",
		"admin.system.secret.newValue": "New value for {label}",
		"admin.system.general.title": "General",
		"admin.system.general.description":
			"The two settings that belong to the application itself rather than to a model.",
		"admin.system.providers.title": "Providers",
		"admin.system.providers.description":
			"Order is failover order — move a provider to change it. Every model select on this screen is built from the providers that are switched on here.",
		"admin.system.providers.enabledOnly": "Enabled only",
		"admin.system.providers.add": "Add provider",
		"admin.system.providers.modelCount": "{count} models",
		"admin.system.providers.modelCountOne": "1 model",
		"admin.system.providers.modelsOn": "Models on {provider}",
		"admin.system.providers.menu": "More actions for {provider}",
		"admin.system.providers.discover": "Discover models from /models",
		"admin.system.providers.manage": "Manage models & pricing",
		"admin.system.providers.edit": "Edit provider",
		"admin.system.providers.test": "Test connection",
		"admin.system.providers.delete": "Delete provider…",
		"admin.system.providers.moveUp": "Move {provider} up",
		"admin.system.providers.moveDown": "Move {provider} down",
		"admin.system.providers.toggleA11y": "Enable {provider}",
		"admin.system.providers.expandA11y": "Show models on {provider}",
		"admin.system.providers.priceWindows": "Price windows · {count}",
		"admin.system.priceWindows": "Price windows",
		"admin.system.modelFree": "free",
		"admin.system.providers.hidden": "Hidden",
		"admin.system.providers.default": "Default",
		"admin.system.providers.perMillion": "{input} / {output} per 1M in/out",
		"admin.system.providers.emptyFiltered": "No provider is switched on.",
		"admin.system.failover.title": "Timeout failover",
		"admin.system.failover.description":
			"A rule about all models, so it is its own card.",
		"admin.system.failover.summary":
			"If a model has not started answering within {seconds} s, the request is retried once on {model}. The user sees one answer, never an error.",
		"admin.system.failover.summaryOff":
			"Switched off: a slow model is not retried anywhere else.",
		"admin.system.failover.enabled": "Retry slow requests on another model",
		"admin.system.failover.timeout": "Give up after",
		"admin.system.failover.timeoutMeaning":
			"Measured to the first token, not to completion.",
		"admin.system.failover.target": "Retry on",
		"admin.system.failover.targetMeaning":
			"Pick something cheap and always-on.",
		"admin.system.newAccounts.title": "New accounts",
		"admin.system.newAccounts.description":
			"What a person gets before they change anything.",
		"admin.system.newAccounts.meaning":
			"Existing accounts keep the model they chose.",
		"admin.system.atlas.title": "Atlas research reports",
		"admin.system.atlas.description": "Six stages, six model choices.",
		"admin.system.atlas.workerEnabled": "Worker enabled",
		"admin.system.atlas.tabs.models": "Models per task",
		"admin.system.atlas.tabs.worker": "Worker & limits",
		"admin.system.atlas.tabs.depth": "Research depth",
		"admin.system.atlas.tabs.prompts": "Pipeline",
		"admin.system.atlas.taskColumn": "Task",
		"admin.system.atlas.modelColumn": "Model",
		"admin.system.atlas.inherit": "Inherit — {model}",
		"admin.system.atlas.inheritNote":
			"A task left on Inherit follows the Atlas synthesis or audit model it belongs to. Those two are on the Worker & limits tab.",
		"admin.system.atlas.v3Only": "Used by the v3 pipeline only.",
		"admin.system.atlas.tasks.ask.label": "Ask",
		"admin.system.atlas.tasks.ask.meaning":
			"Turns the request into a research brief and asks the clarifying question.",
		"admin.system.atlas.tasks.researcher.label": "Researcher",
		"admin.system.atlas.tasks.researcher.meaning":
			"Runs each research question against the web and reads the pages.",
		"admin.system.atlas.tasks.outline.label": "Outline",
		"admin.system.atlas.tasks.outline.meaning":
			"Decides the sections the report will have, and their order.",
		"admin.system.atlas.tasks.writer.label": "Writer",
		"admin.system.atlas.tasks.writer.meaning":
			"Writes each section from the evidence index, sentence by sentence.",
		"admin.system.atlas.tasks.critic.label": "Critic",
		"admin.system.atlas.tasks.critic.meaning":
			"Reviews coverage and asks for the rounds that are still missing.",
		"admin.system.atlas.tasks.verifier.label": "Verifier",
		"admin.system.atlas.tasks.verifier.meaning":
			"Checks every cited figure against the source that is cited for it.",
		"admin.system.atlas.pipeline.label": "Report pipeline",
		"admin.system.atlas.pipeline.meaning":
			"Stamped when a report starts, so reports already queued keep the pipeline they began with.",
		"admin.system.atlas.searchMath": "Questions × rounds = web searches",
		"admin.system.atlas.searchMathRow":
			"{profile} {questions} × {rounds} = {total}",
		"admin.system.atlas.profile.overview": "Overview",
		"admin.system.atlas.profile.inDepth": "In depth",
		"admin.system.atlas.profile.exhaustive": "Exhaustive",
		"admin.system.memory.title": "Memory",
		"admin.system.memory.description":
			"Decides what is worth remembering, and merges duplicates overnight.",
		"admin.system.titles.title": "Conversation titles",
		"admin.system.titles.description": "Names a chat after the first exchange.",
		"admin.system.titles.promptSection": "Prompt",
		"admin.system.titles.langEn": "English",
		"admin.system.titles.langHu": "Magyar",
		"admin.system.titles.complete": "complete",
		"admin.system.titles.incomplete": "empty",
		"admin.system.titles.basePrompt": "System prompt",
		"admin.system.titles.appendix": "Code appendix",
		"admin.system.summarizer.title": "Context summarizer",
		"admin.system.summarizer.description":
			"Compresses long conversations when the window fills.",
		"admin.system.systemPrompt.title": "System prompt",
		"admin.system.systemPrompt.description":
			"Prepended to every normal chat. Atlas and the tasks above use their own prompts.",
		"admin.system.charCount": "{count} / {max} characters",
		"admin.system.integrations.title": "Integrations & keys",
		"admin.system.integrations.description":
			"Every secret in the product, in one place and one idiom.",
		"admin.system.integrations.webResearch": "Web research",
		"admin.system.integrations.documentExtraction": "Document extraction",
		"admin.system.integrations.webPush": "Web push notifications",
		"admin.system.limits.title": "Limits",
		"admin.system.limits.description":
			"Hard ceilings. Every one of them is felt by a user as a refusal, so each says what the refusal looks like.",
		"admin.system.skills.title": "Skills",
		"admin.system.skills.description":
			"Editing a skill opens the dialog instead of growing a form inside the list, so the list never moves under you.",
		"admin.system.skills.new": "New skill",
		"admin.system.skills.editTitle": "Edit skill",
		"admin.system.skills.createTitle": "New skill",
		"admin.system.skills.dialogHint":
			"Changes here are saved with this dialog, not with the page's Save bar.",
		"admin.system.skills.menu": "More actions for {name}",
		"admin.system.skills.unpublish": "Unpublish",
		"admin.system.skills.policyNote":
			"These four already exist on every skill you create — they were posted as silent defaults with no control anywhere in the product.",
		"admin.system.skills.durationPolicy": "Duration policy",
		"admin.system.skills.questionPolicy": "Question policy",
		"admin.system.skills.notesPolicy": "Notes policy",
		"admin.system.skills.sourceScope": "Source scope",
		"admin.system.skills.duration.next_message": "Next message only",
		"admin.system.skills.duration.session": "Whole session",
		"admin.system.skills.question.none": "Never ask",
		"admin.system.skills.question.ask_when_needed": "Ask when needed",
		"admin.system.skills.notes.none": "Keep no notes",
		"admin.system.skills.notes.create_private_notes": "Keep working notes",
		"admin.system.skills.scope.selected_sources_only": "Selected sources only",
		"admin.system.skills.scope.all_sources": "All sources",
		"admin.system.skills.scope.web_and_files": "Web and files",
		"admin.system.skills.activationHint": "One per line.",
		"admin.system.advanced.title": "Advanced",
		"admin.system.advanced.restartFree": "Restart-free",
		"admin.system.advanced.description":
			"{count} settings that used to exist only in the environment file. Every one of them is read fresh on the next call, so saving here is enough — no restart, no deploy.",
		"admin.system.advanced.search":
			"Search advanced settings, keys and defaults",
		"admin.system.advanced.effectiveConfig": "Effective config",
		"admin.system.advanced.keyCount": "{count} keys",
		"admin.system.advanced.collapse": "Collapse {group}",
		"admin.system.advanced.expand": "Expand {group}",
		"admin.system.advanced.groups.limits": "Resource limits",
		"admin.system.advanced.groups.atlas": "Atlas internals",
		"admin.system.advanced.groups.embeddings": "Embeddings & reranker",
		"admin.system.advanced.groups.memory": "Memory & working set",
		"admin.system.advanced.groups.routing": "Routing tuning",
		"admin.system.advanced.groups.models": "Built-in model tuning",
		"admin.system.advanced.groups.integrations": "Integrations",
		"admin.system.advanced.groups.debug": "Debug & stream limits",
		"admin.system.advanced.sandboxTitle": "Sandbox — compiled in",
		"admin.system.advanced.sandboxNote":
			"Not settable anywhere. Whichever limit is tighter bites first — which is why the numbers on the left can look ignored.",
		"admin.system.advanced.teiWarning":
			"Changing the embedder model does not re-embed anything. Stored vectors stay in the old model's space and stop matching new ones until they are rebuilt.",
		"admin.system.advanced.contextRule":
			"Change the context window and the other three re-derive — warn at 80%, fill to 90%, message length from that. Set one yourself and it stays. But if the fill point or the warning is not below the window, the whole set silently reverts to the environment values, with no error.",
		"admin.system.advanced.routingReference":
			"Shown for reference, set in the environment:",
		"admin.system.advanced.owntracksWarning":
			"Not URL-checked — the server will fetch whatever you put here.",
		"admin.system.advanced.model1": "Model 1",
		"admin.system.advanced.model2": "Model 2",
		"admin.system.advanced.envOnlyTitle": "Environment only",
		"admin.system.advanced.envOnlyNote":
			"These stay in the environment file on purpose: they choose what container runs, where it binds, which container gets a command, or they are the key that encrypts every stored provider secret. A restart is required for any of them.",
		"admin.system.diagnostics.title": "Diagnostics",
		"admin.system.diagnostics.description":
			"Read-only. Nothing on this page is a setting — it is what the system currently is.",
		"admin.system.diagnostics.rerun": "Re-run checks",
		"admin.system.diagnostics.checked": "Checked {time}",
		"admin.system.diagnostics.tabs.toolHealth": "Tool health",
		"admin.system.diagnostics.tabs.effectiveConfig": "Effective configuration",
		"admin.system.diagnostics.tabs.routing": "Routing coverage",
		"admin.system.diagnostics.degradedOne": "1 degraded.",
		"admin.system.diagnostics.degradedMany": "{count} degraded.",
		"admin.system.diagnostics.degradedDetail":
			"Every one of them is visible from the chat as a slower or missing result.",
		"admin.system.diagnostics.generated": "Generated {time} · {count} keys",
		"admin.system.diagnostics.filter.overridden": "Overridden only · {count}",
		"admin.system.diagnostics.filter.env": "Set by env · {count}",
		"admin.system.diagnostics.filter.hidden":
			"Never surfaced in the UI · {count}",
		"admin.system.diagnostics.filter.all": "All keys",
		"admin.system.diagnostics.overridesEnv": "overrides env {value}",
		"admin.system.diagnostics.noOverride": "no admin override",
		"admin.system.diagnostics.builtInNote":
			"Built-in model resolution: each built-in key with what it resolves to, where from, and a warning when an admin value shadows a working env value.",
		"admin.system.diagnostics.routingNote":
			"Refreshes every 60 s · open feed lists stay open",
		"admin.system.diagnostics.refreshNow": "Refresh now",
		"admin.system.dialog.savedHere":
			"Changes here are saved with this dialog, not with the page's Save bar.",
		"admin.system.dialog.providerIdFixed":
			"Fixed after creation — config keys point at it.",
		"admin.system.dialog.availability": "Availability",
		"admin.system.dialog.enabledForEveryone": "Enabled for everyone",
		"admin.system.dialog.icon": "Icon",
		"admin.system.dialog.iconReplace": "Replace",
		"admin.system.dialog.iconRecrop": "Re-crop",
		"admin.system.dialog.iconRemove": "Remove",
		"admin.system.dialog.lastTest": "Last test {time}",
		"admin.system.dialog.saveProvider": "Save provider",
		"admin.system.dialog.freeText":
			"Or type a model name that is not in the list",
		"admin.system.dialog.useFreeText": "Use free text instead",
		"admin.system.dialog.usePicker": "Pick from the list instead",
		"admin.system.dialog.fallbackWait": "Wait before falling back",
		"admin.system.dialog.fallbackDescription":
			"Used when this provider answers 429. Separate from the global timeout failover.",
		"admin.system.deleteProvider.title": "Delete {name}?",
		"admin.system.deleteProvider.message":
			"Its models and pricing go with it. Any model select still pointing at it falls back to the default model.",
		"admin.system.deleteModel.title": "Delete {name}?",
		"admin.system.deleteModel.message":
			"The model and its price windows are removed from this provider.",
		"admin.system.removeRegion.title": "Remove {name}?",
		"admin.system.removeRegion.message":
			"The downloaded extract and the built graph are deleted. Requesting the region again re-downloads and rebuilds it.",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUTS.label": "Files per run",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUTS.meaning":
			"How many files one request may produce.",
		"admin.system.keys.FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES.label":
			"Source data cap",
		"admin.system.keys.FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES.meaning":
			"Largest payload a run may read from the conversation.",
		"admin.system.keys.FILE_PRODUCTION_MAX_PROJECTION_BYTES.label":
			"Derived data cap",
		"admin.system.keys.FILE_PRODUCTION_MAX_PROJECTION_BYTES.meaning":
			"Largest projection built from that payload.",
		"admin.system.keys.FILE_PRODUCTION_MAX_PDF_PAGES.label": "Pages per PDF",
		"admin.system.keys.FILE_PRODUCTION_MAX_PDF_PAGES.meaning":
			"Hard stop for a generated document.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_ROWS.label": "Rows per table",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_ROWS.meaning":
			"Rows in one generated spreadsheet or table.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_COLUMNS.label":
			"Columns per table",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_COLUMNS.meaning":
			"Columns in that table.",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_DATA_POINTS.label":
			"Points per chart",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_DATA_POINTS.meaning":
			"Data points across all series.",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_SERIES.label":
			"Series per chart",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_SERIES.meaning":
			"Lines or bar groups in one chart.",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_COUNT.label":
			"Images per document",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_COUNT.meaning":
			"Pictures embeddable in one file.",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_BYTES.label": "Image size",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_BYTES.meaning":
			"Per-picture ceiling.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES.label":
			"All images",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES.meaning":
			"Combined picture bytes in one run.",
		"admin.system.keys.FILE_PRODUCTION_SANDBOX_TIMEOUT_MS.label":
			"Generation timeout",
		"admin.system.keys.FILE_PRODUCTION_SANDBOX_TIMEOUT_MS.meaning":
			"Wall clock for the code that builds the file.",
		"admin.system.keys.FILE_PRODUCTION_RENDERER_TIMEOUT_MS.label":
			"Render timeout",
		"admin.system.keys.FILE_PRODUCTION_RENDERER_TIMEOUT_MS.meaning":
			"Wall clock for turning it into a document.",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES.label":
			"Output file size",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES.meaning":
			"Ceiling for one produced file.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES.label":
			"All outputs",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES.meaning":
			"Combined bytes one run may write to disk.",
		"admin.system.keys.ATLAS_PIPELINE.label": "Report pipeline",
		"admin.system.keys.ATLAS_PIPELINE.meaning":
			"Which pipeline a new report is stamped with.",
		"admin.system.keys.ATLAS_V2_QUESTIONS_OVERVIEW.label":
			"Research questions · overview",
		"admin.system.keys.ATLAS_V2_QUESTIONS_OVERVIEW.meaning":
			"Questions the plan stage writes for an overview report.",
		"admin.system.keys.ATLAS_V2_QUESTIONS_IN_DEPTH.label":
			"Research questions · in depth",
		"admin.system.keys.ATLAS_V2_QUESTIONS_IN_DEPTH.meaning":
			"Questions the plan stage writes for an in-depth report.",
		"admin.system.keys.ATLAS_V2_QUESTIONS_EXHAUSTIVE.label":
			"Research questions · exhaustive",
		"admin.system.keys.ATLAS_V2_QUESTIONS_EXHAUSTIVE.meaning":
			"Questions the plan stage writes for an exhaustive report.",
		"admin.system.keys.ATLAS_V2_ROUNDS_OVERVIEW.label":
			"Research rounds · overview",
		"admin.system.keys.ATLAS_V2_ROUNDS_OVERVIEW.meaning":
			"How many times an overview report goes back for more sources.",
		"admin.system.keys.ATLAS_V2_ROUNDS_IN_DEPTH.label":
			"Research rounds · in depth",
		"admin.system.keys.ATLAS_V2_ROUNDS_IN_DEPTH.meaning":
			"How many times an in-depth report goes back for more sources.",
		"admin.system.keys.ATLAS_V2_ROUNDS_EXHAUSTIVE.label":
			"Research rounds · exhaustive",
		"admin.system.keys.ATLAS_V2_ROUNDS_EXHAUSTIVE.meaning":
			"How many times an exhaustive report goes back for more sources.",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_OVERVIEW.label":
			"Length ceiling · overview",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_OVERVIEW.meaning":
			"Hard word ceiling for an overview report.",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_IN_DEPTH.label":
			"Length ceiling · in depth",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_IN_DEPTH.meaning":
			"Hard word ceiling for an in-depth report.",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_EXHAUSTIVE.label":
			"Length ceiling · exhaustive",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_EXHAUSTIVE.meaning":
			"Hard word ceiling for an exhaustive report.",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_OVERVIEW.label":
			"Indexed sources · overview",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_OVERVIEW.meaning":
			"Sources carried into the write phase of an overview report.",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_IN_DEPTH.label":
			"Indexed sources · in depth",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_IN_DEPTH.meaning":
			"Sources carried into the write phase of an in-depth report.",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_EXHAUSTIVE.label":
			"Indexed sources · exhaustive",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_EXHAUSTIVE.meaning":
			"Sources carried into the write phase of an exhaustive report.",
		"admin.system.keys.ATLAS_V2_ENTAILMENT_BATCH.label":
			"Claims per entailment call",
		"admin.system.keys.ATLAS_V2_ENTAILMENT_BATCH.meaning":
			"How many claims are checked in one call. 1 disables batching.",
		"admin.system.keys.ATLAS_V2_WRITER_CONCURRENCY.label":
			"Sections written at once",
		"admin.system.keys.ATLAS_V2_WRITER_CONCURRENCY.meaning":
			"Sections the writer produces in parallel.",
		"admin.system.keys.ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS.label":
			"Answer length ceiling · overview",
		"admin.system.keys.ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS.meaning":
			"Output tokens the writer may spend on an overview report.",
		"admin.system.keys.ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS.label":
			"Answer length ceiling · in depth",
		"admin.system.keys.ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS.meaning":
			"Output tokens the writer may spend on an in-depth report.",
		"admin.system.keys.ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS.label":
			"Answer length ceiling · exhaustive",
		"admin.system.keys.ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS.meaning":
			"Output tokens the writer may spend on an exhaustive report.",
		"admin.system.keys.ATLAS_MAX_WRITER_PROMPT_CHARS.label":
			"Writer prompt cap",
		"admin.system.keys.ATLAS_MAX_WRITER_PROMPT_CHARS.meaning":
			"Characters of research handed to the writer at once.",
		"admin.system.keys.ATLAS_STALE_MONTHS.label":
			"Call a statistic stale after",
		"admin.system.keys.ATLAS_STALE_MONTHS.meaning":
			"Older figures are moved into Limitations.",
		"admin.system.keys.TEI_EMBEDDER_URL.label": "Embedder endpoint",
		"admin.system.keys.TEI_EMBEDDER_URL.meaning":
			"Where text is turned into vectors. Empty switches semantic search off.",
		"admin.system.keys.TEI_EMBEDDER_MODEL.label": "Embedder model",
		"admin.system.keys.TEI_EMBEDDER_MODEL.meaning":
			"The served model name at that endpoint.",
		"admin.system.keys.TEI_EMBEDDER_BATCH_SIZE.label": "Texts per embed call",
		"admin.system.keys.TEI_EMBEDDER_BATCH_SIZE.meaning":
			"Must not exceed the server's own batch limit.",
		"admin.system.keys.TEI_RERANKER_URL.label": "Reranker endpoint",
		"admin.system.keys.TEI_RERANKER_URL.meaning":
			"Re-scores search hits. Empty switches reranking off.",
		"admin.system.keys.TEI_RERANKER_MODEL.label": "Reranker model",
		"admin.system.keys.TEI_RERANKER_MODEL.meaning":
			"The served model name there.",
		"admin.system.keys.TEI_RERANKER_MAX_TEXTS.label": "Candidates per rerank",
		"admin.system.keys.TEI_RERANKER_MAX_TEXTS.meaning":
			"Hits sent for re-scoring at once.",
		"admin.system.keys.TEI_TIMEOUT_MS.label": "Embedding timeout",
		"admin.system.keys.TEI_TIMEOUT_MS.meaning":
			"Wall clock for one embedder or reranker call.",
		"admin.system.keys.MEMORY_JUDGE_DRY_RUN.label": "Judge dry run",
		"admin.system.keys.MEMORY_JUDGE_DRY_RUN.meaning":
			"The judge decides and logs, but writes nothing to the profile.",
		"admin.system.keys.MEMORY_JUDGE_IDLE_MINUTES.label": "Wait before judging",
		"admin.system.keys.MEMORY_JUDGE_IDLE_MINUTES.meaning":
			"Quiet minutes after a conversation before memories are extracted.",
		"admin.system.keys.MEMORY_CONSOLIDATION_INTERVAL_MINUTES.label":
			"Consolidation sweep",
		"admin.system.keys.MEMORY_CONSOLIDATION_INTERVAL_MINUTES.meaning":
			"How often stored memories are merged and tidied.",
		"admin.system.keys.MEMORY_MAINTENANCE_INTERVAL_MINUTES.label":
			"Maintenance sweep",
		"admin.system.keys.MEMORY_MAINTENANCE_INTERVAL_MINUTES.meaning":
			"Per-user upkeep, such as embedding backfill. 0 switches it off.",
		"admin.system.keys.WORKING_SET_DOCUMENT_TOKEN_BUDGET.label":
			"Tokens per document",
		"admin.system.keys.WORKING_SET_DOCUMENT_TOKEN_BUDGET.meaning":
			"How much of one attached document reaches the prompt.",
		"admin.system.keys.WORKING_SET_PROMPT_TOKEN_BUDGET.label":
			"Tokens for the whole working set",
		"admin.system.keys.WORKING_SET_PROMPT_TOKEN_BUDGET.meaning":
			"Raising this crowds out conversation history.",
		"admin.system.keys.SMALL_FILE_THRESHOLD_CHARS.label": "Inline a file below",
		"admin.system.keys.SMALL_FILE_THRESHOLD_CHARS.meaning":
			"Shorter files go in whole instead of being chunked.",
		"admin.system.keys.ORS_COVERAGE_LABEL.label": "Coverage label",
		"admin.system.keys.ORS_COVERAGE_LABEL.meaning":
			"Region name the model is told about, so it can say why a route is missing.",
		"admin.system.keys.ROUTING_REGION_IDLE_MINUTES.label":
			"Stop idle regions after",
		"admin.system.keys.ROUTING_REGION_IDLE_MINUTES.meaning":
			"An unused region container is stopped.",
		"admin.system.keys.ROUTING_GTFS_REFRESH_DAYS.label": "Timetable refresh",
		"admin.system.keys.ROUTING_GTFS_REFRESH_DAYS.meaning":
			"Age at which a transit feed is downloaded again, overnight.",
		"admin.system.keys.ROUTING_GTFS_MAX_MB.label": "Timetable download cap",
		"admin.system.keys.ROUTING_GTFS_MAX_MB.meaning":
			"Ceiling for one feed download.",
		"admin.system.keys.ROUTING_REGION_MAX_PBF_MB.label": "Map extract cap",
		"admin.system.keys.ROUTING_REGION_MAX_PBF_MB.meaning":
			"Ceiling for one region download.",
		"admin.system.keys.ROUTING_GTFS_FEED_EXCLUDE.label": "Excluded timetables",
		"admin.system.keys.ROUTING_GTFS_FEED_EXCLUDE.meaning":
			"Feeds to leave out — this is where a licence problem is fixed.",
		"admin.system.keys.MODEL_1_MAX_TOKENS.label": "Max output tokens",
		"admin.system.keys.MODEL_1_MAX_TOKENS.meaning":
			"Output ceiling sent to the provider. Empty uses the provider default.",
		"admin.system.keys.MODEL_1_REASONING_EFFORT.label": "Reasoning effort",
		"admin.system.keys.MODEL_1_REASONING_EFFORT.meaning":
			"Provider option for how hard the model thinks.",
		"admin.system.keys.MODEL_1_THINKING_TYPE.label": "Thinking",
		"admin.system.keys.MODEL_1_THINKING_TYPE.meaning":
			"The thinking.type provider option, for Anthropic-shaped APIs.",
		"admin.system.keys.MODEL_1_MAX_MODEL_CONTEXT.label": "Context window",
		"admin.system.keys.MODEL_1_MAX_MODEL_CONTEXT.meaning":
			"The model's own context window, in tokens.",
		"admin.system.keys.MODEL_1_COMPACTION_UI_THRESHOLD.label":
			"Warn the user at",
		"admin.system.keys.MODEL_1_COMPACTION_UI_THRESHOLD.meaning":
			"Where the UI says the context is filling up.",
		"admin.system.keys.MODEL_1_TARGET_CONSTRUCTED_CONTEXT.label":
			"Fill the prompt to",
		"admin.system.keys.MODEL_1_TARGET_CONSTRUCTED_CONTEXT.meaning":
			"Prompt-assembly target before the output reserve.",
		"admin.system.keys.MODEL_1_MAX_MESSAGE_LENGTH.label": "Longest message",
		"admin.system.keys.MODEL_1_MAX_MESSAGE_LENGTH.meaning":
			"Longest user message this model accepts.",
		"admin.system.keys.MODEL_2_MAX_TOKENS.label": "Max output tokens",
		"admin.system.keys.MODEL_2_MAX_TOKENS.meaning":
			"Output ceiling sent to the provider. Empty uses the provider default.",
		"admin.system.keys.MODEL_2_REASONING_EFFORT.label": "Reasoning effort",
		"admin.system.keys.MODEL_2_REASONING_EFFORT.meaning":
			"Provider option for how hard the model thinks.",
		"admin.system.keys.MODEL_2_THINKING_TYPE.label": "Thinking",
		"admin.system.keys.MODEL_2_THINKING_TYPE.meaning":
			"The thinking.type provider option, for Anthropic-shaped APIs.",
		"admin.system.keys.MODEL_2_MAX_MODEL_CONTEXT.label": "Context window",
		"admin.system.keys.MODEL_2_MAX_MODEL_CONTEXT.meaning":
			"The model's own context window, in tokens.",
		"admin.system.keys.MODEL_2_COMPACTION_UI_THRESHOLD.label":
			"Warn the user at",
		"admin.system.keys.MODEL_2_COMPACTION_UI_THRESHOLD.meaning":
			"Where the UI says the context is filling up.",
		"admin.system.keys.MODEL_2_TARGET_CONSTRUCTED_CONTEXT.label":
			"Fill the prompt to",
		"admin.system.keys.MODEL_2_TARGET_CONSTRUCTED_CONTEXT.meaning":
			"Prompt-assembly target before the output reserve.",
		"admin.system.keys.MODEL_2_MAX_MESSAGE_LENGTH.label": "Longest message",
		"admin.system.keys.MODEL_2_MAX_MESSAGE_LENGTH.meaning":
			"Longest user message this model accepts.",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_ID.label": "Google app id",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_ID.meaning":
			"Identifies this server to Google when someone connects Calendar or Contacts.",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_SECRET.label": "Google app secret",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_SECRET.meaning":
			"Empty means the Google connector reports “not configured”.",
		"admin.system.keys.ONEDRIVE_CLIENT_ID.label": "OneDrive app id",
		"admin.system.keys.ONEDRIVE_CLIENT_ID.meaning": "Same, for OneDrive files.",
		"admin.system.keys.ONEDRIVE_CLIENT_SECRET.label": "OneDrive app secret",
		"admin.system.keys.ONEDRIVE_CLIENT_SECRET.meaning":
			"Empty means the OneDrive connector reports “not configured”.",
		"admin.system.keys.OWNTRACKS_RECORDER_URL.label": "OwnTracks recorder",
		"admin.system.keys.OWNTRACKS_RECORDER_URL.meaning":
			"Location history source.",
		"admin.system.keys.OWNTRACKS_RECORDER_USER.label": "OwnTracks user",
		"admin.system.keys.OWNTRACKS_RECORDER_USER.meaning":
			"Basic-auth user for the recorder.",
		"admin.system.keys.OWNTRACKS_RECORDER_PASS.label": "OwnTracks password",
		"admin.system.keys.OWNTRACKS_RECORDER_PASS.meaning":
			"Basic-auth password for the recorder.",
		"admin.system.keys.NATIVE_HISTORY_ENABLED.label":
			"Send history as messages",
		"admin.system.keys.NATIVE_HISTORY_ENABLED.meaning":
			"Off falls back to one flattened text block. This flag is the rollback.",
		"admin.system.keys.TITLE_GEN_URL.label": "Title model endpoint",
		"admin.system.keys.TITLE_GEN_URL.meaning":
			"Where conversation titles are generated.",
		"admin.system.keys.CONTEXT_SUMMARIZER_URL.label": "Summarizer endpoint",
		"admin.system.keys.CONTEXT_SUMMARIZER_URL.meaning":
			"Where long context is compacted. Falls back to the title endpoint.",
		"admin.system.keys.CONTEXT_DIAGNOSTICS_DEBUG.label": "Context diagnostics",
		"admin.system.keys.CONTEXT_DIAGNOSTICS_DEBUG.meaning":
			"Extra logging about how each prompt was assembled.",
		"admin.system.keys.ATTACHMENT_TRACE_DEBUG.label": "Attachment tracing",
		"admin.system.keys.ATTACHMENT_TRACE_DEBUG.meaning":
			"Logs how an upload becomes a ready attachment.",
		"admin.system.keys.NORMAL_CHAT_DEBUG_OUTBOUND.label":
			"Outbound shape logging",
		"admin.system.keys.NORMAL_CHAT_DEBUG_OUTBOUND.meaning":
			"Logs roles, part types and token estimates — never message content.",
		"admin.system.keys.CONCURRENT_STREAM_LIMIT.label": "Concurrent answers",
		"admin.system.keys.CONCURRENT_STREAM_LIMIT.meaning":
			"Chat answers streaming at once across the whole server.",
		"admin.system.keys.PER_USER_STREAM_LIMIT.label":
			"Concurrent answers per person",
		"admin.system.keys.PER_USER_STREAM_LIMIT.meaning":
			"Chat answers one account may stream at once.",
		"admin.system.keys.ATLAS_V3_CRITIC_ROUNDS.label": "Critic rounds",
		"admin.system.keys.ATLAS_V3_CRITIC_ROUNDS.meaning":
			"How many times the critic may send the report back for more work.",
		"admin.system.keys.ATLAS_V3_RESEARCHER_CONCURRENCY.label":
			"Researchers at once",
		"admin.system.keys.ATLAS_V3_RESEARCHER_CONCURRENCY.meaning":
			"Research questions worked on in parallel.",
		"admin.system.keys.ATLAS_V3_SEARCHES_PER_STEP.label": "Searches per step",
		"admin.system.keys.ATLAS_V3_SEARCHES_PER_STEP.meaning":
			"Web searches one research step may run.",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW.label":
			"Pages read · overview",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW.meaning":
			"Pages opened per question in an overview report.",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_IN_DEPTH.label":
			"Pages read · in depth",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_IN_DEPTH.meaning":
			"Pages opened per question in an in-depth report.",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_EXHAUSTIVE.label":
			"Pages read · exhaustive",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_EXHAUSTIVE.meaning":
			"Pages opened per question in an exhaustive report.",
		"admin.system.keys.ATLAS_V3_LANGUAGE_STANDARD_HU.label":
			"Hungarian language standard",
		"admin.system.keys.ATLAS_V3_LANGUAGE_STANDARD_HU.meaning":
			"Applies the Hungarian style rules to a Hungarian report.",
	},
	hu: {
		"admin.activeSessions": "Aktív munkamenetek",
		"admin.addModel": "Modell hozzáadása",
		"admin.addModelAlias": "Alias hozzáadása",
		"admin.addProvider": "Szolgáltató hozzáadása",
		"admin.admin": "Adminisztrátor",
		"admin.admins": "Adminisztrátorok",
		"admin.allRoles": "Minden szerepkör",
		"admin.apiKey": "API-kulcs",
		"admin.apiKeyPlaceholder": "sk-...",
		"admin.appVersion": "Alkalmazásverzió",
		"admin.appVersionOverride": "Appverzió felülírása",
		"admin.appVersionOverrideDescription": `Hagyd üresen a package verzió megjelenítéséhez. Beállított értékkel kampány publikálása nélkül írható felül az alkalmazásverzió jelvénye.`,
		"admin.atlas": "Atlas",
		"admin.atlasAuditModel": "Atlas ellenőrző modell",
		"admin.atlasAuditModelDescription":
			"Ellenőrzi az összeállított Atlast az elfogadott források alapján, és állításalapú alátámasztási adatokat készít az alátámasztási jelölőkhöz.",
		"admin.atlasDescription":
			"Hosszú futású Atlas kutatási körök, forráskeresés, minőségi kapuk és befejező worker beállításai.",
		"admin.atlasGlobalActiveLimit": "Globális aktív Atlas korlát",
		"admin.atlasLimitsDescription":
			"A globális aktív korlát a szerveren egyszerre futó Atlas feladatokat szabályozza. A keresési párhuzamosság és a kötegkésleltetés az egyes Atlas futások webkeresési terhelését állítja.",
		"admin.atlasSearchBatchDelayMs": "Keresési kötegkésleltetés (ms)",
		"admin.atlasSearchConcurrency": "Keresési párhuzamosság",
		"admin.atlasParallelDependency":
			"Az Atlashoz a Webes kutatás Parallel API-kulcsa is szükséges. Parallel nélkül a chat beviteli eszköztára az Atlast nem elérhetőként mutatja.",
		"admin.atlasSynthesisModel": "Atlas szintézis modell",
		"admin.atlasSynthesisModelDescription":
			"Megírja a szakaszolt Atlas eredményeket, vázlatot és jelentéstörzset.",
		"admin.atlasWebPushDescription":
			"A böngésző push opcionális. Beállított VAPID kulcsokkal az Atlas értesítheti a felhasználót, amikor egy jelentés elkészül, miközben nincs az alkalmazásban.",
		"admin.atlasWorkerDescription":
			"Azt szabályozza, hogy indíthatók-e Atlas feladatok, és feldolgozza-e őket a háttérworker.",
		"admin.atlasWorkerEnabled": "Atlas worker engedélyezése",
		"admin.basePromptDescription":
			"Alapprompt az adott nyelvhez. Hagyd üresen, ha csak a few-shot példákra szeretnél támaszkodni.",
		"admin.baseUrl": "Alap-URL",
		"admin.baseUrlPlaceholder": "pl. https://api.openai.com/v1",
		"admin.braveSearchApiKey": "Brave Search API-kulcs",
		"admin.braveSearchApiKeyDescription":
			"A Brave Search képkeresési szolgáltatás API-kulcsa. Hagyd üresen a Brave-alapú képkeresés letiltásához.",
		"admin.campaigns.actionLabelEn": "Angol műveletcímke",
		"admin.campaigns.actionLabelHu": "Magyar műveletcímke",
		"admin.campaigns.actionUrl": "Művelet URL",
		"admin.campaigns.addSetupSlide": "Beállítási dia hozzáadása",
		"admin.campaigns.addStandardSlide": "Általános dia hozzáadása",
		"admin.campaigns.altEn": "Angol képhelyettesítő szöveg",
		"admin.campaigns.altHu": "Magyar képhelyettesítő szöveg",
		"admin.campaigns.analytics": "Megtekintés / művelet",
		"admin.campaigns.analyticsAutoShown": "{count} megjelenítés",
		"admin.campaigns.analyticsCompleted": "{count} befejezés",
		"admin.campaigns.archive": "Archiválás",
		"admin.campaigns.archiveConfirm": "Archiválod ezt a kampányt?",
		"admin.campaigns.assetAttached": "Csatolva: {id}",
		"admin.campaigns.assetMissing": "Nincs csatolt kivágás.",
		"admin.campaigns.bodyEn": "Angol törzsszöveg",
		"admin.campaigns.bodyHu": "Magyar törzsszöveg",
		"admin.campaigns.create": "Kampány létrehozása",
		"admin.campaigns.createName": "Új kampány",
		"admin.campaigns.createNamePlaceholder": "Kampány neve",
		"admin.campaigns.createdAt": "Létrehozva",
		"admin.campaigns.cropTitle": "Kampány képernyőkép kivágása",
		"admin.campaigns.dateMissing": "Nincs beállítva",
		"admin.campaigns.deleteDraft": "Piszkozat törlése",
		"admin.campaigns.deleteDraftConfirm":
			"Törlöd ezt a kampánypiszkozatot? Ez nem vonható vissza.",
		"admin.campaigns.description": `Első indítási és kiadási kampánymodálok szerkesztése lokalizált szöveggel, képernyőképekkel, publikálási ellenőrzéssel és pontos felhasználói előnézettel.`,
		"admin.campaigns.desktopAsset": "Asztali képernyőkép",
		"admin.campaigns.duplicate": "Duplikálás",
		"admin.campaigns.editorLabel": "Kampányszerkesztő",
		"admin.campaigns.empty": "Még nincsenek kampányok.",
		"admin.campaigns.errors.archive": "A kampány archiválása sikertelen.",
		"admin.campaigns.errors.assetUpload":
			"A kampány képernyőkép feltöltése sikertelen.",
		"admin.campaigns.errors.create": "A kampány létrehozása sikertelen.",
		"admin.campaigns.errors.delete": "A kampánypiszkozat törlése sikertelen.",
		"admin.campaigns.errors.detail": "A kampány betöltése sikertelen.",
		"admin.campaigns.errors.duplicate": "A kampány duplikálása sikertelen.",
		"admin.campaigns.errors.load": "A kampányok betöltése sikertelen.",
		"admin.campaigns.errors.publish": "A kampány publikálása sikertelen.",
		"admin.campaigns.errors.save": "A kampány mentése sikertelen.",
		"admin.campaigns.errors.seed":
			"Az első indítási kampány létrehozása sikertelen.",
		"admin.campaigns.history": "Előzmények",
		"admin.campaigns.listLabel": "Kampánylista",
		"admin.campaigns.loading": "Kampányok betöltése…",
		"admin.campaigns.loadingDetail": "Kampány betöltése…",
		"admin.campaigns.messages.archived": "Kampány archiválva.",
		"admin.campaigns.messages.created": "Kampány létrehozva.",
		"admin.campaigns.messages.deleted": "Kampánypiszkozat törölve.",
		"admin.campaigns.messages.duplicated": "Kampány duplikálva.",
		"admin.campaigns.messages.published": "Kampány publikálva.",
		"admin.campaigns.messages.saved": "Kampánypiszkozat mentve.",
		"admin.campaigns.messages.seedExists":
			"Az első indítási kampány már létezik.",
		"admin.campaigns.messages.seeded": "Első indítási kampány létrehozva.",
		"admin.campaigns.mobileAsset": "Mobil képernyőkép",
		"admin.campaigns.moveDownA11y": "{title} mozgatása le",
		"admin.campaigns.moveUpA11y": "{title} mozgatása fel",
		"admin.campaigns.name": "Név",
		"admin.campaigns.noSlides": "Publikálás előtt adj hozzá legalább egy diát.",
		"admin.campaigns.noValidationErrors": "Nincs backend validációs hiba.",
		"admin.campaigns.preview": "Előnézet",
		"admin.campaigns.previewLabel": "Kampányelőnézet és előzmények",
		"admin.campaigns.previewLanguage": "Előnézet nyelve",
		"admin.campaigns.previewNote":
			"Csak admin előnézet. Nem ír analitikát vagy felhasználói állapotot.",
		"admin.campaigns.publish": "Publikálás",
		"admin.campaigns.publishChecklist": "Publikálási ellenőrzés",
		"admin.campaigns.publishedAt": "Publikálva",
		"admin.campaigns.releaseVersion": "Kiadás",
		"admin.campaigns.saveDraft": "Piszkozat mentése",
		"admin.campaigns.seedFirstRun": "Első indítás magkampány",
		"admin.campaigns.seedFirstRunHelp":
			"Létrehozza a szokásos első indítású bemutatókampányt szerkeszthető vázlatként.",
		"admin.campaigns.selectCampaign": "Válassz kampányt a szerkesztéshez.",
		"admin.campaigns.slideCount": "{count} dia",
		"admin.campaigns.slideEditorLabel": "{number}. dia szerkesztője",
		"admin.campaigns.slideKind": "Diatípus",
		"admin.campaigns.slideKind.setup": "Beállítás",
		"admin.campaigns.slideKind.standard": "Általános",
		"admin.campaigns.slideNumber": "{number}. dia",
		"admin.campaigns.slides": "Diák",
		"admin.campaigns.status.archived": "Archivált",
		"admin.campaigns.status.draft": "Piszkozat",
		"admin.campaigns.status.published": "Publikált",
		"admin.campaigns.title": "Kampányok",
		"admin.campaigns.titleEn": "Angol cím",
		"admin.campaigns.titleHu": "Magyar cím",
		"admin.campaigns.type": "Típus",
		"admin.campaigns.type.feature": "Funkció",
		"admin.campaigns.type.firstRun": "Első indítás",
		"admin.campaigns.type.release": "Kiadás",
		"admin.campaigns.type.standard": "Általános",
		"admin.campaigns.updatedAt": "Frissítve",
		"admin.campaigns.uploadDesktop": "Asztali kivágás feltöltése",
		"admin.campaigns.uploadMobile": "Mobil kivágás feltöltése",
		"admin.campaigns.uploadingAsset": "Képernyőkép feltöltése…",
		"admin.campaigns.validation.actionDestinationInvalid":
			"A művelet célja csak engedélyezett belső útvonal lehet.",
		"admin.campaigns.validation.actionLabelsRequired":
			"Beállított művelethez angol és magyar műveletcímke szükséges.",
		"admin.campaigns.validation.dataDisclosureRequired":
			"Az első indítási kampányhoz legalább egy adatkezelési általános dia szükséges.",
		"admin.campaigns.validation.desktopAssetRequired":
			"Az asztali kivágott kép kötelező.",
		"admin.campaigns.validation.imageAltRequired":
			"Feltöltött kép esetén az angol/magyar képhelyettesítő szöveg kötelező.",
		"admin.campaigns.validation.localizedContentRequired":
			"Az angol/magyar cím és törzsszöveg kötelező.",
		"admin.campaigns.validation.mobileAssetRequired":
			"A mobil kivágott kép kötelező.",
		"admin.campaigns.validation.nameRequired": "A kampány neve kötelező.",
		"admin.campaigns.validation.releaseVersionRequired":
			"A kiadási kampányhoz kapcsolt appverzió szükséges.",
		"admin.campaigns.validation.semanticRoleInvalid":
			"A dia szemantikai szerepe érvénytelen.",
		"admin.campaigns.validation.setupControlsPlacementInvalid":
			"Beállítási vezérlők csak első indítási beállítási dián használhatók.",
		"admin.campaigns.validation.setupControlsUnsupported":
			"A beállítási vezérlők között nem támogatott opció szerepel.",
		"admin.campaigns.validation.setupSlideRequired":
			"Az első indítási kampányhoz pontosan egy beállítási dia szükséges.",
		"admin.campaigns.validation.slideLayoutInvalid":
			"A dia elrendezése csak beállítás vagy általános lehet.",
		"admin.campaigns.validation.slideRequired": "Legalább egy dia szükséges.",
		"admin.campaigns.validation.sortOrderInvalid":
			"A diasorrendnek egyedi pozitív egész számokat kell használnia.",
		"admin.campaigns.validation.typeInvalid":
			"A kampány típusa csak első indítási vagy kiadási kampány lehet.",
		"admin.campaigns.versionShort": "v{version}",
		"admin.capability.chat": "Chat",
		"admin.capability.fileMessageParts": "Fájlok",
		"admin.capability.imageMessageParts": "Képek",
		"admin.capability.modelsEndpoint": "Models API",
		"admin.capability.reasoningControls": "Gondolkodás",
		"admin.capability.streaming": "Stream",
		"admin.capability.structuredOutput": "Strukturált kimenet",
		"admin.capability.tools": "Eszközök",
		"admin.capability.usageReporting": "Használat",
		"admin.capabilityState.detected": "Észlelve",
		"admin.capabilityState.manualOverride": "Kézi felülírás",
		"admin.capabilityState.manualOverrideSupported":
			"Kézi felülírás: támogatott",
		"admin.capabilityState.manualOverrideUnsupported":
			"Kézi felülírás: nem támogatott",
		"admin.capabilityState.notDetected": "Nem észlelve",
		"admin.capabilityState.unknown": "Ismeretlen",
		"admin.checkConnection": "Kapcsolat ellenőrzése",
		"admin.checking": "Ellenőrzés…",
		"admin.codeAppendixDescription":
			"Opcionális extra sorok, amelyek csak akkor kerülnek hozzáfűzésre, ha a beszélgetés kódolásnak tűnik.",
		"admin.compactionUiThreshold": "Tömörítési UI küszöb (token)",
		"admin.completionTokens": "Befejezési tokenek",
		"admin.composerCommandRegistry": "Beviteli parancsregiszter",
		"admin.composerCommandRegistryDescription":
			"Megjeleníti a normál chat parancsregiszterének vázát. A skill futtatási viselkedés a későbbi szeletekig inaktív marad.",
		"admin.composerCommandRegistryEnabled":
			"Beviteli parancsregiszter engedélyezése",
		"admin.connected": "Kapcsolódva",
		"admin.contextLimits": "Kontextuskorlátok",
		"admin.contextLimitsDescription":
			"Hagyd üresen a globális alapértelmezések használatához.",
		"admin.contextLimitsDescriptionBuiltIn":
			"Hagyd üresen a globális alapértelmezések használatához.",
		"admin.contextLimitsDescriptionProvider":
			"A harmadik féltől származó szolgáltatóknál kötelező a maximális modellkontextus.",
		"admin.contextSummarizer": "Kontextus-összefoglaló",
		"admin.contextSummarizerModel": "Kontextus-összefoglaló modellje",
		"admin.contextSummarizerUrl": "Kontextus-összefoglaló URL-je",
		"admin.conversations": "Beszélgetések",
		"admin.createUser": "Felhasználó létrehozása",
		"admin.createUserDescription":
			"Új helyi fiók létrehozása, és opcionálisan azonnali adminisztrátori hozzáférés biztosítása.",
		"admin.createUserTitle": "Felhasználó létrehozása",
		"admin.creating": "Létrehozás…",
		"admin.defaultNewUserModel": "Új felhasználók alapértelmezett modellje",
		"admin.defaultNewUserModelDescription": `Válaszd ki az újonnan létrehozott felhasználók kezdeti preferált modelljét. Az engedélyezett szolgáltatók jelennek meg elöl, a beépített modellek továbbra is választhatók.`,
		"admin.deleteAccount": "Fiók törlése",
		"admin.deleteAccountDescription": `Ez véglegesen törli a fiókodat, a beszélgetéseidet, a Tudásbázist, az emlékeket, a generált fájlokat, a profilbeállításokat és az avatart. A korábbi analitikai adatok változtathatatlan használati rekordként megmaradnak. A művelet nem vonható vissza.`,
		"admin.deletePermanently": "Végleges törlés",
		"admin.deleteProviderConfirm":
			'Biztosan törlöd a(z) "{name}" szolgáltatót?',
		"admin.deleteUser": "Felhasználó törlése",
		"admin.deleteUserConfirmButton": "Felhasználó törlése",
		"admin.deleteUserConfirmMessage": `Ez véglegesen törli a kiválasztott felhasználói fiókot, a beszélgetéseket és a tárolt adatokat. A művelet nem vonható vissza.`,
		"admin.deleteUserConfirmTitle": "Felhasználó törlése",
		"admin.deleting": "Törlés…",
		"admin.demoteToUser": "Lefokozás felhasználóvá",
		"admin.disabled": "Letiltva",
		"admin.disconnected": "Szétkapcsolva",
		"admin.discoverModels": "Modellek felfedezése",
		"admin.displayName": "Megjelenített név",
		"admin.displayNamePlaceholder": "pl. 1. modell",
		"admin.doNotSend": "Ne küldje el",
		"admin.editModel": "Modell szerkesztése",
		"admin.editProvider": "Szolgáltató szerkesztése",
		"admin.email": "E-mail",
		"admin.emailPlaceholder": "felhasznalo@example.com",
		"admin.enabled": "Engedélyezve",
		"admin.enterPasswordConfirm": "Add meg a jelszavad a megerősítéshez:",
		"admin.failedDeleteProvider": "Nem sikerült törölni a szolgáltatót.",
		"admin.failedLoadProviders": "Nem sikerült betölteni a szolgáltatókat.",
		"admin.failedSave": "Nem sikerült menteni.",
		"admin.failedValidateProvider": "Nem sikerült ellenőrizni a szolgáltatót.",
		"admin.favoriteModel": "Kedvenc modell",
		"admin.fillRequiredBuiltIn":
			"Töltsd ki a megjelenített nevet, az alap-URL-t és a modell nevét.",
		"admin.fillRequiredFields":
			"Töltsd ki az összes kötelező szolgáltatói mezőt.",
		"admin.fillRequiredProviderContext":
			"Állítsd be a szolgáltató maximális modellkontextusát.",
		"admin.fillRequiredRateLimitFallback":
			"Töltsd ki az összes engedélyezett sebességkorlátos tartalék mezőt.",
		"admin.hide": "Elrejt",
		"admin.high": "Magas",
		"admin.invalidRateLimitFallbackTimeout":
			"A tartalék időkorlátnak legalább 1000 ms-os egész számnak kell lennie.",
		"admin.joined": "Csatlakozott",
		"admin.lastActive": "Utoljára aktív",
		"admin.loadingModels": "Modellek betöltése...",
		"admin.loadingUsers": "Felhasználók betöltése…",
		"admin.local": "Helyi",
		"admin.low": "Alacsony",
		"admin.max": "Maximális",
		"admin.maxFileUploadDescription":
			"Maximális fájlfeltöltési méret bájtban (alapértelmezett 104857600 = 100 MB).",
		"admin.maxFileUploadSize": "Maximális fájlfeltöltési méret (bájt)",
		"admin.maxMessageLength": "Maximális üzenethossz (karakter)",
		"admin.maxMessageLengthDescription": `Globális tartalékérték, amíg nem ismert a modellspecifikus korlát. Hagyd üresen a legalacsonyabb engedélyezett modellkorlát használatához.`,
		"admin.maxMessageLengthLabel": "Maximális üzenethossz (karakter)",
		"admin.maxModelContext": "Maximális modellkontextus (token)",
		"admin.maxModelContextLabel": "Maximális modellkontextus (token)",
		"admin.autoCalculatedFromMaxContext":
			"Maximális modellkontextusból automatikusan számítva",
		"admin.maxModelContextRequired":
			"Harmadik féltől származó szolgáltatóknál kötelező. Ez a teljes bemeneti és kimeneti kontextusablak.",
		"admin.maxTokens": "Maximális tokenek",
		"admin.maxTokensDescription": `A kiválasztott modellnek átadott \`max_tokens\` érték. Hagyd üresen a szolgáltatói alapértelmezés használatához.`,
		"admin.maxTokensPlaceholder": "Szolgáltatói alapértelmezés használata",
		"admin.medium": "Közepes",
		"admin.memory": "Memória",
		"admin.memoryConsolidationModel": "Memória-összesítő modell",
		"admin.memoryConsolidationModelDescription": `Ez futtatja az éjszakai karbantartást, és ez írja meg az „Amit rólad megjegyeztem” összefoglalót.`,
		"admin.memoryJudgeModel": "Memória bíráló modell",
		"admin.memoryJudgeModelDescription":
			"Ez futtatja a bírálót, amely eldönti, mit érdemes megjegyezni az adott beszélgetésből. Alapértelmezésben az elsődleges csevegőmodelledet használja.",
		"admin.minimal": "Minimális",
		"admin.messages": "Üzenetek",
		"admin.mineruApiDescription": `MinerU API-szerver végpontja. A szolgáltatás indításához futtasd: \`docker run -d --name mineru -p 8001:8001 opendatalab/mineru:latest\``,
		"admin.mineruApiUrl": "MinerU API URL",
		"admin.mineruDocumentExtraction": "MinerU dokumentumkinyerés",
		"admin.mineruTimeoutDescription":
			"Maximális várakozási idő a MinerU válaszára. Nagyobb dokumentumokhoz növeld meg.",
		"admin.mineruTimeoutMs": "MinerU időkorlát (ms)",
		"admin.model1": "1. modell",
		"admin.model1ApiKey": "1. modell API-kulcsa",
		"admin.model1BaseUrl": "1. modell alap-URL-je",
		"admin.model1CompactionThreshold": "1. modell tömörítési küszöb",
		"admin.model1DisplayName": "1. modell megjelenített neve",
		"admin.model1IconAssetId": "1. modell ikon eszközazonosítója",
		"admin.model1MaxMessageLength": "1. modell maximális üzenethossza",
		"admin.model1MaxModelContext": "1. modell maximális kontextusa",
		"admin.model1Name": "1. modell neve",
		"admin.model1SystemPrompt": "1. modell rendszerpromptja",
		"admin.model1TargetContext": "1. modell célkontextusa",
		"admin.model2": "2. modell",
		"admin.model2ApiKey": "2. modell API-kulcsa",
		"admin.model2BaseUrl": "2. modell alap-URL-je",
		"admin.model2CompactionThreshold": "2. modell tömörítési küszöb",
		"admin.model2DisplayName": "2. modell megjelenített neve",
		"admin.model2Enabled": "2. modell engedélyezése",
		"admin.model2IconAssetId": "2. modell ikon eszközazonosítója",
		"admin.model2MaxMessageLength": "2. modell maximális üzenethossza",
		"admin.model2MaxModelContext": "2. modell maximális kontextusa",
		"admin.model2Name": "2. modell neve",
		"admin.model2SystemPrompt": "2. modell rendszerpromptja",
		"admin.model2TargetContext": "2. modell célkontextusa",
		"admin.model2Visibility": "2. modell láthatósága",
		"admin.model2VisibilityDescription":
			"A 2. modell elrejtése az alkalmazásból, visszaváltással az 1. modellre",
		"admin.modelCapabilities": "Képességek",
		"admin.modelAliasCanonicalCollision":
			"Az alias nem egyezhet meg a kanonikus modellnévvel.",
		"admin.modelAliasInputA11y": "{number}. alias",
		"admin.modelAliasPlaceholder": "pl. accounts/fireworks/models/qwen3p7-max",
		"admin.modelAliases": "Modellaliasok",
		"admin.modelAliasesDescription":
			"Alternatív szolgáltatói modellazonosítók átjárókhoz, például Fireworks AI-hoz.",
		"admin.modelIcon": "Modellikon",
		"admin.modelIconCropTitle": "Modellikon kivágása",
		"admin.modelIconProviderMissing":
			"Nem található a szolgáltató ehhez az ikonfeltöltéshez. Zárd be az űrlapot, majd próbáld újra.",
		"admin.modelIconReadFailed": "Nem sikerült beolvasni a kiválasztott képet.",
		"admin.modelIconSelected": "Kiválasztva: {name}",
		"admin.modelIconSquareRequired":
			"A modellikon képarányának 1:1-nek kell lennie.",
		"admin.modelIconUpdated": "Modellikon frissítve.",
		"admin.modelIconUploadFailed": "Nem sikerült feltölteni a modell ikonját.",
		"admin.modelIconUploading": "Feltöltés...",
		"admin.modelName": "Modell neve",
		"admin.modelNamePlaceholderBuiltIn": "pl. model-1",
		"admin.modelNamePlaceholderProvider":
			"pl. accounts/fireworks/models/llama-v3-70b",
		"admin.modelFallbackLabel": "Modellspecifikus tartalék",
		"admin.modelFallbackNone": "Nincs modellspecifikus tartalék",
		"admin.modelFallbackNoCompatibleOptions":
			"Ehhez a modellhez nincs elérhető kompatibilis modellspecifikus tartalék.",
		"admin.modelFallbackProviderWarning":
			"Vannak olyan modellek, amelyekhez nincs kompatibilis tartalék",
		"admin.modelFallbackModelWarning": "Nincs kompatibilis tartalék",
		"admin.modelFallbackReasonDisabledTarget": "A modell le van tiltva.",
		"admin.modelFallbackReasonCapabilitySource":
			"A forrásmodellnek támogatnia kell ezt: {capability}.",
		"admin.modelFallbackReasonCapabilityFallback":
			"A tartalék modellnek támogatnia kell ezt: {capability}.",
		"admin.modelFallbackReasonUnknownSourceCapability":
			"A forrásmodell {capability} képessége ismeretlen.",
		"admin.modelFallbackReasonGeneric": "Inkompatibilis",
		"admin.modelTimeoutFailoverDescription": `Akkor használatos, ha a kiválasztott szolgáltatói modellhez nincs kompatibilis modellspecifikus tartalék. Az újrapróbálható modellhibák egyszer ezzel a globális tartalék modellel próbálkozhatnak újra.`,
		"admin.modelTimeoutFailoverEnabled":
			"Globális modell tartalék engedélyezése",
		"admin.modelTimeoutFailoverTargetModel": "Globális tartalék modell",
		"admin.modelTimeoutFailoverTimeoutMs": "Tartalék időkorlát (ms)",
		"admin.manageModels": "Modellek kezelése",
		"admin.models": "Modellek",
		"admin.modelGuide": "Modellútmutató",
		"admin.modelGuideBadge": "Útmutató jelvény",
		"admin.modelGuideDescription":
			"Csak rövid, felhasználóknak szóló útmutatás. Ezek a mezők nem befolyásolják az útválasztást, a tartalék modellt, a promptokat vagy a költségeket.",
		"admin.modelGuideNoCost": "Költségmentesként jelenjen meg",
		"admin.modelGuideNoCostDescription":
			"Helyi vagy csomagban lévő modellekhez, amikor az útmutatóban ne ismeretlen költség jelenjen meg.",
		"admin.modelEstimatedSpeed": "Becsült sebesség",
		"admin.modelEstimatedSpeedDescription":
			"Opcionális token/mp becslés, kizárólag az útmutató sebességjelvényének meghatározásához.",
		"admin.modelEstimatedSpeedPlaceholder": "pl. 150",
		"admin.modelGuideNoteEn": "Angol útmutató megjegyzés",
		"admin.modelGuideNoteHu": "Magyar útmutató megjegyzés",
		"admin.modelGuideNotePlaceholder": "Hosszú dokumentumos munkához ajánlott.",
		"admin.mostChats": "Legtöbb beszélgetés",
		"admin.mostMessages": "Legtöbb üzenet",
		"admin.mostRecent": "Legfrissebb",
		"admin.mostTokens": "Legtöbb token",
		"admin.nameId": "Név (azonosító)",
		"admin.nameIdDescription":
			"Változtathatatlan azonosító a modell kiválasztásához.",
		"admin.nameIdPlaceholder": "pl. fireworks-ai",
		"admin.noModelsYet": "Még nincsenek modellek.",
		"admin.noProvidersYet": "Még nincsenek szolgáltatók.",
		"admin.noUsersMatch": "Nincs a szűrőknek megfelelő felhasználó.",
		"admin.none": "Nincs",
		"admin.pricing": "Árazás",
		"admin.pricingMicroDollars": "Mikrodollár 1M tokenenként",
		"admin.pricingPer1m": "USD 1M tokenenként",
		"admin.advancedCachePricing": "Haladó gyorsítótár-árazás",
		"admin.advancedCachePricingDescription":
			"Csak akkor használd, ha a szolgáltató a gyorsítótár-írást vagy a gyorsítótár-miss tokeneket eltérő áron számlázza. Hagyd üresen a normál bemeneti ár használatához.",
		"admin.cacheWriteMissPrice": "Gyorsítótár-írás / miss",
		"admin.cacheWriteMissPlaceholder": "Bemeneti ár használata",
		"admin.inputPrice": "Bemenet",
		"admin.cachedInputPrice": "Gyorsítótárazott bemenet",
		"admin.cacheHitPrice": "Gyorsítótál találat",
		"admin.cacheMissPrice": "Gyorsítótál melléfogás",
		"admin.outputPrice": "Kimenet",
		"admin.openAiCompatible": "OpenAI-kompatibilis",
		"admin.optionalDisplayName": "Opcionális megjelenített név",
		"admin.parallelApiKey": "Parallel API-kulcs",
		"admin.parallelApiKeyDescription":
			"A Parallel webes keresési és kutatási szolgáltatás API-kulcsa. Hagyd üresen a Parallel-alapú webes kutatás letiltásához.",
		"admin.password": "Jelszó",
		"admin.passwordPlaceholder": "Legalább 8 karakter",
		"admin.profileTabNote": `A saját fiókod módosításait a Profil lapon végezheted el. Az adminisztrátori szerepkör, a munkamenet-visszavonás és a törlés itt le van tiltva az aktuális felhasználónál.`,
		"admin.promoteToAdmin": "Előléptetés adminisztrátorrá",
		"admin.providerAdded": "Szolgáltató hozzáadva.",
		"admin.providerDefault": "Szolgáltató alapértelmezés",
		"admin.providerDeleted": "Szolgáltató törölve.",
		"admin.providerUpdated": "Szolgáltató frissítve.",
		"admin.providerValid": 'A(z) "{name}" érvényes.',
		"admin.providerPrivacyPolicy": "Adatvédelmi irányelv URL",
		"admin.providerPrivacyPolicyDescription":
			"Opcionális link, amely a modellútmutatóból érhető el, nem a kompakt választóban.",
		"admin.providerPrivacyPolicyPlaceholder":
			"https://provider.example/privacy",
		"admin.providerProcessingRegion": "Adatfeldolgozási régió",
		"admin.providerProcessingRegionDescription":
			"Opcionális kétbetűs országkód kompakt adatvédelmi jelzésként.",
		"admin.providerProcessingRegionPlaceholder": "CN",
		"admin.providers": "Szolgáltatók",
		"admin.rateLimitFallback": "Rate-limit tartalék",
		"admin.rateLimitFallbackApiKey": "Tartalék API-kulcs",
		"admin.rateLimitFallbackBaseUrl": "Tartalék alap-URL",
		"admin.rateLimitFallbackDescription":
			"A szolgáltatói sebességkorlátos válaszok újrapróbálása külön OpenAI-kompatibilis végponton keresztül.",
		"admin.rateLimitFallbackEnabled":
			"Sebességkorlátos tartalék út engedélyezése",
		"admin.rateLimitFallbackModelName": "Tartalék modell neve",
		"admin.rateLimitFallbackProvider": "Tartalék szolgáltató",
		"admin.rateLimitFallbackProviderDesc":
			"Válasszon ki egy meglévő szolgáltatót, amelyet tartalékként használ sebességkorlát esetén.",
		"admin.rateLimitFallbackTimeoutMs": "Tartalék időkorlát (ms)",
		"admin.selectModel": "Válasszon modellt...",
		"admin.selectProvider": "Válasszon szolgáltatót...",
		"admin.rateSizeLimits": "Sebesség- és méretkorlátok",
		"admin.reasoningEffort": "Gondolkodási erőfeszítés",
		"admin.reasoningTokens": "Gondolkodási tokenek",
		"admin.refresh": "Frissítés",
		"admin.removeModelAliasA11y": "{number}. alias eltávolítása",
		"admin.requestTimeoutDescription": `HTTP-kérés és stream időkorlátja milliszekundumban (alapértelmezett 300000 = 5 perc). Növeld meg többkörös keresési munkákhoz.`,
		"admin.requestTimeoutMs": "Kérés időkorlát (ms)",
		"admin.resetAccount": "Fiók visszaállítása",
		"admin.resetAccountButton": "Fiók visszaállítása",
		"admin.resetAccountDescription": `Ez törli a beszélgetéseidet, a Tudásbázist, az emlékeket és a generált fájlokat, de megtartja a bejelentkezési adataidat, a profilbeállításokat, az avatart és a korábbi analitikai adatokat. A visszaállítás befejezése után újra be kell jelentkezned.`,
		"admin.resetting": "Visszaállítás…",
		"admin.revokeSessions": "Munkamenetek visszavonása",
		"admin.role": "Szerepkör",
		"admin.saveChanges": "Változtatások mentése",
		"admin.saveConfiguration": "Konfiguráció mentése",
		"admin.searchByNameOrEmail": "Keresés név vagy e-mail-cím alapján",
		"admin.secretConfigured": "A titkos kulcs már be van állítva",
		"admin.selectUser":
			"Válassz ki egy felhasználót a fiókadatok és műveletek megtekintéséhez.",
		"admin.show": "Megjelenítés",
		"admin.summarizerModelDescription":
			"A fenti végpont által kiszolgált modell neve.",
		"admin.summarizerUrlDescription":
			"OpenAI-kompatibilis végpont. Ugyanazt a vLLM-szervert használja, mint a címgenerátor. Hagyd üresen a letiltáshoz.",
		"admin.systemPrompt": "Rendszerprompt",
		"admin.systemPromptDescription": `Állítsd be az összes modellhez használt rendszerpromptot. Beilleszthetsz egy teljes rendszerpromptot, vagy megadhatsz egy referenciakulcsot, például \`alfyai-nemotron\`. Hagyd üresen a modellenkénti alapértelmezésekhez.`,
		"admin.systemPromptLabel": "Rendszerprompt",
		"admin.systemSkills.createTitle": "Skill létrehozása",
		"admin.systemSkills.created": "Skill létrehozva.",
		"admin.systemSkills.description": `Admin által meghatározott skillek kezelése. A felhasználók az engedélyezett, közzétett összefoglalókat látják, de az utasításokat csak adminok szerkeszthetik.`,
		"admin.systemSkills.descriptionPlaceholder":
			"Felhasználóknak megjelenő rövid cél",
		"admin.systemSkills.displayNamePlaceholder": "Review partner",
		"admin.systemSkills.editTitle": "Skill szerkesztése",
		"admin.systemSkills.empty": "Még nincsenek skillek.",
		"admin.systemSkills.errors.load": "Nem sikerült betölteni a skilleket.",
		"admin.systemSkills.errors.save": "Nem sikerült menteni a skillt.",
		"admin.systemSkills.instructionsPlaceholder":
			"Csak adminoknak látható utasítások ehhez a skillhez",
		"admin.systemSkills.loading": "Skillek betöltése...",
		"admin.systemSkills.new": "Új skill",
		"admin.systemSkills.publish": "Közzététel",
		"admin.systemSkills.publishA11y": "{name} közzététele",
		"admin.systemSkills.published": "Közzétéve",
		"admin.systemSkills.save": "Skill mentése",
		"admin.systemSkills.status.draft": "Vázlat",
		"admin.systemSkills.status.published": "Közzétéve",
		"admin.systemSkills.title": "Skillek",
		"admin.systemSkills.updated": "Skill frissítve.",
		"admin.targetConstructedContext": "Célkontextus (token)",
		"admin.thinkingType": "thinking.type",
		"admin.thirdPartyDescription": `A külső modellek ugyanazt az OpenAI-kompatibilis chat futtatást és csatlakoztatott eszközöket használják, mint a beépített modellek.`,
		"admin.titleGenCodeAppendixEn": "Címgenerátor kódfüggeléke (angol)",
		"admin.titleGenCodeAppendixHu": "Címgenerátor kódfüggeléke (magyar)",
		"admin.titleGenModel": "Címgenerátor modell",
		"admin.titleGenPromptEn": "Címgenerátor prompt (angol)",
		"admin.titleGenPromptHu": "Címgenerátor prompt (magyar)",
		"admin.titleGenUrl": "Címgenerátor URL",
		"admin.titleGenerator": "Címgenerátor",
		"admin.totalTokens": "Összes token",
		"admin.unchanged": "(változatlan)",
		"admin.uploadModelIcon": "Ikon feltöltése",
		"admin.uploadModelIconDescription":
			"Hagyd üresen a jelenlegi ikon megtartásához.",
		"admin.user": "Felhasználó",
		"admin.users": "Felhasználók",
		"admin.usersDescription": `Fiókok létrehozása, adminisztrátori hozzáférés kezelése, munkamenetek visszavonása és felhasználók eltávolítása szükség esetén.`,
		"admin.usersRole": "Felhasználók",
		"admin.validationFailed": "Az ellenőrzés sikertelen: {error}",
		"admin.routingRegions.title": "Útvonaltervezési lefedettség",
		"admin.routingRegions.description":
			"A map_route eszköz számára elérhető térképrégiók. A régiókat a szerver a Geofabrikról tölti le, és első használatkor saját OpenRouteService konténerben építi fel; a tétlen régiók leállnak, és igény szerint újraindulnak.",
		"admin.routingRegions.notConfigured":
			"Az útvonaltervezés nincs beállítva (ORS_BASE_URL vagy ROUTING_ON_DEMAND_ENABLED szükséges).",
		"admin.routingRegions.refresh": "Frissítés",
		"admin.routingRegions.request": "Régió előkészítése",
		"admin.routingRegions.requested":
			"A régió letöltése és felépítése sorba került.",
		"admin.routingRegions.unknownId": "Ismeretlen Geofabrik régióazonosító.",
		"admin.routingRegions.idPlaceholder":
			"Geofabrik azonosító, pl. austria vagy bayern",
		"admin.routingRegions.catalogue": "Régiókatalógus",
		"admin.routingRegions.colRegion": "Régió",
		"admin.routingRegions.colStatus": "Állapot",
		"admin.routingRegions.colGeocoder": "Geokódoló",
		"admin.routingRegions.colTransit": "Menetrend",
		"admin.routingRegions.refreshTransit": "Menetrend frissítése",
		"admin.routingRegions.retryFeed": "Forrás újra",
		"admin.routingRegions.feedCount": "{ready}/{total} forrás",
		"admin.routingRegions.transitQueued":
			"A menetrend újraépítése sorba állítva; a régió az új tömegközlekedési gráf elkészültekor indul újra.",
		"admin.routingRegions.colResident": "Állandó",
		"admin.routingRegions.viaSource": "forrás: {source}",
		"admin.routingRegions.retryAt":
			"újrapróbálás: {time} ({attempts}. kísérlet)",
		"admin.routingRegions.attempts": "{attempts} kísérlet",
		"admin.routingRegions.colSize": "Kivonat",
		"admin.routingRegions.colEndpoint": "Végpont",
		"admin.routingRegions.colLastUsed": "Utoljára használva",
		"admin.routingRegions.legacy": "rögzített példány",
		"admin.routingRegions.retry": "Újra",
		"admin.routingRegions.remove": "Eltávolítás",
		"admin.routingRegions.confirmRemove":
			"Eltávolítod ezt a régiót? A konténere és a letöltött adatai törlődnek.",
		"admin.routingRegions.empty": "Még nincs régió.",
		"admin.effectiveConfig.columns.key": "Kulcs",
		"admin.effectiveConfig.columns.override": "Admin felülírás",
		"admin.effectiveConfig.columns.source": "Forrás",
		"admin.effectiveConfig.columns.value": "Tényleges érték",
		"admin.effectiveConfig.description":
			"Honnan származik az egyes futó értékek: itt mentett admin felülírásból, a szerver környezetéből vagy a beépített alapértelmezésből. A titkok el vannak rejtve.",
		"admin.effectiveConfig.empty":
			"Nincs a szűrőnek megfelelő konfigurációs kulcs.",
		"admin.effectiveConfig.errors.load":
			"Nem sikerült betölteni a tényleges konfigurációt.",
		"admin.effectiveConfig.filter": "Kulcsok vagy értékek szűrése",
		"admin.effectiveConfig.filterA11y": "Konfigurációs kulcsok szűrése",
		"admin.effectiveConfig.generatedAt": "Lekérdezve: {time}",
		"admin.effectiveConfig.loading": "Tényleges konfiguráció betöltése…",
		"admin.effectiveConfig.models.enabled": "providers sor engedélyezve",
		"admin.effectiveConfig.models.disabled": "providers sor letiltva",
		"admin.effectiveConfig.models.missing": "nincs providers sor",
		"admin.effectiveConfig.models.resolvedFrom.admin_config_env":
			"admin konfigból / környezetből feloldva",
		"admin.effectiveConfig.models.resolvedFrom.providers_table":
			"a providers táblából feloldva",
		"admin.effectiveConfig.models.resolvedFrom.unresolved": "nem oldható fel",
		"admin.effectiveConfig.models.resolvesTo": "erre oldódik fel: {model}",
		"admin.effectiveConfig.models.shadowed":
			"Elfedett admin felülírások: {keys}",
		"admin.effectiveConfig.models.title": "Beépített modellek feloldása",
		"admin.effectiveConfig.notSet": "nincs beállítva",
		"admin.effectiveConfig.refresh": "Újratöltés",
		"admin.effectiveConfig.source.admin_config": "admin felülírás",
		"admin.effectiveConfig.source.default": "alapértelmezés",
		"admin.effectiveConfig.source.env": "környezet",
		"admin.effectiveConfig.title": "Tényleges konfiguráció",
		"admin.toolHealth.columns.backend": "Háttérszolgáltatás",
		"admin.toolHealth.columns.checked": "Utolsó ellenőrzés",
		"admin.toolHealth.columns.detail": "Részletek",
		"admin.toolHealth.columns.latency": "Késleltetés",
		"admin.toolHealth.columns.status": "Állapot",
		"admin.toolHealth.columns.tool": "Eszköz",
		"admin.toolHealth.description":
			"Az egyes chat-eszközök mögötti szolgáltatások elérhetősége. A próbák 5 másodperces időkorláttal futnak, és néhány percig gyorsítótárazódnak.",
		"admin.toolHealth.empty": "Nincs regisztrált eszköz.",
		"admin.toolHealth.errors.load":
			"Nem sikerült betölteni az eszközállapotot.",
		"admin.toolHealth.lastChecked": "Utolsó ellenőrzés: {time}",
		"admin.toolHealth.loading": "Eszközállapot ellenőrzése…",
		"admin.toolHealth.refresh": "Frissítés",
		"admin.toolHealth.refreshing": "Ellenőrzés…",
		"admin.toolHealth.status.degraded": "Korlátozott",
		"admin.toolHealth.status.healthy": "Működik",
		"admin.toolHealth.status.unconfigured": "Nincs beállítva",
		"admin.toolHealth.title": "Eszközállapot",
		"admin.webResearch": "Webes kutatás",
		"admin.webResearchDescription":
			"Szerveroldali webes keresési és kutatási kulcsok. A Parallel végzi a webes keresést és oldalkutatást; a Brave külön a képkereséshez használatos.",
		"admin.webPushVapidPrivateKey": "Web Push VAPID privát kulcs",
		"admin.webPushVapidPublicKey": "Web Push VAPID nyilvános kulcs",
		"admin.webPushVapidSubject": "Web Push VAPID tárgy",
		"admin.working": "Feldolgozás…",
		"admin.xHigh": "Extra magas",
		"admin.yourPassword": "A jelszavad",
		"analytics.allTime": "Összes idő",
		"analytics.avgResponseTime": "Átlagos válaszidő",
		"analytics.avgTime": "Átlagidő",
		"analytics.chartConversations": "Beszélgetések",
		"analytics.chartCostUsd": "Költség (USD)",
		"analytics.chartMessages": "Üzenetek",
		"analytics.chats": "Beszélgetések",
		"analytics.comparisonVsMonth":
			"{month} hónaphoz képest {direction} {percent}%",
		"analytics.conversations": "Beszélgetések",
		"analytics.cost": "Költség",
		"analytics.costByModel": "Költség modellenként",
		"analytics.favoriteModel": "Kedvenc modell",
		"analytics.loadingAnalytics": "Analitika betöltése...",
		"analytics.messagesSent": "Elküldött üzenetek",
		"analytics.model": "Modell",
		"analytics.modelUsage": "Modellhasználat",
		"analytics.msgs": "Üzenetek",
		"analytics.nextMonth": "Következő hónap",
		"analytics.nextPerUserMonth": "Következő felhasználónkénti hónap",
		"analytics.nextSystemMonth": "Következő rendszerhónap",
		"analytics.noData": "Még nincs analitikai adat.",
		"analytics.output": "Kimenet",
		"analytics.perUserBreakdown": "Felhasználónkénti bontás",
		"analytics.previousMonth": "Előző hónap",
		"analytics.previousPerUserMonth": "Előző felhasználónkénti hónap",
		"analytics.previousSystemMonth": "Előző rendszerhónap",
		"analytics.prompt": "Prompt",
		"analytics.reasoning": "Gondolkodás",
		"analytics.reasoningTokens": "Gondolkodási tokenek",
		"analytics.retry": "Újrapróbálkozás",
		"analytics.systemOverview": "Rendszeráttekintés",
		"analytics.timelineMonthly": "Havi",
		"analytics.timelineWeekly": "Heti",
		"analytics.timelineYearly": "Éves",
		"analytics.tokenUsage": "Tokenhasználat",
		"analytics.tokensUsed": "Felhasznált tokenek",
		"analytics.tooltipMessages": "üzenet",
		"analytics.totalConversations": "Összes beszélgetés",
		"analytics.totalMessages": "Összes üzenet",
		"analytics.totalTokens": "Összes token",
		"analytics.totalUsers": "Összes felhasználó",
		"analytics.user": "Felhasználó",
		"analytics.userActivity": "Felhasználói aktivitás",
		"analytics.usageByModel": "Használat modellenként",
		"analytics.yourActivity": "A tevékenységed",
		"analytics.excludedUsers": "Kizárt felhasználók",
		"analytics.excludedUsersDescription":
			"A kizárt felhasználók nem jelennek meg a Rendszeráttekintés és a Felhasználónkénti bontás szekciókban. A személyes analitikádat ez nem érinti.",
		"analytics.saving": "Mentés\u2026",
		"analytics.saved": "Mentve",
		"analytics.saveFailed": "Mentés sikertelen",
		"analytics.overview": "Áttekintés",
		"analytics.byUser": "Felhasználónként",
		"analytics.parallelApi": "Parallel API",
		"analytics.provider": "Szolgáltató",
		"analytics.calls": "Hívások",
		"analytics.messages": "Üzenetek",
		"analytics.month": "Hónap",
		"analytics.turbo": "Turbo",
		"analytics.extract": "Extract",
		"analytics.total": "Összesen",
		"analytics.webCalls": "Webhívások",
		"analytics.activeUsers": "Aktív felhasználók",
		"analytics.turboSearches": "Turbo keresések",
		"analytics.extractFetches": "Extract lekérések",
		"analytics.parallelCost": "Parallel költség",
		"analytics.totalCalls": "Összes hívás",
		"analytics.llmParallelSplit": "LLM {llm} · Parallel {parallel}",
		"analytics.parallelUsage": "Turbo vs Extract használat",
		"analytics.monthlyBreakdown": "Havi bontás",
		"analytics.monthlyCost": "Havi költség",
		"analytics.filterModels": "Modellek szűrése…",
		"analytics.filterUsers": "Felhasználók szűrése…",
		"analytics.allUsers": "Minden felhasználó",
		"analytics.allProviders": "Minden szolgáltató",
		"analytics.allModels": "Minden modell",
		"analytics.showRetired": "Kivezetettek megjelenítése",
		"analytics.modelCalls": "Modellhívások",
		"analytics.firstTokenMedian": "Első token medián",
		"analytics.firstTokenP50": "Első token p50",
		"analytics.firstTokenP90": "Első token p90",
		"analytics.generationP50": "Generálás p50",
		"analytics.modelsActiveConfigured": "Aktív / konfigurált modellek",
		"analytics.status": "Állapot",
		"analytics.statusActive": "Aktív",
		"analytics.statusDisabled": "Letiltva",
		"analytics.statusRemoved": "Eltávolítva",
		"analytics.retiredGroupLabel":
			"Kivezetve · már egyik szolgáltató sem kínálja",
		"analytics.toolsAndLatency": "Eszközök és késleltetés",
		"analytics.tools": "Eszközök",
		"analytics.tool": "Eszköz",
		"analytics.failedPercent": "Sikertelen %",
		"analytics.cachedPercent": "Gyorsítótárból kiszolgálva %",
		"analytics.durationP50": "Időtartam p50",
		"analytics.commandsSkillsActions": "Parancsok, készségek és műveletek",
		"analytics.name": "Név",
		"analytics.kind": "Típus",
		"analytics.uses": "Használat",
		"analytics.kindCommand": "Parancs",
		"analytics.kindSkill": "Készség",
		"analytics.kindClick": "Kattintás",
		"analytics.latencyByPromptSize": "Késleltetés prompt méret szerint",
		"analytics.promptBucket": "Prompt méret",
		"analytics.turns": "Körök",
		"analytics.reasoningTokensMedian": "Gondolkodási tokenek mediánja",
		"analytics.showingOfTotal": "{shown} / {total} megjelenítve",
		"analytics.viewAllCount": "Mind a(z) {total} megtekintése →",
		"analytics.showFewer": "Kevesebb megjelenítése",
		"campaignCrop.backdropClose": "Kampány képernyőkép-vágó bezárása",
		"campaignCrop.cropAreaLabel": "Kampány képernyőkép kivágási területe",
		"campaignCrop.desktopMetadata": "16:10 asztali kivágás",
		"campaignCrop.mobileMetadata": "9:16 mobil kivágás",
		"campaignCrop.modelIconMetadata": "1:1 modellikon-kivágás",
		"campaignCrop.prepareError":
			"A kampány képernyőkép kivágása nem készíthető elő.",
		"campaignCrop.previewLabel": "Kivágás előnézete",
		"campaignCrop.reset": "Visszaállítás",
		"campaignCrop.save": "Kivágás mentése",
		"campaignCrop.saveError":
			"A kampány képernyőkép kivágásának mentése sikertelen.",
		"campaignCrop.title": "Kampány képernyőkép kivágása",
		"campaignCrop.zoom": "Nagyítás",
		"campaignModal.announcement": "Bejelentés",
		"campaignModal.back": "Vissza",
		"campaignModal.empty": "Nincsenek előnézhető kampánydiák.",
		"campaignModal.finish": "Befejezés",
		"campaignModal.label": "Kampánybejelentés",
		"campaignModal.next": "Következő",
		"campaignModal.noImage": "Nincs csatolt képernyőkép",
		"campaignModal.preview": "Előnézet",
		"campaignModal.previewLabel": "Kampánybejelentés előnézete",
		"campaignModal.previous": "Előző",
		"campaignModal.progressLabel": "Kampány előrehaladása",
		"campaignModal.progressSlide": "{current}. dia / {total}",
		"campaignModal.setup.label": "Beállítási preferenciák",
		"campaignModal.skip": "Kihagyás",
		"campaignModal.slideCount": "{current} / {total}",
		"campaignModal.untitled": "Névtelen kampány",
		settings_admin: "Admin",
		settings_appearance: "Megjelenés",
		settings_atLeast8Chars: "Legalább 8 karakter",
		settings_autoDetect: "Automatikus",
		settings_avatar: "Profilkép",
		// ADR-0043 slice 18a — Profil csoportosított szakaszok, ikongombok, zsargonmentesítés.
		settings_conversationStyle: "Beszélgetési stílus",
		settings_conversationStyleNote:
			"Hogyan válaszol az AlfyAI alapértelmezés szerint.",
		settings_interfaceLanguage: "Felület nyelve",
		settings_interfaceLanguageNote:
			"A menükben és gombokban használt nyelv. A cím nyelvét lent külön is beállíthatod.",
		settings_removePhotoA11y: "Kép eltávolítása",
		settings_sectionAccount: "Fiók",
		settings_sectionAssistant: "Asszisztens",
		settings_sectionDataPrivacy: "Adatok és adatvédelem",
		// Task 14: sticky in-page nav landmark label (jumps between the groups).
		settings_sectionNavA11yLabel: "Profil szakaszai",
		settings_sectionPreferences: "Beállítások",
		// ADR-0043 slice 18c: 5th Profile section (personal analytics merged in).
		settings_sectionYourActivity: "A tevékenységed",
		settings_systemAnalyticsTab: "Rendszerstatisztika",
		// ADR-0043 slice 18b: Skills summary card + full-screen manager.
		settings_skillsManagerBack: "Vissza a beállításokhoz",
		settings_skillsManagerOpenA11y: "Skill-kezelő megnyitása",
		settings_skillsManagerStatus: "{active} aktív · {disabled} letiltva",
		settings_skillsManagerSummaryLabel: "Skillek",
		settings_skillsManagerTitle: "Skillek",
		settings_uploadPhotoA11y: "Kép feltöltése",
		settings_campaignsTab: "Kampányok",
		settings_changePassword: "Jelszó módosítása",
		settings_confirmNewPassword: "Új jelszó megerősítése",
		settings_createUserBtn: "Felhasználó létrehozása",
		settings_createUserDescription:
			"Hozz létre egy új helyi fiókot, és opcionálisan azonnal adj neki admin jogosultságot.",
		settings_createUserTitle: "Felhasználó létrehozása",
		settings_creating: "Létrehozás...",
		settings_currentPassword: "Jelenlegi jelszó",
		settings_archiveDescription:
			"Erősítsd meg a jelszavad, hogy elkészüljön a bejelentkezett fiókod ideiglenes ZIP-archívuma.",
		settings_archiveDownloaded: "Elindult az adatarchívum letöltése.",
		settings_clearMemoryAndKnowledge: "Memória és tudás törlése",
		settings_clearMemoryDescription:
			"Ez törli a megjegyzett kontextust, a Tudásbázis dokumentumait, a dokumentumokból származó kontextust, a folytonossági állapotot, a beágyazásokat, a munkakészlet- és kontextusállapotot, valamint a tárolt bizonyítéknyomokat. A beszélgetéseid megmaradnak, és bejelentkezve maradsz.",
		settings_clearMemorySuccess:
			"A memória és a tudás törölve. A beszélgetéseid továbbra is elérhetők.",
		settings_clearWorkspaceData: "Munkaterületi adatok törlése",
		settings_clearWorkspaceDescription:
			"Ez törli a beszélgetéseket, a Tudásbázis tartalmát, az alkalmazás által kezelt memóriát, a generált fájlokat és a munkaterületi folytonosságot, miközben megtartja a bejelentkezést, a profilbeállításokat, az avatart és a korábbi analitikai adatokat. A befejezés után kijelentkeztetünk.",
		settings_clearing: "Törlés...",
		settings_dangerZone: "Veszélyzóna",
		settings_dark: "Sötét",
		settings_defaultModel: "Alapértelmezett modell",
		settings_deleteAccount: "Fiók törlése",
		settings_deleteAccountDescription: `Ez véglegesen törli a fiókodat, a chat-előzményeket, a tudásbázist, az emlékeket, a generált fájlokat, a profilbeállításokat és az avatart. A korábbi analitikai adatok megmaradnak. Ez nem vonható vissza.`,
		settings_deleteAccountTitle: "Fiók törlése",
		settings_deletePermanently: "Végleges törlés",
		settings_deleteUserBtn: "Felhasználó törlése",
		settings_deleteUserMessage: `Ez véglegesen törli a kiválasztott felhasználói fiókot, a chat-előzményeket és a tárolt adatokat. Ez nem vonható vissza.`,
		settings_deleteUserTitle: "Felhasználó törlése",
		settings_deleting: "Törlés...",
		settings_displayName: "Megjelenítési név",
		settings_done: "Kész",
		settings_emailAddress: "E-mail-cím",
		settings_emailExample: "pelda@example.com",
		settings_english: "Angol",
		settings_enterPasswordConfirm: "Add meg a jelszavad a megerősítéshez:",
		settings_hidePassword: "Jelszó elrejtése",
		settings_hungarian: "Magyar",
		settings_light: "Világos",
		settings_memory: "Memória",
		settings_memoryHelp:
			"Bekapcsolva az AlfyAI a beszélgetéseken átívelően megtanulja és megjegyzi a rólad szóló tényeket, hogy személyre szabja a válaszait. Kikapcsolással minden tanulás szünetel — a meglévő emlékeid megmaradnak, de újak nem keletkeznek.",
		settings_newPassword: "Új jelszó",
		settings_optionalDisplayName: "Opcionális megjelenítési név",
		settings_passwordChanged: "Jelszó módosítva.",
		settings_passwordLabel: "Jelszó",
		settings_passwordMismatch: "Az új jelszavak nem egyeznek.",
		settings_passwordTooShort:
			"A jelszónak legalább 8 karakter hosszúnak kell lennie.",
		settings_preferences: "Beállítások",
		settings_privacyPolicy: "Adatvédelmi irányelvek",
		settings_privacyControls: "Adatvédelmi és adatkezelési vezérlők",
		settings_privacyControlsDescription:
			"Töltsd le a fiókarchívumodat, vagy törölj adatokat ebből a munkaterületből. Minden művelethez meg kell adnod a jelszavad, mielőtt bármi változna.",
		settings_deleteAccountPrivacy: "Fiók törlése",
		settings_deleteAccountPrivacyDescription:
			"Ez véglegesen törli a fiókodat és a személyes munkaterületi adataidat, miután leállítja a hozzád tartozó futó munkákat. Csak névtelenített összesített használati és költségadatok maradhatnak meg. A befejezés után kijelentkeztetünk.",
		settings_downloadBeforeDestructive:
			"A folytatás előtt letöltheted az adataidat. A törlő művelet akkor is elérhető marad, ha nem töltesz le archívumot.",
		settings_downloadMyData: "Adataim letöltése",
		settings_downloadingData: "Letöltés előkészítése...",
		settings_profileInformation: "Profiladatok",
		settings_profileUpdated: "Profil frissítve.",
		settings_removePhoto: "Kép eltávolítása",
		settings_removing: "Eltávolítás...",
		settings_resetAccount: "Fiók visszaállítása",
		settings_resetAccountDescription: `Ez törli a chat-előzményeket, a tudásbázist, az emlékeket és a generált fájlokat, de megtartja a bejelentkezési adatokat, a profilbeállításokat, az avatart és a korábbi analitikai adatokat. A visszaállítás után újra be kell jelentkezned.`,
		settings_resetAccountTitle: "Fiók visszaállítása",
		settings_resetDescription: `A visszaállítás törli a chat-előzményeket, a tudásbázist, az emlékeket és a generált fájlokat, de meghagyja a bejelentkezést, a profilbeállításokat és az avatart. A törlés véglegesen eltávolítja a fiókot is.`,
		settings_resetMemory: "Memória visszaállítása",
		settings_resetMemoryMessage: `Elfelejtsük mindazt, ami a Tudásbázisban van? Ez eltávolítja a személyiség-memóriát, a feladat-folytonosságot, a chat-közi folytonosságot, a dokumentumokat, az eredményeket, a munkafolyamatokat és a tárolt bizonyítékokat, de megtartja magukat a beszélgetéseket.`,
		settings_resetting: "Visszaállítás...",
		settings_role: "Szerepkör",
		settings_save: "Mentés",
		settings_saving: "Mentés...",
		settings_showPassword: "Jelszó megjelenítése",
		settings_system: "Rendszer",
		settings_systemTab: "Rendszer",
		settings_theme: "Téma",
		settings_titleLanguage: "Cím nyelve",
		settings_uploadPhoto: "Kép feltöltése",
		settings_user: "Felhasználó",
		settings_userEmailPlaceholder: "felhasznalo@example.com",
		settings_usersTab: "Felhasználók",
		settings_yourName: "A neved",
		settings_yourPasswordPlaceholder: "A jelszavad",
		// --- BEGIN admin Users & Campaigns redesign keys ---
		"admin.users.accountSummary":
			"{total} fiók · {admins} adminisztrátor · {never} még sosem lépett be",
		"admin.users.actionNote":
			"Az előléptetés és a törlés megerősítést kér. A munkamenetek visszavonása mindenhonnan kilépteti őt ({name}), és nem kér megerősítést.",
		"admin.users.actions": "Műveletek",
		"admin.users.adminGrantsNote":
			"Az adminisztrátor látja minden beszélgetés metaadatait, mindenkinek módosíthatja a modelleket, és fiókokat törölhet.",
		"admin.users.column.email": "E-mail",
		"admin.users.column.lastActive": "Utoljára aktív",
		"admin.users.column.messages": "Üzenetek",
		"admin.users.column.name": "Név",
		"admin.users.column.role": "Szerepkör",
		"admin.users.column.tokens": "Tokenek",
		"admin.users.createUserDescription":
			"A nevét, jelszavát és modelljét később ő maga módosíthatja. Nincs meghívó e-mail — a jelszót neked kell átadnod.",
		"admin.users.detailsColumn": "Részletek",
		"admin.users.generatePassword": "Generálás",
		"admin.users.errors.action": "A művelet nem sikerült.",
		"admin.users.errors.create": "A felhasználó létrehozása nem sikerült.",
		"admin.users.errors.load": "A felhasználók betöltése nem sikerült.",
		"admin.users.hiddenByFilter":
			"Ezt a fiókot elrejtik a jelenlegi szűrők. Töröld őket, hogy újra megjelenjen a táblázatban.",
		"admin.users.lastActive.days": "{count} napja",
		"admin.users.lastActive.hours": "{count} órája",
		"admin.users.lastActive.minutes": "{count} perce",
		"admin.users.lastActive.never": "Soha",
		"admin.users.lastActive.now": "Épp most",
		"admin.users.lastActive.yesterday": "Tegnap",
		"admin.users.nextPage": "Következő",
		"admin.users.pageOf": "{page} / {pageCount}",
		"admin.users.passwordLongEnough": "{count} karakter — elég hosszú",
		"admin.users.passwordTooShort": "Legalább {count} karakter",
		"admin.users.previousPage": "Előző",
		"admin.users.messages.deleted": "A felhasználó törölve.",
		"admin.users.messages.demoted": "Az admin hozzáférés visszavonva.",
		"admin.users.messages.promoted": "Az admin hozzáférés megadva.",
		"admin.users.messages.sessionsRevoked":
			"Az aktív munkamenetek visszavonva.",
		"admin.users.promoteMessage":
			"Az adminisztrátor mindenkinek módosíthatja a modelleket és a rendszerpromptot, láthatja mindenki fiókszintű analitikáját, fiókokat hozhat létre és törölhet, és más adminisztrátorokat is kinevezhet. {name} bármikor visszaminősíthető.",
		"admin.users.promoteTitle": "Legyen {name} adminisztrátor?",
		"admin.users.rowsPerPage": "Sorok oldalanként",
		"admin.users.showingNone": "Nincs megjeleníthető sor",
		"admin.users.showingRange": "{from}–{to} / {total} megjelenítve",
		"admin.users.sortAscending": "növekvő sorrend",
		"admin.users.sortColumn": "rendezés eszerint az oszlop szerint",
		"admin.users.sortCustom": "Egyéni sorrend",
		"admin.users.sortDescending": "csökkenő sorrend",
		"admin.users.sortLabel": "Rendezés",
		"admin.users.tokenSplit": "{completion} válasz · {reasoning} gondolkodás",
		"admin.users.tokensAllTime": "Felhasznált tokenek összesen",
		"admin.users.you": "te",
		"admin.campaigns.actionDestination": "Gomb célhelye",
		"admin.campaigns.actionLabel": "Gomb felirata",
		"admin.campaigns.actionLabelPlaceholder": "Próbáld ki",
		"admin.campaigns.addSlide": "Dia hozzáadása",
		"admin.campaigns.analyticsCompletedLabel": "Befejezve",
		"admin.campaigns.analyticsReplayed": "Újranézve",
		"admin.campaigns.analyticsShown": "Megjelenítve",
		"admin.campaigns.analyticsSkipped": "Kihagyva",
		"admin.campaigns.archivedOn": "archiválva: {date}",
		"admin.campaigns.archivedReadOnly":
			"Az archivált kampányok nem módosíthatók. A szerkesztéshez duplikáld piszkozatként.",
		"admin.campaigns.assetAdd": "Hozzáadás",
		"admin.campaigns.assetAttachedShort": "Csatolt képernyőkép",
		"admin.campaigns.assetRecrop": "Újravágás",
		"admin.campaigns.assetRecropUnavailable":
			"Az eredeti feltöltés már nem érhető el ehhez a kivágáshoz. Cseréld a képernyőképet az újravágáshoz.",
		"admin.campaigns.assetRemove": "Eltávolítás",
		"admin.campaigns.assetReplace": "Csere",
		"admin.campaigns.campaignMenuLabel": "Kampány",
		"admin.campaigns.campaignMenuTrigger": "Kampányműveletek",
		"admin.campaigns.checklist.allPass":
			"{passed} / {total} ellenőrzés rendben ·",
		"admin.campaigns.checklist.fail.actionDestination": "Gomb célhelye",
		"admin.campaigns.checklist.fail.actionLabel":
			"Gombfelirat ezen a nyelven: {language}",
		"admin.campaigns.checklist.fail.alt": "{language} alternatív szöveg",
		"admin.campaigns.checklist.fail.dataDisclosure": "Adatkezelési dia",
		"admin.campaigns.checklist.fail.layout": "Dia elrendezése",
		"admin.campaigns.checklist.fail.localizedBody": "{language} szöveg",
		"admin.campaigns.checklist.fail.localizedTitle": "{language} cím",
		"admin.campaigns.checklist.fail.localizedTitleAndBody":
			"{language} cím és szöveg",
		"admin.campaigns.checklist.fail.name": "Kampány neve",
		"admin.campaigns.checklist.fail.order": "Diák sorrendje",
		"admin.campaigns.checklist.fail.purpose": "Dia célja",
		"admin.campaigns.checklist.fail.releaseVersion": "Kiadás verziószáma",
		"admin.campaigns.checklist.fail.setupControls": "Beállítási vezérlők",
		"admin.campaigns.checklist.fail.setupSlide": "Pontosan egy beállítási dia",
		"admin.campaigns.checklist.fail.slides": "Legalább egy dia",
		"admin.campaigns.checklist.fail.type": "Kampány típusa",
		"admin.campaigns.checklist.failing": "{count} ellenőrzés nem megy át",
		"admin.campaigns.checklist.inSlideMenu": "a dia ⋯ menüjében",
		"admin.campaigns.checklist.passing": "{count} rendben",
		"admin.campaigns.checklist.readyToPublish": "Publikálásra kész",
		"admin.campaigns.checklist.rule.actionDestination":
			"A gombok célhelyei engedélyezettek",
		"admin.campaigns.checklist.rule.actionLabel":
			"Gombfeliratok mindkét nyelven",
		"admin.campaigns.checklist.rule.alt": "Alternatív szöveg minden képhez",
		"admin.campaigns.checklist.rule.dataDisclosure": "Adatkezelési dia",
		"admin.campaigns.checklist.rule.layout": "Minden diának van elrendezése",
		"admin.campaigns.checklist.rule.localized": "Cím és szöveg mindkét nyelven",
		"admin.campaigns.checklist.rule.name": "Kampány neve",
		"admin.campaigns.checklist.rule.order": "A diák sorrendje érvényes",
		"admin.campaigns.checklist.rule.purpose": "Minden diának van célja",
		"admin.campaigns.checklist.rule.releaseVersion": "Kiadás verziószáma",
		"admin.campaigns.checklist.rule.setupControls":
			"A beállítási vezérlők jó helyen vannak",
		"admin.campaigns.checklist.rule.setupSlide": "Pontosan egy beállítási dia",
		"admin.campaigns.checklist.rule.slides": "Legalább egy dia",
		"admin.campaigns.checklist.rule.type": "Kampány típusa",
		"admin.campaigns.checklist.slideHasIssues":
			"Ezen a dián hibás ellenőrzések vannak",
		"admin.campaigns.cropMetadata":
			"{number}. dia · {ratio} · WebP {size} méretben mentve",
		"admin.campaigns.destination.admin": "Adminisztráció",
		"admin.campaigns.destination.chat": "Új beszélgetés",
		"admin.campaigns.destination.home": "Kezdőlap",
		"admin.campaigns.destination.knowledge": "Tudásbázis",
		"admin.campaigns.destination.none": "Nincs gomb",
		"admin.campaigns.destination.notAllowed": "nem engedélyezett célhely",
		"admin.campaigns.destination.profile": "Profil",
		"admin.campaigns.destination.settings": "Beállítások",
		"admin.campaigns.duplicateAsDraft": "Duplikálás piszkozatként",
		"admin.campaigns.editDetailsTitle": "Kampány adatai",
		"admin.campaigns.fieldError.actionLabel": "A(z) {language} felirat üres.",
		"admin.campaigns.fieldError.alt": "A(z) {language} alternatív szöveg üres.",
		"admin.campaigns.fieldError.body": "A(z) {language} szöveg üres.",
		"admin.campaigns.fieldError.title": "A(z) {language} cím üres.",
		"admin.campaigns.finishedAllSlides": "Mind a(z) {count} diát végignézte",
		"admin.campaigns.howItPerformed": "Hogyan teljesített",
		"admin.campaigns.language.en": "angol",
		"admin.campaigns.language.hu": "magyar",
		"admin.campaigns.liveSince": "élesben {date} óta",
		"admin.campaigns.menu.copyEnToHu": "Angol másolása magyarra",
		"admin.campaigns.menu.deleteSlide": "Dia törlése",
		"admin.campaigns.menu.layout": "Elrendezés — {value}",
		"admin.campaigns.menu.moveDown": "Mozgatás lefelé",
		"admin.campaigns.menu.moveUp": "Mozgatás felfelé",
		"admin.campaigns.menu.purpose": "Cél — {value}",
		"admin.campaigns.menu.setupControls": "Beállítási vezérlők — {count}",
		"admin.campaigns.menu.setupControlsNone": "Beállítási vezérlők — nincs",
		"admin.campaigns.mobileFallsBack": "Az asztali kivágást használja",
		"admin.campaigns.mobileFallsBackHelp":
			"Saját 9:16-os kivágás nélkül a telefonok az asztali képernyőképet mutatják, fekete sávokkal.",
		"admin.campaigns.newCampaign": "Új kampány",
		"admin.campaigns.newCampaignDescription":
			"Adj neki nevet, válaszd ki, mire szól, a diákat utána add hozzá.",
		"admin.campaigns.previewDesktop": "Asztali előnézet",
		"admin.campaigns.previewDevice": "Előnézet mérete",
		"admin.campaigns.previewMobile": "Telefonos előnézet",
		"admin.campaigns.publishedReadOnly":
			"A publikált diák nem módosíthatók. A szerkesztéshez duplikáld piszkozatként.",
		"admin.campaigns.purpose.dataDisclosure": "Adatkezelés",
		"admin.campaigns.purpose.feature": "Funkció",
		"admin.campaigns.saveDetails": "Adatok mentése",
		"admin.campaigns.serverIssues": "A szerver elutasította ezt a kampányt:",
		"admin.campaigns.setupControl.aiStyle": "AI stílus",
		"admin.campaigns.setupControl.modelDefault": "Alapértelmezett modell",
		"admin.campaigns.setupControl.theme": "Téma",
		"admin.campaigns.setupControl.uiLanguage": "Felület nyelve",
		"admin.campaigns.setupControls": "Beállítási vezérlők",
		"admin.campaigns.setupControlsHelp":
			"Ezen a dián megjelenő vezérlők, hogy rögtön be lehessen állítani őket.",
		"admin.campaigns.setupControlsStray":
			"Ez a dia már nem első indítású beállítási dia, ezért ezek a vezérlők blokkolják a publikálást — töröld őket.",
		"admin.campaigns.setupControlsUnavailable":
			"A beállítási vezérlők csak az első indítású kampány beállítási diáján működnek.",
		"admin.campaigns.slideAction": "Gomb",
		"admin.campaigns.slideActionHelp":
			"Opcionális gomb a dián. A célhelyek az alkalmazáson belüli oldalakra korlátozódnak, és ha van célhely, a felirat mindkét nyelven kötelező.",
		"admin.campaigns.slideAlt": "Alternatív szöveg",
		"admin.campaigns.slideAltHelp":
			"A képernyőképet írja le képernyőolvasóknak. Ha van csatolt kép, mindkét nyelven kötelező.",
		"admin.campaigns.slideBody": "Szöveg",
		"admin.campaigns.slideLayout": "Elrendezés",
		"admin.campaigns.slideLayoutHelp":
			"A beállítási dia hordozza az első indítás vezérlőit; a normál dia csak tartalom.",
		"admin.campaigns.slideMenuLabel": "Dia",
		"admin.campaigns.slideMenuTrigger": "{number}. dia műveletei",
		"admin.campaigns.slideOptionsDescription":
			"Az elrendezést, a célt és a beállítási vezérlőket publikáláskor ellenőrizzük.",
		"admin.campaigns.slideOptionsTitle": "{number}. dia beállításai",
		"admin.campaigns.slidePurpose": "Cél",
		"admin.campaigns.slidePurposeHelp":
			"Az első indítású kampányhoz kell legalább egy adatkezelési dia, amely elmondja, mit tárol az alkalmazás.",
		"admin.campaigns.slideTitle": "Cím",
		"admin.campaigns.typeHelp":
			"Az első indítású kampány egyszer köszönti az új fiókokat; a kiadási frissítés mindenkinek bejelent egy verziót.",
		"admin.campaigns.untitledCampaign": "Névtelen kampány v{version}",
		"admin.campaigns.updatedOn": "frissítve: {date}",
		// --- END admin Users & Campaigns redesign keys ---
		// ---------------------------------------------------------------
		// Admin System screen redesign. Appended as one block so the three
		// redesign branches do not collide in the middle of the file.
		// ---------------------------------------------------------------
		"admin.system.nav.title": "Rendszerbeállítások",
		"admin.system.nav.readOnly": "Csak olvasható",
		"admin.system.nav.a11y": "Rendszerbeállítási oldalak",
		"admin.system.pages.general": "Általános",
		"admin.system.pages.models": "Modellek és szolgáltatók",
		"admin.system.pages.aiTasks": "AI-feladatok",
		"admin.system.pages.integrations": "Integrációk és kulcsok",
		"admin.system.pages.limits": "Korlátok",
		"admin.system.pages.skills": "Képességek",
		"admin.system.pages.advanced": "Haladó",
		"admin.system.pages.diagnostics": "Diagnosztika",
		"admin.system.search.placeholder":
			"Keresés minden beállításban, kulcsban vagy szolgáltatóban",
		"admin.system.search.a11y": "Keresés a rendszerbeállításokban",
		"admin.system.search.empty": "Nincs találat erre: „{query}”.",
		"admin.system.search.results": "{count} beállítás illeszkedik",
		"admin.system.search.goTo": "Ugrás ide: {page}",
		"admin.system.appliesImmediately": "Azonnal érvénybe lép",
		"admin.system.appliesImmediatelyLegend":
			"azokat a vezérlőket jelöli, amelyek azonnal mentenek — minden más a Mentésre vár.",
		"admin.system.unsaved": "Nincs mentve",
		"admin.system.unsavedRow": "{label}: nem mentett módosítás",
		"admin.system.defaultLabel": "Alapérték",
		"admin.system.valueLabel": "Érték",
		"admin.system.settingLabel": "Beállítás",
		"admin.system.takesEffect": "Érvénybe lép",
		"admin.system.effect.live": "azonnal",
		"admin.system.effect.nextRun": "következő futáskor",
		"admin.system.effect.restart": "újraindítás után",
		"admin.system.effect.liveHint":
			"A következő híváskor frissen olvasva — elég menteni.",
		"admin.system.effect.nextRunHint":
			"Az ütemező következő futásának számításakor lép érvénybe.",
		"admin.system.effect.restartHint":
			"Induláskor olvasva — újraindítás szükséges.",
		"admin.system.effect.unwired": "még nincs hatása",
		"admin.system.effect.unwiredHint":
			"Elmentjük és megőrizzük, de ezt az értéket még semmi nem olvassa — egy későbbi kiadás fogja.",
		"admin.system.resetToDefault": "Visszaállítás alapértékre",
		"admin.system.resetToDefaultA11y": "{label} visszaállítása az alapértékre",
		"admin.system.emptyValue": "nincs beállítva",
		"admin.system.invalid.number": "Egész szám szükséges.",
		"admin.system.invalid.min": "Legalább {limit} lehet.",
		"admin.system.invalid.max": "Legfeljebb {limit} lehet.",
		"admin.system.invalid.option": "Válassz a felsorolt értékek közül.",
		"admin.system.invalid.url": "Teljes http:// vagy https:// cím szükséges.",
		"admin.system.invalidCount": "{count} érték nem menthető",
		"admin.system.invalidCountPlural": "{count} érték nem menthető",
		"admin.discoverNone": "Nem található modell.",
		"admin.discoverFound": "{count} modell található. Létrehozás…",
		"admin.discoverCreated": "{count} modell létrehozva.",
		"admin.discoverFailed":
			"Nem sikerült modelleket felderíteni ennél a szolgáltatónál.",
		"admin.reorderFailed": "Nem sikerült módosítani az átterelési sorrendet.",
		"admin.providerTestOk": "A kapcsolat működik.",
		"admin.providerTestFailed": "A kapcsolat nem jött létre.",
		"admin.system.unit.ms": "ms",
		"admin.system.unit.s": "mp",
		"admin.system.unit.min": "perc",
		"admin.system.unit.days": "nap",
		"admin.system.unit.months": "hónap",
		"admin.system.unit.mb": "MB",
		"admin.system.unit.chars": "karakter",
		"admin.system.unit.tokens": "token",
		"admin.system.unit.words": "szó",
		"admin.system.save.allSaved": "Minden változás mentve",
		"admin.system.save.lastSaved": "Utoljára mentve: {time}",
		"admin.system.save.pendingOne": "1 nem mentett változás",
		"admin.system.save.pendingMany": "{count} nem mentett változás",
		"admin.system.save.button": "{count} változás mentése",
		"admin.system.save.buttonOne": "1 változás mentése",
		"admin.system.save.nothing": "Mentés",
		"admin.system.save.discard": "Elvetés",
		"admin.system.save.savingOne": "1 változás mentése…",
		"admin.system.save.savingMany": "{count} változás mentése…",
		"admin.system.save.savingDetail":
			"admin_config írása, majd a felület újratöltése",
		"admin.system.save.pageBreakdown": "{page} · {count}",
		"admin.system.leave.titleOne": "Elhagyod az 1 nem mentett változást?",
		"admin.system.leave.titleMany":
			"Elhagyod a(z) {count} nem mentett változást?",
		"admin.system.leave.description":
			"Felsoroljuk őket, hogy dönthess — nem csak annyit írunk, hogy „változások”.",
		"admin.system.leave.keepEditing": "Szerkesztés folytatása",
		"admin.system.leave.discardAndLeave": "Elvetés és kilépés",
		"admin.system.leave.saveAndLeave": "Mentés és kilépés",
		"admin.system.secret.set": "Beállítva",
		"admin.system.secret.notSet": "Nincs beállítva",
		"admin.system.secret.replace": "Csere",
		"admin.system.secret.add": "Kulcs hozzáadása",
		"admin.system.secret.cancel": "Marad a jelenlegi",
		"admin.system.secret.lastChanged": "utoljára módosítva: {date}",
		"admin.system.secret.writeOnly":
			"Csak írható — soha nem kerül vissza a böngészőbe.",
		"admin.system.secret.newValue": "{label} új értéke",
		"admin.system.general.title": "Általános",
		"admin.system.general.description":
			"Az a két beállítás, amely magához az alkalmazáshoz tartozik, nem egy modellhez.",
		"admin.system.providers.title": "Szolgáltatók",
		"admin.system.providers.description":
			"A sorrend a feladatátvétel sorrendje — mozgasd a szolgáltatót a módosításhoz. A képernyő összes modellválasztója az itt bekapcsolt szolgáltatókból épül fel.",
		"admin.system.providers.enabledOnly": "Csak a bekapcsoltak",
		"admin.system.providers.add": "Szolgáltató hozzáadása",
		"admin.system.providers.modelCount": "{count} modell",
		"admin.system.providers.modelCountOne": "1 modell",
		"admin.system.providers.modelsOn": "{provider} modelljei",
		"admin.system.providers.menu": "További műveletek: {provider}",
		"admin.system.providers.discover":
			"Modellek felderítése a /models végpontról",
		"admin.system.providers.manage": "Modellek és árazás kezelése",
		"admin.system.providers.edit": "Szolgáltató szerkesztése",
		"admin.system.providers.test": "Kapcsolat tesztelése",
		"admin.system.providers.delete": "Szolgáltató törlése…",
		"admin.system.providers.moveUp": "{provider} mozgatása felfelé",
		"admin.system.providers.moveDown": "{provider} mozgatása lefelé",
		"admin.system.providers.toggleA11y": "{provider} bekapcsolása",
		"admin.system.providers.expandA11y":
			"{provider} modelljeinek megjelenítése",
		"admin.system.providers.priceWindows": "Ársávok · {count}",
		"admin.system.priceWindows": "Ársávok",
		"admin.system.modelFree": "ingyenes",
		"admin.system.providers.hidden": "Rejtett",
		"admin.system.providers.default": "Alapértelmezett",
		"admin.system.providers.perMillion":
			"{input} / {output} 1M be/ki tokenenként",
		"admin.system.providers.emptyFiltered":
			"Egyetlen szolgáltató sincs bekapcsolva.",
		"admin.system.failover.title": "Időtúllépési átterelés",
		"admin.system.failover.description":
			"Ez minden modellre vonatkozó szabály, ezért külön kártyán van.",
		"admin.system.failover.summary":
			"Ha egy modell {seconds} másodpercen belül nem kezd válaszolni, a kérés egyszer újra lefut ezen: {model}. A felhasználó egy választ lát, hibát soha.",
		"admin.system.failover.summaryOff":
			"Kikapcsolva: a lassú modellt nem próbáljuk újra máshol.",
		"admin.system.failover.enabled":
			"Lassú kérések újrapróbálása másik modellen",
		"admin.system.failover.timeout": "Feladás ennyi után",
		"admin.system.failover.timeoutMeaning":
			"Az első tokenig mérve, nem a teljes válaszig.",
		"admin.system.failover.target": "Újrapróbálás ezen",
		"admin.system.failover.targetMeaning":
			"Válassz valami olcsót, ami mindig elérhető.",
		"admin.system.newAccounts.title": "Új fiókok",
		"admin.system.newAccounts.description":
			"Amit egy felhasználó kap, mielőtt bármit módosítana.",
		"admin.system.newAccounts.meaning":
			"A meglévő fiókok megtartják a választott modelljüket.",
		"admin.system.atlas.title": "Atlas kutatási jelentések",
		"admin.system.atlas.description": "Hat szakasz, hat modellválasztás.",
		"admin.system.atlas.workerEnabled": "Feldolgozó bekapcsolva",
		"admin.system.atlas.tabs.models": "Modellek feladatonként",
		"admin.system.atlas.tabs.worker": "Feldolgozó és korlátok",
		"admin.system.atlas.tabs.depth": "Kutatási mélység",
		"admin.system.atlas.tabs.prompts": "Folyamat",
		"admin.system.atlas.taskColumn": "Feladat",
		"admin.system.atlas.modelColumn": "Modell",
		"admin.system.atlas.inherit": "Öröklés — {model}",
		"admin.system.atlas.inheritNote":
			"Az Öröklésen hagyott feladat az Atlas szintézis- vagy ellenőrző modelljét követi. Ez a kettő a Feldolgozó és korlátok fülön van.",
		"admin.system.atlas.v3Only": "Csak a v3 folyamat használja.",
		"admin.system.atlas.tasks.ask.label": "Kérdés",
		"admin.system.atlas.tasks.ask.meaning":
			"Kutatási feladatleírássá alakítja a kérést, és felteszi a tisztázó kérdést.",
		"admin.system.atlas.tasks.researcher.label": "Kutató",
		"admin.system.atlas.tasks.researcher.meaning":
			"Minden kutatási kérdést lefuttat a weben, és elolvassa az oldalakat.",
		"admin.system.atlas.tasks.outline.label": "Vázlat",
		"admin.system.atlas.tasks.outline.meaning":
			"Eldönti, milyen fejezetei lesznek a jelentésnek, és milyen sorrendben.",
		"admin.system.atlas.tasks.writer.label": "Író",
		"admin.system.atlas.tasks.writer.meaning":
			"Mondatról mondatra megírja a fejezeteket a bizonyítékindex alapján.",
		"admin.system.atlas.tasks.critic.label": "Bíráló",
		"admin.system.atlas.tasks.critic.meaning":
			"Átnézi a lefedettséget, és bekéri a még hiányzó köröket.",
		"admin.system.atlas.tasks.verifier.label": "Ellenőr",
		"admin.system.atlas.tasks.verifier.meaning":
			"Minden hivatkozott adatot összevet a hozzá megadott forrással.",
		"admin.system.atlas.pipeline.label": "Jelentésfolyamat",
		"admin.system.atlas.pipeline.meaning":
			"A jelentés indulásakor rögzül, így a már sorban álló jelentések a saját folyamatukkal futnak végig.",
		"admin.system.atlas.searchMath": "Kérdések × körök = webes keresések",
		"admin.system.atlas.searchMathRow":
			"{profile} {questions} × {rounds} = {total}",
		"admin.system.atlas.profile.overview": "Áttekintés",
		"admin.system.atlas.profile.inDepth": "Részletes",
		"admin.system.atlas.profile.exhaustive": "Kimerítő",
		"admin.system.memory.title": "Memória",
		"admin.system.memory.description":
			"Eldönti, mit érdemes megjegyezni, és éjszaka összevonja a duplikátumokat.",
		"admin.system.titles.title": "Beszélgetéscímek",
		"admin.system.titles.description":
			"Az első üzenetváltás után nevet ad a beszélgetésnek.",
		"admin.system.titles.promptSection": "Prompt",
		"admin.system.titles.langEn": "Angol",
		"admin.system.titles.langHu": "Magyar",
		"admin.system.titles.complete": "kész",
		"admin.system.titles.incomplete": "üres",
		"admin.system.titles.basePrompt": "Rendszerprompt",
		"admin.system.titles.appendix": "Kódfüggelék",
		"admin.system.summarizer.title": "Kontextus-összefoglaló",
		"admin.system.summarizer.description":
			"Tömöríti a hosszú beszélgetéseket, amikor megtelik az ablak.",
		"admin.system.systemPrompt.title": "Rendszerprompt",
		"admin.system.systemPrompt.description":
			"Minden normál beszélgetés elé kerül. Az Atlas és a fenti feladatok saját promptot használnak.",
		"admin.system.charCount": "{count} / {max} karakter",
		"admin.system.integrations.title": "Integrációk és kulcsok",
		"admin.system.integrations.description":
			"A termék összes titkos kulcsa egy helyen, egyféle módon.",
		"admin.system.integrations.webResearch": "Webes kutatás",
		"admin.system.integrations.documentExtraction": "Dokumentumkivonatolás",
		"admin.system.integrations.webPush": "Webes push-értesítések",
		"admin.system.limits.title": "Korlátok",
		"admin.system.limits.description":
			"Kemény korlátok. Mindegyiket elutasításként éli meg a felhasználó, ezért mindegyiknél leírjuk, hogyan néz ki az elutasítás.",
		"admin.system.skills.title": "Képességek",
		"admin.system.skills.description":
			"A képesség szerkesztése párbeszédablakot nyit, nem a listán belül növő űrlapot, így a lista sosem mozdul el alattad.",
		"admin.system.skills.new": "Új képesség",
		"admin.system.skills.editTitle": "Képesség szerkesztése",
		"admin.system.skills.createTitle": "Új képesség",
		"admin.system.skills.dialogHint":
			"Az itteni módosításokat ez a párbeszédablak menti, nem az oldal mentősávja.",
		"admin.system.skills.menu": "További műveletek: {name}",
		"admin.system.skills.unpublish": "Publikálás visszavonása",
		"admin.system.skills.policyNote":
			"Ez a négy minden létrehozott képességnél létezik — eddig néma alapértékként kerültek mentésre, bárhol elérhető vezérlő nélkül.",
		"admin.system.skills.durationPolicy": "Időtartam-szabály",
		"admin.system.skills.questionPolicy": "Kérdezési szabály",
		"admin.system.skills.notesPolicy": "Jegyzetelési szabály",
		"admin.system.skills.sourceScope": "Forráskör",
		"admin.system.skills.duration.next_message": "Csak a következő üzenet",
		"admin.system.skills.duration.session": "A teljes munkamenet",
		"admin.system.skills.question.none": "Soha ne kérdezzen",
		"admin.system.skills.question.ask_when_needed": "Kérdezzen, ha kell",
		"admin.system.skills.notes.none": "Ne készítsen jegyzetet",
		"admin.system.skills.notes.create_private_notes":
			"Készítsen munkajegyzetet",
		"admin.system.skills.scope.selected_sources_only":
			"Csak a kijelölt források",
		"admin.system.skills.scope.all_sources": "Minden forrás",
		"admin.system.skills.scope.web_and_files": "Web és fájlok",
		"admin.system.skills.activationHint": "Soronként egy.",
		"admin.system.advanced.title": "Haladó",
		"admin.system.advanced.restartFree": "Újraindítás nélkül",
		"admin.system.advanced.description":
			"{count} beállítás, amely korábban csak a környezeti fájlban létezett. Mindegyiket frissen olvassuk a következő híváskor, így elég itt menteni — nincs újraindítás, nincs telepítés.",
		"admin.system.advanced.search":
			"Keresés a haladó beállítások, kulcsok és alapértékek között",
		"admin.system.advanced.effectiveConfig": "Tényleges konfiguráció",
		"admin.system.advanced.keyCount": "{count} kulcs",
		"admin.system.advanced.collapse": "{group} összecsukása",
		"admin.system.advanced.expand": "{group} kinyitása",
		"admin.system.advanced.groups.limits": "Erőforráskorlátok",
		"admin.system.advanced.groups.atlas": "Atlas belső beállítások",
		"admin.system.advanced.groups.embeddings": "Beágyazás és újrarangsorolás",
		"admin.system.advanced.groups.memory": "Memória és munkakészlet",
		"admin.system.advanced.groups.routing": "Útvonaltervezés hangolása",
		"admin.system.advanced.groups.models": "Beépített modellek hangolása",
		"admin.system.advanced.groups.integrations": "Integrációk",
		"admin.system.advanced.groups.debug": "Hibakeresés és folyamkorlátok",
		"admin.system.advanced.sandboxTitle": "Homokozó — beépítve",
		"admin.system.advanced.sandboxNote":
			"Sehol nem állítható. Mindig a szigorúbb korlát érvényesül — ezért tűnhet úgy, hogy a bal oldali számokat figyelmen kívül hagyja a rendszer.",
		"admin.system.advanced.teiWarning":
			"A beágyazó modell cseréje nem építi újra a meglévő vektorokat. A tárolt vektorok a régi modell terében maradnak, és nem illeszkednek az újakhoz, amíg újra nem épülnek.",
		"admin.system.advanced.contextRule":
			"Ha módosítod a kontextusablakot, a másik három újraszámolódik — figyelmeztetés 80%-nál, feltöltés 90%-ig, üzenethossz ebből. Amit magad állítasz be, az marad. De ha a feltöltési pont vagy a figyelmeztetés nem kisebb az ablaknál, az egész hármas némán visszaáll a környezeti értékekre, hibaüzenet nélkül.",
		"admin.system.advanced.routingReference":
			"Tájékoztatásul, a környezetben beállítva:",
		"admin.system.advanced.owntracksWarning":
			"Nincs URL-ellenőrzés — a szerver azt tölti le, amit ide írsz.",
		"admin.system.advanced.model1": "1. modell",
		"admin.system.advanced.model2": "2. modell",
		"admin.system.advanced.envOnlyTitle": "Csak környezeti változó",
		"admin.system.advanced.envOnlyNote":
			"Ezek szándékosan a környezeti fájlban maradnak: azt választják meg, milyen konténer fut, hova köt, melyik konténer kap parancsot — vagy éppen az a kulcs, amely minden tárolt szolgáltatói titkot titkosít. Bármelyikükhöz újraindítás kell.",
		"admin.system.diagnostics.title": "Diagnosztika",
		"admin.system.diagnostics.description":
			"Csak olvasható. Ezen az oldalon semmi sem beállítás — ez a rendszer jelenlegi állapota.",
		"admin.system.diagnostics.rerun": "Ellenőrzések újrafuttatása",
		"admin.system.diagnostics.checked": "Ellenőrizve: {time}",
		"admin.system.diagnostics.tabs.toolHealth": "Eszközök állapota",
		"admin.system.diagnostics.tabs.effectiveConfig": "Tényleges konfiguráció",
		"admin.system.diagnostics.tabs.routing": "Útvonal-lefedettség",
		"admin.system.diagnostics.degradedOne": "1 romlott állapotú.",
		"admin.system.diagnostics.degradedMany": "{count} romlott állapotú.",
		"admin.system.diagnostics.degradedDetail":
			"Mindegyik lassabb vagy hiányzó eredményként jelenik meg a beszélgetésben.",
		"admin.system.diagnostics.generated": "Létrehozva: {time} · {count} kulcs",
		"admin.system.diagnostics.filter.overridden": "Csak felülírt · {count}",
		"admin.system.diagnostics.filter.env": "Környezetből · {count}",
		"admin.system.diagnostics.filter.hidden":
			"Sehol nem szerkeszthető · {count}",
		"admin.system.diagnostics.filter.all": "Minden kulcs",
		"admin.system.diagnostics.overridesEnv":
			"felülírja a környezeti értéket: {value}",
		"admin.system.diagnostics.noOverride": "nincs admin felülírás",
		"admin.system.diagnostics.builtInNote":
			"Beépített modellek feloldása: melyik beépített kulcs mire és honnan oldódik fel, és figyelmeztetés, ha egy admin érték elfed egy működő környezeti értéket.",
		"admin.system.diagnostics.routingNote":
			"60 másodpercenként frissül · a nyitott listák nyitva maradnak",
		"admin.system.diagnostics.refreshNow": "Frissítés most",
		"admin.system.dialog.savedHere":
			"Az itteni módosításokat ez a párbeszédablak menti, nem az oldal mentősávja.",
		"admin.system.dialog.providerIdFixed":
			"Létrehozás után rögzített — a konfigurációs kulcsok erre mutatnak.",
		"admin.system.dialog.availability": "Elérhetőség",
		"admin.system.dialog.enabledForEveryone": "Mindenki számára bekapcsolva",
		"admin.system.dialog.icon": "Ikon",
		"admin.system.dialog.iconReplace": "Csere",
		"admin.system.dialog.iconRecrop": "Újravágás",
		"admin.system.dialog.iconRemove": "Eltávolítás",
		"admin.system.dialog.lastTest": "Utolsó teszt: {time}",
		"admin.system.dialog.saveProvider": "Szolgáltató mentése",
		"admin.system.dialog.freeText":
			"Vagy írj be egy modellnevet, amely nincs a listában",
		"admin.system.dialog.useFreeText": "Szabad szöveg használata",
		"admin.system.dialog.usePicker": "Válassz inkább a listából",
		"admin.system.dialog.fallbackWait": "Várakozás átterelés előtt",
		"admin.system.dialog.fallbackDescription":
			"Akkor lép életbe, ha ez a szolgáltató 429-cel válaszol. Független a globális időtúllépési átterelést.",
		"admin.system.deleteProvider.title": "Törlöd ezt: {name}?",
		"admin.system.deleteProvider.message":
			"A modelljei és az árazása is törlődik. Minden rá mutató modellválasztó az alapértelmezett modellre vált.",
		"admin.system.deleteModel.title": "Törlöd ezt: {name}?",
		"admin.system.deleteModel.message":
			"A modell és az ársávjai eltávolításra kerülnek ettől a szolgáltatótól.",
		"admin.system.removeRegion.title": "Eltávolítod ezt: {name}?",
		"admin.system.removeRegion.message":
			"A letöltött kivonat és a felépített gráf törlődik. A régió újbóli kérése újra letölti és újraépíti.",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUTS.label": "Fájl futásonként",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUTS.meaning":
			"Hány fájlt hozhat létre egy kérés.",
		"admin.system.keys.FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES.label":
			"Forrásadat-korlát",
		"admin.system.keys.FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES.meaning":
			"A legnagyobb adatcsomag, amelyet egy futás beolvashat a beszélgetésből.",
		"admin.system.keys.FILE_PRODUCTION_MAX_PROJECTION_BYTES.label":
			"Származtatott adat korlátja",
		"admin.system.keys.FILE_PRODUCTION_MAX_PROJECTION_BYTES.meaning":
			"A legnagyobb vetület, amely abból az adatcsomagból épül.",
		"admin.system.keys.FILE_PRODUCTION_MAX_PDF_PAGES.label": "Oldal PDF-enként",
		"admin.system.keys.FILE_PRODUCTION_MAX_PDF_PAGES.meaning":
			"Kemény korlát a generált dokumentumra.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_ROWS.label":
			"Sor táblázatonként",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_ROWS.meaning":
			"Sorok száma egy generált táblázatban.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_COLUMNS.label":
			"Oszlop táblázatonként",
		"admin.system.keys.FILE_PRODUCTION_MAX_TABLE_COLUMNS.meaning":
			"Oszlopok száma abban a táblázatban.",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_DATA_POINTS.label":
			"Adatpont diagramonként",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_DATA_POINTS.meaning":
			"Adatpontok az összes adatsorban.",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_SERIES.label":
			"Adatsor diagramonként",
		"admin.system.keys.FILE_PRODUCTION_MAX_CHART_SERIES.meaning":
			"Vonalak vagy oszlopcsoportok egy diagramon.",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_COUNT.label":
			"Kép dokumentumonként",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_COUNT.meaning":
			"Egy fájlba beágyazható képek száma.",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_BYTES.label": "Képméret",
		"admin.system.keys.FILE_PRODUCTION_MAX_IMAGE_BYTES.meaning":
			"Képenkénti felső korlát.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES.label":
			"Összes kép",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES.meaning":
			"A képek együttes mérete egy futásban.",
		"admin.system.keys.FILE_PRODUCTION_SANDBOX_TIMEOUT_MS.label":
			"Generálási időkorlát",
		"admin.system.keys.FILE_PRODUCTION_SANDBOX_TIMEOUT_MS.meaning":
			"A fájlt előállító kód futásideje.",
		"admin.system.keys.FILE_PRODUCTION_RENDERER_TIMEOUT_MS.label":
			"Renderelési időkorlát",
		"admin.system.keys.FILE_PRODUCTION_RENDERER_TIMEOUT_MS.meaning":
			"A dokumentummá alakítás futásideje.",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES.label":
			"Kimeneti fájlméret",
		"admin.system.keys.FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES.meaning":
			"Egy előállított fájl felső korlátja.",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES.label":
			"Összes kimenet",
		"admin.system.keys.FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES.meaning":
			"Amennyit egy futás összesen lemezre írhat.",
		"admin.system.keys.ATLAS_PIPELINE.label": "Jelentésfolyamat",
		"admin.system.keys.ATLAS_PIPELINE.meaning":
			"Melyik folyamattal indul egy új jelentés.",
		"admin.system.keys.ATLAS_V2_QUESTIONS_OVERVIEW.label":
			"Kutatási kérdések · áttekintés",
		"admin.system.keys.ATLAS_V2_QUESTIONS_OVERVIEW.meaning":
			"Ennyi kérdést ír a tervezési szakasz áttekintő jelentéshez.",
		"admin.system.keys.ATLAS_V2_QUESTIONS_IN_DEPTH.label":
			"Kutatási kérdések · részletes",
		"admin.system.keys.ATLAS_V2_QUESTIONS_IN_DEPTH.meaning":
			"Ennyi kérdést ír a tervezési szakasz részletes jelentéshez.",
		"admin.system.keys.ATLAS_V2_QUESTIONS_EXHAUSTIVE.label":
			"Kutatási kérdések · kimerítő",
		"admin.system.keys.ATLAS_V2_QUESTIONS_EXHAUSTIVE.meaning":
			"Ennyi kérdést ír a tervezési szakasz kimerítő jelentéshez.",
		"admin.system.keys.ATLAS_V2_ROUNDS_OVERVIEW.label":
			"Kutatási körök · áttekintés",
		"admin.system.keys.ATLAS_V2_ROUNDS_OVERVIEW.meaning":
			"Hányszor tér vissza az áttekintő jelentés újabb forrásokért.",
		"admin.system.keys.ATLAS_V2_ROUNDS_IN_DEPTH.label":
			"Kutatási körök · részletes",
		"admin.system.keys.ATLAS_V2_ROUNDS_IN_DEPTH.meaning":
			"Hányszor tér vissza a részletes jelentés újabb forrásokért.",
		"admin.system.keys.ATLAS_V2_ROUNDS_EXHAUSTIVE.label":
			"Kutatási körök · kimerítő",
		"admin.system.keys.ATLAS_V2_ROUNDS_EXHAUSTIVE.meaning":
			"Hányszor tér vissza a kimerítő jelentés újabb forrásokért.",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_OVERVIEW.label":
			"Hosszkorlát · áttekintés",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_OVERVIEW.meaning":
			"Kemény szókorlát az áttekintő jelentésre.",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_IN_DEPTH.label":
			"Hosszkorlát · részletes",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_IN_DEPTH.meaning":
			"Kemény szókorlát a részletes jelentésre.",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_EXHAUSTIVE.label":
			"Hosszkorlát · kimerítő",
		"admin.system.keys.ATLAS_V2_MAX_WORDS_EXHAUSTIVE.meaning":
			"Kemény szókorlát a kimerítő jelentésre.",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_OVERVIEW.label":
			"Indexelt források · áttekintés",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_OVERVIEW.meaning":
			"Ennyi forrás jut el az áttekintő jelentés írási szakaszába.",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_IN_DEPTH.label":
			"Indexelt források · részletes",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_IN_DEPTH.meaning":
			"Ennyi forrás jut el a részletes jelentés írási szakaszába.",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_EXHAUSTIVE.label":
			"Indexelt források · kimerítő",
		"admin.system.keys.ATLAS_V2_MAX_SOURCES_EXHAUSTIVE.meaning":
			"Ennyi forrás jut el a kimerítő jelentés írási szakaszába.",
		"admin.system.keys.ATLAS_V2_ENTAILMENT_BATCH.label":
			"Állítás következtetési hívásonként",
		"admin.system.keys.ATLAS_V2_ENTAILMENT_BATCH.meaning":
			"Hány állítást ellenőriz egy hívás. Az 1 kikapcsolja a kötegelést.",
		"admin.system.keys.ATLAS_V2_WRITER_CONCURRENCY.label":
			"Egyszerre írt fejezetek",
		"admin.system.keys.ATLAS_V2_WRITER_CONCURRENCY.meaning":
			"Hány fejezetet ír az író párhuzamosan.",
		"admin.system.keys.ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS.label":
			"Válaszhossz-korlát · áttekintés",
		"admin.system.keys.ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS.meaning":
			"Ennyi kimeneti tokent költhet az író áttekintő jelentésre.",
		"admin.system.keys.ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS.label":
			"Válaszhossz-korlát · részletes",
		"admin.system.keys.ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS.meaning":
			"Ennyi kimeneti tokent költhet az író részletes jelentésre.",
		"admin.system.keys.ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS.label":
			"Válaszhossz-korlát · kimerítő",
		"admin.system.keys.ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS.meaning":
			"Ennyi kimeneti tokent költhet az író kimerítő jelentésre.",
		"admin.system.keys.ATLAS_MAX_WRITER_PROMPT_CHARS.label":
			"Írói prompt korlátja",
		"admin.system.keys.ATLAS_MAX_WRITER_PROMPT_CHARS.meaning":
			"Ennyi karakternyi kutatás kerül egyszerre az íróhoz.",
		"admin.system.keys.ATLAS_STALE_MONTHS.label":
			"Ennyi idő után elavult egy adat",
		"admin.system.keys.ATLAS_STALE_MONTHS.meaning":
			"A régebbi adatok a Korlátok szakaszba kerülnek.",
		"admin.system.keys.TEI_EMBEDDER_URL.label": "Beágyazó végpont",
		"admin.system.keys.TEI_EMBEDDER_URL.meaning":
			"Itt lesz a szövegből vektor. Üresen a szemantikus keresés kikapcsol.",
		"admin.system.keys.TEI_EMBEDDER_MODEL.label": "Beágyazó modell",
		"admin.system.keys.TEI_EMBEDDER_MODEL.meaning":
			"A végponton kiszolgált modell neve.",
		"admin.system.keys.TEI_EMBEDDER_BATCH_SIZE.label":
			"Szöveg beágyazási hívásonként",
		"admin.system.keys.TEI_EMBEDDER_BATCH_SIZE.meaning":
			"Nem haladhatja meg a szerver saját kötegkorlátját.",
		"admin.system.keys.TEI_RERANKER_URL.label": "Újrarangsoroló végpont",
		"admin.system.keys.TEI_RERANKER_URL.meaning":
			"Újrapontozza a találatokat. Üresen az újrarangsorolás kikapcsol.",
		"admin.system.keys.TEI_RERANKER_MODEL.label": "Újrarangsoroló modell",
		"admin.system.keys.TEI_RERANKER_MODEL.meaning":
			"Az ott kiszolgált modell neve.",
		"admin.system.keys.TEI_RERANKER_MAX_TEXTS.label":
			"Jelölt újrarangsorolásonként",
		"admin.system.keys.TEI_RERANKER_MAX_TEXTS.meaning":
			"Ennyi találat megy egyszerre újrapontozásra.",
		"admin.system.keys.TEI_TIMEOUT_MS.label": "Beágyazási időkorlát",
		"admin.system.keys.TEI_TIMEOUT_MS.meaning":
			"Egy beágyazó- vagy újrarangsoroló-hívás futásideje.",
		"admin.system.keys.MEMORY_JUDGE_DRY_RUN.label": "Bíráló próbafutás",
		"admin.system.keys.MEMORY_JUDGE_DRY_RUN.meaning":
			"A bíráló dönt és naplóz, de semmit nem ír a profilba.",
		"admin.system.keys.MEMORY_JUDGE_IDLE_MINUTES.label":
			"Várakozás a bírálat előtt",
		"admin.system.keys.MEMORY_JUDGE_IDLE_MINUTES.meaning":
			"Ennyi csendes perc után vonjuk ki az emlékeket egy beszélgetésből.",
		"admin.system.keys.MEMORY_CONSOLIDATION_INTERVAL_MINUTES.label":
			"Összevonási körút",
		"admin.system.keys.MEMORY_CONSOLIDATION_INTERVAL_MINUTES.meaning":
			"Milyen gyakran vonjuk össze és rendezzük a tárolt emlékeket.",
		"admin.system.keys.MEMORY_MAINTENANCE_INTERVAL_MINUTES.label":
			"Karbantartási körút",
		"admin.system.keys.MEMORY_MAINTENANCE_INTERVAL_MINUTES.meaning":
			"Felhasználónkénti karbantartás, például beágyazások pótlása. A 0 kikapcsolja.",
		"admin.system.keys.WORKING_SET_DOCUMENT_TOKEN_BUDGET.label":
			"Token dokumentumonként",
		"admin.system.keys.WORKING_SET_DOCUMENT_TOKEN_BUDGET.meaning":
			"Egy csatolt dokumentumból ennyi jut el a promptba.",
		"admin.system.keys.WORKING_SET_PROMPT_TOKEN_BUDGET.label":
			"Token a teljes munkakészletre",
		"admin.system.keys.WORKING_SET_PROMPT_TOKEN_BUDGET.meaning":
			"Ha növeled, kiszorítja a beszélgetés előzményeit.",
		"admin.system.keys.SMALL_FILE_THRESHOLD_CHARS.label":
			"Fájl beillesztése ez alatt",
		"admin.system.keys.SMALL_FILE_THRESHOLD_CHARS.meaning":
			"A rövidebb fájlok egyben kerülnek be, nem darabolva.",
		"admin.system.keys.ORS_COVERAGE_LABEL.label": "Lefedettség megnevezése",
		"admin.system.keys.ORS_COVERAGE_LABEL.meaning":
			"A modell ezt a régiónevet ismeri, így meg tudja mondani, miért nincs útvonal.",
		"admin.system.keys.ROUTING_REGION_IDLE_MINUTES.label":
			"Tétlen régiók leállítása ennyi után",
		"admin.system.keys.ROUTING_REGION_IDLE_MINUTES.meaning":
			"A használaton kívüli régiókonténer leáll.",
		"admin.system.keys.ROUTING_GTFS_REFRESH_DAYS.label": "Menetrend frissítése",
		"admin.system.keys.ROUTING_GTFS_REFRESH_DAYS.meaning":
			"Ilyen idős menetrendet töltünk le újra, éjszaka.",
		"admin.system.keys.ROUTING_GTFS_MAX_MB.label":
			"Menetrend-letöltés korlátja",
		"admin.system.keys.ROUTING_GTFS_MAX_MB.meaning":
			"Egy menetrendletöltés felső korlátja.",
		"admin.system.keys.ROUTING_REGION_MAX_PBF_MB.label":
			"Térképkivonat korlátja",
		"admin.system.keys.ROUTING_REGION_MAX_PBF_MB.meaning":
			"Egy régió letöltésének felső korlátja.",
		"admin.system.keys.ROUTING_GTFS_FEED_EXCLUDE.label":
			"Kihagyott menetrendek",
		"admin.system.keys.ROUTING_GTFS_FEED_EXCLUDE.meaning":
			"Kihagyandó menetrendek — itt orvosolható egy licencprobléma.",
		"admin.system.keys.MODEL_1_MAX_TOKENS.label": "Max. kimeneti token",
		"admin.system.keys.MODEL_1_MAX_TOKENS.meaning":
			"A szolgáltatónak küldött kimeneti korlát. Üresen a szolgáltató alapértéke.",
		"admin.system.keys.MODEL_1_REASONING_EFFORT.label":
			"Gondolkodási erőfeszítés",
		"admin.system.keys.MODEL_1_REASONING_EFFORT.meaning":
			"Szolgáltatói beállítás arról, mennyit gondolkodjon a modell.",
		"admin.system.keys.MODEL_1_THINKING_TYPE.label": "Gondolkodás",
		"admin.system.keys.MODEL_1_THINKING_TYPE.meaning":
			"A thinking.type szolgáltatói beállítás, Anthropic-alakú API-khoz.",
		"admin.system.keys.MODEL_1_MAX_MODEL_CONTEXT.label": "Kontextusablak",
		"admin.system.keys.MODEL_1_MAX_MODEL_CONTEXT.meaning":
			"A modell saját kontextusablaka tokenben.",
		"admin.system.keys.MODEL_1_COMPACTION_UI_THRESHOLD.label":
			"Figyelmeztetés ennél",
		"admin.system.keys.MODEL_1_COMPACTION_UI_THRESHOLD.meaning":
			"Itt jelzi a felület, hogy telik a kontextus.",
		"admin.system.keys.MODEL_1_TARGET_CONSTRUCTED_CONTEXT.label":
			"Prompt feltöltése eddig",
		"admin.system.keys.MODEL_1_TARGET_CONSTRUCTED_CONTEXT.meaning":
			"A promptösszeállítás célértéke a kimeneti tartalék előtt.",
		"admin.system.keys.MODEL_1_MAX_MESSAGE_LENGTH.label": "Leghosszabb üzenet",
		"admin.system.keys.MODEL_1_MAX_MESSAGE_LENGTH.meaning":
			"A leghosszabb felhasználói üzenet, amit ez a modell elfogad.",
		"admin.system.keys.MODEL_2_MAX_TOKENS.label": "Max. kimeneti token",
		"admin.system.keys.MODEL_2_MAX_TOKENS.meaning":
			"A szolgáltatónak küldött kimeneti korlát. Üresen a szolgáltató alapértéke.",
		"admin.system.keys.MODEL_2_REASONING_EFFORT.label":
			"Gondolkodási erőfeszítés",
		"admin.system.keys.MODEL_2_REASONING_EFFORT.meaning":
			"Szolgáltatói beállítás arról, mennyit gondolkodjon a modell.",
		"admin.system.keys.MODEL_2_THINKING_TYPE.label": "Gondolkodás",
		"admin.system.keys.MODEL_2_THINKING_TYPE.meaning":
			"A thinking.type szolgáltatói beállítás, Anthropic-alakú API-khoz.",
		"admin.system.keys.MODEL_2_MAX_MODEL_CONTEXT.label": "Kontextusablak",
		"admin.system.keys.MODEL_2_MAX_MODEL_CONTEXT.meaning":
			"A modell saját kontextusablaka tokenben.",
		"admin.system.keys.MODEL_2_COMPACTION_UI_THRESHOLD.label":
			"Figyelmeztetés ennél",
		"admin.system.keys.MODEL_2_COMPACTION_UI_THRESHOLD.meaning":
			"Itt jelzi a felület, hogy telik a kontextus.",
		"admin.system.keys.MODEL_2_TARGET_CONSTRUCTED_CONTEXT.label":
			"Prompt feltöltése eddig",
		"admin.system.keys.MODEL_2_TARGET_CONSTRUCTED_CONTEXT.meaning":
			"A promptösszeállítás célértéke a kimeneti tartalék előtt.",
		"admin.system.keys.MODEL_2_MAX_MESSAGE_LENGTH.label": "Leghosszabb üzenet",
		"admin.system.keys.MODEL_2_MAX_MESSAGE_LENGTH.meaning":
			"A leghosszabb felhasználói üzenet, amit ez a modell elfogad.",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_ID.label":
			"Google alkalmazásazonosító",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_ID.meaning":
			"Ez azonosítja a szervert a Google felé, amikor valaki Naptárt vagy Névjegyeket csatlakoztat.",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_SECRET.label":
			"Google alkalmazástitok",
		"admin.system.keys.GOOGLE_OAUTH_CLIENT_SECRET.meaning":
			"Üresen a Google-kapcsolat „nincs beállítva” állapotot jelez.",
		"admin.system.keys.ONEDRIVE_CLIENT_ID.label":
			"OneDrive alkalmazásazonosító",
		"admin.system.keys.ONEDRIVE_CLIENT_ID.meaning":
			"Ugyanez, a OneDrive-fájlokhoz.",
		"admin.system.keys.ONEDRIVE_CLIENT_SECRET.label":
			"OneDrive alkalmazástitok",
		"admin.system.keys.ONEDRIVE_CLIENT_SECRET.meaning":
			"Üresen a OneDrive-kapcsolat „nincs beállítva” állapotot jelez.",
		"admin.system.keys.OWNTRACKS_RECORDER_URL.label": "OwnTracks rögzítő",
		"admin.system.keys.OWNTRACKS_RECORDER_URL.meaning":
			"A helyelőzmények forrása.",
		"admin.system.keys.OWNTRACKS_RECORDER_USER.label": "OwnTracks felhasználó",
		"admin.system.keys.OWNTRACKS_RECORDER_USER.meaning":
			"A rögzítő basic-auth felhasználója.",
		"admin.system.keys.OWNTRACKS_RECORDER_PASS.label": "OwnTracks jelszó",
		"admin.system.keys.OWNTRACKS_RECORDER_PASS.meaning":
			"A rögzítő basic-auth jelszava.",
		"admin.system.keys.NATIVE_HISTORY_ENABLED.label":
			"Előzmények natív üzenetként",
		"admin.system.keys.NATIVE_HISTORY_ENABLED.meaning":
			"Kikapcsolva egyetlen lapos szövegblokk megy. Ez a kapcsoló a visszaállás.",
		"admin.system.keys.TITLE_GEN_URL.label": "Címgeneráló végpont",
		"admin.system.keys.TITLE_GEN_URL.meaning":
			"Itt készülnek a beszélgetéscímek.",
		"admin.system.keys.CONTEXT_SUMMARIZER_URL.label": "Összefoglaló végpont",
		"admin.system.keys.CONTEXT_SUMMARIZER_URL.meaning":
			"Itt tömörödik a hosszú kontextus. Alapból a címgeneráló végpontra esik vissza.",
		"admin.system.keys.CONTEXT_DIAGNOSTICS_DEBUG.label":
			"Kontextus-diagnosztika",
		"admin.system.keys.CONTEXT_DIAGNOSTICS_DEBUG.meaning":
			"Extra naplózás arról, hogyan állt össze egy-egy prompt.",
		"admin.system.keys.ATTACHMENT_TRACE_DEBUG.label": "Csatolmány-nyomkövetés",
		"admin.system.keys.ATTACHMENT_TRACE_DEBUG.meaning":
			"Naplózza, hogyan lesz a feltöltésből kész csatolmány.",
		"admin.system.keys.NORMAL_CHAT_DEBUG_OUTBOUND.label":
			"Kimenő üzenet naplózása",
		"admin.system.keys.NORMAL_CHAT_DEBUG_OUTBOUND.meaning":
			"Szerepeket, résztípusokat és tokenbecslést naplóz — üzenettartalmat soha.",
		"admin.system.keys.CONCURRENT_STREAM_LIMIT.label": "Egyidejű válaszok",
		"admin.system.keys.CONCURRENT_STREAM_LIMIT.meaning":
			"Ennyi beszélgetésválasz futhat egyszerre az egész szerveren.",
		"admin.system.keys.PER_USER_STREAM_LIMIT.label":
			"Egyidejű válasz felhasználónként",
		"admin.system.keys.PER_USER_STREAM_LIMIT.meaning":
			"Ennyi választ streamelhet egyszerre egy fiók.",
		"admin.system.keys.ATLAS_V3_CRITIC_ROUNDS.label": "Bírálati körök",
		"admin.system.keys.ATLAS_V3_CRITIC_ROUNDS.meaning":
			"Hányszor küldheti vissza a bíráló a jelentést további munkára.",
		"admin.system.keys.ATLAS_V3_RESEARCHER_CONCURRENCY.label":
			"Egyszerre futó kutatók",
		"admin.system.keys.ATLAS_V3_RESEARCHER_CONCURRENCY.meaning":
			"Ennyi kutatási kérdés fut párhuzamosan.",
		"admin.system.keys.ATLAS_V3_SEARCHES_PER_STEP.label": "Keresés lépésenként",
		"admin.system.keys.ATLAS_V3_SEARCHES_PER_STEP.meaning":
			"Ennyi webes keresést futtathat egy kutatási lépés.",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW.label":
			"Olvasott oldalak · áttekintés",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_OVERVIEW.meaning":
			"Ennyi oldalt nyit meg kérdésenként az áttekintő jelentés.",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_IN_DEPTH.label":
			"Olvasott oldalak · részletes",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_IN_DEPTH.meaning":
			"Ennyi oldalt nyit meg kérdésenként a részletes jelentés.",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_EXHAUSTIVE.label":
			"Olvasott oldalak · kimerítő",
		"admin.system.keys.ATLAS_V3_PAGES_PER_QUESTION_EXHAUSTIVE.meaning":
			"Ennyi oldalt nyit meg kérdésenként a kimerítő jelentés.",
		"admin.system.keys.ATLAS_V3_LANGUAGE_STANDARD_HU.label":
			"Magyar nyelvi szabvány",
		"admin.system.keys.ATLAS_V3_LANGUAGE_STANDARD_HU.meaning":
			"Magyar nyelvű jelentésre alkalmazza a magyar stílusszabályokat.",
	},
} as const;

export default settingsDict;
