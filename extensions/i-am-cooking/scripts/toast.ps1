#Requires -Version 5.1
# Windows Toast notification via WinRT
# DataFile contains JSON: { title: string, body: string }
param(
  [Parameter(Mandatory=$true)][string]$DataFile
)
$ErrorActionPreference = "Continue"

$data = Get-Content -Raw -Encoding UTF8 $DataFile | ConvertFrom-Json

try {
  # Register WinRT types (type literal expression, output discarded)
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null

  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
           [Windows.UI.Notifications.ToastTemplateType]::ToastText02)

  $texts = $xml.GetElementsByTagName("text")
  $null  = $texts.Item(0).AppendChild($xml.CreateTextNode([string]$data.title))
  $null  = $texts.Item(1).AppendChild($xml.CreateTextNode([string]$data.body))

  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("I am cooking").Show($toast)
} catch {
  Write-Warning "[iam-cooking] Toast failed: $($_.Exception.Message)"
}
