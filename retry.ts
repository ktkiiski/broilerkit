/* eslint-disable @typescript-eslint/no-explicit-any */
import { wait } from './async';
import { HttpErrorStatus, HttpStatus, isErrorResponse } from './http';

const retryableStatusCodes: HttpErrorStatus[] = [
    HttpStatus.ServiceUnavailable,
    HttpStatus.RequestTimeout,
    HttpStatus.TooManyRequests,
    HttpStatus.GatewayTimeout,
];

/**
 * Executes the given (async) function, running it again if it
 * throws an exception. The retry attempts are delayed with an
 * exponential backoff mechanism with automatically calculated
 * duration. Retrying is done maximum of the given number of times.
 * You can optionally provide a callback that is called on error
 * with the error. If it returns false, then no retry is made.
 * @param maxRetryCount Maximum number of retry attempts
 * @param fn The function to execute
 */
export async function retryWithBackoff<T>(maxRetryCount: number, fn: (retryCount: number) => Promise<T>, retryCheck?: (error: any, retryCount: number) => boolean): Promise<T> {
    let retryCount = 0;
    const startTime = new Date().getTime();
    for (;;) {
        try {
            return await fn(retryCount);
        } catch (error) {
            if (retryCount >= maxRetryCount) {
                // No more retries or not retryable error
                throw error;
            }
            if (retryCheck && !retryCheck(error, retryCount)) {
                // Not a retryable status code
                throw error;
            }
            // Retry
            retryCount += 1;
            // Wait for a random portion of the total time spent
            await wait(getRetryDelay(startTime));
        }
    }
}

/**
 * Executes the given (async) function, running it again if it
 * throws an exception that represents a retryable HTTP error status.
 * The retry attempts are delayed with an exponential backoff mechanism
 * with automatically calculated duration. Retrying is done maximum
 * of the given number of times.
 * @param maxRetryCount Maximum number of retry attempts
 * @param fn The function to execute
 */
export async function retryRequestWithBackoff<T>(maxRetryCount: number, fn: (retryCount: number) => Promise<T>, statusCodes = retryableStatusCodes): Promise<T> {
    let retryCount = 0;
    const startTime = new Date().getTime();
    for (;;) {
        try {
            return await fn(retryCount);
        } catch (error) {
            if (retryCount >= maxRetryCount || !isErrorResponse(error)) {
                // No more retries or not retryable error
                throw error;
            }
            const { statusCode } = error;
            if (statusCodes.indexOf(statusCode as HttpErrorStatus) < 0) {
                // Not a retryable status code
                throw error;
            }
            // Retry
            const { 'Retry-After': retryAfters } = error.headers;
            const retryAfter = Array.isArray(retryAfters) ? retryAfters[0] : retryAfters;
            retryCount += 1;
            // Wait for a random portion of the total time spent
            await wait(getRetryDelay(startTime, retryAfter));
        }
    }
}

function getRetryDelay(startTime: number, retryAfter?: string): number {
    const now = new Date().getTime();
    if (retryAfter) {
        if (/^\d+(\.\d+)?$/.test(retryAfter)) {
            // Retry-After represents a floating point number.
            // Interprete as seconds
            const retryDelay = parseFloat(retryAfter);
            if (!Number.isNaN(retryDelay)) {
                return Math.max(0, retryDelay * 1000);
            }
        }
        // Otherwise parse as a date/time string
        const retryTimestamp = new Date(retryAfter).getTime();
        if (!Number.isNaN(retryTimestamp)) {
            // Retry-After is a valid date/time
            return Math.max(0, now - retryTimestamp);
        }
    }
    // Otherwise get a random portion from the duration passed so far
    const totalDuration = now - startTime;
    return Math.floor(Math.random() * totalDuration);
}

/**
 * Utility for performing an action and possibly retrying it.
 * If the function throws an error, the given function is called
 * to check whether to retry the action or to pass through the error.
 * @param fn Function that will be executed as many times necessary
 * @param shouldRetry Function that returns whether retry
 */
export async function retry<T>(fn: (retryCount: number) => Promise<T>, shouldRetry: (error: any, retryCount: number) => boolean): Promise<T> {
    let retryCount = 0;
    for (;;) {
        try {
            return await fn(retryCount);
        } catch (error) {
            retryCount += 1;
            if (!shouldRetry(error, retryCount)) {
                // Pass the error through
                throw error;
            }
        }
    }
}

const conflictStatusCodes = [
    HttpStatus.PreconditionFailed,
    HttpStatus.Conflict,
];

/**
 * Utility for performing a simple conditional update using
 * the given function. The function will be run again whenever
 * it raises a 409 or 412 or error.
 * @param fn Function that performs a "transaction"
 */
export async function retryOptimistically<T>(fn: (retryCount: number) => Promise<T>, statusCodes = conflictStatusCodes): Promise<T> {
    return retry(fn, (error) => {
        if (isErrorResponse(error)) {
            const { statusCode } = error;
            if (statusCodes.indexOf(statusCode) >= 0) {
                // There was a conflict. Try again.
                return true;
            }
        }
        // Pass the error through
        return false;
    });
}
