/** API 统一错误：`{ error: { code, message } }`。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers?: Record<string, string>;
  constructor(status: number, code: string, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (code: string, message: string): ApiError => new ApiError(400, code, message);
