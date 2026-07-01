# AI Upload Blocker

Browser extension that blocks file uploads to AI web services on managed endpoints.
Deployed via Intune `ExtensionInstallForcelist` to Chrome and Edge.

## Browser Support

| Browser | Minimum Version |
|---|---|
| Chrome | 111 |
| Edge | 111 |
| Firefox | 128 |

## Block Features

| Vector | Method |
|---|---|
| fetch() with File/FormData/Blob body | Override window.fetch |
| XMLHttpRequest.send() with file body | Override XHR.prototype.send |
| input[type=file] via DOM insertion | MutationObserver + shadow root recursion |
| input[type=file] created off-DOM | Document.prototype.createElement override |
| Programmatic .click() on file inputs | HTMLInputElement.prototype.click override |
| File System Access API | window.showOpenFilePicker override |
| Drag-and-drop file drop | Capture-phase drop listener |
| Clipboard paste with files | Capture-phase paste listener |
| Form submit containing files | Capture-phase submit listener |

## Architecture

Domain list lives in `ai-sites.json`. On install and startup, `background.js` reads that file, generates match patterns, and dynamically registers `content.js` via `chrome.scripting.registerContentScripts()` in `world: MAIN`.

No domain configuration lives in `manifest.json` - adding or removing a site is a one-line edit to `ai-sites.json`.

### Conditional Blocking

Some domains serve both AI tools and legitimate services. The `URL_CONDITIONS` map in `content.js` gates blocking on a runtime URL check.

Current conditional domains:
- `www.google.com` -- blocks only when `udm=50` (Google AI Search / AI Mode) is present in the URL

## Files

```
ai-upload-blocker/
+-- manifest.json        MV3 manifest
+-- background.js        reads ai-sites.json, registers content.js dynamically
+-- content.js           upload blocking logic (MAIN world)
+-- rules.json           declarativeNetRequest rules (intentionally empty)
+-- ai-sites.json        domain list
+-- ai-sites.txt         human-readable source list, one *.domain per line
+-- docs/
    +-- ai-upload-blocker.crx
    +-- update.xml
+-- icons/
```

## Adding or Removing Domains

Edit `ai-sites.json` only. Add the apex domain as a plain string:

```json
"newsite.ai",
```

`background.js` generates both `*://newsite.ai/*` and `*://*.newsite.ai/*` automatically.

To regenerate `ai-sites.json` from the human-readable `ai-sites.txt`:

```powershell
$d = Get-Content ai-sites.txt |
  Where-Object { $_ -match '^\*\.' } |
  ForEach-Object { ($_ -replace '^\*\.','').Trim() } |
  Sort-Object -Unique
ConvertTo-Json $d | Set-Content ai-sites.json -Encoding UTF8
```

**Always** bump the version in `manifest.json` when updating `ai-sites.json`.

## Deployment via Intune

### Chrome and Edge

1. Pack the extension using the same `.pem` key each time (Chrome -> chrome://extensions -> Pack extension)
2. Replace `docs/ai-upload-blocker.crx` and update the version in `docs/update.xml`
3. Push to GitHub -- GitHub Pages serves the files automatically

Intune Settings Catalog:
Find the current appID at https://guyvolvo.github.io/ai-upload-blocker/update.xml '<app appid="ID">'
- Chrome: `ExtensionInstallForcelist` -> `appID;https://guyvolvo.github.io/ai-upload-blocker/update.xml`
- Edge: same value under Microsoft Edge `ExtensionInstallForcelist`

To enforce minimum version via `ExtensionSettings`:

```json
{
  "appID": {
    "installation_mode": "force_installed",
    "update_url": "https://guyvolvo.github.io/ai-upload-blocker/update.xml",
    "minimum_version_required": "1.4.0"
  }
}
```

### Removing the Extension from a Device

Apply via a separate Intune profile - do not mix with the force-install profile:

```json
{
  "appID": {
    "installation_mode": "removed"
  }
}
```

Remove the device from the force-install profile assignment before applying this to avoid a conflict.

## Verifying a CRX Version

```powershell
$crx = [System.IO.File]::ReadAllBytes("docs\ai-upload-blocker.crx")
$headerLen = [BitConverter]::ToUInt32($crx, 8)
$zip = $crx[(12 + $headerLen)..($crx.Length - 1)]
[System.IO.File]::WriteAllBytes("$env:TEMP\crx_check.zip", $zip)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead("$env:TEMP\crx_check.zip")
$entry = $archive.Entries | Where-Object { $_.Name -eq "manifest.json" }
(New-Object System.IO.StreamReader($entry.Open())).ReadToEnd() |
  ConvertFrom-Json | Select-Object name, version
```

## Known Limitations

- DevTools bypass: user opens DevTools and overrides the content script. Mitigate by disabling DevTools via Intune Settings Catalog (separate entries for Chrome and Edge).
- Non-managed browsers: extension only runs on MDM managed browsers.
- ArrayBuffer uploads: caller manually reads file to ArrayBuffer without using browser file UI is not covered.
- Native app WebViews: extension does not run there.
