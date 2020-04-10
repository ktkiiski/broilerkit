import { BucketFileCreateTrigger } from './buckets';
import { executeHandler, Handler } from './handlers';
import { LambdaEvent } from './lambda';
import { ServerContext } from './server';

export type Trigger = BucketFileCreateTrigger;

export type TriggerHandler<I, O = void> = Handler<I, O, {}>;

export async function triggerEvent(triggers: Trigger[], { Records }: LambdaEvent, serverContext: ServerContext) {
    for (const event of Records) {
        for (const trigger of triggers) {
            if (trigger.sourceType === 'storage' && trigger.eventName === 'create') {
                if (/^ObjectCreated:/.test(event.eventName)) {
                    const { object, bucket } = event.s3;
                    const s3BucketName = `${serverContext.stackName}-storage-${trigger.bucket.name}`;
                    if (bucket.name === s3BucketName) {
                        try {
                            // TODO: Side-effects and real-time changes!
                            await executeHandler(
                                trigger.handler, object, { ...serverContext, effects: [] }, {},
                            );
                        } catch (error) {
                            // tslint:disable-next-line:no-console
                            console.error(`Failed to process event ${trigger.eventName} for bucket ${bucket.name}:`, error);
                        }
                    }
                }
            }
        }
    }
}
