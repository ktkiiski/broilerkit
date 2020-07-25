import type { TriggerHandler } from './triggers';

export type ACL = 'private' | 'public-read';

interface BucketConfig {
    access: ACL;
}

interface StorageCreateEvent {
    key: string;
}

type StorageEventHandler = TriggerHandler<StorageCreateEvent>;

export interface BucketFileCreateTrigger {
    sourceType: 'storage';
    bucket: Bucket;
    eventName: 'create';
    handler: StorageEventHandler;
}

export class Bucket {
    constructor(public readonly name: string, public readonly access: ACL) {}

    public on(eventName: 'create', handler: StorageEventHandler): BucketFileCreateTrigger {
        return {
            sourceType: 'storage',
            bucket: this,
            eventName,
            handler,
        };
    }
}

export function bucket(name: string, config: BucketConfig): Bucket {
    return new Bucket(name, config.access);
}
