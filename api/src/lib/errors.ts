export interface ErrorDetail {
  path?: string;
  message: string;
  [extra: string]: unknown;
}

/** Every non-2xx response is `{ error: { code, message, details? } }`. Throw this from anywhere. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: ErrorDetail[],
  ) {
    super(message);
  }
}

export const unauthorized = (message = "Authentication required") => new AppError(401, "UNAUTHENTICATED", message);
export const forbidden = (message = "You do not have access to this resource") => new AppError(403, "FORBIDDEN", message);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
export const badRequest = (code: string, message: string, details?: ErrorDetail[]) => new AppError(400, code, message, details);
export const conflict = (code: string, message: string, details?: ErrorDetail[]) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: ErrorDetail[]) => new AppError(422, code, message, details);
