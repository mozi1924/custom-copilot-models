import vscode from 'vscode';

/**
 * Lightweight i18n module — zero dependencies, follows VS Code display language.
 *
 *  - en / en-US / en-*      → English (default)
 *  - zh-cn                  → Simplified Chinese
 *  - all other locales      → English until translated
 */

function isZh(): boolean {
	const lang = vscode.env.language.toLowerCase();
	return lang === 'zh-cn';
}

// ---- Translation dictionaries ----

type Translations = Record<string, string>;

const zh: Translations = {
	// Model descriptions
	'model.flash.detail': '通用模型',
	'model.pro.detail': '高质量推理',

	// API Key
	'auth.apiKeyRequiredDetail': '请先配置 API Key',
	'auth.prompt': '请输入 OpenAI 或兼容 Responses 上游的 API Key。',
	'auth.placeholder': 'sk-... 或服务商令牌',
	'auth.emptyValidation': 'API Key 不能为空',
	'auth.saved': 'API Key 已安全保存。',
	'auth.removed': 'API Key 已移除。',
	'auth.notConfigured': 'API Key 未配置，请在命令面板运行 "Responses: 设置 API Key"。',
	'models.refreshUnauthorized': '模型列表刷新失败：API Key 无效或已过期，已回退到内置模型。',

	// Thinking Effort — short labels for model picker dropdown
	'status.thinking': '思考模式',
	'thinking.none': '停用',
	'thinking.none.desc': '停用思考，响应更快',
	'thinking.minimal': '极低',
	'thinking.minimal.desc': '最低推理开销',
	'thinking.low': '低',
	'thinking.low.desc': '低开销推理',
	'thinking.medium': '中',
	'thinking.medium.desc': '默认平衡档位',
	'thinking.high': '高',
	'thinking.high.desc': '更强推理质量',
	'thinking.xhigh': '超高',
	'thinking.xhigh.desc': '最高推理强度，成本更高',

	// Request
	'request.toolsLimitExceeded':
		'当前请求包含 {1} 个函数工具，超过上限 {0}。请先在 VS Code 的 Configure Tools 里关闭不常用工具。',
	'request.preflightRoundLimitExceeded':
		'实验性稳定工具列表设置已尝试 {0} 轮，仍无法得到稳定的已启用工具列表。请关闭该实验性设置，或先用 VS Code 的 Configure Tools 关闭不常用的工具。',
	'notice.toolDrift':
		'⚠️ 工具列表不稳定，缓存命中率可能下降。',

	// Extension
	'extension.activateFailed': 'Responses Copilot 激活失败，请运行 "Responses: 显示日志" 查看详情。',
	'extension.deactivateFailed': 'Responses Copilot 停用异常',
	'extension.welcomeFailed': '欢迎引导加载异常',
	'extension.openRequestDumpsFolderFailed':
		'打开请求 dump 目录失败，请运行 "Responses: 显示日志" 查看详情。',
};

const en: Translations = {
	// Model descriptions
	'model.flash.detail': 'Fast, general-purpose model',
	'model.pro.detail': 'Most capable reasoning model',

	// API Key
	'auth.apiKeyRequiredDetail': 'Please run Responses: Set API Key to configure.',
	'auth.prompt':
		'Enter your OpenAI API key or compatible Responses provider token.',
	'auth.placeholder': 'sk-... or provider token',
	'auth.emptyValidation': 'API key cannot be empty',
	'auth.saved': 'API key saved.',
	'auth.removed': 'API key removed.',
	'auth.notConfigured':
		'API key not configured. Run "Responses: Set API Key" from the Command Palette.',
	'models.refreshUnauthorized':
		'Model refresh failed: the API key is invalid or expired. Falling back to built-in models.',

	// Thinking Effort
	'status.thinking': 'Thinking Effort',
	'thinking.none': 'None',
	'thinking.none.desc': 'Disable thinking for faster responses',
	'thinking.minimal': 'Minimal',
	'thinking.minimal.desc': 'Minimal reasoning overhead',
	'thinking.low': 'Low',
	'thinking.low.desc': 'Lower reasoning cost',
	'thinking.medium': 'Medium',
	'thinking.medium.desc': 'Balanced default',
	'thinking.high': 'High',
	'thinking.high.desc': 'Higher reasoning quality',
	'thinking.xhigh': 'XHigh',
	'thinking.xhigh.desc': 'Maximum reasoning depth with higher latency/cost',

	// Request
	'request.toolsLimitExceeded':
		'The request contains {1} tools but limit is {0}. Use VS Code Configure Tools to disable tools you rarely use.',
	'request.preflightRoundLimitExceeded':
		'Experimental tool-list stabilization tried {0} rounds but still could not get a stable enabled-tools list. Turn this experimental setting off, or use VS Code Configure Tools to disable tools you rarely use first.',
	'notice.toolDrift':
		'⚠️ Tool list is unstable; cache hit rate may drop.',

	// Extension
	'extension.activateFailed': 'Responses Copilot failed to activate. Run "Responses: Show Logs" for details.',
	'extension.deactivateFailed': 'Failed to prepare provider for deactivate',
	'extension.welcomeFailed': 'Failed to show welcome prompt',
	'extension.openRequestDumpsFolderFailed':
		'Failed to open request dumps folder. Run "Responses: Show Logs" for details.',
};

/**
 * Resolve a translation key for the current VS Code display language.
 * Supports positional placeholders {0}, {1}, ...
 */
export function t(key: string, ...args: (string | number)[]): string {
	const dict = isZh() ? zh : en;
	let text = dict[key];
	if (text === undefined) {
		// Fall back to English when a key is missing from the active locale.
		text = en[key];
	}
	if (text === undefined) {
		return key;
	}
	// Replace all occurrences of each positional placeholder.
	for (let i = 0; i < args.length; i++) {
		text = text.replaceAll(`{${i}}`, String(args[i]));
	}
	return text;
}
