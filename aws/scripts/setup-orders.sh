#!/usr/bin/env bash
# Deploys CHBE orders Lambda + Function URL (place / get / inventory).
# Creates IAM role chbe-orders-lambda-role if missing.
#
# Prerequisites: aws CLI logged in; DynamoDB tables `orders` + `inventory`;
# SES domain (or from-address) verified in REGION.
#
# Usage (Git Bash / WSL):
#   ./aws/scripts/setup-orders.sh
#
# Then set PUBLIC_ORDERS_API_URL in .env to the printed Function URL.
# Seed stock:  node aws/scripts/seed-inventory.mjs
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
LAMBDA_NAME="${ORDERS_LAMBDA_NAME:-chbe-orders}"
ROLE_NAME="${ORDERS_ROLE_NAME:-chbe-orders-lambda-role}"
ORDERS_TABLE="${ORDERS_TABLE:-orders}"
INVENTORY_TABLE="${INVENTORY_TABLE:-inventory}"
SES_FROM="${SES_FROM:-CHBE Orders <orders@ubcchbecouncil.com>}"
STAFF_ORDER_EMAILS="${STAFF_ORDER_EMAILS:-akshaj243@gmail.com,sachdevaakshaj1@gmail.com}"
COGNITO_USER_POOL_ID="${COGNITO_USER_POOL_ID:-us-east-2_HeZCWYUt3}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID:-285b5dv7j67uos6r1rcv572bo5}"
SITE_URL="${SITE_URL:-https://ubcchbecouncil.com}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,https://chbe-site.akshajs.org,http://localhost:3001,http://localhost:4321}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$(cd "$SCRIPT_DIR/../lambdas/orders" && pwd)"
# Keep artifacts under the repo so Windows aws.exe can read paths from Git Bash
WORK_DIR="$SCRIPT_DIR/.orders-build"
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
echo "    Tables: $ORDERS_TABLE / $INVENTORY_TABLE"
echo "    SES from: $SES_FROM"

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
      "Sid": "DynamoOrdersInventory",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:TransactWriteItems",
        "dynamodb:DescribeTable"
      ],
      "Resource": [
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${ORDERS_TABLE}",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${INVENTORY_TABLE}",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${ORDERS_TABLE}/index/*",
        "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${INVENTORY_TABLE}/index/*"
      ]
    },
    {
      "Sid": "SesSend",
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "*"
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
        if "node_modules" in dirpath.split(os.sep) and ".cache" in dirpath:
            continue
        for name in filenames:
            if name.endswith(".zip"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            zf.write(full, rel.replace("\\", "/"))
print("zipped", zip_path)
PY
)

# Environment
export ORDERS_TABLE INVENTORY_TABLE SES_FROM STAFF_ORDER_EMAILS
export COGNITO_USER_POOL_ID COGNITO_CLIENT_ID SITE_URL
python - "$ENV_JSON" <<'PY'
import json, os, sys
path = sys.argv[1]
vars = {
    "ORDERS_TABLE": os.environ.get("ORDERS_TABLE", "orders"),
    "INVENTORY_TABLE": os.environ.get("INVENTORY_TABLE", "inventory"),
    "SES_FROM": os.environ.get(
        "SES_FROM",
        "CHBE Orders <orders@ubcchbecouncil.com>",
    ),
    "STAFF_ORDER_EMAILS": os.environ.get(
        "STAFF_ORDER_EMAILS",
        "akshaj243@gmail.com,sachdevaakshaj1@gmail.com",
    ),
    "COGNITO_USER_POOL_ID": os.environ.get("COGNITO_USER_POOL_ID", ""),
    "COGNITO_CLIENT_ID": os.environ.get("COGNITO_CLIENT_ID", ""),
    "SITE_URL": os.environ.get("SITE_URL", "https://ubcchbecouncil.com"),
}
with open(path, "w") as f:
    json.dump({"Variables": vars}, f)
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
    --timeout 30 \
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
    --timeout 30 \
    --memory-size 256 \
    --environment "file://$(winpath "$ENV_JSON")" \
    --zip-file "fileb://$(winpath "$ZIP_PATH")" >/dev/null
  aws lambda wait function-active --function-name "$LAMBDA_NAME" --region "$REGION"
fi

# --- Function URL ---
python - "$CORS_JSON" <<'PY'
import json, os, sys
origins = [
    o.strip()
    for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,http://localhost:3001,http://localhost:4321",
    ).split(",")
    if o.strip()
]
with open(sys.argv[1], "w") as f:
    json.dump(
        {
            "AllowOrigins": origins,
            "AllowMethods": ["GET", "POST"],
            "AllowHeaders": ["content-type", "authorization"],
            "MaxAge": 86400,
        },
        f,
    )
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

  aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --statement-id FunctionURLAllowInvokeFunction \
    --action lambda:InvokeFunction \
    --principal "*" \
    --invoked-via-function-url \
    2>/dev/null || true
fi

FUNCTION_URL="$(aws lambda get-function-url-config \
  --function-name "$LAMBDA_NAME" \
  --region "$REGION" \
  --query FunctionUrl \
  --output text)"
FUNCTION_URL="${FUNCTION_URL%/}"

echo ""
echo "Done."
echo "  • IAM role: $ROLE_NAME"
echo "  • Lambda:   $LAMBDA_NAME"
echo "  • Function URL: $FUNCTION_URL"
echo ""
echo "Add to .env:"
echo "  PUBLIC_ORDERS_API_URL=$FUNCTION_URL"
echo ""
echo "Seed inventory from CSVs:"
echo "  node aws/scripts/seed-inventory.mjs"
