# PowerShell script to build Linux binary and upload to release
# Run from C:\dev\DiskRaptor

$ErrorActionPreference = "Stop"
$TAG = "v0.1.6"

Write-Host "=== DiskRaptor Linux Build & Upload ===" -ForegroundColor Cyan

# Check if Docker is available
$dockerCheck = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCheck) {
    Write-Host "Docker not available. Linux binary cannot be built on Windows without Docker/WSL." -ForegroundColor Red
    Write-Host "Attempting alternative: download existing Linux artifact from CI..." -ForegroundColor Yellow
    exit 1
}

Write-Host "Docker available, building Linux binary..." -ForegroundColor Green

# Create a Dockerfile that builds the binary
@"
FROM rust:latest AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libsoup2.4-dev libglib2.0-dev patchelf libayatana-appindicator3-dev

COPY Cargo.toml Cargo.lock ./
COPY src-tauri/Cargo.toml src-tauri/
COPY src-tauri/src src-tauri/src
COPY src-tauri/build.rs src-tauri/
COPY src-tauri/tauri.conf.json src-tauri/
COPY src-tauri/icons src-tauri/icons/
COPY src-tauri/.cargo src-tauri/.cargo/

RUN cargo build --manifest-path src-tauri/Cargo.toml --release && cp src-tauri/target/release/diskraptor /diskraptor
"@ | Out-File -FilePath Dockerfile.linux -Encoding utf8

# Build the Docker image
docker build -f Dockerfile.linux -t diskraptor-linux-builder .

# Extract the binary
docker create --name diskraptor-extract diskraptor-linux-builder
docker cp diskraptor-extract:/diskraptor ./DiskRaptor-Linux-x64
docker rm diskraptor-extract

# Upload to release
gh release upload $TAG ./DiskRaptor-Linux-x64 --clobber

Write-Host "=== Linux binary uploaded! ===" -ForegroundColor Green
