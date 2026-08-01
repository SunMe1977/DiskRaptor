cask "diskraptor" do
  version "1.0.9"

  name "DiskRaptor"
  desc "Ultra-fast cross-platform disk space analyzer"
  homepage "https://github.com/SunMe1977/DiskRaptor"

  on_macos do
    url "https://github.com/SunMe1977/DiskRaptor/releases/download/v#{version}/DiskRaptor-#{version}-macos.dmg"
    sha256 :no_check
    app "DiskRaptor.app"
  end

  on_linux do
    url "https://github.com/SunMe1977/DiskRaptor/releases/download/v#{version}/DiskRaptor-#{version}-linux-amd64.deb"
    sha256 "3ac98e963e2cf08dcb1f83046e76f84ba8778bca5ceeffeca6350edb969d4245"
    pkg "DiskRaptor-#{version}-linux-amd64.deb"
  end

  caveats do
    "macOS .dmg for v#{version} must be uploaded to the GitHub release before this cask can be installed." if OS.mac?
  end
end
