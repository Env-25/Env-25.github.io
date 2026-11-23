#!/usr/bin/env bash
# Deploys the CHBE Hackathon Lambda + Function URL (register / validate / me).
# Creates the DynamoDB table `hackathon-participants` and IAM role if missing.
#
# Prerequisites: aws CLI logged in (`aws login`); Cognito user pool already set up.
#
# Usage (Git Bash / WSL):
#   ./aws/scripts/setup-hackathon.sh
#
# Then set PUBLIC_HACKATHON_API_URL in .env to the printed Function URL.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
LAMBDA_NAME="${HACKATHON_LAMBDA_NAME:-chbe-hackathon}"
ROLE_NAME="${HACKATHON_ROLE_NAME:-chbe-hackathon-lambda-role}"
HACKATHON_TABLE="${HACKATHON_TABLE:-hackathon-participants}"
COGNITO_USER_POOL_ID="${COGNITO_USER_POOL_ID:-us-east-2_HeZCWYUt3}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-285b5dv7j67uos6r1rcv572bo5}"
HACKATHON_SIGNUP_ENABLED="${HACKATHON_SIGNUP_ENABLED:-true}"
HACKATHON_REQUIRE_VERIFIED="${HACKATHON_REQUIRE_VERIFIED:-true}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,https://chbe-site.akshajs.org,http://localhost:3001,http://localhost:4321}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$(cd "$SCRIPT_DIR/../lambdas/hackathon" && pwd)"
# Keep artifacts under the repo so Windows aws.exe can read paths from Git Bash
WORK_DIR="$SCRIPT_DIR/.hackathon-build"
mkdir -p "$WORK_DIR"
ZIP_PATH="$WORK_DIR/${LAMBDA_NAME}.zip"
ENV_JSON="$WORK_DIR/${LAMBDA_NAME}-env.json"
CORS_JSON="$WORK_DIR/${LAMBDA_NAME}-cors.json"
POLICY_JSON="$WORK_DIR/${LAMBDA_NAME}-policy.json"

winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

echo "==> Account $ACCOUNT_ID  Region $REGION  Function $LAMBDA_NAME"
echo "    Table: $HACKATHON_TABLE"
echo "    User pool: $COGNITO_USER_POOL_ID"

# --- DynamoDB table ---
if ! aws dynamodb describe-table --region "$REGION" --table-name "$HACKATHON_TABLE" >/dev/null 2>&1; then
  echo "==> Creating DynamoDB table $HACKATHON_TABLE"
  aws dynamodb create-table --region "$REGION" --table-name "$HACKATHON_TABLE" \
    --attribute-definitions "AttributeName=userSub,AttributeType=S" \
    --key-schema "AttributeName=userSub,KeyType=HASH" \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --region "$REGION" --table-name "$HACKATHON_TABLE"
else
  echo "==> Table $HACKATHON_TABLE already exists"
fi

# --- IAM role ---
echo "==> Ensuring IAM role $ROLE_NAME"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }' >/dev/null
  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "    Waiting for role to propagate…"
  sleep 12
fi

cat > "$POLICY_JSON" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HackathonTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
        "dynamodb:DescribeTable"
      ],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${HACKATHON_TABLE}",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${HACKATHON_TABLE}/index/*"
      ]
    },
    {
      "Sid": "CognitoLookup",
      "Effect": "Allow",
      "Action": ["cognito-idp:ListUsers"],
      "Resource": "arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${COGNITO_USER_POOL_ID}"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${LAMBDA_NAME}-access" \
  --policy-document "file://$(winpath "$POLICY_JSON")" >/dev/null

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

# --- Package ---
echo "==> Installing deps + packaging from $LAMBDA_DIR"
(
  cd "$LAMBDA_DIR"
  npm install --omit=dev --no-fund --no-audit
  rm -f "$ZIP_PATH"
  python - "$ZIP_PATH" <<'PY'
import os, sys, zipfile
zip_path = sys.argv[1]
root = os.getcwd()
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            if name.endswith(".zip"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            zf.write(full, rel.replace("\\", "/"))
print("zipped", zip_path)
PY
)

# --- Environment ---
export HACKATHON_TABLE COGNITO_USER_POOL_ID COGNITO_CLIENT_ID
export HACKATHON_SIGNUP_ENABLED HACKATHON_REQUIRE_VERIFIED
python - "$ENV_JSON" <<'PY'
import json, os, sys
vars = {
    "HACKATHON_TABLE": os.environ.get("HACKATHON_TABLE", "hackathon-participants"),
    "COGNITO_USER_POOL_ID": os.environ.get("COGNITO_USER_POOL_ID", ""),
    "COGNITO_CLIENT_ID": os.environ.get("COGNITO_CLIENT_ID", ""),
    "HACKATHON_SIGNUP_ENABLED": os.environ.get("HACKATHON_SIGNUP_ENABLED", "true"),
    "HACKATHON_REQUIRE_VERIFIED": os.environ.get("HACKATHON_REQUIRE_VERIFIED", "true"),
}
json.dump({"Variables": vars}, open(sys.argv[1], "w"))
PY

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating Lambda code $LAMBDA_NAME"
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --zip-file "fileb://$(winpath "$ZIP_PATH")" >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"
  echo "==> Updating Lambda configuration"
  aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --timeout 15 \
    --memory-size 256 \
    --environment "file://$(winpath "$ENV_JSON")" >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"
else
  echo "==> Creating Lambda $LAMBDA_NAME"
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --runtime nodejs20.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --timeout 15 \
    --memory-size 256 \
    --environment "file://$(winpath "$ENV_JSON")" \
    --zip-file "fileb://$(winpath "$ZIP_PATH")" >/dev/null
  aws lambda wait function-active --function-name "$LAMBDA_NAME" --region "$REGION"
fi

# --- Function URL + CORS ---
python - "$CORS_JSON" <<'PY'
import json, os, sys
origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
json.dump({
  "AllowOrigins": origins,
  "AllowMethods": ["GET", "POST"],
  "AllowHeaders": ["content-type", "authorization"],
  "MaxAge": 86400,
}, open(sys.argv[1], "w"))
PY

echo "==> Ensuring Function URL"
if ! aws lambda get-function-url-config --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --auth-type NONE \
    --cors "file://$(winpath "$CORS_JSON")" >/dev/null

  aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --statement-id FunctionURLAllowPublicInvoke \
    --action lambda:InvokeFunctionUrl \
    --principal "*" \
    --function-url-auth-type NONE \
    2>/dev/null || true

  aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --statement-id FunctionURLAllowInvokeFunction \
    --action lambda:InvokeFunction \
    --principal "*" \
    --invoked-via-function-url \
    2>/dev/null || true
else
  aws lambda update-function-url-config \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --auth-type NONE \
    --cors "file://$(winpath "$CORS_JSON")" >/dev/null
fi

FUNCTION_URL="$(aws lambda get-function-url-config \
  --function-name "$LAMBDA_NAME" \
  --region "$REGION" \
  --query FunctionUrl \
  --output text)"
FUNCTION_URL="${FUNCTION_URL%/}"

echo ""
echo "Done."
echo "  • DynamoDB table: $HACKATHON_TABLE"
echo "  • IAM role:       $ROLE_NAME"
echo "  • Lambda:         $LAMBDA_NAME"
echo "  • Function URL:   $FUNCTION_URL"
echo ""
echo "Add to .env:"
echo "  PUBLIC_HACKATHON_API_URL=$FUNCTION_URL"
