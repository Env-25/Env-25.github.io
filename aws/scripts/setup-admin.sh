#!/usr/bin/env bash
# Deploy the protected CHBE admin Lambda Function URL and its audit tables.
# Required environment variables:
#   GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_OWNER, GITHUB_REPO,
#   GITHUB_PRIVATE_KEY_SECRET_ID
# The referenced Secrets Manager secret must contain the GitHub App PEM key.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
LAMBDA_NAME="${ADMIN_LAMBDA_NAME:-chbe-admin}"
ROLE_NAME="${ADMIN_ROLE_NAME:-chbe-admin-lambda-role}"
USER_POOL_ID="${COGNITO_USER_POOL_ID:-us-east-2_HeZCWYUt3}"
CLIENT_ID="${COGNITO_CLIENT_ID:-285b5dv7j67uos6r1rcv572bo5}"
INVENTORY_TABLE="${INVENTORY_TABLE:-inventory}"
LOCKER_CHANGES_TABLE="${LOCKER_CHANGES_TABLE:-locker-changes}"
ADMIN_AUDIT_TABLE="${ADMIN_AUDIT_TABLE:-admin-audit}"
SES_FROM="${SES_FROM:-UBC CHBE Council Notifications <notifications@ubcchbecouncil.com>}"
EMAIL_QUEUE_NAME="${EMAIL_QUEUE_NAME:-chbe-ses-send}"
EMAIL_DLQ_NAME="${EMAIL_DLQ_NAME:-chbe-ses-send-dlq}"
SITE_URL="${SITE_URL:-https://ubcchbecouncil.com}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,http://localhost:4321,http://localhost:3001}"

: "${GITHUB_APP_ID:?Set GITHUB_APP_ID}"
: "${GITHUB_INSTALLATION_ID:?Set GITHUB_INSTALLATION_ID}"
: "${GITHUB_OWNER:?Set GITHUB_OWNER}"
: "${GITHUB_REPO:?Set GITHUB_REPO}"
: "${GITHUB_PRIVATE_KEY_SECRET_ID:?Set GITHUB_PRIVATE_KEY_SECRET_ID}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAMBDA_DIR="$ROOT/aws/lambdas/admin"
BUILD_DIR="$SCRIPT_DIR/.admin-build"
ZIP_PATH="$BUILD_DIR/$LAMBDA_NAME.zip"
ENV_PATH="$BUILD_DIR/$LAMBDA_NAME-env.json"
POLICY_PATH="$BUILD_DIR/$LAMBDA_NAME-policy.json"
CORS_PATH="$BUILD_DIR/$LAMBDA_NAME-cors.json"
QUEUE_ATTRIBUTES_PATH="$BUILD_DIR/$LAMBDA_NAME-queue-attributes.json"
mkdir -p "$BUILD_DIR"

winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

ensure_table() {
  local table="$1" key="$2"
  if ! aws dynamodb describe-table --region "$REGION" --table-name "$table" >/dev/null 2>&1; then
    aws dynamodb create-table --region "$REGION" --table-name "$table" \
      --attribute-definitions "AttributeName=$key,AttributeType=S" \
      --key-schema "AttributeName=$key,KeyType=HASH" \
      --billing-mode PAY_PER_REQUEST >/dev/null
    aws dynamodb wait table-exists --region "$REGION" --table-name "$table"
  fi
}

ensure_table "$LOCKER_CHANGES_TABLE" changeId
ensure_table "$ADMIN_AUDIT_TABLE" auditId

EMAIL_DLQ_URL="$(aws sqs get-queue-url --region "$REGION" --queue-name "$EMAIL_DLQ_NAME" --query QueueUrl --output text 2>/dev/null || true)"
if [ -z "$EMAIL_DLQ_URL" ]; then
  EMAIL_DLQ_URL="$(aws sqs create-queue --region "$REGION" --queue-name "$EMAIL_DLQ_NAME" \
    --attributes VisibilityTimeout=360,ReceiveMessageWaitTimeSeconds=20,MessageRetentionPeriod=1209600,SqsManagedSseEnabled=true \
    --query QueueUrl --output text)"
