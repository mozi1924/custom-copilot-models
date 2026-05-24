import vscode from 'vscode';
import { getDebugMode, migrateLegacyDebugSetting } from './config';
import { CONFIG_SECTION, WALKTHROUGH_ID, WELCOME_SHOWN_KEY } from './consts';
import { t } from './i18n';
import { logger } from './logger';
import { ResponsesChatProvider } from './provider';
import { ensureRequestDumpRoot } from './provider/debug';

let activeProvider: ResponsesChatProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
	try {
		await migrateLegacyDebugSetting();
	} catch (error) {
		logger.warn('Failed to migrate legacy debug setting', error);
	}

	logger.info(
		`Activating extension version=${context.extension.packageJSON.version}` +
			` vscode=${vscode.version}` +
			` extensionKind=${context.extension.extensionKind}` +
			` remoteName=${vscode.env.remoteName ?? 'none'}` +
			` uiKind=${vscode.env.uiKind}` +
			` platform=${process.platform}` +
			` arch=${process.arch}` +
			` debugMode=${getDebugMode()}`,
	);

	let currentDebugMode = getDebugMode();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${CONFIG_SECTION}.debugMode`)) {
				const previous = currentDebugMode;
				currentDebugMode = getDebugMode();
				logger.info(`debugMode changed: ${previous} -> ${currentDebugMode}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('responses-copilot.showLogs', () => logger.show()),
		vscode.commands.registerCommand('responses-copilot.openRequestDumpsFolder', () =>
			openRequestDumpsFolder(context),
		),
		vscode.commands.registerCommand('responses-copilot.getApiKey', () =>
			vscode.env.openExternal(
				vscode.Uri.parse('https://platform.openai.com/settings/organization/api-keys'),
			),
		),
		vscode.commands.registerCommand('responses-copilot.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'responses-copilot'),
		),
	);

	try {
		const provider = new ResponsesChatProvider(context);
		activeProvider = provider;

		context.subscriptions.push(
			vscode.commands.registerCommand('responses-copilot.setApiKey', () =>
				provider.configureApiKey(),
			),
			vscode.commands.registerCommand('responses-copilot.clearApiKey', () =>
				provider.clearApiKey(),
			),
			vscode.commands.registerCommand('responses-copilot.refreshModels', () =>
				provider.refreshRemoteModels(),
			),
			vscode.lm.registerLanguageModelChatProvider('responses-copilot', provider),
		);

		try {
			await vscode.extensions.getExtension('github.copilot-chat')?.activate();
		} catch {
			logger.warn('Copilot Chat activation unavailable; model picker refresh may be delayed');
		}

		provider.refreshModelPicker();

		void showWelcomeIfNeeded(context, provider).catch((error) => {
			logger.warn(t('extension.welcomeFailed'), error);
		});

		logger.info(`Extension activated version=${context.extension.packageJSON.version}`);
	} catch (error) {
		activeProvider = undefined;
		logger.error('Failed to activate extension', error);
		void vscode.window.showErrorMessage(t('extension.activateFailed'));
		throw error;
	}
}

async function openRequestDumpsFolder(context: vscode.ExtensionContext): Promise<void> {
	try {
		const root = await ensureRequestDumpRoot(context.globalStorageUri);
		logger.info(`Opening request dumps folder: ${root.toString(true)}`);
		await vscode.commands.executeCommand('revealFileInOS', root);
	} catch (error) {
		logger.warn('Failed to open request dumps folder', error);
		void vscode.window.showErrorMessage(t('extension.openRequestDumpsFolderFailed'));
	}
}

async function showWelcomeIfNeeded(
	context: vscode.ExtensionContext,
	provider: ResponsesChatProvider,
): Promise<void> {
	if (context.globalState.get<boolean>(WELCOME_SHOWN_KEY)) {
		return;
	}
	if (await provider.hasApiKey()) {
		await context.globalState.update(WELCOME_SHOWN_KEY, true);
		return;
	}

	await vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
	await context.globalState.update(WELCOME_SHOWN_KEY, true);
}

export async function deactivate() {
	try {
		await activeProvider?.prepareForDeactivate();
	} catch (error) {
		logger.warn(t('extension.deactivateFailed'), error);
	} finally {
		activeProvider = undefined;
		logger.info('Extension deactivated');
		logger.dispose();
	}
}
