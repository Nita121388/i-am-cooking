#Requires -Version 5.1
# Windows volume control via Core Audio API
# Actions: save (read current + set target), restore (recover saved)
param(
  [Parameter(Mandatory=$true)][ValidateSet("save","restore")][string]$Action,
  [Parameter(Mandatory=$false)][double]$Level = 0.8,
  [Parameter(Mandatory=$true)][string]$SaveFile
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int NotImpl5();
    int GetMasterVolumeLevelScalar(out float pfLevel);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}
"@

$enumerator = New-Object -ComObject MMDeviceEnumerator
$device = $null
[void]$enumerator.GetDefaultAudioEndpoint(0, 1, [ref]$device)

$iid = [Guid]"5CDF2C82-841E-4546-9722-0CF74078229A"
$volume = $null
[void]$device.Activate([ref]$iid, 1, [IntPtr]::Zero, [ref]$volume)

$current = [float]0
[void]$volume.GetMasterVolumeLevelScalar([ref]$current)

switch ($Action) {
    "save" {
        # Save original then boost only if target is higher
        @{savedVolume = $current} | ConvertTo-Json | Set-Content -Path $SaveFile -Encoding UTF8
        $target = [float]$Level
        if ($target -gt $current) {
            [void]$volume.SetMasterVolumeLevelScalar($target, [Guid]::Empty)
        }
        Write-Output "saved=$current"
    }
    "restore" {
        if (Test-Path $SaveFile) {
            $data = Get-Content -Raw -Encoding UTF8 $SaveFile | ConvertFrom-Json
            $restoreTo = [float]$data.savedVolume
            [void]$volume.SetMasterVolumeLevelScalar($restoreTo, [Guid]::Empty)
            Remove-Item $SaveFile -Force -ErrorAction SilentlyContinue
            Write-Output "restored=$restoreTo"
        }
    }
}
