# Microsoft Store: MSIX-Packaging (statt signiertem Win32)

Der Store lehnt die unsignierten EXE/MSI ab (Policy 10.2.9: Code-Signing über
ein Zertifikat aus dem Microsoft Trusted Root Program). Microsoft empfiehlt
für diesen Fall, die App als **MSIX** zu verpacken — MSIX-Pakete werden von
Microsoft beim Einreichen automatisch signiert, du brauchst **kein eigenes
Code-Signing-Zertifikat**.

> Tauri v2 hat aktuell **keinen** MSIX-Bundler (nur `msi`/`nsis`), daher wird
> die Conversion einmalig pro Version mit dem offiziellen **MSIX Packaging
> Tool** gemacht. Das ist ein ~2-Minuten-Schritt.

## Voraussetzungen

- Windows 10/11 mit Admin-Rechten
- **MSIX Packaging Tool** aus dem Microsoft Store installieren:
  `ms-windows-store://pdp/?productid=9N5LW3JBCXKF` (oder im Store nach
  „MSIX Packaging Tool" suchen, Hersteller Microsoft)
- Das **Silent-MSI** neu bauen (enthält den Publisher `Hansjoerg Hofer`):

  ```powershell
  cd src-tauri
  npx tauri build --bundles msi --config tauri.silent.conf.json --ci
  ```

  Ergebnis: `src-tauri\target\release\bundle\msi\DiskRaptor_1.0.13_x64_en-US.msi`

## MSIX-Paket erzeugen

**Automatisch (empfohlen):** Der Release-Workflow (`.github/workflows/release.yml`,
Job `windows-release`) baut das MSIX jetzt automatisch mit
`msix\pack-msix.ps1` und lädt es als `DiskRaptor-windows-x64.msix` auf den
GitHub-Release. Du kannst es von dort direkt im Partner Center einreichen.

**Manuell (optional):**
```powershell
powershell -ExecutionPolicy Bypass -File msix\pack-msix.ps1 `
  -MsiPath src-tauri\target\release\bundle\msi\DiskRaptor_1.0.13_x64_en-US.msi `
  -Version 1.0.13.0
```
- Voraussetzungen: Windows-SDK (enthält `makeappx.exe`), Python mit Pillow.
- `-SelfSign` erzeugt zusätzlich eine Signatur mit einem temporären
  Selbstzertifikat (nur für lokale Tests; der Store signiert ohnehin neu).
- Das Skript: extrahiert die App aus dem MSI, generiert
  `AppxManifest.xml` (`Publisher=CN=Hansjoerg Hofer`, `runFullTrust`),
  erzeugt die Store-Logos aus `src-tauri/icons/icon.png` und packt mit
  `makeappx`.

Oder per **MSIX Packaging Tool** (GUI): → **„MSIX conversion"** → Datei =
das Silent-MSI auswählen → fertigstellen. Der Publisher im Manifest muss
`CN=Hansjoerg Hofer` sein.

## Partner Center (wichtig — einmalig pro App)

Beim Wechsel von Win32 → MSIX gilt laut Microsoft:

1. **Die bestehende Win32-App „DiskRaptor" in Partner Center LÖSCHEN**
   (Product → App entfernen), damit der Name für die MSIX-App frei wird.
2. **Neue App anlegen** (gleicher Name „DiskRaptor").
3. **Package einreichen:** das `.msix` aus Schritt 4 hochladen.
   - Der **Produkt-/Publishername** in Partner Center muss exakt
     „DiskRaptor" / „Hansjoerg Hofer" sein (wie im ARP/Manifest).
4. Nach dem Upload prüfen: Der Store übernimmt **Code-Signing** — der
   Signatur-Check (Policy 10.2.9) ist damit erledigt.

## Hinweise

- Die `-silent.msi` und der normale Win32-Build bleiben für **Nicht-Store**-
  Nutzer (GitHub-Releases) erhalten und werden dort unverändert verteilt.
- Das MSIX wird im CI automatisch gebaut (siehe oben); das Skript liegt unter
  `msix\pack-msix.ps1` + `msix\generate_logos.py`.
- Der Publisher `CN=Hansjoerg Hofer` steckt in `tauri.conf.json`
  (`bundle.publisher` → MSI-Manufacturer). Für das MSIX-Manifest muss er
  genauso lauten.
