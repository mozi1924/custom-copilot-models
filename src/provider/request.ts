import vscode from 'vscode';
import { AuthManager } from '../auth';
import { ResponsesClient } from '../client';
import { getBaseUrl, getMaxOutputTokens, getStreamingTransportMode } from '../config';
import { FALLBACK_MODELS } from '../consts';
import { t } from '../i18n';
import type { DeepSeekRequest, ResponsesRequest } from '../types';
import { convertMessages, countMessageChars } from './convert';
import {
	classifyDeepSeekRequest,
	dumpDeepSeekRequest,
	type CacheDiagnosticsRecorder,
	type CacheDiagnosticsRun,
	type RequestKind,
} from './debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from './models';
import { parseFirstReplayMarker, type ReplayMarkerMetadata } from './replay';
import type { ConversationSegment } from './segment';
import { collectTrailingToolResultIds, prepareRequestTools } from './tools/request';

export interface PreparedChatRequest {
	client: ResponsesClient;
	request: ResponsesRequest;
	debugRequest: DeepSeekRequest;
	isThinkingModel: boolean;
	totalRequestChars: number;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
	streamingTransportMode: ReturnType<typeof getStreamingTransportMode>;
}

export interface PrepareChatRequestOptions {
	authManager: AuthManager;
	globalStorageUri: vscode.Uri;
	modelInfo: vscode.LanguageModelChatInformation;
	segment: ConversationSegment;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	token: vscode.CancellationToken;
	cacheDiagnostics: CacheDiagnosticsRecorder;
}

export async function prepareChatRequest({
	authManager,
	globalStorageUri,
	modelInfo,
	segment,
	messages,
	options,
	cacheDiagnostics,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	const apiKey = await authManager.getApiKey();
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

	const client = new ResponsesClient(getBaseUrl(), apiKey);
	const modelDef = FALLBACK_MODELS.find((m) => m.id === modelInfo.id);
	const isThinkingModel = modelDef?.capabilities.thinking ?? true;
	const thinkingEffort = getConfiguredThinkingEffort(options as ModelConfigurationOptions);
	const configuredMaxOutputTokens = getMaxOutputTokens();
	const modelOptionOverrides = resolveModelOptionOverrides(options.modelOptions);
	const effectiveMaxOutputTokens =
		modelOptionOverrides.maxOutputTokens ?? configuredMaxOutputTokens;
	const previousResponseId = resolvePreviousResponseId(messages, segment);
	const requestMessages = resolveRequestMessages(messages, segment, previousResponseId);
	const converted = convertMessages(requestMessages, isThinkingModel);
	const { tools, toolChoice } = prepareRequestTools(
		modelDef?.capabilities.toolCalling ?? true,
		options,
	);

	const request: ResponsesRequest = {
		model: modelInfo.id,
		input: converted.input,
		stream: true,
		previous_response_id: previousResponseId,
		tools,
		tool_choice: toolChoice,
		max_output_tokens: effectiveMaxOutputTokens,
		temperature: modelOptionOverrides.temperature,
		top_p: modelOptionOverrides.topP,
		...(isThinkingModel ? { reasoning: { effort: thinkingEffort } } : {}),
	};

	const totalRequestChars = countMessageChars(converted.debugMessages);
	const debugRequest: DeepSeekRequest = {
		model: request.model,
		messages: converted.debugMessages,
		stream: true,
		previous_response_id: request.previous_response_id,
		tools: tools?.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		})),
		tool_choice: request.tool_choice,
		temperature: request.temperature,
		top_p: request.top_p,
		max_tokens: request.max_output_tokens,
		reasoning_effort: request.reasoning?.effort,
	};

	const requestKind = classifyDeepSeekRequest({
		request: debugRequest,
		inputMessages: requestMessages,
	});

	dumpDeepSeekRequest(debugRequest, {
		globalStorageUri,
		segment,
		requestKind,
			vscodeModelId: modelInfo.id,
			isThinkingModel,
			thinkingEffort,
			maxTokens: effectiveMaxOutputTokens,
			inputMessages: messages,
			resolvedMessages: requestMessages,
			requestOptions: options,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest({
		request: debugRequest,
		segment,
		requestKind,
			vscodeModelId: modelInfo.id,
			isThinkingModel,
			thinkingEffort,
			maxTokens: effectiveMaxOutputTokens,
			inputMessages: messages,
			resolvedMessages: requestMessages,
	});

	return {
		client,
		request,
		debugRequest,
		isThinkingModel,
		totalRequestChars,
		trailingToolResultIds: collectTrailingToolResultIds(converted.debugMessages),
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: previousResponseId ? { responseId: previousResponseId } : {},
		streamingTransportMode: getStreamingTransportMode(),
	};
}

function resolvePreviousResponseId(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	segment: ConversationSegment,
): string | undefined {
	if (segment.reason !== 'markerFound' || segment.markerMessageIndex === undefined) {
		return undefined;
	}

	const markerMessage = messages[segment.markerMessageIndex];
	if (!markerMessage) {
		return undefined;
	}
	const marker = parseFirstReplayMarker(markerMessage);
	if (!marker?.valid || !marker.responseId) {
		return undefined;
	}
	return marker.responseId;
}

function resolveRequestMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	segment: ConversationSegment,
	previousResponseId: string | undefined,
): readonly vscode.LanguageModelChatRequestMessage[] {
	if (!previousResponseId || segment.markerMessageIndex === undefined) {
		return messages;
	}

	const deltaMessages = messages.slice(segment.markerMessageIndex + 1);
	return deltaMessages.length > 0 ? deltaMessages : messages;
}

function resolveModelOptionOverrides(
	modelOptions: vscode.ProvideLanguageModelChatResponseOptions['modelOptions'],
): {
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
} {
	if (!modelOptions || typeof modelOptions !== 'object' || Array.isArray(modelOptions)) {
		return {};
	}
	const options = modelOptions as Record<string, unknown>;

	return {
		maxOutputTokens: getPositiveInteger(
			options.max_output_tokens,
			getPositiveInteger(options.maxOutputTokens, getPositiveInteger(options.maxTokens, undefined)),
		),
		temperature: getFiniteNumber(options.temperature, undefined),
		topP: getFiniteNumber(options.top_p, getFiniteNumber(options.topP, undefined)),
	};
}

function getFiniteNumber(value: unknown, fallback: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getPositiveInteger(value: unknown, fallback: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}
