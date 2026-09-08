<#
Deploy the protected CHBE admin Lambda Function URL from Windows PowerShell.
Required environment variables:
  GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_OWNER, GITHUB_REPO,
  GITHUB_PRIVATE_KEY_SECRET_ID
#>
[CmdletBinding()]
param(
  [string]$Region = "us-east-2",
  [string]$LambdaName = "chbe-admin",
  [string]$RoleName = "chbe-admin-lambda-role",
  [string]$UserPoolId = "us-east-2_HeZCWYUt3",
  [string]$ClientId = "285b5dv7j67uos6r1rcv572bo5",
  [string]$InventoryTable = "inventory",
  [string]$LockerChangesTable = "locker-changes",
  [string]$AdminAuditTable = "admin-audit",
  [string]$SesFrom = "UBC CHBE Council Notifications <notifications@ubcchbecouncil.com>",
  [string]$EmailQueueName = "chbe-ses-send",
  [string]$EmailDlqName = "chbe-ses-send-dlq",
  [string]$SiteUrl = "https://ubcchbecouncil.com",
  [string]$GithubBranch = "main",
  [string]$AllowedOrigins = "https://ubcchbecouncil.com,https://www.ubcchbecouncil.com,http://localhost:4321,http://localhost:3001"
)
$ErrorActionPreference = "Continue"

$required = "GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_PRIVATE_KEY_SECRET_ID"
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Set $name before running this script."
  }
}

