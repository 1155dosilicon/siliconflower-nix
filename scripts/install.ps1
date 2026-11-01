# Instala o binário standalone do Siliconflower no PATH do usuário (sem admin).
# Copia dist/siliconflower.exe para $InstallDir e adiciona ao PATH (User scope).
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
#   npm run install:bin

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\siliconflower")
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "dist\siliconflower.exe"

if (-not (Test-Path -LiteralPath $source)) {
    Write-Error "Binário não encontrado em: $source`nRode 'bun run build' primeiro."
    exit 1
}

# Garante o diretório de destino
if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Copia o binário (sobrescreve versão anterior)
Copy-Item -LiteralPath $source -Destination $InstallDir -Force
Write-Host "[ok] binário copiado para: $InstallDir\siliconflower.exe" -ForegroundColor Green

# Adiciona ao PATH do usuário (escopo User, sem admin). Preserva o tipo do
# registro (REG_EXPAND_SZ) para não quebrar entradas com %VARIÁVEL%; faz
# fallback para a API .NET (REG_SZ) se o acesso ao registro falhar.
$regKey = "HKCU:\Environment"
$installDirNorm = $InstallDir.TrimEnd("\")

function Add-ToUserPath {
    param([string]$Dir)
    # Lê o valor bruto (sem expandir) e o tipo original para preservá-lo.
    $key = Get-Item -LiteralPath $regKey
    $rawPath = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (-not $rawPath) { $rawPath = "" }
    $existing = $rawPath.Split([char]";", [System.StringSplitOptions]::RemoveEmptyEntries) |
                ForEach-Object { $_.TrimEnd("\") }
    if ($existing -notcontains $Dir) {
        $newPath = if ($rawPath) { "$rawPath;$Dir" } else { $Dir }
        $kind = "ExpandString"
        try { $kind = $key.GetValueKind("Path") } catch { }
        New-ItemProperty -LiteralPath $regKey -Name "Path" -Value $newPath -PropertyType $kind -Force | Out-Null
        Write-Host "[ok] '$Dir' adicionado ao PATH do usuário (tipo $kind preservado)." -ForegroundColor Green
        Write-Host "     (abra um NOVO terminal para a alteração ter efeito)" -ForegroundColor Yellow
    } else {
        Write-Host "[skip] '$Dir' já está no PATH do usuário." -ForegroundColor DarkGray
    }
}

try {
    Add-ToUserPath -Dir $installDirNorm
} catch {
    # Fallback: API .NET (escreve REG_SZ; adequado para entradas com caminhos absolutos)
    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    $paths = $userPath.Split([char]";", [System.StringSplitOptions]::RemoveEmptyEntries) |
             ForEach-Object { $_.TrimEnd("\") }
    if ($paths -notcontains $installDirNorm) {
        $newPath = if ($userPath) { "$userPath;$InstallDir" } else { $InstallDir }
        [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "[ok] '$InstallDir' adicionado ao PATH do usuário (fallback REG_SZ)." -ForegroundColor Green
        Write-Host "     (abra um NOVO terminal para a alteração ter efeito)" -ForegroundColor Yellow
    } else {
        Write-Host "[skip] '$InstallDir' já está no PATH do usuário." -ForegroundColor DarkGray
    }
}

# Atualiza a sessão atual para validar imediatamente
if (($env:Path.Split(";") | ForEach-Object { $_.TrimEnd("\") }) -notcontains $InstallDir.TrimEnd("\")) {
    $env:Path = "$env:Path;$InstallDir"
}

Write-Host ""
Write-Host "Pronto. Em um novo terminal rode:" -ForegroundColor Cyan
Write-Host "    siliconflower --version"
Write-Host "    siliconflower            # inicia a TUI (wizard na 1ª vez)"
Write-Host "    siliconflower config     # reconfigurar"
