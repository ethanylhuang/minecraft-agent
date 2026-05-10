import type { StructuredError, ToolResult } from "./types.js";

export function structuredError(
  code: string,
  message: string,
  retryable = true,
  details?: unknown,
): StructuredError {
  return { code, message, retryable, details };
}

export function failedResult(
  code: string,
  message: string,
  retryable = true,
  details?: unknown,
): ToolResult {
  return {
    ok: false,
    message,
    error: structuredError(code, message, retryable, details),
  };
}

export function okResult(message: string, data?: unknown): ToolResult {
  return { ok: true, message, data };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
