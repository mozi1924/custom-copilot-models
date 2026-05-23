import type { LanguageModelChatInformation } from 'vscode';
import {
	getBaseUrl,
	getForceOverrideModelTokenSettings,
	getModelListTtlMinutes,
	getModelMaxInputTokensDefault,
	getModelMaxOutputTokensDefault,
	getModelTokenOverrides,
} from '../config';
import { FALLBACK_MODELS } from '../consts';
import { logger } from '../logger';
import type { ModelDefinition } from '../types';

interface ModelsApiResponse {
	data?: Array<{
		id: string;
	}>;
}

const EXCLUDED_MODEL_PATTERNS = [
	/embedding/i,
	/moderation/i,
	/\btts\b/i,
	/\bstt\b/i,
	/transcribe/i,
	/whisper/i,
	/image/i,
	/realtime/i,
	/audio/i,
];

interface ModelTokenSettings {
	defaultMaxInputTokens: number;
	defaultMaxOutputTokens: number;
	forceOverrideModelTokenSettings: boolean;
	overrides: ReturnType<typeof getModelTokenOverrides>;
}

interface ModelTokenPreset {
	maxInputTokens: number;
	maxOutputTokens: number;
}

const BUILTIN_MODEL_TOKEN_PRESETS: Array<{ pattern: RegExp; preset: ModelTokenPreset }> = [
	{
		pattern: /^gpt-5/i,
		preset: {
			maxInputTokens: 272_000,
			maxOutputTokens: 128_000,
		},
	},
	{
		pattern: /^deepseek-v4-/i,
		preset: {
			maxInputTokens: 1_000_000,
			maxOutputTokens: 384_000,
		},
	},
];

