import vscode from 'vscode';
import { safeStringify } from '../json';
import type {
	DeepSeekMessage,
	DeepSeekToolCall,
	ResponsesFunctionTool,
	ResponsesInputImagePart,
	ResponsesInputItem,
	ResponsesInputTextPart,
	ResponsesOutputTextPart,
} from '../types';
import { parseFirstReplayMarker } from './replay';

interface ConvertedMessages {
	input: ResponsesInputItem[];
	debugMessages: DeepSeekMessage[];
}

interface ConvertMessagesOptions {
	omitSystemMessages?: boolean;
}

/**
 * Convert VS Code chat messages to Responses `input` messages.
 * Also returns a text-only debug message list used by existing diagnostics.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	isThinkingModel: boolean,
	options: ConvertMessagesOptions = {},
): ConvertedMessages {
	const input: ResponsesInputItem[] = [];
	const debugMessages: DeepSeekMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message.role);
		const skipSystemMessage = options.omitSystemMessages && role === 'system';
		const parts: Array<ResponsesInputTextPart | ResponsesOutputTextPart | ResponsesInputImagePart> =
			[];
		let debugText = '';
		let thinkingContent = '';
		const toolCalls: DeepSeekToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string }> = [];
		const responseToolCalls: Array<{
			id: string;
			call_id: string;
			name: string;
			arguments: string;
		}> = [];
		const responseToolOutputs: Array<{ call_id: string; output: string }> = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value.length > 0) {
					if (!skipSystemMessage) {
						parts.push(createTextPartForRole(role, part.value));
					}
				}
				debugText += part.value;
			} else if (
				part instanceof vscode.LanguageModelDataPart &&
				part.mimeType.startsWith('image/')
			) {
				if (role !== 'assistant' && !skipSystemMessage) {
					parts.push({
						type: 'input_image',
						image_url: toDataUrl(part.mimeType, part.data),
					});
				}
				debugText += '[image]';
			} else if (isLanguageModelThinkingPart(part)) {
				thinkingContent += normalizeThinkingPartText(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				if (skipSystemMessage) {
					continue;
				}
				const argumentsJson = safeStringify(part.input);
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: argumentsJson,
					},
				});
				responseToolCalls.push({
					id: part.callId,
					call_id: part.callId,
					name: part.name,
					arguments: argumentsJson,
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				if (skipSystemMessage) {
					continue;
				}
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
				responseToolOutputs.push({
					call_id: part.callId,
					output: toolContent || safeStringify(part.content),
				});
			}
		}

		if (parts.length > 0) {
			input.push({ role, content: parts });
		}
		for (const tc of responseToolCalls) {
			input.push({
				type: 'function_call',
				call_id: tc.call_id,
				name: tc.name,
				arguments: tc.arguments,
			});
		}
		for (const tr of responseToolOutputs) {
			input.push({
				type: 'function_call_output',
				call_id: tr.call_id,
				output: tr.output,
			});
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

export function extractSystemInstructions(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string | undefined {
	const parts: string[] = [];

	for (const message of messages) {
		if (mapRole(message.role) !== 'system') {
			continue;
		}

		const text = getMessageText(message);
		if (text.length > 0) {
			parts.push(text);
		}
	}

	if (parts.length === 0) {
		return undefined;
	}

	return parts.join('\n\n');
}

function getMessageText(message: vscode.LanguageModelChatRequestMessage): string {
	let text = '';
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
		}
	}
	return text;
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

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			return 'system';
	}
}

function createTextPartForRole(
	role: 'user' | 'assistant' | 'system',
	text: string,
): ResponsesInputTextPart | ResponsesOutputTextPart {
	if (role === 'assistant') {
		return { type: 'output_text', text };
	}
	return { type: 'input_text', text };
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

	return tools.map((tool) => {
		const normalizedSchema = normalizeToolSchema(
			tool.inputSchema as Record<string, unknown> | undefined,
		);
		const strictCompatible = isStrictCompatibleSchema(normalizedSchema);
		return {
			type: 'function',
			name: tool.name,
			description: tool.description,
			parameters: normalizedSchema,
			strict: strictCompatible,
		};
	});
}

function normalizeToolSchema(
	schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	const baseSchema = schema ?? {};
	const normalized = normalizeSchemaNode(baseSchema, true);
	if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
		return createEmptyObjectSchema();
	}
	const root = { ...(normalized as Record<string, unknown>) };
	const hasObjectShape =
		root.type === 'object' ||
		(typeof root.properties === 'object' &&
			root.properties !== null &&
			!Array.isArray(root.properties));
	if (!hasObjectShape) {
		return createEmptyObjectSchema();
	}
	if (root.type === undefined) {
		root.type = 'object';
	}
	if (root.properties === undefined) {
		root.properties = {};
	}
	if (root.additionalProperties === undefined) {
		root.additionalProperties = false;
	}
	root.required = mergeRequiredKeys(root.required, getObjectPropertyKeys(root.properties));
	return root;
}

function normalizeSchemaNode(value: unknown, isRoot = false): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => normalizeSchemaNode(item));
	}
	if (!value || typeof value !== 'object') {
		return value;
	}

	const source = value as Record<string, unknown>;
	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(source)) {
		normalized[key] = normalizeSchemaNode(child);
	}

	const isObjectSchema =
		normalized.type === 'object' ||
		(typeof normalized.properties === 'object' &&
			normalized.properties !== null &&
			!Array.isArray(normalized.properties));
	if (isObjectSchema && normalized.additionalProperties === undefined) {
		normalized.additionalProperties = false;
	}
	if (isObjectSchema) {
		const propertyKeys = getObjectPropertyKeys(normalized.properties);
		if (propertyKeys.length > 0) {
			normalized.required = mergeRequiredKeys(normalized.required, propertyKeys);
		}
	}
	if (isRoot && normalized.additionalProperties === undefined && normalized.type === 'object') {
		normalized.additionalProperties = false;
	}

	return normalized;
}

function createEmptyObjectSchema(): Record<string, unknown> {
	return {
		type: 'object',
		properties: {},
		required: [],
		additionalProperties: false,
	};
}

const STRICT_INCOMPATIBLE_KEYWORDS = new Set([
	'oneOf',
	'anyOf',
	'allOf',
	'not',
	'if',
	'then',
	'else',
	'patternProperties',
	'dependentSchemas',
	'unevaluatedProperties',
	'propertyNames',
]);

function isStrictCompatibleSchema(schema: Record<string, unknown> | undefined): boolean {
	if (!schema) {
		return true;
	}
	return !containsStrictIncompatibleKeyword(schema);
}

function containsStrictIncompatibleKeyword(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some((item) => containsStrictIncompatibleKeyword(item));
	}
	if (!value || typeof value !== 'object') {
		return false;
	}

	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (STRICT_INCOMPATIBLE_KEYWORDS.has(key)) {
			return true;
		}
		if (containsStrictIncompatibleKeyword(child)) {
			return true;
		}
	}
	return false;
}

function getObjectPropertyKeys(properties: unknown): string[] {
	if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
		return [];
	}
	return Object.keys(properties as Record<string, unknown>);
}

function mergeRequiredKeys(required: unknown, propertyKeys: string[]): string[] {
	const existing = Array.isArray(required)
		? required.filter((item): item is string => typeof item === 'string')
		: [];
	const requiredSet = new Set(existing);
	for (const key of propertyKeys) {
		requiredSet.add(key);
	}
	return [...requiredSet];
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
