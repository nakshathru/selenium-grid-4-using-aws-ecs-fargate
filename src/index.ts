

import { CfnOutput, Duration } from 'aws-cdk-lib';
import { AdjustmentType, ScalableTarget, ServiceNamespace } from 'aws-cdk-lib/aws-applicationautoscaling';
import { Metric } from 'aws-cdk-lib/aws-cloudwatch';
import { IVpc, Peer, Port, SecurityGroup, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AwsLogDriver, CfnCluster, Cluster, ContainerImage, FargateService, FargateTaskDefinition, ListenerConfig, Protocol } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { NamespaceType } from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';


// Customizable construct inputs
export interface ISeleniumGridProps {
  // VPC
  readonly vpc?: IVpc;

  // Selenium version to pull in, ex:3.141.59
  readonly seleniumVersion?: string;

  // Memory settings for hub and chrome fargate nodes, ex: 512
  readonly memory?: number;

  // CPU settings for hub and chrome fargate nodes, ex: 256
  readonly cpu?: number;

  // Selenium NODE_MAX_INSTANCES pointing to number of instances of same version of browser that can run in node, ex: 5
  readonly seleniumNodeMaxInstances?: number;

  // Selenium NODE_MAX_SESSION pointing to number of browsers (Any browser and version) that can run in parallel at a time in node, ex: 5
  readonly seleniumNodeMaxSessions?: number;

  // Auto-scale minimum number of instances
  readonly minInstances?: number;

  // Auto-scale maximum number of instances
  readonly maxInstances?: number;
}

export interface IResourceDefinitionProps{
  cluster: Cluster;
  stack: Construct;
  loadBalancer: ApplicationLoadBalancer;
  securityGroup: SecurityGroup;
  identifier: string;
  minInstances: number;
  maxInstances: number;
}

export interface IServiceDefinitionProps{
  resource: IResourceDefinitionProps;
  image: string;
  healthCheckPeriod?: number;
  env: {[key: string]: string};
  readonly entryPoint?: string[];
  readonly command?: string[];
}

export interface IScalingPolicyDefinitionProps{
  stack: Construct;
  serviceName: string;
  clusterName: string;
  identifier: string;
  minInstances: number;
  maxInstances: number;
}

export class SeleniumGridConstruct extends Construct {

  readonly vpc: IVpc;
  readonly seleniumVersion: string;
  readonly memory: number;
  readonly cpu: number;
  readonly seleniumNodeMaxInstances: number;
  readonly seleniumNodeMaxSessions: number;
  readonly minInstances: number;
  readonly maxInstances: number;

