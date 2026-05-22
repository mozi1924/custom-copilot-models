import type { LanguageModelChatInformation } from 'vscode';
import { getBaseUrl, getModelListTtlMinutes } from '../config';
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
			logger.warn('Failed to fetch remote model list; falling back to static models', error);
		}

		const fallback = [...FALLBACK_MODELS];
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
		const response = await fetch(`${getBaseUrl()}/models`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
		});
		if (!response.ok) {
			throw new Error(`Model list request failed: ${response.status}`);
		}

		const payload = (await response.json()) as ModelsApiResponse;
		const ids = (payload.data ?? []).map((model) => model.id).filter(isLikelyChatModelId);

		return ids.map((id) => toModelDefinition(id));
	}
}

export function toModelDefinition(id: string): ModelDefinition {
	const family = resolveFamily(id);
	return {
		id,
		name: id,
		family,
		version: resolveVersion(id),
		detail: 'Responses API model',
		maxInputTokens: 1_000_000,
		maxOutputTokens: 393_216,
		capabilities: {
			toolCalling: true,
			imageInput: true,
			thinking: true,
		},
		requiresThinkingParam: false,
	};
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
