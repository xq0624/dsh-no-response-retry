# dsh-no-response-retry 一键安装脚本（Windows PowerShell 5.1+）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1                     # 安装到 desktop profile
#   powershell ... -File install.ps1 -ProfileName web                                   # 安装到其他 profile
#   powershell ... -File install.ps1 -DshDir "D:\Program Files (x86)\DSH"              # 指定 dsh 安装目录
#   powershell ... -File install.ps1 -Remove                                            # 从 profile 卸载
# 完成后重启 DeepSeek Harness 生效。
[CmdletBinding()]
param(
	[string]$ProfileName = "desktop",
	[string]$DshDir = "",
	[string]$Tarball = "",
	[switch]$Remove
)

$ErrorActionPreference = "Stop"
$PluginName = "dsh-no-response-retry"
if (-not $Tarball) { $Tarball = Join-Path $PSScriptRoot "$PluginName-0.1.0.tgz" }

function Find-DshDir {
	if ($DshDir) {
		if (Test-Path (Join-Path $DshDir "DeepSeek Harness.exe")) { return $DshDir }
		throw "指定的 -DshDir 下没有 DeepSeek Harness.exe：$DshDir"
	}
	$roots = @("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
		"HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
		"HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*")
	foreach ($root in $roots) {
		$key = Get-ItemProperty $root -ErrorAction SilentlyContinue |
			Where-Object { $_.DisplayName -like "DeepSeek Harness*" } |
			Select-Object -First 1
		if ($key) {
			foreach ($raw in @($key.InstallLocation, $key.DisplayIcon)) {
				if (-not $raw) { continue }
				$candidate = ($raw -replace ',\d*\s*$', "").Trim('"').Trim()
				if ($candidate -and (Test-Path (Join-Path $candidate "DeepSeek Harness.exe"))) { return $candidate }
			}
		}
	}
	foreach ($candidate in @(
		"${env:ProgramFiles(x86)}\DSH",
		"$env:ProgramFiles\DSH",
		"D:\Program Files (x86)\DSH",
		"C:\Program Files (x86)\DSH",
		"$env:LOCALAPPDATA\Programs\DSH")) {
		if ($candidate -and (Test-Path (Join-Path $candidate "DeepSeek Harness.exe"))) { return $candidate }
	}
	throw "找不到 DeepSeek Harness 安装目录；请用 -DshDir 参数指定，例如：-DshDir 'D:\Program Files (x86)\DSH'"
}

function Find-PnpmMjs($dsh) {
	$candidates = @(
		(Join-Path $dsh "resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"),
		(Join-Path $dsh "resources\app\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"),
		(Join-Path $dsh "resources\app.asar.unpacked\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"))
	foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
	$found = Get-ChildItem (Join-Path $dsh "resources") -Recurse -Filter "pnpm.mjs" -ErrorAction SilentlyContinue |
		Where-Object { $_.FullName -like "*primary-runtime*" } | Select-Object -First 1
	if ($found) { return $found.FullName }
	throw "在 $dsh 下找不到自带的 pnpm.mjs"
}