fi
EMAIL_DLQ_ARN="$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$EMAIL_DLQ_URL" --attribute-names QueueArn --query "Attributes.QueueArn" --output text)"
python - "$QUEUE_ATTRIBUTES_PATH" "$EMAIL_DLQ_ARN" <<'PY'
import json, sys
json.dump({
  "VisibilityTimeout": "360",
  "ReceiveMessageWaitTimeSeconds": "20",
  "MessageRetentionPeriod": "1209600",
  "SqsManagedSseEnabled": "true",
  "RedrivePolicy": json.dumps({"deadLetterTargetArn": sys.argv[2], "maxReceiveCount": "3"}),
}, open(sys.argv[1], "w"))
PY
EMAIL_QUEUE_URL="$(aws sqs get-queue-url --region "$REGION" --queue-name "$EMAIL_QUEUE_NAME" --query QueueUrl --output text 2>/dev/null || true)"
if [ -z "$EMAIL_QUEUE_URL" ]; then
  EMAIL_QUEUE_URL="$(aws sqs create-queue --region "$REGION" --queue-name "$EMAIL_QUEUE_NAME" --attributes "file://$(winpath "$QUEUE_ATTRIBUTES_PATH")" --query QueueUrl --output text)"
else
  aws sqs set-queue-attributes --region "$REGION" --queue-url "$EMAIL_QUEUE_URL" --attributes "file://$(winpath "$QUEUE_ATTRIBUTES_PATH")"
fi
EMAIL_QUEUE_ARN="$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$EMAIL_QUEUE_URL" --attribute-names QueueArn --query "Attributes.QueueArn" --output text)"

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10
fi

