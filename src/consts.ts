import type { ModelDefinition } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'responses-copilot';

// VS Code's internal LanguageModelChatMessageRole.System is not exposed in @types/vscode.
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

// ---- Secret keys ----

/** SecretStorage key for the provider API key. */
export const API_KEY_SECRET = 'responses-copilot.apiKey';

/** memento key tracking whether the welcome walkthrough has been shown. */
export const WELCOME_SHOWN_KEY = 'responses-copilot.welcomeShown';

// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'mozi1924.responses-copilot#responsesGettingStarted';

// ---- Model registry ----

/** Fallback model shown before remote model discovery succeeds. */
export const FALLBACK_MODELS: ModelDefinition[] = [
	{
		id: 'gpt-5.4-mini',
		name: 'GPT-5.4 Mini',
		family: 'gpt',
		version: '5.4',
		detail: 'General-purpose fallback model',
		maxInputTokens: 256_000,
		maxOutputTokens: 128_000,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			thinking: true,
		},
		requiresThinkingParam: false,
	},
];
