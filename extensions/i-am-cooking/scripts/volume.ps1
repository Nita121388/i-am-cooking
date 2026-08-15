#Requires -Version 5.1
# Windows volume control via Core Audio API (WASAPI)
# Two calling styles (aligned with index.ts):
#   1) Command line:  -Action get|set|save|restore|mute|unmute [-Level X] [-SaveFile path]
#   2) JSON data file: -DataFile path  (content: {"action":"set","level":0.7})
# Behavior:
#   - get:     output volume=X.XX (0-1)
#   - set:     set volume AND unmute (so shouts can be heard)
#   - save:    save current volume+mute, boost to target (only if higher), unmute if was muted
#   - restore: restore saved volume and mute state
#   - mute/unmute: toggle mute
param(
  [Parameter(Mandatory=$false)][ValidateSet("get","set","save","restore","mute","unmute")][string]$Action,
  [Parameter(Mandatory=$false)][double]$Level = 0.8,
  [Parameter(Mandatory=$false)][string]$SaveFile,
  [Parameter(Mandatory=$false)][string]$DataFile
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.IO;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
    int GetState(ref int pdwState);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out int pCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute(bool bMute, ref Guid pguidEventContext);
    int GetMute(out bool pbMute);
}

public static class AudioVolHelper {
    private static IAudioEndpointVolume GetVolume() {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IntPtr devPtr = IntPtr.Zero;
        int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out devPtr);
        if (hr != 0 || devPtr == IntPtr.Zero) throw new Exception("No default playback device (0x" + hr.ToString("X8") + ")");
        IMMDevice device = (IMMDevice)Marshal.GetObjectForIUnknown(devPtr);
        Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        IntPtr volPtr = IntPtr.Zero;
        int hr2 = device.Activate(ref iid, 1, IntPtr.Zero, out volPtr);
        if (hr2 != 0 || volPtr == IntPtr.Zero) throw new Exception("Activate failed (0x" + hr2.ToString("X8") + ")");
        return (IAudioEndpointVolume)Marshal.GetObjectForIUnknown(volPtr);
    }

    public static string Get() {
        try {
            IAudioEndpointVolume vol = GetVolume();
            float level;
            vol.GetMasterVolumeLevelScalar(out level);
            return "volume=" + level.ToString("0.##");
        } catch (Exception ex) { return "ERR:" + ex.Message; }
    }

    public static string Set(double level) {
        try {
            IAudioEndpointVolume vol = GetVolume();
            float target = (float)Math.Max(0, Math.Min(1, level));
            Guid ctx = Guid.Empty;
            vol.SetMasterVolumeLevelScalar(target, ref ctx);
            vol.SetMute(false, ref ctx); // set volume also unmutes
            return "volume=" + target.ToString("0.##") + " muted=false";
        } catch (Exception ex) { return "ERR:" + ex.Message; }
    }

    public static string SetMute(bool mute) {
        try {
            IAudioEndpointVolume vol = GetVolume();
            Guid ctx = Guid.Empty;
            vol.SetMute(mute, ref ctx);
            return "muted=" + (mute ? "true" : "false");
        } catch (Exception ex) { return "ERR:" + ex.Message; }
    }

    public static string Save(string saveFile, double target) {
        try {
            IAudioEndpointVolume vol = GetVolume();
            float current;
            vol.GetMasterVolumeLevelScalar(out current);
            bool muted = false;
            vol.GetMute(out muted);
            string json = "{\"savedVolume\":" + current.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture) + ",\"savedMuted\":" + (muted ? "true" : "false") + "}";
            File.WriteAllText(saveFile, json);
            float t = (float)Math.Max(0, Math.Min(1, target));
            Guid ctx = Guid.Empty;
            if (t > current) vol.SetMasterVolumeLevelScalar(t, ref ctx);
            if (muted) vol.SetMute(false, ref ctx); // unmute if was muted so shout can be heard
            return "saved=" + current.ToString("0.##");
        } catch (Exception ex) { return "ERR:" + ex.Message; }
    }

    public static string Restore(string saveFile) {
        try {
            if (!File.Exists(saveFile)) return "ERR:no-save-file";
            string json = File.ReadAllText(saveFile);
            // naive parse (small file, controlled content)
            double vol = 0.5; bool wasMuted = false;
            var m1 = System.Text.RegularExpressions.Regex.Match(json, "\"savedVolume\":([\\d.]+)");
            if (m1.Success) double.TryParse(m1.Groups[1].Value, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out vol);
            var m2 = System.Text.RegularExpressions.Regex.Match(json, "\"savedMuted\":(true|false)");
            if (m2.Success) wasMuted = m2.Groups[1].Value == "true";
            IAudioEndpointVolume volume = GetVolume();
            Guid ctx = Guid.Empty;
            volume.SetMasterVolumeLevelScalar((float)vol, ref ctx);
            if (wasMuted) volume.SetMute(true, ref ctx);
            File.Delete(saveFile);
            return "restored=" + vol.ToString("0.##") + " muted=" + (wasMuted ? "true" : "false");
        } catch (Exception ex) { return "ERR:" + ex.Message; }
    }
}
"@

# Read params from JSON data file (runPowerShellScript style)
if ($DataFile -and (Test-Path $DataFile)) {
    $data = Get-Content -Raw -Encoding UTF8 $DataFile | ConvertFrom-Json
    if ($data.action) { $Action = [string]$data.action }
    if ($null -ne $data.level) { $Level = [double]$data.level }
    if ($data.saveFile) { $SaveFile = [string]$data.saveFile }
}

if (-not $Action) {
    Write-Error "Missing -Action or -DataFile {action}"
    exit 1
}

switch ($Action) {
    "get"     { Write-Output ([AudioVolHelper]::Get()) }
    "set"     { Write-Output ([AudioVolHelper]::Set($Level)) }
    "save"    { Write-Output ([AudioVolHelper]::Save($SaveFile, $Level)) }
    "restore" { Write-Output ([AudioVolHelper]::Restore($SaveFile)) }
    "mute"    { Write-Output ([AudioVolHelper]::SetMute($true)) }
    "unmute"  { Write-Output ([AudioVolHelper]::SetMute($false)) }
}
