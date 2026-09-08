# Admin console deployment

The public admin UI is `/admin/`; its editing and sending actions are served by the
protected `chbe-admin` Lambda. A valid Cognito ID token and the required group are
checked for every request. Do not put AWS or GitHub credentials in `PUBLIC_*` values.

## 1. Cognito groups

Run the following from Git Bash/WSL while authenticated to the existing `us-east-2`
AWS account:

```sh
./aws/scripts/create-admin-groups.sh
```

Add every console operator to `superusers` and only the work-area group(s) they need:
`merch`, `lockers`, `notifications`, `members`, `events`, `resources`, or `admin`.
`admin` grants Cognito group management only. A user must sign out and sign back in
after their membership changes before their token carries the new claim.

## 2. GitHub App

Create and install a GitHub App for this repository, not a personal access token.
Grant repository permissions:

- Contents: Read and write
- Actions: Read and write
- Metadata: Read-only

Generate a private key and store its full PEM value in AWS Secrets Manager. The
Lambda role may read only that one secret. The App’s installation ID, App ID, owner,
repository, and branch are configuration values, not browser secrets.

## 3. Email

Verify the `ubcchbecouncil.com` SES domain in `us-east-2`, then confirm
`notifications@ubcchbecouncil.com` is an authorized From address for that identity.
Request SES production access before sending to normal student addresses. The
notification service sends one individualized email per deduplicated recipient and
always includes subscription-management and contact links.

## 4. Deploy

Set the GitHub App values, then run:

```sh
export GITHUB_APP_ID=...
export GITHUB_INSTALLATION_ID=...
export GITHUB_OWNER=...
export GITHUB_REPO=...
export GITHUB_PRIVATE_KEY_SECRET_ID=...
./aws/scripts/setup-admin.sh
```

The script creates `locker-changes` and `admin-audit` on-demand DynamoDB tables,
the `chbe-ses-send` email queue and dead-letter queue, deploys the Lambda Function
URL, and prints `PUBLIC_ADMIN_API_URL`. Notification emails are delivered in batches
of six per second. Set that value locally and as the GitHub repository secret
`PUBLIC_ADMIN_API_URL`; the Pages workflows already pass it to the Astro build.

After deploying the admin service, re-run `./aws/scripts/setup-orders.sh` so order
emails also use the same queue and rate limit.

Stock updates are written to DynamoDB first and dispatch the existing
`sync-inventory.yml` workflow to reconcile `merch.csv` and `lockers.csv`, commit the
result, and redeploy Pages. Other editor changes and image uploads commit through the
GitHub App and use the normal Pages deployment workflow.
