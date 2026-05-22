import type { CancellationToken } from 'vscode';
import { safeStringify } from './json';
import { logger } from './logger';
import type {
	DeepSeekToolCall,
	DeepSeekUsage,
	ResponsesRequest,
	ResponsesStreamEvent,
	StreamCallbacks,
} from './types';

/**
 * Lightweight SSE-streaming Responses API client.
 * No external dependencies - uses Node's built-in fetch.
 */
export class ResponsesClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
	) {}

	async streamResponse(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
		}

		try {
			const response = await fetch(`${this.baseUrl}/responses`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: safeStringify(request),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				let errorMessage: string;
				try {
					const errorJson = JSON.parse(errorText);
					errorMessage = errorJson.error?.message || errorJson.message || errorText;
				} catch {
					errorMessage = errorText;
				}
				throw new Error(`Responses API error (${response.status}): ${errorMessage}`);
			}

			if (!response.body) {
				throw new Error('No response body received');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			const pendingToolCalls = new Map<string, DeepSeekToolCall>();
			const emittedToolCallItemIds = new Set<string>();

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					return;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data: ')) {
						continue;
					}

					const jsonStr = trimmed.slice(6);
					try {
						const event = JSON.parse(jsonStr) as ResponsesStreamEvent;
						this.handleEvent(event, pendingToolCalls, emittedToolCallItemIds, callbacks);
						if (event.type === 'response.completed') {
							// Some gateways may skip function_call_arguments.done and only keep
							// the latest function_call state in output_item events.
							for (const [itemId, pending] of pendingToolCalls) {
								if (!emittedToolCallItemIds.has(itemId)) {
									callbacks.onToolCall(pending);
									emittedToolCallItemIds.add(itemId);
								}
							}
							callbacks.onDone();
							return;
						}
					} catch (error) {
						logger.error('Failed to parse Responses SSE chunk:', jsonStr.slice(0, 200), error);
					}
				}
			}

			callbacks.onDone();
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			callbacks.onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			cancelListener?.dispose();
		}
	}

	private handleEvent(
		event: ResponsesStreamEvent,
		pendingToolCalls: Map<string, DeepSeekToolCall>,
		emittedToolCallItemIds: Set<string>,
		callbacks: StreamCallbacks,
	): void {
		switch (event.type) {
			case 'response.output_text.delta': {
				if (event.delta) {
					callbacks.onContent(event.delta);
				}
				break;
			}
			case 'response.output_item.added': {
				const item = event.item;
				if (!item || item.type !== 'function_call') {
					break;
				}
				pendingToolCalls.set(item.id, {
					id: item.call_id || item.id,
					call_id: item.call_id,
					type: 'function',
					function: {
						name: item.name ?? '',
						arguments: item.arguments ?? '',
					},
				});
				break;
			}
			case 'response.function_call_arguments.delta': {
				if (!event.item_id || !event.delta) {
					break;
				}
				const pending = pendingToolCalls.get(event.item_id);
				if (pending) {
					pending.function.arguments += event.delta;
				}
				break;
			}
			case 'response.function_call_arguments.done': {
				const item = event.item;
				if (!item || item.type !== 'function_call') {
					break;
				}
				this.emitToolCallFromItem(
					item,
					pendingToolCalls,
					emittedToolCallItemIds,
					callbacks,
				);
				break;
			}
			case 'response.output_item.done': {
				const item = event.item;
				if (!item || item.type !== 'function_call') {
					break;
				}
				// Some gateways emit function calls only in output_item.done.
				this.emitToolCallFromItem(
					item,
					pendingToolCalls,
					emittedToolCallItemIds,
					callbacks,
				);
				break;
			}
			case 'response.completed': {
				const usage = event.response?.usage;
				if (usage && callbacks.onUsage) {
					callbacks.onUsage(mapResponsesUsage(usage));
				}
				break;
			}
			default:
				break;
		}
	}

	private emitToolCallFromItem(
		item: {
			id: string;
			call_id?: string;
			name: string;
			arguments: string;
		},
		pendingToolCalls: Map<string, DeepSeekToolCall>,
		emittedToolCallItemIds: Set<string>,
		callbacks: StreamCallbacks,
	): void {
		if (emittedToolCallItemIds.has(item.id)) {
			return;
		}

		const pending = pendingToolCalls.get(item.id);
		const toolCall = pending ?? {
			id: item.call_id || item.id,
			call_id: item.call_id,
			type: 'function' as const,
			function: {
				name: item.name,
				arguments: item.arguments || '',
			},
		};
		if (!toolCall.function.name) {
			toolCall.function.name = item.name;
		}
		if (item.arguments) {
			toolCall.function.arguments = item.arguments;
		}
		callbacks.onToolCall(toolCall);
		emittedToolCallItemIds.add(item.id);
		pendingToolCalls.delete(item.id);
	}
}

function mapResponsesUsage(usage: {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	input_tokens_details?: { cached_tokens?: number };
}): DeepSeekUsage {
	return {
		prompt_tokens: usage.input_tokens,
		completion_tokens: usage.output_tokens,
		total_tokens: usage.total_tokens,
		prompt_cache_hit_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
