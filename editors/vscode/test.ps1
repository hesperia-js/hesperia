param([string]$CodePath = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'))
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $CodePath)) { throw 'VS Code is required. Supply its Code.exe path with -CodePath.' }
$extensionRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $extensionRoot '..\..'))
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryBase ('hesperia-vscode-' + [guid]::NewGuid().ToString('N'))
$testRoot = [System.IO.Path]::GetFullPath($testRoot)
if (-not $testRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid test workspace path.' }
$passed = $false
$testProcess = $null
try {
  New-Item -ItemType Directory -Path (Join-Path $testRoot 'src'), (Join-Path $testRoot 'node_modules') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $testRoot 'node_modules\hesperia') -Target $packageRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $testRoot 'package.json') -Encoding UTF8 -Value '{"name":"hesperia-editor-test","private":true,"type":"module"}'
  [System.IO.File]::WriteAllText((Join-Path $testRoot 'hesperia.config.json'), '')
  Set-Content -LiteralPath (Join-Path $testRoot 'tsconfig.json') -Encoding UTF8 -Value '{"compilerOptions":{"strict":true,"skipLibCheck":true,"lib":["ESNext","DOM"],"target":"ESNext","module":"ESNext","moduleResolution":"Bundler","types":[]}}'
  $cat = [char]::ConvertFromUtf32(0x1F408)
  $apiSource = 'export const message = "ready";'
  $shellSource = 'import { message } from "./api";' + "`r`n" + 'export default function App(){ return <html><head><title>Shell</title></head><body><main>{message}</main></body></html>; }'
  $source = 'import { message } from "../api"; export function App(){' + "`r`n" + ' const emoji = "' + $cat + '"; const field = <input />;' + "`r`n" + ' return <div title={field.value}>{message}{field.missing()}</div>;' + "`r`n" + '}'
  Set-Content -LiteralPath (Join-Path $testRoot 'api.ts') -Encoding UTF8 -Value $apiSource
  Set-Content -LiteralPath (Join-Path $testRoot 'app.tsx') -Encoding UTF8 -Value $shellSource
  Set-Content -LiteralPath (Join-Path $testRoot 'src\App.tsx') -Encoding UTF8 -Value $source
  $arguments = @(
    ('--extensionDevelopmentPath="' + $extensionRoot + '"'),
    ('--extensionTestsPath="' + (Join-Path $extensionRoot 'dist\test-host.cjs') + '"'),
    ('--user-data-dir="' + (Join-Path $testRoot 'user-data') + '"'),
    ('--extensions-dir="' + (Join-Path $testRoot 'extensions') + '"'),
    '--disable-workspace-trust', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--new-window',
    ('"' + $testRoot + '"')
  )
  $testProcess = Start-Process -FilePath $CodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $testProcess.WaitForExit(45000)) { throw 'VS Code extension tests exceeded 45 seconds.' }
  $result = Get-Content -LiteralPath (Join-Path $testRoot 'editor-result.json') -Raw | ConvertFrom-Json
  if (-not $result.passed) { throw $result.error }
  $passed = $true
  Write-Output ('VS Code extension checks passed: ' + ($result.checks -join ', '))
} finally {
  if ($null -ne $testProcess -and -not $testProcess.HasExited) { Stop-Process -Id $testProcess.Id -Force }
  $junction = Join-Path $testRoot 'node_modules\hesperia'
  if (Test-Path -LiteralPath $junction) { (Get-Item -LiteralPath $junction).Delete() }
  if ($passed) {
    if (-not $testRoot.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or -not ([System.IO.Path]::GetFileName($testRoot)).StartsWith('hesperia-vscode-')) { throw 'Refusing invalid cleanup path.' }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  } else { Write-Output ('Test evidence retained in ' + $testRoot) }
}
