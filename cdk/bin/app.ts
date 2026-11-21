#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { IdpStack } from '../lib/idp-stack';

const app = new cdk.App();
new IdpStack(app, 'PrivateCaIdp', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'ap-northeast-1' },
});