export class ModelListRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Model list request failed: ${status}`);
		this.name = 'ModelListRequestError';
		this.status = status;
	}
}

export class ModelRegistry {
	private cache:
		| {
				models: ModelDefinition[];
				expiresAt: number;
		  }
		| undefined;

	async listModels(apiKey: string | undefined, forceRefresh = false): Promise<ModelDefinition[]> {
		const now = Date.now();
		if (!forceRefresh && this.cache && this.cache.expiresAt > now) {
			return this.cache.models;
		}

		if (!apiKey?.trim()) {
			const fallback = this.getFallbackModels();
			this.cache = {
				models: fallback,
				expiresAt: now + getModelListTtlMinutes() * 60_000,
			};
			return fallback;
		}

		try {
			const fetched = await this.fetchModels(apiKey);
			if (fetched.length > 0) {
				this.cache = {
					models: fetched,
					expiresAt: now + getModelListTtlMinutes() * 60_000,
				};
				return fetched;
			}
		} catch (error) {
			if (error instanceof ModelListRequestError && (error.status === 401 || error.status === 403)) {
				logger.info('Remote model list unauthorized; falling back to static models');
			} else {
				logger.warn('Failed to fetch remote model list; falling back to static models', error);
			}
		}

		const fallback = this.getFallbackModels();
		this.cache = {
			models: fallback,
			expiresAt: now + getModelListTtlMinutes() * 60_000,
		};
		return fallback;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	private async fetchModels(apiKey: string | undefined): Promise<ModelDefinition[]> {
		const tokenSettings = getCurrentModelTokenSettings();
		const response = await fetch(`${getBaseUrl()}/models`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
		});
		if (!response.ok) {
			throw new ModelListRequestError(response.status);
		}

		const payload = (await response.json()) as ModelsApiResponse;
		const ids = (payload.data ?? []).map((model) => model.id).filter(isLikelyChatModelId);

		return ids.map((id) => toModelDefinition(id, tokenSettings));
	}

	private getFallbackModels(): ModelDefinition[] {
		const tokenSettings = getCurrentModelTokenSettings();
		return FALLBACK_MODELS.map((model) =>
			applyModelTokenSettings(
				{
					...model,
					maxInputTokens: tokenSettings.defaultMaxInputTokens,
					maxOutputTokens: tokenSettings.defaultMaxOutputTokens,
				},
				tokenSettings,
			),
		);
	}
}

export function toModelDefinition(
	id: string,
	tokenSettings = getCurrentModelTokenSettings(),
): ModelDefinition {
	const family = resolveFamily(id);
	return applyModelTokenSettings({
		id,
		name: id,
		family,
		version: resolveVersion(id),
		detail: 'Responses API model',
		maxInputTokens: tokenSettings.defaultMaxInputTokens,
		maxOutputTokens: tokenSettings.defaultMaxOutputTokens,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			thinking: true,
		},
		requiresThinkingParam: false,
	}, tokenSettings);
}

export function isLikelyChatModelId(modelId: string): boolean {
	if (!modelId || modelId.trim().length === 0) {
		return false;
	}
	return !EXCLUDED_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

export function toChatInfoModel(
	model: ModelDefinition,
	hasApiKey: boolean,
): LanguageModelChatInformation {
	return {
		id: model.id,
		name: model.name,
		family: model.family,
		version: model.version,
		detail: hasApiKey ? model.detail : 'Please run Responses: Set API Key to configure.',
		tooltip: hasApiKey ? undefined : 'Please run Responses: Set API Key to configure.',
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxOutputTokens,
		capabilities: {
			toolCalling: model.capabilities.toolCalling,
			imageInput: model.capabilities.imageInput,
		},
	};
}

function resolveFamily(modelId: string): string {
	const normalized = modelId.toLowerCase();
	if (normalized.startsWith('gpt-')) return 'gpt';
	if (normalized.startsWith('o')) return 'o-series';
	if (normalized.startsWith('claude')) return 'claude';
	return 'responses';
}

function resolveVersion(modelId: string): string {
	const match = modelId.match(/\d+(\.\d+)?/);
	return match?.[0] ?? '1';
}

function getCurrentModelTokenSettings(): ModelTokenSettings {
	return {
		defaultMaxInputTokens: getModelMaxInputTokensDefault(),
		defaultMaxOutputTokens: getModelMaxOutputTokensDefault(),
		forceOverrideModelTokenSettings: getForceOverrideModelTokenSettings(),
		overrides: getModelTokenOverrides(),
	};
}

function applyModelTokenSettings(
	model: ModelDefinition,
	tokenSettings: ModelTokenSettings,
): ModelDefinition {
	const override = resolveConfiguredModelTokenOverride(model.id, tokenSettings);
	if (override) {
		return {
			...model,
			maxInputTokens: override.maxInputTokens ?? model.maxInputTokens,
			maxOutputTokens: override.maxOutputTokens ?? model.maxOutputTokens,
		};
	}

	if (tokenSettings.forceOverrideModelTokenSettings) {
		return {
			...model,
			maxInputTokens: tokenSettings.defaultMaxInputTokens,
			maxOutputTokens: tokenSettings.defaultMaxOutputTokens,
		};
	}

	const preset = getBuiltinModelTokenPreset(model.id);
	if (preset) {
		return {
			...model,
			maxInputTokens: preset.maxInputTokens,
			maxOutputTokens: preset.maxOutputTokens,
		};
	}

	return {
		...model,
		maxInputTokens: model.maxInputTokens,
		maxOutputTokens: model.maxOutputTokens,
	};
}

function getBuiltinModelTokenPreset(modelId: string): ModelTokenPreset | undefined {
	for (const entry of BUILTIN_MODEL_TOKEN_PRESETS) {
		if (entry.pattern.test(modelId)) {
			return entry.preset;
		}
	}
	return undefined;
}

function resolveConfiguredModelTokenOverride(
	modelId: string,
	tokenSettings: ModelTokenSettings,
) {
	const exact = tokenSettings.overrides.exact[modelId];
	if (exact) {
		return exact;
	}

	for (const prefixOverride of tokenSettings.overrides.prefix) {
		if (modelId.startsWith(prefixOverride.prefix)) {
			return prefixOverride.override;
		}
	}

	return undefined;
}
