/**
 * Shared types for the Responses Copilot extension.
 */

// ---- Legacy debug compatibility types (still consumed by debug pipeline) ----

export interface DeepSeekMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_call_id?: string;
	tool_calls?: DeepSeekToolCall[];
	reasoning_content?: string;
}

export interface DeepSeekToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
	call_id?: string;
}

export interface DeepSeekTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface DeepSeekUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

export interface DeepSeekRequest {
	model: string;
	messages: DeepSeekMessage[];
	stream: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	tools?: DeepSeekTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	thinking?: { type: 'enabled' | 'disabled' };
	reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	stream_options?: {
		include_usage: boolean;
	};
}

// ---- Responses API request/response types ----

export interface ResponsesInputTextPart {
	type: 'input_text';
	text: string;
}

export interface ResponsesInputImagePart {
	type: 'input_image';
	image_url?: string;
	file_id?: string;
	detail?: 'low' | 'high' | 'original' | 'auto';
}

export interface ResponsesInputMessage {
	role: 'user' | 'assistant' | 'system';
	content: Array<ResponsesInputTextPart | ResponsesInputImagePart>;
}

export interface ResponsesFunctionTool {
	type: 'function';
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
	strict?: boolean;
}

export interface ResponsesRequest {
	model: string;
	input: ResponsesInputMessage[];
	stream: boolean;
	max_output_tokens?: number;
	tools?: ResponsesFunctionTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	reasoning?: {
		effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	};
}

export interface ResponsesUsage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details?: {
		cached_tokens?: number;
	};
}

export interface ResponsesFunctionCallItem {
	type: 'function_call';
	id: string;
	call_id?: string;
	name: string;
	arguments: string;
	status?: string;
}

export interface ResponsesStreamEvent {
	type: string;
	delta?: string;
	item_id?: string;
	output_index?: number;
	item?: ResponsesFunctionCallItem;
	response?: {
		usage?: ResponsesUsage | null;
	};
}

// ---- Stream callbacks ----

export interface StreamCallbacks {
	onContent: (content: string) => void;
	onThinking: (text: string) => void;
	onToolCall: (toolCall: DeepSeekToolCall) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: DeepSeekUsage) => void;
}

// ---- Model definitions ----

export interface ModelDefinition {
	id: string;
	name: string;
	family: string;
	version: string;
	detail: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean | number;
		imageInput: boolean;
		thinking: boolean;
	};
	requiresThinkingParam: boolean;
}

