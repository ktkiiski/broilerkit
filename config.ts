import type { AppStageConfig } from './index';

export interface BroilerConfig extends AppStageConfig {
    /**
     * The name of the stack when deployed to AWS CloudFormation.
     * This will also act as an unique name of the app stage.
     */
    stackName: string;
    /**
     * Directory where the stage-specific files are stored,
     * relative to the project root path.
     */
    stageDir: string;
    /**
     * Directory where the compiled bundle files are stored,
     * relative to the project root path.
     */
    buildDir: string;
}
