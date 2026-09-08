#!/usr/bin/env bash
# Create the Cognito groups used by the CHBE admin console.
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
USER_POOL_ID="${COGNITO_USER_POOL_ID:-us-east-2_HeZCWYUt3}"

for group in superusers merch lockers notifications members events resources admin; do
  if aws cognito-idp get-group --region "$REGION" --user-pool-id "$USER_POOL_ID" --group-name "$group" >/dev/null 2>&1; then
    echo "Exists: $group"
  else
    aws cognito-idp create-group --region "$REGION" --user-pool-id "$USER_POOL_ID" --group-name "$group" >/dev/null
    echo "Created: $group"
  fi
done

echo "Add each operator to superusers plus only their permitted workspace groups."
