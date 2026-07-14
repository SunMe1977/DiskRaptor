import re, os, sys

log = []

def fix_index_html():
    path = 'C:/dev/DiskRaptor/frontend/index.html'
    with open(path, 'r', encoding='utf-8') as f:
        html = f.read()
    
    orig = html
    
    # Remove merge conflict markers
    html = html.replace('<<<<<<< HEAD', '')
    html = html.replace('=======', '')
    html = html.replace('>>>>>>> galaxy-view', '')
    
    # Count diagram-mode buttons
    btns = re.findall(r'data-mode="([^"]+)"', html)
    log.append(f"Diagram buttons before fix: {btns}")
    
    # Ensure galaxy button exists in diagram-controls
    if 'data-mode="galaxy"' not in html:
        log.append("Galaxy button missing - adding it")
        # Add after treemap button
        html = html.replace(
            '<button class="diagram-mode" data-mode="treemap"',
            '<button class="diagram-mode" data-mode="galaxy" data-i18n="diagram.galaxy">\n                                Galaxy\n                            </button>\n                            <button class="diagram-mode" data-mode="treemap"',
            1
        )
    
    # Verify no conflict markers remain
    if '<<<<<<<' in html or '>>>>>>>' in html:
        log.append("WARNING: Conflict markers still present!")
    
    if html != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(html)
        log.append("index.html SAVED")
    else:
        log.append("index.html unchanged")
    
    btns_after = re.findall(r'data-mode="([^"]+)"', html)
    log.append(f"Diagram buttons after fix: {btns_after}")
    
    return html

def fix_app_js():
    path = 'C:/dev/DiskRaptor/frontend/app.js'
    with open(path, 'r', encoding='utf-8') as f:
        app = f.read()
    
    orig = app
    
    # Check for syntax errors by looking for common issues
    # The galaxyView.updateLiveScan might be in a broken location
    
    # Find all galaxyView references
    for m in re.finditer(r'galaxyView\.\w+', app):
        pos = m.start()
        line = app[:pos].count('\n') + 1
        context = app[pos:pos+80]
        log.append(f"app.js line {line}: {context}")
    
    if app != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(app)
        log.append("app.js SAVED")
    else:
        log.append("app.js unchanged")

def fix_i18n():
    path = 'C:/dev/DiskRaptor/frontend/i18n.js'
    with open(path, 'r', encoding='utf-8') as f:
        i18n = f.read()
    
    orig = i18n
    
    # Check for galaxy keys
    if 'diagram.galaxy' not in i18n:
        log.append("i18n missing diagram.galaxy key - fixing")
        i18n = i18n.replace(
            '"diagram.treemap":"Treemap"',
            '"diagram.treemap":"Treemap","diagram.galaxy":"Galaxy","galaxy.empty":"Scan a directory to explore the galaxy"'
        )
    
    if i18n != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(i18n)
        log.append("i18n SAVED")
    else:
        log.append("i18n unchanged")

fix_index_html()
fix_app_js()
fix_i18n()

# Write log
with open('C:/temp/fixes_applied.txt', 'w') as f:
    f.write('\n'.join(log))

print('\n'.join(log))
