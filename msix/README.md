# Microsoft Store: MSIX-Packaging (statt signiertem Win32)

Der Store lehnt die unsignierten EXE/MSI ab (Policy 10.2.9: Code-Signing Ã¼ber
ein Zertifikat aus dem Microsoft Trusted Root Program). Microsoft empfiehlt
fÃ¼r diesen Fall, die App als **MSIX** zu verpacken â€” MSIX-Pakete werden von
Microsoft beim Einreichen automatisch signiert, du brauchst **kein eigenes
Code-Signing-Zertifikat**.

> Tauri v2 hat aktuell **keinen** MSIX-Bundler (nur `msi`/`nsis`), daher wird
> die Conversion einmalig pro Version mit dem offiziellen **MSIX Packaging
> Tool** gemacht. Das ist ein ~2-Minuten-Schritt.

## Voraussetzungen

- Windows 10/11 mit Admin-Rechten
- **MSIX Packaging Tool** aus dem Microsoft Store installieren:
  `ms-windows-store://pdp/?productid=9N5LW3JBCXKF` (oder im Store nach
  â€žMSIX Packaging Tool" suchen, Hersteller Microsoft)
- Das **Silent-MSI** neu bauen (enthÃ¤lt den Publisher `Hansjoerg Hofer`):

  ```powershell
  cd src-tauri
  npx tauri build --bundles msi --config tauri.silent.conf.json --ci
  ```

  Ergebnis: `src-tauri\target\release\bundle\msi\DiskRaptor_1.0.14_x64_en-US.msi`

## MSIX-Paket erzeugen

**Automatisch (empfohlen):** Der Release-Workflow (`.github/workflows/release.yml`,
Job `windows-release`) baut das MSIX jetzt automatisch mit
`msix\pack-msix.ps1` und lÃ¤dt es als `DiskRaptor-windows-x64.msix` auf den
GitHub-Release. Du kannst es von dort direkt im Partner Center einreichen.

**Manuell (optional):**
```powershell
powershell -ExecutionPolicy Bypass -File msix\pack-msix.ps1 `
  -MsiPath src-tauri\target\release\bundle\msi\DiskRaptor_1.0.14_x64_en-US.msi `
  -Version 1.0.14.0
```
- Voraussetzungen: Windows-SDK (enthÃ¤lt `makeappx.exe`), Python mit Pillow.
- `-SelfSign` erzeugt zusÃ¤tzlich eine Signatur mit einem temporÃ¤ren
  Selbstzertifikat (nur fÃ¼r lokale Tests; der Store signiert ohnehin neu).
- Das Skript: extrahiert die App aus dem MSI, generiert
  `AppxManifest.xml` (`Publisher=CN=Hansjoerg Hofer`, `runFullTrust`),
  erzeugt die Store-Logos aus `src-tauri/icons/icon.png` und packt mit
  `makeappx`.

Oder per **MSIX Packaging Tool** (GUI): â†’ **â€žMSIX conversion"** â†’ Datei =
das Silent-MSI auswÃ¤hlen â†’ fertigstellen. Der Publisher im Manifest muss
`CN=Hansjoerg Hofer` sein.

## Partner Center (wichtig â€” einmalig pro App)

Beim Wechsel von Win32 â†’ MSIX gilt laut Microsoft:

1. **Die bestehende Win32-App â€žDiskRaptor" in Partner Center LÃ–SCHEN**
   (Product â†’ App entfernen), damit der Name fÃ¼r die MSIX-App frei wird.
2. **Neue App anlegen** (gleicher Name â€žDiskRaptor").
3. **Package einreichen:** das `.msix` aus Schritt 4 hochladen.
   - Der **Produkt-/Publishername** in Partner Center muss exakt
     â€žDiskRaptor" / â€žHansjoerg Hofer" sein (wie im ARP/Manifest).
4. Nach dem Upload prÃ¼fen: Der Store Ã¼bernimmt **Code-Signing** â€” der
   Signatur-Check (Policy 10.2.9) ist damit erledigt.

## Hinweise

- Die `-silent.msi` und der normale Win32-Build bleiben fÃ¼r **Nicht-Store**-
  Nutzer (GitHub-Releases) erhalten und werden dort unverÃ¤ndert verteilt.
- Das MSIX wird im CI automatisch gebaut (siehe oben); das Skript liegt unter
  `msix\pack-msix.ps1` + `msix\generate_logos.py`.
- Der Publisher `CN=Hansjoerg Hofer` steckt in `tauri.conf.json`
  (`bundle.publisher` â†’ MSI-Manufacturer). FÃ¼r das MSIX-Manifest muss er
  genauso lauten.
