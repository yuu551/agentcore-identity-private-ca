import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

const ROOT = path.join(__dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(ROOT, 'certs', name), 'utf8');
const IDP_HOST = 'idp.internal.example.com';
// デプロイ前にAWS CLIで登録しておく、Keycloakのサーバー証明書の秘密鍵
const SERVER_KEY_SECRET = 'private-ca-demo/keycloak-server-key';
const KEYCLOAK_IMAGE = 'quay.io/keycloak/keycloak:26.8.2';

export class IdpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // パブリックサブネット（NAT用）と、Keycloakを置くプライベートサブネット
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // AgentCore Identity（VPC Lattice）が作るENIに付けるSG
    const latticeSg = new ec2.SecurityGroup(this, 'LatticeSg', { vpc, allowAllOutbound: true });

    // Keycloakは、リソースゲートウェイのENIからの443だけを受け付ける
    const idpSg = new ec2.SecurityGroup(this, 'IdpSg', { vpc, allowAllOutbound: true });
    idpSg.addIngressRule(latticeSg, ec2.Port.tcp(443));

    // Keycloakのクライアントシークレット
    const clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      secretName: 'private-ca-demo/keycloak-client-secret',
      generateSecretString: { excludePunctuation: true, passwordLength: 32 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Keycloakのサーバー証明書・レルム定義と、AgentCore Identityが参照するCA証明書のPEM（秘密鍵は置かない）
    const bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const serverFiles = new s3deploy.BucketDeployment(this, 'ServerFiles', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'server',
      sources: [
        s3deploy.Source.data('server.pem', read('server.pem')),
        s3deploy.Source.asset(path.join(ROOT, 'keycloak')),
      ],
    });
    new s3deploy.BucketDeployment(this, 'CaFiles', {
      destinationBucket: bucket,
      destinationKeyPrefix: 'ca',
      sources: [s3deploy.Source.data('private-ca.pem', read('ca.pem'))],
      prune: false,
    });

    // Keycloak（起動時にS3から証明書とレルム定義を、Secrets Managerから秘密鍵とクライアントシークレットを取得してHTTPSで起動する）
    const role = new iam.Role(this, 'IdpRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    bucket.grantRead(role, 'server/*');
    clientSecret.grantRead(role);
    const serverKey = secretsmanager.Secret.fromSecretNameV2(this, 'ServerKey', SERVER_KEY_SECRET);
    serverKey.grantRead(role);
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail', // -x を付けるとシークレットの値がcloud-initのログに残る
      'dnf install -y docker',
      'systemctl enable --now docker',
      'mkdir -p /opt/kc/tls /opt/kc/import',
      `aws s3 cp s3://${bucket.bucketName}/server/server.pem /opt/kc/tls/`,
      // umask 077 で最初から600の権限で作る（差し替えで上書きしても600のまま）
      `(umask 077; aws secretsmanager get-secret-value --region ${this.region} --secret-id ${SERVER_KEY_SECRET} --query SecretString --output text > /opt/kc/tls/server.key)`,
      `aws s3 cp s3://${bucket.bucketName}/server/realm-demo.json /opt/kc/import/`,
      'chown -R 1000:1000 /opt/kc',
      `SECRET=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id ${clientSecret.secretArn} --query SecretString --output text)`,
      [
        'docker run -d --name keycloak --restart always -p 443:8443',
        '-e KC_CLIENT_SECRET="$SECRET"',
        '-v /opt/kc/tls:/opt/keycloak/conf/tls:ro',
        '-v /opt/kc/import:/opt/keycloak/data/import:ro',
        KEYCLOAK_IMAGE,
        'start-dev --import-realm',
        `--hostname=https://${IDP_HOST}`,
        '--https-certificate-file=/opt/keycloak/conf/tls/server.pem',
        '--https-certificate-key-file=/opt/keycloak/conf/tls/server.key',
      ].join(' '),
    );
    const idp = new ec2.Instance(this, 'Keycloak', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, availabilityZones: [vpc.availabilityZones[0]] },
      instanceType: new ec2.InstanceType('t4g.medium'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: idpSg,
      role,
      userData,
    });
    idp.node.addDependency(serverFiles);

    // VPC内だけで名前解決できるドメイン
    const zone = new route53.PrivateHostedZone(this, 'Zone', { zoneName: 'internal.example.com', vpc });
    new route53.ARecord(this, 'IdpRecord', {
      zone,
      recordName: 'idp',
      target: route53.RecordTarget.fromIpAddresses(idp.instancePrivateIp),
      ttl: cdk.Duration.seconds(60),
    });

    // インバウンド認証を試すGatewayのサービスロール（ターゲットは登録しない）
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*` },
        },
      }),
    });

    // 認証情報プロバイダーやGatewayの作成時に privateEndpoint へそのまま渡すJSON
    const privateEndpoint = {
      managedVpcResource: {
        vpcIdentifier: vpc.vpcId,
        subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
        endpointIpAddressType: 'IPV4',
        securityGroupIds: [latticeSg.securityGroupId],
      },
    };

    new cdk.CfnOutput(this, 'PrivateEndpoint', { value: this.toJsonString(privateEndpoint) });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'ClientSecretArn', { value: clientSecret.secretArn });
    new cdk.CfnOutput(this, 'KeycloakInstanceId', { value: idp.instanceId });
    new cdk.CfnOutput(this, 'GatewayRoleArn', { value: gatewayRole.roleArn });
  }
}