SECRET_ARN="$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$GITHUB_PRIVATE_KEY_SECRET_ID" --query ARN --output text)"
cat > "$POLICY_PATH" <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {"Sid":"InventoryAndAudit","Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:Scan","dynamodb:TransactWriteItems"],"Resource":[
      "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$INVENTORY_TABLE",
      "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$LOCKER_CHANGES_TABLE",
      "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$ADMIN_AUDIT_TABLE"
    ]},
    {"Sid":"InventoryDelete","Effect":"Allow","Action":"dynamodb:DeleteItem","Resource":"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$INVENTORY_TABLE"},
    {"Sid":"EmailQueue","Effect":"Allow","Action":["sqs:SendMessage","sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes"],"Resource":"$EMAIL_QUEUE_ARN"},
    {"Sid":"CognitoGroups","Effect":"Allow","Action":["cognito-idp:ListUsers","cognito-idp:ListGroups","cognito-idp:ListUsersInGroup","cognito-idp:AdminListGroupsForUser","cognito-idp:AdminAddUserToGroup","cognito-idp:AdminRemoveUserFromGroup"],"Resource":"arn:aws:cognito-idp:$REGION:$ACCOUNT_ID:userpool/$USER_POOL_ID"},
    {"Sid":"ReadGitHubKey","Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"$SECRET_ARN"},
    {"Sid":"Notifications","Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":"*"}
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "$LAMBDA_NAME-access" \
  --policy-document "file://$(winpath "$POLICY_PATH")"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

(
  cd "$LAMBDA_DIR"
  npm install --omit=dev --no-fund --no-audit
  rm -f "$ZIP_PATH"
  python - "$ZIP_PATH" <<'PY'
import os, sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
    for root, _, files in os.walk("."):
        for filename in files:
            if filename.endswith(".zip"):
                continue
            full = os.path.join(root, filename)
            archive.write(full, os.path.relpath(full, ".").replace("\\", "/"))
PY
)

python - "$ENV_PATH" <<PY
import json, sys
variables = {
  "COGNITO_USER_POOL_ID": "$USER_POOL_ID",
  "COGNITO_CLIENT_ID": "$CLIENT_ID",
  "INVENTORY_TABLE": "$INVENTORY_TABLE",
  "LOCKER_CHANGES_TABLE": "$LOCKER_CHANGES_TABLE",
  "ADMIN_AUDIT_TABLE": "$ADMIN_AUDIT_TABLE",
  "SES_FROM": "$SES_FROM",
  "EMAIL_QUEUE_URL": "$EMAIL_QUEUE_URL",
  "SITE_URL": "$SITE_URL",
  "GITHUB_APP_ID": "$GITHUB_APP_ID",
  "GITHUB_INSTALLATION_ID": "$GITHUB_INSTALLATION_ID",
  "GITHUB_OWNER": "$GITHUB_OWNER",
  "GITHUB_REPO": "$GITHUB_REPO",
  "GITHUB_BRANCH": "$GITHUB_BRANCH",
  "GITHUB_PRIVATE_KEY_SECRET_ID": "$GITHUB_PRIVATE_KEY_SECRET_ID",
}
json.dump({"Variables": variables}, open(sys.argv[1], "w"))
PY

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$LAMBDA_NAME" --region "$REGION" \
    --zip-file "fileb://$(winpath "$ZIP_PATH")" >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"
  aws lambda update-function-configuration --function-name "$LAMBDA_NAME" --region "$REGION" \
    --timeout 60 --memory-size 512 --environment "file://$(winpath "$ENV_PATH")" >/dev/null
else
  aws lambda create-function --function-name "$LAMBDA_NAME" --region "$REGION" \
    --runtime nodejs20.x --handler index.handler --role "$ROLE_ARN" --timeout 60 --memory-size 512 \
    --environment "file://$(winpath "$ENV_PATH")" --zip-file "fileb://$(winpath "$ZIP_PATH")" >/dev/null
fi
aws lambda wait function-active --function-name "$LAMBDA_NAME" --region "$REGION"
EVENT_SOURCE_MAPPING_ID="$(aws lambda list-event-source-mappings --function-name "$LAMBDA_NAME" --event-source-arn "$EMAIL_QUEUE_ARN" --query "EventSourceMappings[0].UUID" --output text)"
if [ "$EVENT_SOURCE_MAPPING_ID" = "None" ] || [ -z "$EVENT_SOURCE_MAPPING_ID" ]; then
  aws lambda create-event-source-mapping --function-name "$LAMBDA_NAME" --event-source-arn "$EMAIL_QUEUE_ARN" \
    --batch-size 6 --maximum-batching-window-in-seconds 1 --scaling-config MaximumConcurrency=1 \
    --function-response-types ReportBatchItemFailures >/dev/null
else
  aws lambda update-event-source-mapping --uuid "$EVENT_SOURCE_MAPPING_ID" --batch-size 6 \
    --maximum-batching-window-in-seconds 1 --scaling-config MaximumConcurrency=1 \
    --function-response-types ReportBatchItemFailures >/dev/null
fi

python - "$CORS_PATH" <<PY
import json, os, sys
json.dump({"AllowOrigins":[x.strip() for x in "$ALLOWED_ORIGINS".split(",") if x.strip()],
           "AllowMethods":["GET","POST"],"AllowHeaders":["content-type","authorization"],"MaxAge":86400}, open(sys.argv[1],"w"))
PY
if ! aws lambda get-function-url-config --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$LAMBDA_NAME" --region "$REGION" \
    --auth-type NONE --cors "file://$(winpath "$CORS_PATH")" >/dev/null
  aws lambda add-permission --function-name "$LAMBDA_NAME" --region "$REGION" \
    --statement-id FunctionURLAllowPublicInvoke --action lambda:InvokeFunctionUrl \
    --principal "*" --function-url-auth-type NONE 2>/dev/null || true
  aws lambda add-permission --function-name "$LAMBDA_NAME" --region "$REGION" \
    --statement-id FunctionURLAllowInvokeFunction --action lambda:InvokeFunction \
    --principal "*" --invoked-via-function-url 2>/dev/null || true
else
  aws lambda update-function-url-config --function-name "$LAMBDA_NAME" --region "$REGION" \
    --auth-type NONE --cors "file://$(winpath "$CORS_PATH")" >/dev/null
fi

URL="$(aws lambda get-function-url-config --function-name "$LAMBDA_NAME" --region "$REGION" --query FunctionUrl --output text)"
echo "Admin API deployed: ${URL%/}"
echo "Set PUBLIC_ADMIN_API_URL=${URL%/} locally and as a GitHub Pages build secret."
