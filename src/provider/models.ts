import vscode from 'vscode';
import { getReasoningEffortDefault } from '../config';
import { t } from '../i18n';
import type { ModelDefinition } from '../types';

/**
 * NOTE: Non-public API surface.
 *
 * The fields below (`configurationSchema` on chat info, `modelConfiguration`
 * on response options, plus `isUserSelectable` / `statusIcon`) are not part
 * of the stable `vscode.LanguageModelChat*` typings yet. They are the same
 * shape currently consumed by GitHub Copilot Chat to render a per-model
 * config dropdown in the model picker.
 */

export type ThinkingEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

type ThinkingEffortConfigurationSchema = ReturnType<typeof buildThinkingEffortSchema>;

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable: boolean;
	readonly statusIcon?: vscode.ThemeIcon;
	readonly configurationSchema?: ThinkingEffortConfigurationSchema;
};

export function toChatInfo(m: ModelDefinition, hasApiKey: boolean): ModelPickerChatInformation {
	const modelDetail = m.detail;
	return {
		id: m.id,
		name: m.name,
		family: m.family,
		version: m.version,
		detail: hasApiKey ? modelDetail : t('auth.apiKeyRequiredDetail'),
		tooltip: hasApiKey ? undefined : t('auth.apiKeyRequiredDetail'),
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.imageInput,
		},
		...(m.capabilities.thinking ? { configurationSchema: buildThinkingEffortSchema() } : {}),
	};
}

export function getConfiguredThinkingEffort(options: ModelConfigurationOptions): ThinkingEffort {
	const configuredEffort =
		options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;

	if (configuredEffort === 'none') return 'none';
	if (configuredEffort === 'minimal') return 'minimal';
	if (configuredEffort === 'low') return 'low';
	if (configuredEffort === 'high') return 'high';
	if (configuredEffort === 'xhigh') return 'xhigh';
	return getReasoningEffortDefault();
}

function buildThinkingEffortSchema() {
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
				enumItemLabels: [
					t('thinking.none'),
					t('thinking.minimal'),
					t('thinking.low'),
					t('thinking.medium'),
					t('thinking.high'),
					t('thinking.xhigh'),
				],
				enumDescriptions: [
					t('thinking.none.desc'),
					t('thinking.minimal.desc'),
					t('thinking.low.desc'),
					t('thinking.medium.desc'),
					t('thinking.high.desc'),
					t('thinking.xhigh.desc'),
				],
				default: getReasoningEffortDefault(),
				group: 'navigation',
			},
		},
	} as const;
}
