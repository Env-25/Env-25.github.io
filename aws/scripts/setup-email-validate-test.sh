#!/usr/bin/env bash
# Deploys internal email-validate Lambda:
#   - Skips Turnstile (use Cloudflare always-pass site key on the site)
#   - Validates emails with SES GetEmailAddressInsights
#
# Usage:
#   ./aws/scripts/setup-email-validate-test.sh
#
# Pair with:
#   PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
LAMBDA_NAME="${EMAIL_VALIDATE_TEST_LAMBDA_NAME:-chbe-email-validate-test}"
ROLE_NAME="${EMAIL_VALIDATE_TEST_ROLE_NAME:-chbe-email-validate-test-role}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$(cd "$SCRIPT_DIR/../lambdas/email-validate-test" && pwd)"
ZIP_PATH="/tmp/${LAMBDA_NAME}.zip"
ENV_JSON="/tmp/${LAMBDA_NAME}-env.json"
CORS_JSON="/tmp/${LAMBDA_NAME}-cors.json"

export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-*}"
export MIN_VALID_VERDICT="${MIN_VALID_VERDICT:-MEDIUM}"

echo "==> Account $ACCOUNT_ID  Region $REGION  Function $LAMBDA_NAME (SES, no Turnstile)"

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
  sleep 10
fi

POLICY_NAME="${LAMBDA_NAME}-ses"
echo "==> Attaching inline policy $POLICY_NAME (ses:GetEmailAddressInsights)"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "EmailValidation",
        "Effect": "Allow",
        "Action": [
          "ses:GetEmailAddressInsights",
          "iam:CreateServiceLinkedRole"
        ],
        "Resource": "*"
      }
    ]
  }' >/dev/null

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

echo "==> Installing deps + packaging from $LAMBDA_DIR"
(
  cd "$LAMBDA_DIR"
  npm install --omit=dev --no-fund --no-audit
  rm -f "$ZIP_PATH"
  zip -qr "$ZIP_PATH" index.mjs package.json node_modules
)

python3 - "$ENV_JSON" <<'PY'
import json, os, sys
with open(sys.argv[1], "w") as f:
    json.dump(
        {
            "Variables": {
                "ALLOWED_ORIGINS": os.environ.get("ALLOWED_ORIGINS", "*"),
                "MIN_VALID_VERDICT": os.environ.get("MIN_VALID_VERDICT", "MEDIUM"),
            }
        },
        f,
    )
PY

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating Lambda code $LAMBDA_NAME"
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --zip-file "fileb://${ZIP_PATH}" >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"
  aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --timeout 10 \
    --memory-size 256 \
    --environment "file://${ENV_JSON}" >/dev/null
else
  echo "==> Creating Lambda $LAMBDA_NAME"
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --runtime nodejs20.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --timeout 10 \
    --memory-size 256 \
    --environment "file://${ENV_JSON}" \
    --zip-file "fileb://${ZIP_PATH}" >/dev/null
  aws lambda wait function-active --function-name "$LAMBDA_NAME" --region "$REGION"
fi

python3 - "$CORS_JSON" <<'PY'
import json, os, sys
raw = os.environ.get("ALLOWED_ORIGINS", "*")
origins = ["*"] if raw.strip() == "*" else [o.strip() for o in raw.split(",") if o.strip()]
with open(sys.argv[1], "w") as f:
    json.dump(
        {
            "AllowOrigins": origins,
            "AllowMethods": ["POST"],
            "AllowHeaders": ["content-type"],
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
    --cors "file://${CORS_JSON}" >/dev/null

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
    --cors "file://${CORS_JSON}" >/dev/null

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
echo "Done (SES validation, Turnstile skipped)."
echo "  • Lambda: $LAMBDA_NAME"
echo "  • Function URL: $FUNCTION_URL"
echo ""
echo "Local .env:"
echo "  PUBLIC_EMAIL_VALIDATE_URL=$FUNCTION_URL"
echo "  PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA"
echo ""
echo "Bad emails are blocked via SES. Turnstile is not checked by this Lambda."
