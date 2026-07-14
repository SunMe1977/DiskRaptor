#!/usr/bin/env python3
"""Fix GalaxyView integration issues in DiskRaptor frontend."""

import re
import os

ROOT = "C:/dev/DiskRaptor/frontend"

def log(msg):
    print(msg)

# ──────────────────────────────────────────────
# Bug 1: Check scan polling loop in app.js
# ──────────────────────────────────────────────
app_path = os.path.join(ROOT, "app.js")
with open(app_path, "r", encoding="utf-8") as f:
    app = f.read()

# Check if galaxyView.updateLiveScan injection is syntactically valid
# The issue might be that the injected code broke the for loop
if "galaxyView.updateLiveScan" in app:
    # Extract the context around the injection
    idx = app.index("galaxyView.updateLiveScan")
    start = max(0, idx - 200)
    end = min(len(app), idx + 300)
    context = app[start:end]
    # Count braces to check balance
    open_braces = context.count("{")
    close_braces = context.count("}")
    log(f"Bug 1 - galaxyView.updateLiveScan found at position {idx}")
    log(f"  Context braces: {open_braces} open, {close_braces} close")
    log(f"  Context snippet: {context[:100]}...")

# Check for the scan button click handler
if "btnScan.addEventListener" in app:
    log("Bug 1 - btnScan click handler found")

# Check for possible syntax issue: missing comma or brace
# Look for the section where the for loop polls
poll_match = re.search(r"for\s*\(\s*var\s+i\s*=\s*0\s*;\s*i\s*<\s*600\s*;\s*i\+\+\)", app)
if poll_match:
    poll_start = poll_match.start()
    poll_section = app[poll_start:poll_start+1000]
    log(f"Bug 1 - Poll loop found at {poll_start}")
    # Check if galaxyView.updateLiveScan is inside this loop
    if "galaxyView.updateLiveScan" in poll_section:
        log("  - galaxyView.updateLiveScan IS inside the poll loop")
    else:
        log("  - galaxyView.updateLiveScan NOT inside poll loop section")

# ──────────────────────────────────────────────
# Bug 2: Galaxy button in diagram controls
# ──────────────────────────────────────────────
html_path = os.path.join(ROOT, "index.html")
with open(html_path, "r", encoding="utf-8") as f:
    html = f.read()

# Check for galaxy button
if 'data-mode="galaxy"' in html:
    log("Bug 2 - Galaxy button found in HTML")
    # Check context
    idx = html.index('data-mode="galaxy"')
    context = html[max(0,idx-150):idx+100]
    log(f"  Context: ...{context[:100]}...")
else:
    log("Bug 2 - Galaxy button MISSING from HTML")

# Check the diagram-controls section
if 'diagram-controls' in html:
    # Count buttons inside diagram-controls
    dc_start = html.index('diagram-controls')
    dc_section = html[dc_start:dc_start+500]
    btn_count = dc_section.count('data-mode=')
    log(f"Bug 2 - Found {btn_count} diagram mode buttons")

# Check CSS for galaxy-related hiding
css_path = os.path.join(ROOT, "style.css")
with open(css_path, "r", encoding="utf-8") as f:
    css = f.read()

if "galaxy-view" in css:
    log("Bug 2 - GalaxyView CSS found")
    # Check if display:none is set
    gv_idx = css.index("galaxy-view")
    gv_section = css[gv_idx:gv_idx+200]
    if "display:none" in gv_section or "display: none" in gv_section:
        log("  - #galaxy-view has display:none (expected for inactive)")

# Check i18n
i18n_path = os.path.join(ROOT, "i18n.js")
with open(i18n_path, "r", encoding="utf-8") as f:
    i18n = f.read()

if "diagram.galaxy" in i18n:
    log("Bug 2 - i18n key 'diagram.galaxy' found")
else:
    log("Bug 2 - i18n key 'diagram.galaxy' MISSING")

# ──────────────────────────────────────────────
# Fix: Ensure scan works - check if the GalaxyView 
# initialization might be throwing and blocking app init
# ──────────────────────────────────────────────
if "GalaxyView.GalaxyView" in app:
    log("Fix check - GalaxyView constructor call found")
    # Check if try/catch wraps it
    gv_idx = app.index("GalaxyView.GalaxyView")
    before = app[max(0,gv_idx-50):gv_idx]
    if "try" in before:
        log("  - Wrapped in try/catch: OK")
    else:
        log("  - NOT wrapped in try/catch: potential issue")

# ──────────────────────────────────────────────
# Apply fixes
# ──────────────────────────────────────────────

# Fix 1: Check if the galaxy button HTML is corrupted 
# (might have encoding issues from the version bump)
old_galaxy_btn = '''                            <button class="diagram-mode" data-mode="galaxy" data-i18n="diagram.galaxy">
                                🌌 Galaxy
                            </button>'''

# Make sure the button is properly formatted
galaxy_btn_html = '''                            <button class="diagram-mode" data-mode="galaxy" data-i18n="diagram.galaxy">
                                🌌 Galaxy
                            </button>'''

if galaxy_btn_html in html:
    log("Fix - Galaxy button HTML is correct")
else:
    log("Fix - Galaxy button HTML needs correction")
    # Replace any malformed galaxy button
    old_pattern = r'<button class="diagram-mode"[^>]*data-mode="galaxy"[^>]*>.*?</button>'
    if re.search(old_pattern, html, re.DOTALL):
        html = re.sub(old_pattern, galaxy_btn_html, html, flags=re.DOTALL)
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html)
        log("  - Fixed galaxy button HTML")

# Write log file
with open("C:/temp/galaxy_fix_log.txt", "w") as f:
    f.write("Galaxy fix analysis complete\n")

print("Analysis complete")
