#!/usr/bin/env bash
# Deploys CHBE contact form Lambda + Function URL (Turnstile + SES via SQS).
#
# Usage:
#   TURNSTILE_SECRET_KEY=0x... ./aws/scripts/setup-contact.sh
#
# Then set PUBLIC_CONTACT_API_URL in .env / GitHub secrets to the printed URL.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
LAMBDA_NAME="${CONTACT_LAMBDA_NAME:-chbe-contact}"
ROLE_NAME="${CONTACT_ROLE_NAME:-chbe-contact-lambda-role}"
EMAIL_QUEUE_NAME="${EMAIL_QUEUE_NAME:-chbe-ses-send.fifo}"
SES_FROM="${SES_FROM:-UBC CHBE Support <support@ubcchbecouncil.com>}"
SITE_URL="${SITE_URL:-https://ubcchbecouncil.com}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,https://chbe-site.akshajs.org,http://localhost:3001,http://localhost:4321}"
export TURNSTILE_SECRET_KEY="${TURNSTILE_SECRET_KEY:-}"
if [[ -z "$TURNSTILE_SECRET_KEY" ]]; then
  EXISTING_SECRET="$(aws lambda get-function-configuration --function-name "$LAMBDA_NAME" --region "$REGION" --query 'Environment.Variables.TURNSTILE_SECRET_KEY' --output text 2>/dev/null || true)"
  if [[ -n "$EXISTING_SECRET" && "$EXISTING_SECRET" != "None" ]]; then
    export TURNSTILE_SECRET_KEY="$EXISTING_SECRET"
    echo "    Reusing TURNSTILE_SECRET_KEY already on $LAMBDA_NAME"
  else
    EXISTING_SECRET="$(aws lambda get-function-configuration --function-name chbe-email-validate --region "$REGION" --query 'Environment.Variables.TURNSTILE_SECRET_KEY' --output text 2>/dev/null || true)"
    if [[ -n "$EXISTING_SECRET" && "$EXISTING_SECRET" != "None" ]]; then
      export TURNSTILE_SECRET_KEY="$EXISTING_SECRET"
      echo "    Copied TURNSTILE_SECRET_KEY from chbe-email-validate"
    fi
  fi
  unset EXISTING_SECRET
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
EMAIL_QUEUE_URL="$(aws sqs get-queue-url --region "$REGION" --queue-name "$EMAIL_QUEUE_NAME" --query QueueUrl --output text)"
EMAIL_QUEUE_ARN="$(aws sqs get-queue-attributes --region "$REGION" --queue-url "$EMAIL_QUEUE_URL" --attribute-names QueueArn --query "Attributes.QueueArn" --output text)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$(cd "$SCRIPT_DIR/../lambdas/contact" && pwd)"
WORK_DIR="$SCRIPT_DIR/.contact-build"
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
echo "    Email queue: $EMAIL_QUEUE_NAME"
echo "    SES from: $SES_FROM"

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
      "Sid": "QueueEmail",
      "Effect": "Allow",
      "Action": ["sqs:SendMessage"],
      "Resource": "${EMAIL_QUEUE_ARN}"
    }
  ]
}
EOF
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${LAMBDA_NAME}-access" \
  --policy-document "file://$(winpath "$POLICY_JSON")"
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

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

export EMAIL_QUEUE_URL SES_FROM SITE_URL
python - "$ENV_JSON" <<'PY'
import json, os, sys
vars = {
    "EMAIL_QUEUE_URL": os.environ.get("EMAIL_QUEUE_URL", ""),
    "SES_FROM": os.environ.get("SES_FROM", "UBC CHBE Support <support@ubcchbecouncil.com>"),
    "SITE_URL": os.environ.get("SITE_URL", "https://ubcchbecouncil.com"),
    "ALLOWED_ORIGINS": os.environ.get("ALLOWED_ORIGINS", ""),
}
secret = os.environ.get("TURNSTILE_SECRET_KEY", "").strip()
if secret:
    vars["TURNSTILE_SECRET_KEY"] = secret
json.dump({"Variables": vars}, open(sys.argv[1], "w"))
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

python - "$CORS_JSON" <<'PY'
import json, os, sys
origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
json.dump({
  "AllowOrigins": origins,
  "AllowMethods": ["POST"],
  "AllowHeaders": ["content-type"],
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
    --function-url-auth-type NONE 2>/dev/null || true
  aws lambda add-permission \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --statement-id FunctionURLAllowInvokeFunction \
    --action lambda:InvokeFunction \
    --principal "*" \
    --invoked-via-function-url 2>/dev/null || true
else
  aws lambda update-function-url-config \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --cors "file://$(winpath "$CORS_JSON")" >/dev/null
fi

FUNCTION_URL="$(aws lambda get-function-url-config --function-name "$LAMBDA_NAME" --region "$REGION" --query FunctionUrl --output text)"
echo ""
echo "==> Done."
echo "  PUBLIC_CONTACT_API_URL=${FUNCTION_URL%/}"
