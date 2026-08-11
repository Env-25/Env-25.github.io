#!/usr/bin/env bash
# Deploys SES Email Validation Lambda + Function URL for signup checks.
# Prerequisites: aws CLI logged in; SES Email Validation available in REGION.
#
# Usage:
#   TURNSTILE_SECRET_KEY=0x... ./aws/scripts/setup-email-validate.sh
#
# Then set PUBLIC_EMAIL_VALIDATE_URL in .env / GitHub secrets to the printed URL.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
LAMBDA_NAME="${EMAIL_VALIDATE_LAMBDA_NAME:-chbe-email-validate}"
ROLE_NAME="${EMAIL_VALIDATE_ROLE_NAME:-chbe-email-validate-role}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$(cd "$SCRIPT_DIR/../lambdas/email-validate" && pwd)"
ZIP_PATH="/tmp/${LAMBDA_NAME}.zip"
ENV_JSON="/tmp/${LAMBDA_NAME}-env.json"
CORS_JSON="/tmp/${LAMBDA_NAME}-cors.json"

# Comma-separated browser origins allowed to call the Function URL
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,https://chbe-site.akshajs.org,http://localhost:3001,http://localhost:4321}"
export MIN_VALID_VERDICT="${MIN_VALID_VERDICT:-MEDIUM}"
export TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-}"

echo "==> Account $ACCOUNT_ID  Region $REGION  Function $LAMBDA_NAME"

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

# --- Package ---
echo "==> Installing deps + packaging from $LAMBDA_DIR"
(
  cd "$LAMBDA_DIR"
  npm install --omit=dev --no-fund --no-audit
  rm -f "$ZIP_PATH"
  zip -qr "$ZIP_PATH" index.mjs package.json node_modules
)

# Environment JSON (avoids comma-splitting issues with ALLOWED_ORIGINS)
python3 - "$ENV_JSON" <<'PY'
import json, os, sys
path = sys.argv[1]
vars = {
    "ALLOWED_ORIGINS": os.environ.get(
        "ALLOWED_ORIGINS",
        "https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,http://localhost:3001,http://localhost:4321",
    ),
    "MIN_VALID_VERDICT": os.environ.get("MIN_VALID_VERDICT", "MEDIUM"),
}
secret = os.environ.get("TURNSTILE_SECRET_KEY", "").strip()
if secret:
    vars["TURNSTILE_SECRET_KEY"] = secret
with open(path, "w") as f:
    json.dump({"Variables": vars}, f)
PY

if [[ -z "${TURNSTILE_SECRET_KEY:-}" ]]; then
  echo "WARNING: TURNSTILE_SECRET_KEY not set — Lambda will skip CAPTCHA checks."
  echo "         Re-run with TURNSTILE_SECRET_KEY=0x... for production."
fi

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating Lambda code $LAMBDA_NAME"
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --zip-file "fileb://${ZIP_PATH}" >/dev/null

  aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION"

  echo "==> Updating Lambda configuration"
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

# --- Function URL (public POST + CORS) ---
python3 - "$CORS_JSON" <<'PY'
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
            # OPTIONS is not allowed here (max 6 chars); Function URL handles preflight when CORS is set.
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

  # Required since Oct 2025 for AuthType NONE (otherwise POST returns 403)
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
echo "Done."
echo "  • Lambda: $LAMBDA_NAME"
echo "  • Function URL: $FUNCTION_URL"
echo ""
echo "Add to .env and GitHub Actions secrets:"
echo "  PUBLIC_EMAIL_VALIDATE_URL=$FUNCTION_URL"
echo ""
echo "Optional: set TURNSTILE_SECRET_KEY when running this script (Cloudflare Turnstile secret)."
echo "SES Email Validation costs ~\$0.01 per check — enable only after SES supports it in $REGION."