function Test-AwsResource([string[]]$Arguments) {
  & aws @Arguments 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

function Ensure-Table([string]$Name, [string]$Key) {
  if (-not (Test-AwsResource @("dynamodb", "describe-table", "--region", $Region, "--table-name", $Name))) {
    & aws dynamodb create-table --region $Region --table-name $Name `
      --attribute-definitions "AttributeName=$Key,AttributeType=S" `
      --key-schema "AttributeName=$Key,KeyType=HASH" --billing-mode PAY_PER_REQUEST | Out-Null
    & aws dynamodb wait table-exists --region $Region --table-name $Name
  }
}

$accountId = (& aws sts get-caller-identity --query Account --output text).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not determine the AWS account." }
$scriptRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$lambdaDir = Join-Path $repoRoot "aws\lambdas\admin"
$buildDir = Join-Path $scriptRoot ".admin-build"
$zipPath = Join-Path $buildDir "$LambdaName.zip"
$environmentPath = Join-Path $buildDir "$LambdaName-env.json"
$policyPath = Join-Path $buildDir "$LambdaName-policy.json"
$corsPath = Join-Path $buildDir "$LambdaName-cors.json"
$trustPath = Join-Path $buildDir "$LambdaName-trust.json"
$queueAttributesPath = Join-Path $buildDir "$LambdaName-queue-attributes.json"
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

Ensure-Table $LockerChangesTable "changeId"
Ensure-Table $AdminAuditTable "auditId"

$emailDlqUrl = (& aws sqs get-queue-url --region $Region --queue-name $EmailDlqName --query QueueUrl --output text 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $emailDlqUrl) {
  $emailDlqUrl = (& aws sqs create-queue --region $Region --queue-name $EmailDlqName --attributes VisibilityTimeout=360,ReceiveMessageWaitTimeSeconds=20,MessageRetentionPeriod=1209600,SqsManagedSseEnabled=true --query QueueUrl --output text).Trim()
}
$emailDlqArn = (& aws sqs get-queue-attributes --region $Region --queue-url $emailDlqUrl --attribute-names QueueArn --query "Attributes.QueueArn" --output text).Trim()
$queueAttributes = @{
  VisibilityTimeout = "360"; ReceiveMessageWaitTimeSeconds = "20"; MessageRetentionPeriod = "1209600"; SqsManagedSseEnabled = "true"
  RedrivePolicy = (@{ deadLetterTargetArn = $emailDlqArn; maxReceiveCount = "3" } | ConvertTo-Json -Compress)
}
$queueAttributes | ConvertTo-Json -Compress | Set-Content -Path $queueAttributesPath -NoNewline
$emailQueueUrl = (& aws sqs get-queue-url --region $Region --queue-name $EmailQueueName --query QueueUrl --output text 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or -not $emailQueueUrl) {
  $emailQueueUrl = (& aws sqs create-queue --region $Region --queue-name $EmailQueueName --attributes "file://$queueAttributesPath" --query QueueUrl --output text).Trim()
} else {
  & aws sqs set-queue-attributes --region $Region --queue-url $emailQueueUrl --attributes "file://$queueAttributesPath" | Out-Null
}
$emailQueueArn = (& aws sqs get-queue-attributes --region $Region --queue-url $emailQueueUrl --attribute-names QueueArn --query "Attributes.QueueArn" --output text).Trim()

if (-not (Test-AwsResource @("iam", "get-role", "--role-name", $RoleName))) {
  $trust = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  Set-Content -Path $trustPath -Value $trust -NoNewline
  & aws iam create-role --role-name $RoleName --assume-role-policy-document "file://$trustPath" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not create IAM role $RoleName." }
  & aws iam attach-role-policy --role-name $RoleName --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  if ($LASTEXITCODE -ne 0) { throw "Could not attach Lambda logging policy." }
  Start-Sleep -Seconds 10
}

$secretArn = (& aws secretsmanager describe-secret --region $Region --secret-id $env:GITHUB_PRIVATE_KEY_SECRET_ID --query ARN --output text).Trim()
if ($LASTEXITCODE -ne 0) { throw "The GitHub App private-key secret could not be found." }
$policy = @{
  Version = "2012-10-17"
  Statement = @(
    @{
      Sid = "InventoryAndAudit"; Effect = "Allow"
      Action = @("dynamodb:PutItem", "dynamodb:Scan", "dynamodb:TransactWriteItems")
      Resource = @(
        "arn:aws:dynamodb:$Region`:$accountId`:table/$InventoryTable",
        "arn:aws:dynamodb:$Region`:$accountId`:table/$LockerChangesTable",
        "arn:aws:dynamodb:$Region`:$accountId`:table/$AdminAuditTable"
      )
    },
    @{
      Sid = "InventoryDelete"; Effect = "Allow"
      Action = "dynamodb:DeleteItem"
      Resource = "arn:aws:dynamodb:$Region`:$accountId`:table/$InventoryTable"
    },
    @{
      Sid = "EmailQueue"; Effect = "Allow"
      Action = @("sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes")
      Resource = $emailQueueArn
    },
    @{
      Sid = "CognitoGroups"; Effect = "Allow"
      Action = @("cognito-idp:ListUsers", "cognito-idp:ListGroups", "cognito-idp:ListUsersInGroup", "cognito-idp:AdminListGroupsForUser", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup")
      Resource = "arn:aws:cognito-idp:$Region`:$accountId`:userpool/$UserPoolId"
    },
    @{ Sid = "ReadGitHubKey"; Effect = "Allow"; Action = "secretsmanager:GetSecretValue"; Resource = $secretArn },
    @{ Sid = "Notifications"; Effect = "Allow"; Action = @("ses:SendEmail", "ses:SendRawEmail"); Resource = "*" }
  )
}
$policy | ConvertTo-Json -Depth 8 | Set-Content -Path $policyPath -NoNewline
& aws iam put-role-policy --role-name $RoleName --policy-name "$LambdaName-access" --policy-document "file://$policyPath" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not set the admin Lambda access policy." }
$roleArn = (& aws iam get-role --role-name $RoleName --query Role.Arn --output text).Trim()
if ($LASTEXITCODE -ne 0 -or -not $roleArn) { throw "Could not read IAM role $RoleName." }

Push-Location $lambdaDir
try {
  & npm ci --omit=dev --no-fund --no-audit
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $lambdaDir "*") -DestinationPath $zipPath -Force
} finally {
  Pop-Location
}

$lambdaEnvironment = @{
  Variables = @{
    COGNITO_USER_POOL_ID = $UserPoolId; COGNITO_CLIENT_ID = $ClientId
    INVENTORY_TABLE = $InventoryTable; LOCKER_CHANGES_TABLE = $LockerChangesTable; ADMIN_AUDIT_TABLE = $AdminAuditTable
    SES_FROM = $SesFrom; EMAIL_QUEUE_URL = $emailQueueUrl; SITE_URL = $SiteUrl
    GITHUB_APP_ID = $env:GITHUB_APP_ID; GITHUB_INSTALLATION_ID = $env:GITHUB_INSTALLATION_ID
    GITHUB_OWNER = $env:GITHUB_OWNER; GITHUB_REPO = $env:GITHUB_REPO; GITHUB_BRANCH = $GithubBranch
    GITHUB_PRIVATE_KEY_SECRET_ID = $env:GITHUB_PRIVATE_KEY_SECRET_ID
  }
}
$lambdaEnvironment | ConvertTo-Json -Depth 5 | Set-Content -Path $environmentPath -NoNewline
if (Test-AwsResource @("lambda", "get-function", "--function-name", $LambdaName, "--region", $Region)) {
  & aws lambda update-function-code --function-name $LambdaName --region $Region --zip-file "fileb://$zipPath" | Out-Null
  & aws lambda wait function-updated --function-name $LambdaName --region $Region
  & aws lambda update-function-configuration --function-name $LambdaName --region $Region --timeout 60 --memory-size 512 --environment "file://$environmentPath" | Out-Null
} else {
  & aws lambda create-function --function-name $LambdaName --region $Region --runtime nodejs20.x --handler index.handler `
    --role $roleArn --timeout 60 --memory-size 512 --environment "file://$environmentPath" --zip-file "fileb://$zipPath" | Out-Null
}
& aws lambda wait function-active --function-name $LambdaName --region $Region
$eventSourceMappingId = (& aws lambda list-event-source-mappings --function-name $LambdaName --event-source-arn $emailQueueArn --query "EventSourceMappings[0].UUID" --output text).Trim()
if ($LASTEXITCODE -eq 0 -and $eventSourceMappingId -and $eventSourceMappingId -ne "None") {
  & aws lambda update-event-source-mapping --uuid $eventSourceMappingId --batch-size 6 --maximum-batching-window-in-seconds 1 --scaling-config MaximumConcurrency=1 --function-response-types ReportBatchItemFailures | Out-Null
} else {
  & aws lambda create-event-source-mapping --function-name $LambdaName --event-source-arn $emailQueueArn --batch-size 6 --maximum-batching-window-in-seconds 1 --scaling-config MaximumConcurrency=1 --function-response-types ReportBatchItemFailures | Out-Null
}

$cors = @{ AllowOrigins = @($AllowedOrigins.Split(",").Trim() | Where-Object { $_ }); AllowMethods = @("GET", "POST"); AllowHeaders = @("content-type", "authorization"); MaxAge = 86400 }
$cors | ConvertTo-Json -Depth 4 | Set-Content -Path $corsPath -NoNewline
if (-not (Test-AwsResource @("lambda", "get-function-url-config", "--function-name", $LambdaName, "--region", $Region))) {
  & aws lambda create-function-url-config --function-name $LambdaName --region $Region --auth-type NONE --cors "file://$corsPath" | Out-Null
  & aws lambda add-permission --function-name $LambdaName --region $Region --statement-id FunctionURLAllowPublicInvoke --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE 2>$null
  & aws lambda add-permission --function-name $LambdaName --region $Region --statement-id FunctionURLAllowInvokeFunction --action lambda:InvokeFunction --principal "*" --invoked-via-function-url 2>$null
} else {
  & aws lambda update-function-url-config --function-name $LambdaName --region $Region --auth-type NONE --cors "file://$corsPath" | Out-Null
}
$url = ((& aws lambda get-function-url-config --function-name $LambdaName --region $Region --query FunctionUrl --output text).Trim()).TrimEnd("/")
Write-Output "Admin API deployed: $url"
Write-Output "Set PUBLIC_ADMIN_API_URL=$url locally and as a GitHub Pages build secret."
