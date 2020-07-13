import { Route53 } from 'aws-sdk';
import { wait } from '../async';

export type HostedZone = Route53.GetHostedZoneResponse;

/**
 * Wrapper class for Amazon S3 operations with a reactive interface.
 */
export class AmazonRoute53 {

    private route53 = new Route53({
        region: this.region,
        apiVersion: '2013-04-01',
        maxRetries: 20,
    });

    constructor(private region: string) { }

    /**
     * Creates a hosted zone for the given domain, e.g `example.com`
     * It should *not* end with the dot.
     *
     * The function waits until the hosted zone has been created and
     * applied to all Amazon Route 53 DNS servers.
     */
    public async createHostedZone(domain: string): Promise<HostedZone> {
        // Ensure that the hosted zone name ends with a dot
        const Name = domain.replace(/\.?$/, '.');
        const CallerReference = new Date().toISOString();
        const creationResult = await this.route53.createHostedZone({Name, CallerReference}).promise();
        let change = creationResult.ChangeInfo;
        while (change.Status !== 'INSYNC') {
            // Wait for a while
            await wait(1000);            const changeResult = await this.route53.getChange({Id: change.Id}).promise();
            change = changeResult.ChangeInfo;
        }
        // Return all the information about the hosted zone
        return await this.route53.getHostedZone({Id: creationResult.HostedZone.Id}).promise();
    }

    /**
     * Gets a hosted zone informatino for the given domain, e.g `example.com`.
     * It should *not* end with the dot.
     *
     * Fails if the hosted zone with that domain does not exist.
     */
    public async getHostedZone(domain: string): Promise<HostedZone> {
        const DNSName = domain.replace(/\.?$/, '.');
        const {HostedZones} = await this.route53.listHostedZonesByName({DNSName, MaxItems: '1'}).promise();
        const zone = HostedZones[0];
        if (!zone || zone.Name !== DNSName) {
            throw new Error(`Hosted zone does not exist`);
        }
        // Return all the information about the hosted zone
        return await this.route53.getHostedZone({Id: zone.Id}).promise();
    }
}
