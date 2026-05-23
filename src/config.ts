import vscode from 'vscode';
import { CONFIG_SECTION } from './consts';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type StreamingTransportMode = 'websocketPreferred' | 'httpOnly' | 'websocketOnly';
export interface ModelTokenOverride {
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

export interface ModelTokenPrefixOverride {
	prefix: string;
	override: ModelTokenOverride;
}

export interface ModelTokenOverrideSettings {
	exact: Record<string, ModelTokenOverride>;
	prefix: ModelTokenPrefixOverride[];
}

/**
 * Get Responses API base URL from settings.
 * Falls back to official OpenAI v1 endpoint when not configured.
 */
export function getBaseUrl(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const baseUrl = config.get<string>('baseUrl') || 'https://api.openai.com/v1';
	return stripTrailingSlash(baseUrl.trim() || 'https://api.openai.com/v1');
}

/**
 * Get the configured max output tokens limit.
 * Returns `undefined` when set to 0 (API default — no limit).
 */
export function getMaxOutputTokens(): number | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('maxOutputTokens', 0);
	return value > 0 ? value : undefined;
}

export function getModelListTtlMinutes(): number {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('modelListTtlMinutes', 30);
	return Number.isFinite(value) && value > 0 ? value : 30;
}

export function getModelMaxInputTokensDefault(): number {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('modelMaxInputTokensDefault', 272_000);
	return toPositiveInteger(value, 272_000) ?? 272_000;
}

export function getModelMaxOutputTokensDefault(): number {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('modelMaxOutputTokensDefault', 128_000);
	return toPositiveInteger(value, 128_000) ?? 128_000;
}

export function getModelTokenOverrides(): ModelTokenOverrideSettings {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown>('modelTokenOverrides', {});
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {
			exact: {},
			prefix: [],
		};
	}

	const exact: Record<string, ModelTokenOverride> = {};
	const prefix: ModelTokenPrefixOverride[] = [];
	for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!modelId || typeof modelId !== 'string') {
			continue;
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}

		const record = value as Record<string, unknown>;
		const maxInputTokens = toPositiveInteger(record.maxInputTokens, undefined);
		const maxOutputTokens = toPositiveInteger(record.maxOutputTokens, undefined);
		if (maxInputTokens === undefined && maxOutputTokens === undefined) {
			continue;
		}

		const override: ModelTokenOverride = {
			maxInputTokens,
			maxOutputTokens,
		};

		if (modelId.endsWith('*')) {
			const keyPrefix = modelId.slice(0, -1).trim();
			if (!keyPrefix) {
				continue;
			}
			prefix.push({
				prefix: keyPrefix,
				override,
			});
			continue;
		}

		exact[modelId] = override;
	}

	prefix.sort((a, b) => b.prefix.length - a.prefix.length);

	return {
		exact,
		prefix,
	};
}

export function getForceOverrideModelTokenSettings(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('forceOverrideModelTokenSettings', false);
}

export function getReasoningEffortDefault(): ReasoningEffort {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<string>('reasoningEffortDefault', 'medium');
	return normalizeReasoningEffort(value) ?? 'medium';
}

/**
 * Diagnostic mode. `verbose` also enables metadata logs.
 *
 * The legacy boolean `debug` setting is still read as a fallback so old
 * settings keep working even if migration cannot update every scope.
 */
export function getDebugMode(): DebugMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const mode = getConfiguredDebugMode(config);
	if (mode) return mode;

	return config.get<boolean>('debug', false) ? 'metadata' : 'minimal';
}

/**
 * Whether to log privacy-preserving diagnostic debug information.
 */
export function getDebugLoggingEnabled(): boolean {
	return getDebugMode() !== 'minimal';
}

/**
 * Whether to write full upstream request payloads to disk.
 */
export function getRequestDumpEnabled(): boolean {
	return getDebugMode() === 'verbose';
}

export function getStabilizeToolListEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('experimental.stabilizeToolList', false);
}

export function getStreamingTransportMode(): StreamingTransportMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<string>('streamingTransport', 'websocketPreferred');
	return normalizeStreamingTransportMode(value) ?? 'websocketPreferred';
}

/**
 * Migrate the legacy boolean `responses-copilot.debug` setting to `debugMode`.
 *
 * `debug: true` maps to `debugMode: metadata`; `debug: false` maps to the
 * default `minimal`, so it only needs cleanup.
 */
export async function migrateLegacyDebugSetting(): Promise<void> {
	await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Global);
	if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
		await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Workspace);
	}
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
	if (
		value === 'none' ||
		value === 'minimal' ||
		value === 'low' ||
		value === 'medium' ||
		value === 'high' ||
		value === 'xhigh'
	) {
		return value;
	}
	return undefined;
}

function stripTrailingSlash(url: string): string {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function toPositiveInteger(value: unknown, fallback: number | undefined): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	return fallback;
}

function getConfiguredDebugMode(config: vscode.WorkspaceConfiguration): DebugMode | undefined {
	const mode = config.inspect<unknown>('debugMode');
	return normalizeDebugMode(mode?.workspaceValue) ?? normalizeDebugMode(mode?.globalValue);
}

function normalizeDebugMode(value: unknown): DebugMode | undefined {
	if (value === 'minimal' || value === 'metadata' || value === 'verbose') {
		return value;
	}
	return undefined;
}

function normalizeStreamingTransportMode(value: unknown): StreamingTransportMode | undefined {
	if (value === 'websocketPreferred' || value === 'httpOnly' || value === 'websocketOnly') {
		return value;
	}
	return undefined;
}

async function migrateLegacyDebugSettingAtScope(
	target: vscode.ConfigurationTarget,
	resource?: vscode.Uri,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
	const legacy = config.inspect<boolean>('debug');
	const mode = config.inspect<DebugMode>('debugMode');
	const legacyValue = getScopedValue(legacy, target);

	if (legacyValue === undefined) {
		return;
	}

	if (legacyValue === true && getScopedValue(mode, target) === undefined) {
		await config.update('debugMode', 'metadata', target);
	}
	await config.update('debug', undefined, target);
}

function getScopedValue<T>(
	inspection:
		| {
				globalValue?: T;
				workspaceValue?: T;
				workspaceFolderValue?: T;
		  }
		| undefined,
	target: vscode.ConfigurationTarget,
): T | undefined {
	if (!inspection) {
		return undefined;
	}

	if (target === vscode.ConfigurationTarget.Global) {
		return inspection.globalValue;
	}
	if (target === vscode.ConfigurationTarget.Workspace) {
		return inspection.workspaceValue;
	}
	return undefined;
}
