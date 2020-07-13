interface ARN {
    service: string;
    region: string;
    accountId: string;
    resource: string;
    resourceType: string;
    resourceId: string;
}

/**
 * Parses a Amazon Resource Name (ARN) into components.
 */
export function parseARN(arn: string): ARN {
    const [, , service, region, accountId, resource] = arn.split(':', 6);
    const [resourceType, resourceId] = resource.split(/[:/]/g, 2);
    return {service, region, accountId, resource, resourceType, resourceId};
}
