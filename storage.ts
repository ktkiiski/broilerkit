/**
 * This module provides convenient wrappers around local and session storage
 * that allow safe usage of storages even in cases where they are not supported
 * e.g. due to browser security settings.
 */

export class SafeStorage {
    private cache: {[key: string]: any} = {};
    constructor(private storage: Storage | undefined) {
        if (storage && typeof window !== 'undefined') {
            window.addEventListener('storage', ({storageArea, key, newValue}) => {
                if (storageArea === storage) {
                    if (key == null) {
                        this.cache = {};
                    } else {
                        this.cacheValue(key, newValue);
                    }
                }
            });
        }
    }
    public clear(): void {
        this.cache = {};
        if (this.storage) {
            try {
                this.storage.clear();
            } catch {
                // Ignore errors
            }
        }
    }
    public getItem(key: string): any | null {
        const {cache} = this;
        if (cache[key] != null) {
            return cache[key];
        }
        if (this.storage) {
            try {
                const encodedValue = this.storage.getItem(key);
                const value = encodedValue == null ? encodedValue : JSON.parse(encodedValue);
                this.cacheValue(key, value);
                return value;
            } catch {
                // Storage could not be read due to security settings
                // or the stored value is not valid JSON. Ignore this.
            }
        }
        return null;
    }
    public removeItem(key: string): void {
        delete this.cache[key];
        if (this.storage) {
            try {
                this.storage.removeItem(key);
            } catch {
                // Ignore errors
            }
        }
    }
    public setItem(key: string, value: any | undefined | null): void {
        this.cacheValue(key, value);
        if (this.storage) {
            try {
                if (value == null) {
                    this.storage.removeItem(key);
                } else {
                    this.storage.setItem(key, JSON.stringify(value));
                }
            } catch {
                // Ignore errors
            }
        }
    }
    private cacheValue(key: string, value: any) {
        if (value == null) {
            delete this.cache[key];
        } else {
            this.cache[key] = value;
        }
    }
}

export const localStorage = new SafeStorage(window.localStorage);
export const sessionStorage = new SafeStorage(window.sessionStorage);
