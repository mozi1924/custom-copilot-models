import vscode from 'vscode';
import { AuthManager } from '../auth';
import { ResponsesClient } from '../client';
import { getBaseUrl, getMaxOutputTokens } from '../config';
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
import type { ReplayMarkerMetadata } from './replay';
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
	const maxOutputTokens = getMaxOutputTokens();
	const converted = convertMessages(messages, isThinkingModel);
	const tools = prepareRequestTools(modelDef?.capabilities.toolCalling ?? true, options);

	const request: ResponsesRequest = {
		model: modelInfo.id,
		input: converted.input,
		stream: true,
		tools,
		tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
		max_output_tokens: maxOutputTokens,
		...(isThinkingModel ? { reasoning: { effort: thinkingEffort } } : {}),
	};

	const totalRequestChars = countMessageChars(converted.debugMessages);
	const debugRequest: DeepSeekRequest = {
		model: request.model,
		messages: converted.debugMessages,
		stream: true,
		tools: tools?.map((tool) => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		})),
		tool_choice: request.tool_choice,
		max_tokens: request.max_output_tokens,
		reasoning_effort: request.reasoning?.effort,
	};

	const requestKind = classifyDeepSeekRequest({
		request: debugRequest,
		inputMessages: messages,
	});

	dumpDeepSeekRequest(debugRequest, {
		globalStorageUri,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens: maxOutputTokens,
		inputMessages: messages,
		resolvedMessages: messages,
		requestOptions: options,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest({
		request: debugRequest,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens: maxOutputTokens,
		inputMessages: messages,
		resolvedMessages: messages,
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
		replayMarkerMetadata: {},
	};
}
