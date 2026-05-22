import vscode from 'vscode';
import { safeStringify } from '../json';
import type {
	DeepSeekMessage,
	DeepSeekToolCall,
	ResponsesFunctionTool,
	ResponsesInputImagePart,
	ResponsesInputMessage,
	ResponsesInputTextPart,
} from '../types';
import { parseFirstReplayMarker } from './replay';

interface ConvertedMessages {
	input: ResponsesInputMessage[];
	debugMessages: DeepSeekMessage[];
}

/**
 * Convert VS Code chat messages to Responses `input` messages.
 * Also returns a text-only debug message list used by existing diagnostics.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	isThinkingModel: boolean,
): ConvertedMessages {
	const input: ResponsesInputMessage[] = [];
	const debugMessages: DeepSeekMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message.role);
		const parts: Array<ResponsesInputTextPart | ResponsesInputImagePart> = [];
		let debugText = '';
		let thinkingContent = '';
		const toolCalls: DeepSeekToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string }> = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value.length > 0) {
					parts.push({ type: 'input_text', text: part.value });
				}
				debugText += part.value;
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				parts.push({
					type: 'input_image',
					image_url: toDataUrl(part.mimeType, part.data),
				});
				debugText += '[image]';
			} else if (isLanguageModelThinkingPart(part)) {
				thinkingContent += normalizeThinkingPartText(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: safeStringify(part.input),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let toolContent = '';
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelTextPart) {
						toolContent += item.value;
					}
				}
				toolResults.push({
					callId: part.callId,
					content: toolContent || safeStringify(part.content),
				});
			}
		}

		if (parts.length > 0) {
			input.push({ role, content: parts });
		}

		if (role === 'assistant') {
			if (debugText || toolCalls.length > 0) {
				const replayMarker = isThinkingModel ? parseFirstReplayMarker(message) : undefined;
				const debugMessage: DeepSeekMessage = {
					role: 'assistant',
					content: debugText || '',
				};
				if (toolCalls.length > 0) {
					debugMessage.tool_calls = toolCalls;
				}
				if (isThinkingModel) {
					debugMessage.reasoning_content = getReasoningContent(replayMarker, thinkingContent);
				}
				debugMessages.push(debugMessage);
			}
		} else if (debugText) {
			debugMessages.push({
				role,
				content: debugText,
			});
		}

		for (const toolResult of toolResults) {
			debugMessages.push({
				role: 'tool',
				content: toolResult.content,
				tool_call_id: toolResult.callId,
			});
		}
	}

	return { input, debugMessages };
}

function getReasoningContent(
	replayMarker: ReturnType<typeof parseFirstReplayMarker>,
	thinkingContent: string,
): string {
	if (replayMarker?.valid && replayMarker.reasoningText) {
		return replayMarker.reasoningText;
	}
	return thinkingContent;
}

function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof vscode.LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

function normalizeThinkingPartText(value: string | string[]): string {
	return Array.isArray(value) ? value.join('') : value;
}

function mapRole(
	role: vscode.LanguageModelChatMessageRole,
): 'user' | 'assistant' | 'system' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'system';
	}
}

function toDataUrl(mimeType: string, data: Uint8Array): string {
	const base64 = Buffer.from(data).toString('base64');
	return `data:${mimeType};base64,${base64}`;
}

/**
 * Convert VS Code tool definitions to Responses tool format.
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ResponsesFunctionTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema as Record<string, unknown> | undefined,
		strict: true,
	}));
}

/**
 * Count total characters across all debug messages to calibrate chars-per-token ratio.
 */
export function countMessageChars(messages: DeepSeekMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += msg.content?.length ?? 0;
		total += msg.reasoning_content?.length ?? 0;
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				total += tc.function?.name?.length ?? 0;
				total += tc.function?.arguments?.length ?? 0;
			}
		}
	}
	return total;
}
