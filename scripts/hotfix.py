import re

def fix():
    results = []
    
    # === FIX 1: index.html ===
    with open('C:/dev/DiskRaptor/frontend/index.html', 'r', encoding='utf-8') as f:
        html = f.read()
    
    # Remove ALL merge conflict markers
    html = html.replace('<<<<<<< HEAD', '')
    html = html.replace('=======', '')
    html = html.replace('>>>>>>> galaxy-view', '')
    
    # Ensure diagram-controls has exactly: pie, galaxy, treemap buttons in that order
    # Replace the ENTIRE diagram-controls section
    diagram_controls = '''                        <div class="diagram-controls">
                            <button class="diagram-mode active" data-mode="pie" data-i18n="diagram.pie">
                                Pie
                            </button>
                            <button class="diagram-mode" data-mode="galaxy" data-i18n="diagram.galaxy">
                                Galaxy
                            </button>
                            <button class="diagram-mode" data-mode="treemap" data-i18n="diagram.treemap">
                                Treemap
                            </button>
                        </div>'''
    
    # Find and replace the diagram-controls block
    dc_start = html.find('class="diagram-controls"')
    if dc_start > 0:
        # Find the enclosing div
        div_start = html.rfind('<div', 0, dc_start)
        div_end = html.find('</div>', dc_start)
        if div_end > 0:
            div_end = html.find('</div>', div_end + 6) + 6  # Close the outer div
            html = html[:div_start] + diagram_controls + html[div_end:]
    
    # Remove empty lines caused by conflict marker removal
    html = re.sub(r'\n\s*\n\s*\n', '\n\n', html)
    
    with open('C:/dev/DiskRaptor/frontend/index.html', 'w', encoding='utf-8') as f:
        f.write(html)
    results.append(f"index.html: galaxy={'data-mode=\"galaxy\"' in html}, conflicts={'<<<<<<<' not in html}")
    
    # === FIX 2: app.js - check for syntax issues ===
    with open('C:/dev/DiskRaptor/frontend/app.js', 'r', encoding='utf-8') as f:
        app = f.read()
    
    # The galaxyView.updateLiveScan might be injected incorrectly
    # Let's check if there's a syntax issue by looking for unbalanced braces
    # Count braces before and after the injection
    
    # Remove any duplicate or broken galaxyView feed blocks
    # Look for patterns like: if (galaxyView && isGalaxyMode) { ... }
    # The correct placement should be AFTER the running check
    
    # Find the feed block and ensure it's properly placed
    feed_pattern = r'// Feed GalaxyView live scan[\s\S]*?if \(galaxyView && isGalaxyMode\)[\s\S]*?\}'
    if re.search(feed_pattern, app):
        # Extract the feed block
        match = re.search(feed_pattern, app)
        feed_block = match.group()
        
        # Check if it's inside the poll loop but after the running check
        running_check = 'if (running === false || p.phase === 3)'
        if running_check in app:
            rc_pos = app.find(running_check)
            feed_pos = app.find('Feed GalaxyView live scan')
            
            if feed_pos > rc_pos:
                results.append("app.js: galaxyView feed is AFTER running check (correct)")
            else:
                results.append("app.js: galaxyView feed is BEFORE running check (may break scan)")
                
                # Move the feed block to after the running check
                app = app[:feed_pos] + app[feed_pos + len(feed_block):]
                
                # Find the closing brace of the if block after running check
                after_rc = app[rc_pos:]
                brace_count = 0
                insert_pos = rc_pos
                for i, ch in enumerate(after_rc):
                    if ch == '{': brace_count += 1
                    elif ch == '}': 
                        brace_count -= 1
                        if brace_count == 0:
                            insert_pos = rc_pos + i + 1
                            break
                
                app = app[:insert_pos] + '\n' + feed_block + app[insert_pos:]
                results.append("app.js: moved galaxyView feed to correct position")
    
    with open('C:/dev/DiskRaptor/frontend/app.js', 'w', encoding='utf-8') as f:
        f.write(app)
    
    # === FIX 3: i18n ===
    with open('C:/dev/DiskRaptor/frontend/i18n.js', 'r', encoding='utf-8') as f:
        i18n = f.read()
    
    if 'diagram.galaxy' not in i18n:
        i18n = i18n.replace(
            '"diagram.treemap":"Treemap"',
            '"diagram.treemap":"Treemap","diagram.galaxy":"Galaxy","galaxy.empty":"Scan a directory to explore the galaxy","galaxy.timeline":"Time Travel","galaxy.insight.title":"AI Insight"'
        )
        with open('C:/dev/DiskRaptor/frontend/i18n.js', 'w', encoding='utf-8') as f:
            f.write(i18n)
        results.append("i18n: added galaxy keys")
    else:
        results.append("i18n: galaxy keys OK")
    
    # === FIX 4: style.css - ensure galaxy styles exist ===
    with open('C:/dev/DiskRaptor/frontend/style.css', 'r', encoding='utf-8') as f:
        css = f.read()
    
    if '#galaxy-view' not in css:
        galaxy_css = '''
#galaxy-view {
  display: none;
  position: relative;
  flex: 1;
  overflow: hidden;
  background: #0a0a1a;
  min-height: 300px;
}
#galaxy-view.active {
  display: flex;
  flex-direction: column;
}
.galaxy-canvas {
  display: block;
  width: 100%;
  flex: 1;
  cursor: grab;
  touch-action: none;
}
.galaxy-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: rgba(255,255,255,0.3);
  pointer-events: none;
}
.galaxy-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(10,10,26,0.9);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  z-index: 10;
  flex-shrink: 0;
}
.gbtn {
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.08);
  color: rgba(255,255,255,0.7);
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}
.gbtn:hover {
  background: rgba(255,255,255,0.12);
  color: #fff;
}
.galaxy-scan-stats {
  position: absolute;
  top: 50px;
  right: 12px;
  display: flex;
  gap: 12px;
  background: rgba(10,10,26,0.8);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 12px;
  color: rgba(255,255,255,0.7);
  pointer-events: none;
  z-index: 10;
}
.galaxy-insight-overlay {
  position: absolute;
  bottom: 60px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  pointer-events: none;
}
.galaxy-timeline-wrap {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 15;
  padding: 10px 20px;
  background: linear-gradient(transparent, rgba(10,10,26,0.95) 40%);
}
'''
        css += galaxy_css
        with open('C:/dev/DiskRaptor/frontend/style.css', 'w', encoding='utf-8') as f:
            f.write(css)
        results.append("css: added galaxy styles")
    else:
        results.append("css: galaxy styles OK")
    
    return results

r = fix()
with open('C:/temp/hotfix_results.txt', 'w') as f:
    f.write('\n'.join(r))
