import fs from "fs";
import path from "path";

const dir = "C:\\dev\\diskraptor.com\\locales";
const websiteKeys = {
  en: {
    "hero.title":"DiskRaptor — Ultra-fast disk space analyzer",
    "hero.badge":"⚡ Open Source",
    "hero.headline":"One of the fastest disk space analyzers",
    "hero.subtitle":"Scan millions of files in seconds. Built with Rust + Tauri.",
    "hero.download":"Download Free",
    "hero.github":"View on GitHub",
    "hero.files":"files scanned",
    "hero.speed":"scan speed",
    "hero.languages":"languages",
    "hero.free":"free & open source",
    "nav.features":"Features",
    "nav.download":"Download",
    "nav.about":"About",
    "features.title":"Why DiskRaptor?",
    "f1.title":"Blazing Fast","f1.desc":"Parallel Win32 engine scans 1M+ files in seconds. Up to 6x faster than traditional scanners.",
    "f2.title":"Virtual TreeView","f2.desc":"Handles 20M+ nodes without UI lag. Only renders visible rows — 50-200 at a time.",
    "f3.title":"Interactive Diagrams","f3.desc":"Pie chart and squarified treemap. Click any slice to jump directly to the file in the tree.",
    "f4.title":"100% Private","f4.desc":"All scanning happens locally. No data leaves your machine. No telemetry. No tracking.",
    "f5.title":"25 Languages","f5.desc":"Fully translated into 25 languages. Auto-detects your system language.",
    "f6.title":"Rust + Tauri","f6.desc":"Built with Rust for maximum performance and Tauri for a native, secure WebView2 UI.",
    "download.title":"Download DiskRaptor",
    "download.sub":"Free. Open source. No ads. No data collection.",
    "dl.windows":"Windows","dl.msi":".msi installer",
    "dl.macos":"macOS","dl.dmg":".dmg bundle",
    "dl.linux":"Linux","dl.appimage":".AppImage",
    "about.text":"DiskRaptor is a modern, open-source successor to JDiskReport. Written in Rust with a Tauri UI, it combines raw scanning performance with a polished, accessible interface.",
    "about.meta":"MIT License \u00a9 2026 DiskRaptor Team"
  },
  de: {
    "hero.title":"DiskRaptor \u2014 Ultraschneller Festplatten-Analysator",
    "hero.badge":"\u26a1 Open Source",
    "hero.headline":"Einer der schnellsten Festplatten-Analysatoren",
    "hero.subtitle":"Scannt Millionen von Dateien in Sekunden. Entwickelt mit Rust + Tauri.",
    "hero.download":"Kostenlos herunterladen",
    "hero.github":"Auf GitHub ansehen",
    "hero.files":"Dateien gescannt",
    "hero.speed":"Scan-Geschwindigkeit",
    "hero.languages":"Sprachen",
    "hero.free":"kostenlos & open source",
    "nav.features":"Funktionen",
    "nav.download":"Download",
    "nav.about":"\u00dcber",
    "features.title":"Warum DiskRaptor?",
    "f1.title":"Blitzschnell","f1.desc":"Parallele Win32-Engine scannt 1M+ Dateien in Sekunden. Bis zu 6x schneller als herk\u00f6mmliche Scanner.",
    "f2.title":"Virtuelle Baumansicht","f2.desc":"Unterst\u00fctzt 20M+ Knoten ohne UI-Verz\u00f6gerung. Rendert nur sichtbare Zeilen.",
    "f3.title":"Interaktive Diagramme","f3.desc":"Kreis- und Baumdiagramm. Klicken Sie auf ein Segment, um direkt zur Datei zu springen.",
    "f4.title":"100% Privat","f4.desc":"Alle Scans sind lokal. Keine Telemetrie. Kein Tracking.",
    "f5.title":"25 Sprachen","f5.desc":"Vollst\u00e4ndig in 25 Sprachen \u00fcbersetzt. Erkennt Ihre Systemsprache automatisch.",
    "f6.title":"Rust + Tauri","f6.desc":"Maximale Leistung durch Rust, native UI durch Tauri.",
    "download.title":"DiskRaptor herunterladen",
    "download.sub":"Kostenlos. Open Source. Keine Werbung. Keine Datensammlung.",
    "dl.windows":"Windows","dl.msi":".msi-Installer",
    "dl.macos":"macOS","dl.dmg":".dmg-Paket",
    "dl.linux":"Linux","dl.appimage":".AppImage",
    "about.text":"DiskRaptor ist ein moderner, quelloffener Nachfolger von JDiskReport. Geschrieben in Rust mit Tauri-UI.",
    "about.meta":"MIT-Lizenz \u00a9 2026 DiskRaptor Team"
  }
};

for (const [code, keys] of Object.entries(websiteKeys)) {
  const filePath = path.join(dir, code + ".json");
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  Object.assign(data, keys);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  console.log("Updated " + code + ".json");
}
console.log("Done");
