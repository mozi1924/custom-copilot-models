// Conservative default cap used when host metadata does not provide an explicit
// tool-calling limit.
export const DEFAULT_TOOLS_LIMIT = 128;

export const ACTIVATE_TOOL_PREFIX = 'activate_';
export const PREFLIGHT_ACTIVATE_CALL_ID_PREFIX = 'responses_preflight_activate_';
export const MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST = 3;

export const TOOL_DRIFT_NOTICE_START = '[responses-copilot-tool-drift-notice-start]: #';
export const TOOL_DRIFT_NOTICE_END = '[responses-copilot-tool-drift-notice-end]: #';
