import type { CancellationToken } from 'vscode';
import type { StreamingTransportMode } from './config';
import { safeStringify } from './json';
import { logger } from './logger';
import type {
	DeepSeekToolCall,
	DeepSeekUsage,
	ResponsesFunctionCallItem,
	ResponsesRequest,
	ResponsesStreamEvent,
	StreamCallbacks,
} from './types';
import WebSocket, { type RawData } from 'ws';

interface ReusableWebSocketSession {
	key: string;
	ws: WebSocket;
	ready: Promise<void>;
	createdAt: number;
	lastUsedAt: number;
	inFlight: boolean;
	closed: boolean;
}

const WS_SESSION_MAX_LIFETIME_MS = 55 * 60_000;
const WS_SESSION_IDLE_TTL_MS = 5 * 60_000;

/**
 * Responses API streaming client with dual transport:
 * WebSocket mode (preferred) with HTTP SSE fallback.
 */
export class ResponsesClient {
	private static readonly wsSessions = new Map<string, ReusableWebSocketSession>();

	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
	) {}

	async streamResponse(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
		transportMode: StreamingTransportMode = 'websocketPreferred',
		sessionKey?: string,
	): Promise<void> {
		if (transportMode === 'httpOnly') {
			await this.streamResponseHttp(request, callbacks, cancellationToken);
			return;
		}

		try {
			await this.streamResponseWebSocket(request, callbacks, cancellationToken, sessionKey);
			return;
		} catch (error) {
			if (transportMode === 'websocketOnly' || cancellationToken?.isCancellationRequested) {
				throw error;
			}
			logger.warn(
				'WebSocket mode failed; falling back to HTTP SSE',
				error instanceof Error ? error.message : String(error),
			);
		}

		await this.streamResponseHttp(request, callbacks, cancellationToken);
	}

	private async streamResponseHttp(
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

	private async streamResponseWebSocket(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
		sessionKey?: string,
	): Promise<void> {
		this.pruneWebSocketSessions();
		const wsUrl = toResponsesWebSocketUrl(this.baseUrl);
		const createPayload = createWebSocketCreatePayload(request);
		const session = this.getOrCreateWebSocketSession(wsUrl, sessionKey);

		await waitForWebSocketReady(session, cancellationToken);
		if (session.inFlight) {
			throw new Error('Responses WebSocket session is busy');
		}
		session.inFlight = true;
		session.lastUsedAt = Date.now();

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let completed = false;
			const pendingToolCalls = new Map<string, DeepSeekToolCall>();
			const emittedToolCallItemIds = new Set<string>();
			const ws = session.ws;
			let cleanupListeners = () => {};

			const settleResolve = () => {
				if (settled) {
					return;
				}
				settled = true;
				cleanupListeners();
				cancelListener?.dispose();
				session.inFlight = false;
				session.lastUsedAt = Date.now();
				resolve();
			};

			const settleReject = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanupListeners();
				cancelListener?.dispose();
				session.inFlight = false;
				safeCloseWebSocket(ws, 1011, 'error');
				reject(error);
			};

			const cancelListener = cancellationToken?.onCancellationRequested(() => {
				if (settled) {
					return;
				}
				safeCloseWebSocket(ws, 1000, 'cancelled');
				settleReject(createAbortError());
			});

			if (cancellationToken?.isCancellationRequested) {
				safeCloseWebSocket(ws, 1000, 'cancelled');
				settleReject(createAbortError());
				return;
			}

			const onMessage = (data: RawData) => {
				if (settled) {
					return;
				}
				try {
					const event = JSON.parse(rawDataToString(data)) as ResponsesStreamEvent;
					if (event.type === 'error') {
						settleReject(new Error(formatWebSocketEventError(event)));
						return;
					}

					this.handleEvent(event, pendingToolCalls, emittedToolCallItemIds, callbacks);
					if (event.type === 'response.completed') {
						flushPendingToolCalls(pendingToolCalls, emittedToolCallItemIds, callbacks);
						completed = true;
						callbacks.onDone();
						settleResolve();
					}
				} catch (error) {
					logger.error('Failed to parse Responses WebSocket event', error);
				}
			};

			const onClose = (code: number, reasonBuffer: Buffer) => {
				if (settled) {
					return;
				}
				if (cancellationToken?.isCancellationRequested || completed) {
					settleResolve();
					return;
				}
				const reason = bufferToString(reasonBuffer);
				settleReject(
					new Error(
						`Responses WebSocket closed before completion (code=${code}, reason=${reason || 'none'})`,
					),
				);
			};

			const onError = (error: Error) => {
				if (settled) {
					return;
				}
				settleReject(
					error instanceof Error ? error : new Error(`Responses WebSocket error: ${String(error)}`),
				);
			};

			ws.on('message', onMessage);
			ws.on('close', onClose);
			ws.on('error', onError);

			cleanupListeners = () => {
				ws.off('message', onMessage);
				ws.off('close', onClose);
				ws.off('error', onError);
			};

			ws.send(JSON.stringify(createPayload));
		});
	}

	private getOrCreateWebSocketSession(
		wsUrl: string,
		sessionKey?: string,
	): ReusableWebSocketSession {
		const key = `${wsUrl}|${this.apiKey}|${sessionKey ?? 'default'}`;
		const existing = ResponsesClient.wsSessions.get(key);
		if (existing && !existing.closed) {
			return existing;
		}

		const ws = new WebSocket(wsUrl, {
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
			},
		});

		const session: ReusableWebSocketSession = {
			key,
			ws,
			createdAt: Date.now(),
			lastUsedAt: Date.now(),
			inFlight: false,
			closed: false,
			ready: new Promise<void>((resolve, reject) => {
				ws.once('open', () => resolve());
				ws.once('error', (error: Error) =>
					reject(
						error instanceof Error
							? error
							: new Error(`Responses WebSocket open failed: ${String(error)}`),
					),
				);
			}),
		};

		ws.on('close', () => {
			session.closed = true;
			if (ResponsesClient.wsSessions.get(key) === session) {
				ResponsesClient.wsSessions.delete(key);
			}
		});

		ResponsesClient.wsSessions.set(key, session);
		return session;
	}

	private pruneWebSocketSessions(): void {
		const now = Date.now();
		for (const [key, session] of ResponsesClient.wsSessions) {
			if (session.inFlight) {
				continue;
			}
			const idle = now - session.lastUsedAt;
			const age = now - session.createdAt;
			if (session.closed || idle > WS_SESSION_IDLE_TTL_MS || age > WS_SESSION_MAX_LIFETIME_MS) {
				safeCloseWebSocket(session.ws, 1000, 'session-pruned');
				ResponsesClient.wsSessions.delete(key);
			}
		}
	}

	private handleEvent(
		event: ResponsesStreamEvent,
		pendingToolCalls: Map<string, DeepSeekToolCall>,
		emittedToolCallItemIds: Set<string>,
		callbacks: StreamCallbacks,
	): void {
		switch (event.type) {
			case 'response.created': {
				const responseId = event.response?.id;
				if (responseId && callbacks.onResponseId) {
					callbacks.onResponseId(responseId);
				}
				break;
			}
			case 'response.output_text.delta': {
				if (event.delta) {
					callbacks.onContent(event.delta);
				}
				break;
			}
			case 'response.output_item.added': {
				const item = event.item;
				if (!isFunctionCallItem(item)) {
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
				if (!isFunctionCallItem(item)) {
					break;
				}
				this.emitToolCallFromItem(item, pendingToolCalls, emittedToolCallItemIds, callbacks);
				break;
			}
			case 'response.output_item.done': {
				const item = event.item;
				if (!isFunctionCallItem(item)) {
					break;
				}
				// Some gateways emit function calls only in output_item.done.
				this.emitToolCallFromItem(item, pendingToolCalls, emittedToolCallItemIds, callbacks);
				break;
			}
			case 'response.completed': {
				const responseId = event.response?.id;
				if (responseId && callbacks.onResponseId) {
					callbacks.onResponseId(responseId);
				}
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

function isFunctionCallItem(item: unknown): item is ResponsesFunctionCallItem {
	return Boolean(
		item &&
		typeof item === 'object' &&
		(item as { type?: unknown }).type === 'function_call' &&
		typeof (item as { id?: unknown }).id === 'string',
	);
}

function createWebSocketCreatePayload(request: ResponsesRequest): Record<string, unknown> {
	return {
		type: 'response.create',
		...request,
		stream: true,
	};
}

function toResponsesWebSocketUrl(baseUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new Error(`Invalid base URL for WebSocket mode: ${baseUrl}`);
	}

	if (parsed.protocol === 'https:') {
		parsed.protocol = 'wss:';
	} else if (parsed.protocol === 'http:') {
		parsed.protocol = 'ws:';
	} else if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
		throw new Error(`Unsupported base URL protocol for WebSocket mode: ${parsed.protocol}`);
	}

	const path = parsed.pathname.replace(/\/+$/, '');
	parsed.pathname = `${path}/responses`;
	parsed.search = '';
	parsed.hash = '';
	return parsed.toString();
}

function rawDataToString(data: RawData): string {
	if (typeof data === 'string') {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8');
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString('utf8');
	}
	return data.toString('utf8');
}

function flushPendingToolCalls(
	pendingToolCalls: Map<string, DeepSeekToolCall>,
	emittedToolCallItemIds: Set<string>,
	callbacks: StreamCallbacks,
): void {
	for (const [itemId, pending] of pendingToolCalls) {
		if (!emittedToolCallItemIds.has(itemId)) {
			callbacks.onToolCall(pending);
			emittedToolCallItemIds.add(itemId);
		}
	}
}

function safeCloseWebSocket(ws: WebSocket, code: number, reason: string): void {
	if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
		return;
	}
	try {
		ws.close(code, reason);
	} catch {
		// ignore
	}
}

async function waitForWebSocketReady(
	session: ReusableWebSocketSession,
	cancellationToken?: CancellationToken,
): Promise<void> {
	if (session.closed || session.ws.readyState === WebSocket.CLOSED) {
		throw new Error('Responses WebSocket session is already closed');
	}
	if (session.ws.readyState === WebSocket.OPEN) {
		return;
	}
	if (cancellationToken?.isCancellationRequested) {
		throw createAbortError();
	}

	await Promise.race([
		session.ready,
		new Promise<never>((_, reject) => {
			const listener = cancellationToken?.onCancellationRequested(() => {
				listener?.dispose();
				reject(createAbortError());
			});
		}),
	]);
}

function bufferToString(value: Buffer | Uint8Array): string {
	if (!value || value.length === 0) {
		return '';
	}
	return Buffer.from(value).toString('utf8');
}

function formatWebSocketEventError(event: ResponsesStreamEvent): string {
	const code = event.error?.code;
	const message = event.error?.message ?? 'Unknown WebSocket error event';
	const status = event.status ? ` status=${event.status}` : '';
	return `Responses WebSocket event error:${status}${code ? ` code=${code}` : ''} message=${message}`;
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

function createAbortError(): Error {
	const error = new Error('Request cancelled');
	error.name = 'AbortError';
	return error;
}
