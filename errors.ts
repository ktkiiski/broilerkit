import { ApiResponse, HttpStatus, isResponse } from './http';

export interface ErrorData {
    message: string;
    errors?: ErrorList;
}

type ErrorList = KeyErrorData<string>[] | KeyErrorData<number>[];

export interface KeyErrorData<T> extends ErrorData {
    key: T;
}

export class ValidationError extends Error implements ApiResponse<ErrorData> {
    public readonly headers = {};
    public readonly statusCode = HttpStatus.BadRequest;
    public readonly data: ErrorData;
    constructor(message: string, public readonly errors?: ErrorList) {
        super(message);
        this.data = { message };
        if (errors) {
            this.data.errors = errors;
        }
    }
}

export async function catchNotFound<T>(promise: Promise<T>): Promise<T | null> {
    try {
        return await promise;
    } catch (error) {
        if (isResponse(error, HttpStatus.NotFound)) {
            return null;
        }
        throw error;
    }
}
