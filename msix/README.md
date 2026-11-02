# Microsoft Store: MSIX statt Win32-MSI

## Warum MSIX (und nicht die Silent-MSI)

Microsoft hat für Windows-Apps zwei getrennte Store-Pfade. Sie verhalten sich
grundlegend unterschiedlich – das erklärt, warum "Store-Update" mit der MSI
nicht funktioniert:

| | MSI/EXE-Einreichung | MSIX-Einreichung |
|---|---|---|
| Signierung | **Du** brauchst ein Zertifikat aus dem Microsoft Trusted Root Program (alle PE-Dateien: exe **und** DLLs) | Microsoft signiert kostenlos beim Einreichen |
| Hosting | Du hostest den Installer selbst unter einer **versionierten, unveränderlichen** URL | Microsoft hostet das Paket |
| Updates | **Keine** – „Updates sind Aufgabe des App-Herstellers" | Store verwaltet Updates automatisch |
| Installation | Store lädt deine MSI und führt sie aus | Store installiert das MSIX |
| UAC | erlaubt | keine Elevation möglich |

Quelle: <https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/app-package-requirements>

Konkret heißt das:

- Die Store-Update-Kette gibt es **nur** beim MSIX-Pfad. Eine über MSI/EXE
  installierte App wird vom Store **nie** aktualisiert – unabhängig davon, wie
  oft du eine neue MSI einreichst.
