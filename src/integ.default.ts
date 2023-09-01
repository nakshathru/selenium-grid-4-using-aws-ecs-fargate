import { App, Stack } from 'aws-cdk-lib';
import { SeleniumGridConstruct } from './index';

const app = new App();
const env = {
  region: process.env.CDK_DEFAULT_REGION,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

const stack = new Stack(app, 'dentalxchage-qa-automation-stack', { env });

new SeleniumGridConstruct(stack, 'DentalXChangeSeleniumCluster', {
  cpu: 1024,
  memory: 2048,
  seleniumNodeMaxInstances: 100,
  seleniumNodeMaxSessions: 100,
  minInstances: 1,
  maxInstances: 10,
});
