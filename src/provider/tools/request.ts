import vscode from 'vscode';
import { t } from '../../i18n';
import type { DeepSeekMessage, ResponsesFunctionTool } from '../../types';
import { convertTools } from '../convert';
import { DEFAULT_TOOLS_LIMIT } from './consts';

export interface PreparedRequestTools {
	tools: ResponsesFunctionTool[] | undefined;
	toolChoice: 'none' | 'auto' | 'required' | undefined;
}

export function prepareRequestTools(
	toolCallingCapability: boolean | number | undefined,
	options: vscode.ProvideLanguageModelChatResponseOptions,
): PreparedRequestTools {
	const tools = toolCallingCapability ? convertTools(options.tools) : undefined;
	const toolLimit = getToolCallingLimit(toolCallingCapability);
	const toolsCount = tools?.length ?? 0;
	if (toolsCount > toolLimit) {
		throw new Error(t('request.toolsLimitExceeded', toolLimit, toolsCount));
	}
	if (options.toolMode === vscode.LanguageModelChatToolMode.Required && toolsCount === 0) {
		throw new Error(t('request.requiredToolModeNeedsTools'));
	}

	return {
		tools,
		toolChoice: resolveToolChoice(options.toolMode, toolsCount),
	};
}

export function collectTrailingToolResultIds(messages: readonly DeepSeekMessage[]): string[] {
	const trailingToolResultIds: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== 'tool' || !message.tool_call_id) {
			break;
		}
		trailingToolResultIds.push(message.tool_call_id);
	}
	return trailingToolResultIds.reverse();
}

function getToolCallingLimit(toolCallingCapability: boolean | number | undefined): number {
	return typeof toolCallingCapability === 'number' ? toolCallingCapability : DEFAULT_TOOLS_LIMIT;
}

function resolveToolChoice(
	toolMode: vscode.LanguageModelChatToolMode,
	toolsCount: number,
): 'none' | 'auto' | 'required' | undefined {
	if (toolsCount === 0) {
		return undefined;
	}
	if (toolMode === vscode.LanguageModelChatToolMode.Required) {
		return 'required';
	}
	return 'auto';
}
