import { CloudWatchLogs } from 'aws-sdk';
import { mergeAsync, toArray, wait } from '../async';
import { indent, stripPrefix } from '../utils/strings';
import { retrievePages } from './utils';

import chalk from 'chalk';

import * as YAML from 'yamljs';

export interface LogStreamOptions {
    logGroupName: string;
    startTime: number;
    follow: boolean;
    maxCount?: number;
}

export interface MultiLogStreamOptions {
    logGroupNames: string[];
    startTime: number;
    follow: boolean;
    maxCount?: number;
}

export interface LogEvent {
    /**
     * The name of the log stream this event belongs to.
     */
    logStreamName: string;
    /**
     * The name of the log group this event belongs to.
     */
    logGroupName: string;
    /**
     * The time the event occurred, expressed as the number of milliseconds after Jan 1, 1970 00:00:00 UTC.
     */
    timestamp: number;
    /**
     * The data contained in the log event.
     */
    message: string;
    /**
     * The time the event was ingested, expressed as the number of milliseconds after Jan 1, 1970 00:00:00 UTC.
     */
    ingestionTime: number;
    /**
     * The ID of the event.
     */
    eventId: string;
}

/**
 * Wrapper class for Amazon S3 operations with a reactive interface.
 */
export class AmazonCloudWatch {

    private cloudWatch = new CloudWatchLogs({
        region: this.region,
        apiVersion: '2014-03-28',
    });

    constructor(private region: string) { }

    public async *streamLogGroups(options: MultiLogStreamOptions): AsyncIterableIterator<LogEvent> {
        // First stream everything got so far
        const {logGroupNames, follow} = options;
        let {maxCount = Infinity, startTime} = options;
        if (maxCount <= 0) {
            return;
        }
        const eventIterators = logGroupNames.map(
            (logGroupName) => this.iterateLogEvents({logGroupName, maxCount, startTime}),
        );
        const oldEvents = await toArray(mergeAsync(...eventIterators));
        // TODO: Could do merge sort for the iterators for better performance for large log groups
        const sortedEvents = oldEvents.sort((a, b) => a.timestamp - b.timestamp);
        for (const event of sortedEvents) {
            yield event;
            maxCount --;
            if (maxCount <= 0) {
                return;
            }
            startTime = event.timestamp + 1;
        }
        // Follow if enabled
        while (follow) {
            const iterator = this.streamLogGroups({logGroupNames, startTime, maxCount, follow: false});
            for await (const event of iterator) {
                yield event;
                maxCount --;
                if (maxCount <= 0) {
                    return;
                }
                startTime = event.timestamp + 1;
            }
            // Wait for a while before polling more
            await wait(1000);
        }
    }

    public async *iterateLogEvents(options: {logGroupName: string, startTime: number, maxCount?: number}) {
        const {logGroupName, startTime} = options;
        let {maxCount = Infinity} = options;
        const request = this.cloudWatch.filterLogEvents({
            logGroupName, startTime,
            interleaved: true,
        });
        for await (const page of retrievePages(request, 'events')) {
            if (!page) {
                continue;
            }
            for (const event of page) {
                yield {...event, logGroupName} as LogEvent;
                maxCount --;
                // Stop if yielded max number of events
                if (maxCount <= 0) {
                    return;
                }
            }
        }
    }
}

/**
 * Formats the given log event as a pretty, colorized, printable message string.
 */
export function formatLogEvent(event: LogEvent, stackName?: string) {
    const timestamp = new Date(event.timestamp).toISOString();
    const groupName = event.logGroupName.replace(/^\/aws\/lambda\//, '');
    const functionName = stackName && stripPrefix(groupName, `${stackName}-`) || groupName;
    const message = event.message.trim().replace(/\t+(\{\"[^\t]+\})$/, (match, encodedJson) => {
        let obj: any;
        try {
            obj = JSON.parse(encodedJson);
        } catch {
            // Wasn't valid JSON after all. Return as it was.
            return match;
        }
        const prettified = YAML.stringify(obj, 4, 2).replace(/^(\s*)(\w+):/gm, (_, indentation, attr) => {
            const color = /^(error\w+|stackTrace)$/i.test(attr) ? chalk.red : chalk.dim;
            return `${indentation}${color(attr)}:`;
        });
        return '\n' + indent(prettified.trimRight(), 2);
    });
    return `${chalk.dim(`${timestamp}:`)} ${chalk.cyan(functionName)} ${message}`;
}
