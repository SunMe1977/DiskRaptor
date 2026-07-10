import { execSync } from "node:child_process";
try {
  const out = execSync("gh release view v0.1.6 --json name,assets,url", { encoding: "utf8", timeout: 15000 });
  const r = JSON.parse(out);
  console.log("RELEASE: " + r.name);
  console.log("URL: " + r.url);
  r.assets.forEach(a => console.log("ASSET: " + a.name + " " + a.size + " bytes"));
  const linuxAssets = r.assets.filter(a => a.name.includes("Linux"));
  if (linuxAssets.length === 0) {
    console.log("MISSING: Linux binary");
    process.exit(1);
  } else {
    console.log("OK: Linux is present");
    process.exit(0);
  }
} catch(e) {
  console.log("ERROR: " + e.message);
  process.exit(1);
}
