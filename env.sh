# 後続のコマンドで使う値をスタックの出力から読み込む
export AWS_REGION=ap-northeast-1
out() { aws cloudformation describe-stacks --stack-name PrivateCaIdp \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
PE=$(out PrivateEndpoint)              # privateEndpoint に渡すJSON（VPC・サブネット・SG）
B=$(out BucketName)                    # CA証明書のPEMを置いたバケット
GW_ROLE=$(out GatewayRoleArn)          # インバウンド認証を試すGatewayのロール
KC_ID=$(out KeycloakInstanceId)
CLIENT_SECRET=$(aws secretsmanager get-secret-value --secret-id "$(out ClientSecretArn)" \
  --query SecretString --output text)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
DISCOVERY_URL=https://idp.internal.example.com/realms/demo/.well-known/openid-configuration
