#Requires -Version 5.1
# Shout for user: play beeps + TTS
# DataFile contains JSON: { beeps: number, soundPath: string, ttsText: string }
param(
  [Parameter(Mandatory=$true)][string]$DataFile
)
$ErrorActionPreference = "Continue"

$data = Get-Content -Raw -Encoding UTF8 $DataFile | ConvertFrom-Json
$beeps = [int]$data.beeps
$soundPath = [string]$data.soundPath

# ---- Sound ----
if ($soundPath -and (Test-Path $soundPath)) {
  try {
    Add-Type -AssemblyName System.Media
    $player = New-Object System.Media.SoundPlayer $soundPath
    $count = [Math]::Max(1, $beeps)
    for ($i = 0; $i -lt $count; $i++) { $player.PlaySync() }
  } catch { Write-Warning "[iam-cooking] WAV playback failed: $($_.Exception.Message)" }
} elseif ($beeps -gt 0) {
  # Try Console.Beep (fast, loud) -> fall back to system sound
  $played = $false
  try {
    for ($i = 0; $i -lt $beeps; $i++) {
      [System.Console]::Beep(880, 350)
      Start-Sleep -Milliseconds 250
    }
    $played = $true
  } catch {
    # No console available (windowsHide) - fall through to system sound
  }
  if (-not $played) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      for ($i = 0; $i -lt $beeps; $i++) {
        [System.Media.SystemSounds]::Exclamation.Play()
        Start-Sleep -Milliseconds 600
      }
    } catch {}
  }
}

# ---- TTS ----
$ttsText = [string]$data.ttsText
if ($ttsText) {
  try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $synth.Rate   = 0
    $synth.Volume = 100
    $synth.Speak($ttsText)
  } catch { Write-Warning "[iam-cooking] TTS failed: $($_.Exception.Message)" }
}