- Beim MSI/EXE-Pfad muss die Download-URL in Partner Center versioniert sein
  (z. B. `.../releases/download/v1.0.50/DiskRaptor-1.0.50-windows-x64-silent.msi`)
  und die Datei darf sich danach **nicht mehr ändern**. Ein `latest/download/...`-
  Link oder ein überschriebenes Release-Asset lässt die Prüfung
  („Hintergrundinstallation konnte nicht verifiziert werden") scheitern.
- Unsere MSI/EXE-Dateien sind **unsigniert** (`Get-AuthenticodeSignature` →
  `NotSigned`) – auf dem MSI/EXE-Pfad ist das ein Ablehnungsgrund (Policy 10.2.9).

## Was der Release-Workflow baut

`windows-x64` baut pro Version:

1. `DiskRaptor-<ver>-windows-x64.exe` – normaler NSIS-Installer (mit UI)
2. `DiskRaptor-<ver>-windows-x64.msi` – normaler MSI (mit UI)
3. `DiskRaptor-<ver>-windows-x64-silent.msi` – MSI ohne UI (Basis für das MSIX)
4. `DiskRaptor-<ver>-windows-x64-silent.exe` – NSIS ohne UI
5. `DiskRaptor-windows-x64.msix` – **das Store-Paket**

Das Silent-MSI wird mit `--features store` gebaut (keine Admin-Elevation,
`restart_as_admin` ist deaktiviert) und enthält **keinen** WebView2-Download
mehr, damit es die Store-Regel „standalone installer, kein Web-Downloader"
erfüllt. Es enthält außerdem keine zweite Frontend-Kopie: das Frontend steckt
bereits (als Store-Build gestempelt, ohne In-App-Self-Update) in
`diskraptor.exe`.

### Silent-MSI ist per-user (nicht per-machine)

Seit v1.0.50 wird das Store-MSI als **per-user**-Paket gebaut:

- Installiert nach `%LOCALAPPDATA%\DiskRaptor`, schreibt **nur** HKCU und fragt
  **nie** nach Admin-Rechten.
- Grund: Der Store startet den eingereichten Installer im Hintergrund als
  angemeldeter Benutzer. Ein per-machine-MSI (`ALLUSERS=1`, `Program Files`)
  braucht Elevation und scheitert dort mit Fehler 1925 („unzureichende
  Berechtigungen"), was Partner Center als „Hintergrundinstallation konnte nicht
  verifiziert werden" meldet.
- Tauris WiX-Bundler kann kein per-user-MSI erzeugen (seine File-Keypath-
  Komponente scheitert an ICE38, das `Programs`-Verzeichnis an ICE64), daher wird
  das Store-MSI aus `installer/wix/silent-peruser.wxs` mit `candle`/`light`
  gebaut (`installer/wix/build-silent-msi.ps1`).
- `IgnoreRemoveFailure` sorgt dafür, dass ein noch installiertes altes
  per-machine v1.0.44 die Installation nicht abbricht (Fehler 1730). Dieses alte
  Paket muss einmalig per Hand (mit Admin) entfernt werden.

## MSIX bauen

Automatisch: der Release-Workflow ruft `msix/pack-msix.ps1` auf und lädt das
Ergebnis als `DiskRaptor-windows-x64.msix` hoch.

Manuell:

```powershell
powershell -ExecutionPolicy Bypass -File msix\pack-msix.ps1 `
  -MsiPath src-tauri\target\release\bundle\msi\DiskRaptor_1.0.50_x64_en-US.msi
```

- Version wird aus `package.json` abgeleitet (`1.0.50` → `1.0.50.0`).
- Logos werden aus `images/logo6_original_ms.png` erzeugt; das Skript bricht ab,
  wenn eine Logo-Datei leer/transparent wäre (Store-Validierung lehnt das ab).
- Voraussetzungen: Windows-SDK (`makeappx.exe`), Python + Pillow.

## Partner Center (einmalig, danach pro Version nur Upload)

1. **App-Identität aus Partner Center holen**
   (Product → App identity): `Package/Identity/Name` und
   `Package/Identity/Publisher`. Diese müssen **exakt** im Manifest stehen.
2. Als Repository-Variablen setzen (Settings → Secrets and variables → Actions
   → Variables):
   - `MSIX_IDENTITY_NAME` – z. B. `12345HansjoergHofer.DiskRaptor`
   - `MSIX_IDENTITY_PUBLISHER` – z. B. `CN=8A1B...`
   Ohne diese Variablen werden die Standardwerte
   `DiskRaptor.DiskRaptor` / `CN=Hansjoerg Hofer` verwendet.
3. **Neue Submission** anlegen, `DiskRaptor-windows-x64.msix` hochladen,
   Version prüfen (`1.0.50.0`), einreichen.

> Ein bestehendes Win32-Produkt (MSI/EXE) lässt sich nicht in ein
> MSIX-Produkt umwandeln. Für MSIX braucht es ein neues Produkt – der
> Produktname „DiskRaptor" muss dafür in Partner Center frei sein (das alte
> Win32-Produkt ggf. entfernen). Das ist der Preis dafür, dass der Store
> Updates künftig selbst ausliefert.

## Lokal testen (optional)

Das MSIX ist absichtlich unsigniert (Microsoft signiert erst beim Einreichen).
`Add-AppxPackage` scheitert daher mit `0x800B0100`. Zum Testen:

```powershell
powershell -ExecutionPolicy Bypass -File msix\install-msix.ps1
```

- fordert Admin-Rechte an (AppX vertraut nur Maschinen-Zertifikaten),
- erzeugt ein wiederverwendbares Selbstzertifikat,
- signiert eine **Kopie** in `%TEMP%` (das Store-Artefakt bleibt unsigniert),
- Optionen: `-SkipSign`, `-SignOnly`, `-Uninstall`.

## Wenn du beim MSI/EXE-Pfad bleiben willst

Seit v1.0.50 ist das Silent-MSI per-user und installiert daher auch in der
Store-Hintergrundprüfung ohne Admin. Damit ist der Fehler „Hintergrundinstallation
konnte nicht verifiziert werden" behoben – es bleiben aber zwei harte
Anforderungen:

- Das MSI/EXE muss **code-signiert** sein (alle PE-Dateien), sonst Ablehnung.
- Die Download-URL muss **versioniert und unveränderlich** sein.

Konkret sind dafür nötig (nicht im Repo enthalten):

- Code-Signing-Zertifikat (z. B. Azure Trusted Signing) für
  `diskraptor.exe`, `diskraptor_scanner.dll`, `zerofrom_derive.dll` **und** die MSI;
- in Partner Center eine **versionierte** Download-URL pro Release, die nach
  der Einreichung unverändert bleibt;
- Updates selbst ausliefern (der Store tut es auf diesem Pfad nicht).
