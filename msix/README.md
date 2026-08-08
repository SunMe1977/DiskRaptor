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

## MSIX-Paket erzeugen (MSIX Packaging Tool)

1. **MSIX Packaging Tool** öffnen → **„MSIX conversion"** (links oben) → als
   Administrator bestätigen.
2. **App-Vorbereitung:** Datei auswählen = `DiskRaptor_1.0.13_x64_en-US.msi`.
   Installationszeit-Grenze z. B. 60 Sekunden.
3. **Optionen:** Ausgabepfad festlegen (z. B. `release-assets\`).
   - **Signing:** „Use a test certificate" ist für die Store-Einreichung ok
     (Microsoft signiert beim Einreichen neu). Wichtig ist, dass der
     **Publisher im Manifest `CN=Hansjoerg Hofer`** ist.
   - Andernfalls den Haken für Signierung weglassen → unsigniertes MSIX.
4. **Fertigstellen** → das Tool installiert die App in eine saubere Sandbox,
   erfasst die Dateien/Registry und baut `DiskRaptor.msix`.
5. **Verifizieren:** MSIX-Datei in Explorer öffnen (zeigt Manifest/Assets) oder
   mit dem Tool „Package editor" prüfen.

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
- Soll künftig automatisch gebaut werden, bräuchte es einen MSIX-Target-
  Support in Tauri (aktuell nicht vorhanden) oder eine eigene
  `makeappx`-Pipeline im CI.
- Der Publisher `CN=Hansjoerg Hofer` steckt in `tauri.conf.json`
  (`bundle.publisher` → MSI-Manufacturer). Für das MSIX-Manifest muss er
  genauso lauten.