# 用 dsh 自带的 Electron 运行时当 node 执行 JS（与官方插件管理器同一招）。
# Electron 是 GUI 子系统进程，PowerShell 的 & 不等它结束；必须 Start-Process -Wait，
# 否则会读到写了一半的文件。返回真实退出码。
function Invoke-DshNode($dsh, $arguments) {
	$exe = Join-Path $dsh "DeepSeek Harness.exe"
	$out = [IO.Path]::GetTempFileName()
	$err = [IO.Path]::GetTempFileName()
	$quoted = @("--expose-internals") + ($arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' })
	$previous = $env:ELECTRON_RUN_AS_NODE
	$env:ELECTRON_RUN_AS_NODE = "1"
	try {
		$process = Start-Process -FilePath $exe -ArgumentList $quoted -Wait -PassThru `
			-RedirectStandardOutput $out -RedirectStandardError $err
		Get-Content $out -ErrorAction SilentlyContinue | Write-Host
		Get-Content $err -ErrorAction SilentlyContinue | Write-Host
		return $process.ExitCode
	} finally {
		Remove-Item $out, $err -ErrorAction SilentlyContinue
		$env:ELECTRON_RUN_AS_NODE = $previous
	}
}

Write-Host "== dsh-no-response-retry 安装器 =="
$dsh = Find-DshDir
$pnpmMjs = Find-PnpmMjs $dsh
$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $home_ "profiles\$ProfileName"
$pkgPath = Join-Path $profileDir "package.json"

if (-not (Test-Path $pkgPath)) { throw "profile '$ProfileName' 不存在（$profileDir）。请先启动一次 dsh 让它创建 profile，或确认 -ProfileName 拼写。" }
if (-not (Test-Path $Tarball)) { throw "找不到插件包：$Tarball" }

Write-Host "dsh 目录 : $dsh"
Write-Host "profile  : $profileDir"
$installedMarker = Join-Path $profileDir "node_modules\$PluginName\package.json"
if ($Remove) {
	Write-Host "== 卸载 $PluginName =="
	for ($attempt = 1; $attempt -le 2; $attempt++) {
		Push-Location $profileDir
		try { Invoke-DshNode $dsh @($pnpmMjs, "remove", $PluginName) | Out-Null } finally { Pop-Location }
		if (-not (Test-Path $installedMarker)) { break }
		if ($attempt -eq 1) {
			Write-Host "文件似乎被占用，2 秒后重试一次（若再次失败请先完全退出 dsh）……"
			Start-Sleep -Seconds 2
		}
	}
	if (Test-Path $installedMarker) { throw "pnpm remove 未成功（$installedMarker 仍存在）。请先完全退出 DeepSeek Harness（含托盘）再运行本脚本。" }
} else {
	Write-Host "== 安装 $PluginName =="
	Push-Location $profileDir
	try { Invoke-DshNode $dsh @($pnpmMjs, "add", $Tarball) | Out-Null } finally { Pop-Location }
	if (-not (Test-Path $installedMarker)) { throw "pnpm add 未成功（$installedMarker 不存在），请把上面的 pnpm 输出发给我看。" }
}

# 维护 dsh.profile.bundles 列表（pnpm 不认识这个字段）
$helper = Join-Path $env:TEMP "dsh-set-bundle.mjs"
@'
import { readFileSync, writeFileSync } from "node:fs";
const [pkgPath, name, remove] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.dsh = pkg.dsh ?? {};
pkg.dsh.profile = pkg.dsh.profile ?? {};
const bundles = pkg.dsh.profile.bundles ?? (pkg.dsh.profile.bundles = []);
const index = bundles.indexOf(name);
if (remove === "remove") {
	if (index >= 0) bundles.splice(index, 1);
} else if (index < 0) {
	bundles.push(name);
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`bundles: ${JSON.stringify(pkg.dsh.profile.bundles)}`);
'@ | Set-Content -Path $helper -Encoding ASCII
$helperExit = Invoke-DshNode $dsh @($helper, $pkgPath, $PluginName, $(if ($Remove) { "remove" } else { "keep" }))
if ($helperExit -ne 0) { throw "维护 dsh.profile.bundles 失败（退出码 $helperExit）" }
$pkgCheck = Get-Content $pkgPath -Raw | ConvertFrom-Json
$hasBundle = @($pkgCheck.dsh.profile.bundles) -contains $PluginName
if ($Remove -eq $hasBundle) { throw "维护 dsh.profile.bundles 未达预期（bundles=$($pkgCheck.dsh.profile.bundles -join ', ')）" }

if (Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue) {
	Write-Host ""
	Write-Host "提示：dsh 正在运行。请退出并重新打开 DeepSeek Harness（托盘图标也要退出），插件才会加载/移除。"
}
if ($Remove) { Write-Host "完成：已从 $ProfileName 卸载。" } else { Write-Host "完成：已安装到 $ProfileName。重启 dsh 即生效。" }
