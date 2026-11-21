# agentcore-identity-private-ca

Amazon Bedrock AgentCore Identityのプライベート認証局（CA）対応を試すための検証環境です。OpenSSLで作った自己署名のルートCAの証明書でHTTPSを受け付けるKeycloakを、VPCのプライベートサブネットに作ります。

## 構成

```text
.
├── certs.sh                # プライベートCAとKeycloakのサーバー証明書を作る
├── env.sh                  # スタックの出力から後続のコマンドで使う値を読み込む
├── keycloak/realm-demo.json  # Keycloakのレルムの定義（クライアント agentcore-client）
└── cdk/                    # VPC・Keycloak（EC2）・プライベートホストゾーン・S3バケットを作るCDKアプリ
```

## 前提

- AWS CLI v2・jq・OpenSSL 3.x以降
- Node.js 26.13.0（`mise.toml`）とpnpm
- ap-northeast-1でCDKのブートストラップを済ませたAWSアカウント

## デプロイ

```bash
./certs.sh
export AWS_REGION=ap-northeast-1
# サーバー証明書の秘密鍵はCDKのアセットに含めず、Secrets Managerに登録しておく
aws secretsmanager create-secret --name private-ca-demo/keycloak-server-key \
  --secret-string file://certs/server.key
(cd cdk && pnpm install && pnpm cdk deploy PrivateCaIdp)
source env.sh
```

認証情報プロバイダーやGatewayの作成、トークンの取得、CAの入れ替えはDevelopersIOの記事の手順で進めます。

## 後片付け

AgentCore側で作った認証情報プロバイダー・Gateway・ワークロードIDを削除してから実行します。

```bash
# スタックを削除する前にLambdaの関数名を控えて、残るロググループを特定する
FNS=$(aws cloudformation describe-stack-resources --stack-name PrivateCaIdp \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)
(cd cdk && pnpm cdk destroy PrivateCaIdp)
aws secretsmanager delete-secret --secret-id private-ca-demo/keycloak-server-key \
  --force-delete-without-recovery
for fn in $FNS; do
  aws logs delete-log-group --log-group-name "/aws/lambda/$fn"
done
```

## 注意

検証用の構成です。Keycloakは開発モード（`start-dev`）で動かしています。
