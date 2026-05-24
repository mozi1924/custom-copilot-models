import vscode from 'vscode';
import { AuthManager } from '../auth';
import { getStabilizeToolListEnabled } from '../config';
import { CONFIG_SECTION } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import {
	classifyProviderRequest,
	createCacheDiagnosticsRecorder,
	dumpProviderInput,
} from './debug';
import { ModelListRequestError, ModelRegistry } from './modelRegistry';
import { toChatInfo } from './models';
import { prepareChatRequest } from './request';
import { resolveConversationSegment } from './segment';
import { streamChatCompletion } from './stream';
import { estimateTokenCount } from './tokens';
import { processToolFlow } from './tools/flow';

/**
 * Responses Chat Provider - implements vscode.LanguageModelChatProvider so
 * remote Responses API models appear directly in the Copilot Chat model picker.
 */
export class ResponsesChatProvider implements vscode.LanguageModelChatProvider {
	private readonly authManager: AuthManager;
	private readonly globalStorageUri: vscode.Uri;
	private readonly modelRegistry = new ModelRegistry();
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private isActive = true;
	private charsPerToken = 4.0;
	private readonly cacheDiagnostics = createCacheDiagnosticsRecorder();

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		this.authManager = new AuthManager(context);
		this.globalStorageUri = context.globalStorageUri;

		context.subscriptions.push(
			this.onDidChangeLanguageModelChatInformationEmitter,
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('responses-copilot.apiKey')) {
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}
				if (
					e.affectsConfiguration(`${CONFIG_SECTION}.baseUrl`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.modelListTtlMinutes`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.modelMaxInputTokensDefault`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.modelMaxOutputTokensDefault`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.modelTokenOverrides`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.omitMaxOutputTokensInModelMetadata`)
				) {
					this.modelRegistry.invalidate();
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}
			}),
			context.secrets.onDidChange((e) => {
				if (e.key === 'responses-copilot.apiKey') {
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}
			}),
		);
	}

	async configureApiKey(): Promise<void> {
		const saved = await this.authManager.promptForApiKey();
		if (saved) {
			this.modelRegistry.invalidate();
			this.onDidChangeLanguageModelChatInformationEmitter.fire();
		}
	}

	async clearApiKey(): Promise<void> {
		await this.authManager.deleteApiKey();
		this.modelRegistry.invalidate();
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
		vscode.window.showInformationMessage(t('auth.removed'));
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasApiKey();
	}

	async refreshRemoteModels(): Promise<void> {
		this.modelRegistry.invalidate();
		const apiKey = await this.authManager.getApiKey();
		if (!apiKey?.trim()) {
			void vscode.window.showWarningMessage(t('auth.notConfigured'));
			this.onDidChangeLanguageModelChatInformationEmitter.fire();
			return;
		}

		try {
			await this.modelRegistry.listModels(apiKey, true);
		} catch (error) {
			if (
				error instanceof ModelListRequestError &&
				(error.status === 401 || error.status === 403)
			) {
				void vscode.window.showWarningMessage(t('models.refreshUnauthorized'));
				logger.info('Model refresh unauthorized; keeping fallback models');
			} else {
				throw error;
			}
		}
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
		try {
			await vscode.lm.selectChatModels({ vendor: 'responses-copilot' });
		} catch (error) {
			logger.warn('Failed to refresh models during deactivate', error);
		}
	}

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}

		const apiKey = await this.authManager.getApiKey();
		const models = await this.modelRegistry.listModels(apiKey, false);
		return models.map((model) => toChatInfo(model, Boolean(apiKey)));
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const segment = resolveConversationSegment(messages);
		const requestKind = classifyProviderRequest({
			messages,
			tools: options.tools,
		});

		dumpProviderInput({
			globalStorageUri: this.globalStorageUri,
			segment,
			modelInfo,
			messages,
			requestOptions: options,
			requestKind,
		});

		const toolFlow = processToolFlow({
			stabilizeToolList: getStabilizeToolListEnabled(),
			messages,
			tools: options.tools,
			progress,
			requestKind,
		});
		if (toolFlow.preflightHandled) {
			return;
		}

		const prepared = await prepareChatRequest({
			authManager: this.authManager,
			globalStorageUri: this.globalStorageUri,
			modelInfo,
			segment,
			messages: toolFlow.messages,
			options,
			token,
			cacheDiagnostics: this.cacheDiagnostics,
		});

		return streamChatCompletion({
			prepared,
			progress,
			token,
			initialResponseNotice: toolFlow.initialResponseNotice,
			getCharsPerToken: () => this.charsPerToken,
			setCharsPerToken: (charsPerToken) => {
				this.charsPerToken = charsPerToken;
			},
		});
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text, this.charsPerToken);
	}
}
