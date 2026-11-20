param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('Foundations','BuildImage','Configure','Bootstrap','Seed','Workloads','Run','Verify','WebCheck')]
    [string]$Phase,
    [string]$SubscriptionId = '9be1289f-3360-481b-9f14-b3f065b28177',
    [string]$ResourceGroup = 'at-fileslm-test-rg',
    [string]$Prefix = 'atfileslm1120',
    [string]$Location = 'japaneast',
    [string]$ImageTag = 'web-20261120-3',
    [string]$AuthenticationClientId = 'bf654a82-da62-4163-91c8-bd5adcb24936'
)
$ErrorActionPreference = 'Stop'
$env:AZURE_CORE_ONLY_SHOW_ERRORS = 'true'
$env:AZURE_BICEP_CHECK_VERSION = 'false'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))

function Invoke-Azure([string[]]$Arguments) {
    $result = & az @Arguments --subscription $SubscriptionId --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Azure command failed in phase $Phase; inspect its error above." }
    return ($result -join "`n")
}
function Get-AzureObject([string[]]$Arguments) {
    return (Invoke-Azure ($Arguments + @('-o','json')) | ConvertFrom-Json)
}
function Deploy-Template([string]$Name, [string]$Template, [string[]]$Parameters) {
    $base = @('deployment','group','what-if','-g',$ResourceGroup,'-n',$Name,
        '--template-file',$Template,'--parameters') + $Parameters
    $null = Invoke-Azure ($base + @('--no-pretty-print','--query','changes[].changeType','-o','json'))
    $base[2] = 'create'
    $null = Invoke-Azure ($base + @('-o','none'))
}
function Start-AndWait([string]$Job) {
    $execution = Get-AzureObject @('containerapp','job','start','-g',$ResourceGroup,'-n',$Job)
    Write-Output "Execution: $($execution.name)"
    $deadline = (Get-Date).AddMinutes(15)
    do {
        Start-Sleep -Seconds 10
        $status = Invoke-Azure @('containerapp','job','execution','show','-g',$ResourceGroup,
            '-n',$Job,'--job-execution-name',$execution.name,'--query','properties.status','-o','tsv')
        if ($status -eq 'Succeeded') {
            Write-Output "Succeeded: $($execution.name)"
            return
        }
        if ($status -in @('Failed','Degraded','Canceled','Stopped')) {
            throw "Execution $($execution.name) ended with $status; inspect Container Apps logs."
        }
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for $($execution.name); no automatic start retry was submitted."
}

$accountJson = & az account show --only-show-errors -o json
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Azure subscription.' }
$account = $accountJson | ConvertFrom-Json
if ($account.id -ne $SubscriptionId) { throw 'Select the approved subscription with az account set first.' }
$userJson = & az ad signed-in-user show --only-show-errors -o json
if ($LASTEXITCODE -ne 0) { throw 'Unable to identify signed-in operator.' }
$user = $userJson | ConvertFrom-Json
if ($Phase -eq 'Foundations') {
    $null = Invoke-Azure @('group','create','-n',$ResourceGroup,'-l',$Location,'-o','none')
    Deploy-Template "$Prefix-foundations" '.\infra\web-demo\main.bicep' @(
        "prefix=$Prefix","operatorObjectId=$($user.id)","operatorName=$($user.userPrincipalName)","location=$Location")
    Write-Output 'Foundations deployed.'
    exit 0
}
$deployment = Get-AzureObject @('deployment','group','show','-g',$ResourceGroup,'-n',"$Prefix-foundations")
$outputs = @{}
$deployment.properties.outputs.PSObject.Properties | ForEach-Object { $outputs[$_.Name] = $_.Value.value }

if ($Phase -eq 'BuildImage') {
    $status = Invoke-Azure @('acr','build','--registry',$outputs.registryName,
        '--image',"archive-console:$ImageTag",'--platform','linux','--file','.\app\Dockerfile',
        '--no-logs','--query','status','-o','tsv','.')
    if ($status -ne 'Succeeded') { throw "Image build did not succeed: $status" }
    Write-Output "Built immutable image archive-console:$ImageTag"
} elseif ($Phase -eq 'Configure') {
    $env:AUTH_MODE = 'azure-cli'
    $env:APP_CONFIG_ENDPOINT = $outputs.configEndpoint
    $env:TEST_STORAGE_ACCOUNT = $outputs.storageName
    & node .\job\scripts\azure-web-demo.mjs configure
    if ($LASTEXITCODE -ne 0) { throw 'Initial settings publication failed.' }
} elseif ($Phase -eq 'Workloads') {
    $origin = "https://$Prefix-web.$($outputs.domain)"
    $callback = "$origin/.auth/login/aad/callback"
    $appJson = & az ad app show --id $AuthenticationClientId --only-show-errors -o json
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect dedicated Entra application.' }
    $app = $appJson | ConvertFrom-Json
    if ($app.signInAudience -ne 'AzureADMyOrg') { throw 'Expected a single-tenant Entra application.' }
    $redirects = @($app.web.redirectUris) + @($callback) | Select-Object -Unique
    & az ad app update --id $AuthenticationClientId --web-redirect-uris @redirects --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Callback registration failed.' }
    $credentialJson = & az ad app credential reset --id $AuthenticationClientId --append `
        --display-name "archive-console-$ImageTag" `
        --end-date ((Get-Date).ToUniversalTime().AddDays(180).ToString('yyyy-MM-ddTHH:mm:ssZ')) `
        --only-show-errors -o json
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create Easy Auth application credential.' }
    $secret = ($credentialJson | ConvertFrom-Json).password
    try {
        Deploy-Template "$Prefix-workloads" '.\infra\web-demo\workloads.bicep' @(
            "prefix=$Prefix","environmentId=$($outputs.environmentId)","domain=$($outputs.domain)",
            "registryServer=$($outputs.registryServer)","imageTag=$ImageTag",
            "configEndpoint=$($outputs.configEndpoint)","databaseHost=$($outputs.databaseHost)",
            "jobIdentityId=$($outputs.jobIdentityId)","jobClientId=$($outputs.jobClientId)",
            "webIdentityId=$($outputs.webIdentityId)","webClientId=$($outputs.webClientId)",
            "webPrincipalId=$($outputs.webPrincipalId)","allowedUserId=$($user.id)",
            "authenticationClientId=$AuthenticationClientId","authenticationClientSecret=$secret")
    } finally { $secret = $null; $credentialJson = $null }
    Write-Output "Web URL: $origin"
} elseif ($Phase -eq 'Run') {
    $setting = Invoke-Azure @('appconfig','kv','show','--endpoint',$outputs.configEndpoint,
        '--auth-mode','login','--key','archive:settings','--label','validation','--query','value','-o','tsv')
    if (($setting | ConvertFrom-Json).dryRun -ne $true) { throw 'Refusing to start a non-dry-run job.' }
    Start-AndWait "$Prefix-job"
} else {
    $mode = @{ Bootstrap='bootstrap'; Seed='seed'; Verify='verify'; WebCheck='web-check' }[$Phase]
    $webCheck = $Phase -eq 'WebCheck'
    $identity = $outputs.jobIdentityId
    $client = $outputs.jobClientId
    $dbUser = 'archive_job'
    if ($webCheck) { $identity=$outputs.webIdentityId; $client=$outputs.webClientId; $dbUser='archive_web' }
    $parameters = @(
        "prefix=$Prefix","environmentId=$($outputs.environmentId)","registryServer=$($outputs.registryServer)",
        "imageTag=$ImageTag","identityId=$identity","clientId=$client","databaseHost=$($outputs.databaseHost)",
        "configEndpoint=$($outputs.configEndpoint)","storageName=$($outputs.storageName)",
        "jobPrincipalId=$($outputs.jobPrincipalId)","webPrincipalId=$($outputs.webPrincipalId)",
        "adminName=$($user.userPrincipalName)","databaseUser=$dbUser","mode=$mode")
    $token = $null
    try {
        if ($Phase -eq 'Bootstrap') {
            $token = Invoke-Azure @('account','get-access-token','--resource',
                'https://ossrdbms-aad.database.windows.net','--query','accessToken','-o','tsv')
        }
        Deploy-Template "$Prefix-helper" '.\infra\web-demo\helper.bicep' ($parameters + @("adminToken=$token"))
        Start-AndWait "$Prefix-helper"
    } finally {
        if ($Phase -eq 'Bootstrap') {
            # Clear both the secret and its environment reference, even if bootstrap fails.
            Deploy-Template "$Prefix-helper" '.\infra\web-demo\helper.bicep' ($parameters + @('adminToken='))
        }
        $token = $null
    }
}
