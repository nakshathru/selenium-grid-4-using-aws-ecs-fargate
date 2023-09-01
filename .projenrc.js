const { AwsCdkConstructLibrary } = require('projen');

const project = new AwsCdkConstructLibrary({
  author: 'Nakshathru Ajay',
  authorAddress: 'nakshathru@gmail.com',
  cdkVersion: '2.93.0',
  name: 'selenium-grid-4-ecs',
  repositoryUrl: 'https://github.com/nakshathru/selenium-grid-4-using-aws-ecs-fargate.git',
  cdkDependencies: [
    'aws-cdk-lib',
    'constructs'
  ],
});

project.synth();