  constructor(scope: Construct, id: string, props: ISeleniumGridProps = {}) {
    super(scope, id);

    // Create new VPC if it doesnt exist
    const getExistingVpc = Vpc.fromLookup(this, 'ImportVPC', { isDefault: false, vpcId: 'vpc-0c22a4472f6bddf04' });

    this.vpc = getExistingVpc ?? new Vpc(this, 'Vpc', { natGateways: 1 });
    this.seleniumVersion = props.seleniumVersion ?? 'latest';
    this.memory = props.memory ?? 512;
    this.cpu = props.cpu ?? 256;
    this.seleniumNodeMaxInstances = props.seleniumNodeMaxInstances ?? 5;
    this.seleniumNodeMaxSessions = props.seleniumNodeMaxSessions ?? 5;
    this.minInstances = props.minInstances ?? 1;
    this.maxInstances = props.maxInstances ?? 10;

    // Cluster
    const cluster = new Cluster(this, 'cluster', {
      vpc: this.vpc,
      containerInsights: true,
      clusterName: 'dentalxchange-selenium',
      defaultCloudMapNamespace: {
        name: 'dentalx-selenium-grid',
        type: NamespaceType.HTTP,
      },
    });

    // Setup capacity providers and default strategy for cluster
    const cfnEcsCluster = cluster.node.defaultChild as CfnCluster;
    cfnEcsCluster.capacityProviders = ['FARGATE', 'FARGATE_SPOT'];
    cfnEcsCluster.defaultCapacityProviderStrategy = [{
      capacityProvider: 'FARGATE',
      weight: 1,
      base: 4,
    }, {
      capacityProvider: 'FARGATE_SPOT',
      weight: 4,
    }];

    // Create security group and add inbound and outbound traffic ports
    var securityGroup = new SecurityGroup(this, 'dentalxchange-selenium-sg', {
      vpc: cluster.vpc,
      allowAllOutbound: true,
    });

    // Open up port 4444 and 5555 for execution
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(4444), 'Port 4444 for inbound traffic');
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(5555), 'Port 5555 for inbound traffic');
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(4442), 'Port 4442 for inbound traffic');
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(4443), 'Port 4443 for inbound traffic');
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'Port 80 for inbound traffic');

    // Setup Load balancer & register targets
    var loadBalancer = new ApplicationLoadBalancer(this, 'dentalxchange-selenium-alb', {
      vpc: this.vpc,
      internetFacing: true,
    });
    loadBalancer.addSecurityGroup(securityGroup);

    // Register SeleniumHub resources
    this.createHubResources({
      cluster: cluster,
      identifier: 'hub',
      loadBalancer: loadBalancer,
      securityGroup: securityGroup,
      stack: this,
      maxInstances: this.maxInstances,
      minInstances: this.minInstances,

    });

    // Register Chrome node resources
    this.createBrowserResource({
      cluster: cluster,
      identifier: 'chrome',
      loadBalancer: loadBalancer,
      securityGroup: securityGroup,
      stack: this,
      maxInstances: this.maxInstances,
      minInstances: this.minInstances,
    }, 'selenium/node-chrome');

    // Register Firefox node resources
    // this.createBrowserResource({
    //   cluster: cluster,
    //   identifier: 'firefox',
    //   loadBalancer: loadBalancer,
    //   securityGroup: securityGroup,
    //   stack: this,
    //   maxInstances: this.maxInstances,
    //   minInstances: this.minInstances
    // }, 'selenium/node-firefox');

    new CfnOutput(this, 'LoadBalancerDNS', {
      exportName: 'DentalXChange-Selenium-Hub-DNS',
      value: loadBalancer.loadBalancerDnsName,
    });
  }

  createHubResources(options: IResourceDefinitionProps) {
    var service = this.createService({
      resource: options,
      env: {
        SE_OPTS: '--log-level FINE',
      },
      image: 'selenium/hub:'+this.seleniumVersion,
      healthCheckPeriod: 300,
    });

    // Create autoscaling policy
    this.createScalingPolicy({
      clusterName: options.cluster.clusterName,
      serviceName: service.serviceName,
      identifier: options.identifier,
      stack: options.stack,
      minInstances: options.minInstances,
      maxInstances: options.maxInstances,
    });

    // Default target routing for 4444 so webdriver client can connect to
    const listener80 = options.loadBalancer.addListener('Listener80', { port: 80, protocol: ApplicationProtocol.HTTP });
    service.registerLoadBalancerTargets(
      {
        containerName: 'selenium-hub-container',
        containerPort: 4444,
        newTargetGroupId: 'ECS',
        protocol: Protocol.TCP,
        listener: ListenerConfig.applicationListener(listener80, {
          protocol: ApplicationProtocol.HTTP,
          port: 80,
          targets: [service],
          healthCheck: {
            path: '/status',
            interval: Duration.seconds(120),
            port: '4444',
          },
        }),
      },
    );
  }

  createBrowserResource(options: IResourceDefinitionProps, image: string) {

    // Env parameters configured to connect back to selenium hub when new nodes gets added
    var service = this.createService({
      resource: options,
      env: {
        SE_EVENT_BUS_HOST: 'dentalx-se-hub',
        SE_EVENT_BUS_PUBLISH_PORT: '4442',
        SE_EVENT_BUS_SUBSCRIBE_PORT: '4443',
        NODE_MAX_INSTANCES: this.seleniumNodeMaxInstances.toString(),
        NODE_MAX_SESSION: this.seleniumNodeMaxSessions.toString(),
        SE_OPTS: '--log-level FINE',
      },
      image: image+':'+this.seleniumVersion,
      entryPoint: ['sh', '-c'],
      command: ["PRIVATE=$(curl -s http://169.254.170.2/v2/metadata | jq -r '.Containers[0].Networks[0].IPv4Addresses[0]') ; export SE_OPTS=\"--host $PRIVATE\" ; /opt/bin/entry_point.sh"],
    });

    // Create autoscaling policy
    this.createScalingPolicy({
      clusterName: options.cluster.clusterName,
      serviceName: service.serviceName,
      identifier: options.identifier,
      stack: options.stack,
      minInstances: options.minInstances,
      maxInstances: options.maxInstances,
    });
  }

  createService(options: IServiceDefinitionProps): FargateService {
    const stack = options.resource.stack;
    const identiifer = options.resource.identifier;
    const cluster = options.resource.cluster;
    const securityGroup = options.resource.securityGroup;

    // Task and container definition
    const taskDefinition = new FargateTaskDefinition(stack, 'dentalx-selenium-'+identiifer+'-task-def', {
      memoryLimitMiB: this.memory,
      cpu: this.cpu,
    });
    const containerDefinition = taskDefinition.addContainer('selenium-'+identiifer+'-container', {
      image: ContainerImage.fromRegistry(options.image),
      memoryLimitMiB: this.memory,
      cpu: this.cpu,
      environment: options.env,
      essential: true,
      logging: new AwsLogDriver({
        streamPrefix: 'selenium-'+identiifer+'-logs',
      }),
      entryPoint: options.entryPoint,
      command: options.command,
    });

    if (options.healthCheckPeriod) {
      containerDefinition.addPortMappings({
        containerPort: 4444,
        hostPort: 4444,
        protocol: Protocol.TCP,
      },
      {
        containerPort: 4443,
        hostPort: 4443,
        protocol: Protocol.TCP,
      },
      {
        containerPort: 4442,
        hostPort: 4442,
        protocol: Protocol.TCP,
      });
    } else {
      containerDefinition.addPortMappings({
        containerPort: 5555,
        hostPort: 5555,
        protocol: Protocol.TCP,
      });
    }


    // Setup Fargate service
    return new FargateService(stack, 'dentalx-selenium-'+identiifer+'-service', {
      cluster: cluster,
      taskDefinition: taskDefinition,
      minHealthyPercent: 75,
      maxHealthyPercent: 100,
      securityGroups: [securityGroup],
      enableExecuteCommand: true,
      desiredCount: 1,
      assignPublicIp: false,
      healthCheckGracePeriod: options.healthCheckPeriod?Duration.seconds(options.healthCheckPeriod):undefined,
    });
  }

  createScalingPolicy(options: IScalingPolicyDefinitionProps) {
    const serviceName = options.serviceName;
    const clusterName = options.clusterName;
    const identifier = options.identifier;
    const stack = options.stack;

    // Scaling set on ECS service level
    const target = new ScalableTarget(stack, 'selenium-scalableTarget-'+identifier, {
      serviceNamespace: ServiceNamespace.ECS,
      maxCapacity: options.maxInstances,
      minCapacity: options.minInstances,
      resourceId: 'service/'+clusterName+'/'+serviceName,
      scalableDimension: 'ecs:service:DesiredCount',
    });

    // Metrics to listen
    const workerUtilizationMetric = new Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      statistic: 'max',
      period: Duration.seconds(10),
      dimensionsMap: {
        ClusterName: clusterName,
        ServiceName: serviceName,
      },
    });

    // Define Scaling policies (scale-in and scale-out)
    // Remove one instance if CPUUtilization is less than 30%,
    // Add three instance if the CPUUtilization is greater than 70%
    target.scaleOnMetric('step-metric-scaling-'+identifier, {
      metric: workerUtilizationMetric,
      adjustmentType: AdjustmentType.CHANGE_IN_CAPACITY,
      scalingSteps: [
        { upper: 30, change: -1 },
        { lower: 80, change: +3 },
      ],
      cooldown: Duration.seconds(180),
    });
  }
}