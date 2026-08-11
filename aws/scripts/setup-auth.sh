#!/usr/bin/env bash
# Sets up Cognito email via SES + PreSignUp Lambda for verify-later sign-in.
# Prerequisites: aws CLI logged in, SES identity verified for FROM_EMAIL (or its domain).
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-2_HeZCWYUt3}"
FROM_EMAIL="${SES_FROM_EMAIL:-no-reply@ubcchbecouncil.com}"
LAMBDA_NAME="${PRE_SIGNUP_LAMBDA_NAME:-chbe-cognito-pre-signup}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ROLE_NAME="${PRE_SIGNUP_ROLE_NAME:-chbe-cognito-pre-signup-role}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAMBDA_DIR="$(cd "$SCRIPT_DIR/../lambdas/pre-signup" && pwd)"
ZIP_PATH="/tmp/${LAMBDA_NAME}.zip"

echo "==> Account $ACCOUNT_ID  Region $REGION  Pool $POOL_ID"
echo "==> From address $FROM_EMAIL"

# --- SES identity check ---
echo "==> Checking SES identity verification for $FROM_EMAIL"
STATUS="$(aws ses get-identity-verification-attributes \
  --region "$REGION" \
  --identities "$FROM_EMAIL" \
  --query "VerificationAttributes.\"$FROM_EMAIL\".VerificationStatus" \
  --output text 2>/dev/null || true)"

IDENTITY_NAME="$FROM_EMAIL"
if [[ "$STATUS" != "Success" ]]; then
  DOMAIN="${FROM_EMAIL#*@}"
  DOMAIN_STATUS="$(aws ses get-identity-verification-attributes \
    --region "$REGION" \
    --identities "$DOMAIN" \
    --query "VerificationAttributes.\"$DOMAIN\".VerificationStatus" \
    --output text 2>/dev/null || true)"
  if [[ "$DOMAIN_STATUS" != "Success" ]]; then
    echo "ERROR: Neither $FROM_EMAIL nor domain $DOMAIN is verified in SES ($REGION)."
    echo "Verify in SES (same region as Cognito), then re-run:"
    echo "  aws ses verify-email-identity --email-address $FROM_EMAIL --region $REGION"
    echo "Or verify the domain $DOMAIN in the SES console."
    exit 1
  fi
  echo "    Domain $DOMAIN is verified — OK"
  IDENTITY_NAME="$DOMAIN"
else
  echo "    Email $FROM_EMAIL is verified — OK"
fi
IDENTITY_ARN="arn:aws:ses:${REGION}:${ACCOUNT_ID}:identity/${IDENTITY_NAME}"

echo "==> Granting Cognito permission to send via SES"
aws ses put-identity-policy --region "$REGION" --identity "$IDENTITY_NAME" --policy-name CognitoSend --policy "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCognitoToSend",
      "Effect": "Allow",
      "Principal": { "Service": "cognito-idp.amazonaws.com" },
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": "${IDENTITY_ARN}",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" },
        "ArnLike": {
          "aws:SourceArn": "arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${POOL_ID}"
        }
      }
    }
  ]
}
EOF
)" >/dev/null

# --- IAM role for Lambda ---
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
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)"

# --- Package + deploy Lambda ---
echo "==> Packaging Lambda from $LAMBDA_DIR"
rm -f "$ZIP_PATH"
( cd "$LAMBDA_DIR" && zip -q "$ZIP_PATH" index.mjs )

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo "==> Updating Lambda $LAMBDA_NAME"
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --zip-file "fileb://${ZIP_PATH}" >/dev/null
else
  echo "==> Creating Lambda $LAMBDA_NAME"
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --region "$REGION" \
    --runtime nodejs20.x \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --timeout 5 \
    --memory-size 128 \
    --zip-file "fileb://${ZIP_PATH}" >/dev/null
fi

LAMBDA_ARN="$(aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" --query Configuration.FunctionArn --output text)"

echo "==> Allowing Cognito to invoke Lambda"
aws lambda add-permission \
  --function-name "$LAMBDA_NAME" \
  --region "$REGION" \
  --statement-id CognitoPreSignUp \
  --action lambda:InvokeFunction \
  --principal cognito-idp.amazonaws.com \
  --source-arn "arn:aws:cognito-idp:${REGION}:${ACCOUNT_ID}:userpool/${POOL_ID}" \
  2>/dev/null || true

# --- Preserve existing pool settings, then set SES + PreSignUp ---
echo "==> Reading current user pool settings (to avoid wiping config)"
POOL_JSON="$(aws cognito-idp describe-user-pool --region "$REGION" --user-pool-id "$POOL_ID" --output json)"

# Build update args carefully — Cognito resets omitted fields to defaults.
AUTO_VERIFIED="$(echo "$POOL_JSON" | python3 -c 'import json,sys; p=json.load(sys.stdin)["UserPool"]; print(",".join(p.get("AutoVerifiedAttributes") or ["email"]))')"
MFA="$(echo "$POOL_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["UserPool"].get("MfaConfiguration","OFF"))')"

# Merge existing LambdaConfig with PreSignUp
LAMBDA_CONFIG_ARGS="$(echo "$POOL_JSON" | LAMBDA_ARN="$LAMBDA_ARN" python3 - <<'PY'
import json, os, sys
pool = json.load(sys.stdin)["UserPool"]
cfg = dict(pool.get("LambdaConfig") or {})
# Normalize nested structures Cognito returns into CLI-style flat keys where possible
flat = {}
for k, v in cfg.items():
    if isinstance(v, str):
        flat[k] = v
    elif isinstance(v, dict) and "LambdaArn" in v:
        # CustomSMSSender / CustomEmailSender style
        flat[k] = v
# Always set PreSignUp
flat["PreSignUp"] = os.environ["LAMBDA_ARN"]
parts = []
for k, v in flat.items():
    if isinstance(v, str):
        parts.append(f"{k}={v}")
print(",".join(parts) if parts else f"PreSignUp={os.environ['LAMBDA_ARN']}")
PY
)"

echo "==> Updating user pool: SES from=$FROM_EMAIL, PreSignUp Lambda"
aws cognito-idp update-user-pool \
  --region "$REGION" \
  --user-pool-id "$POOL_ID" \
  --auto-verified-attributes $(echo "$AUTO_VERIFIED" | tr ',' ' ') \
  --mfa-configuration "$MFA" \
  --email-configuration "SourceArn=${IDENTITY_ARN},EmailSendingAccount=DEVELOPER,From=${FROM_EMAIL},ReplyToEmailAddress=${FROM_EMAIL}" \
  --lambda-config "$LAMBDA_CONFIG_ARGS"

echo ""
echo "Done."
echo "  • Verification emails send from: $FROM_EMAIL (SES)"
echo "  • PreSignUp: $LAMBDA_ARN (account confirmed; email_verified=false until code entered)"
echo "  • Existing UNCONFIRMED users still cannot sign in — delete them in Cognito or confirm manually"
echo ""
echo "If SES is in sandbox, mail only delivers to verified recipients."
echo "Request production access in SES before expecting delivery to arbitrary student emails."
