import json, urllib.request, sys, os

# Check CI runs
r = json.load(urllib.request.urlopen('https://api.github.com/repos/SunMe1977/DiskRaptor/actions/runs?per_page=5'))
ci = []
for x in r['workflow_runs'][:5]:
    ci.append(f"#{x['run_number']} {x['head_branch']} {x['status']} {x.get('conclusion','?')}")

# Check releases
rel = json.load(urllib.request.urlopen('https://api.github.com/repos/SunMe1977/DiskRaptor/releases?per_page=5'))
rels = []
for x in rel[:3]:
    assets = [a['name'] for a in x['assets']]
    rels.append(f"{x['tag_name']} draft={x['draft']} assets={assets}")

# Check if v0.3.0 exists as a release
v30 = None
for x in rel:
    if x['tag_name'] == 'v0.3.0':
        v30 = {'draft': x['draft'], 'assets': [a['name'] for a in x['assets']], 'html_url': x['html_url']}

out = []
out.append("=== CI RUNS ===")
out.extend(ci)
out.append("")
out.append("=== RELEASES ===")
out.extend(rels)
out.append("")
if v30:
    out.append(f"v0.3.0 EXISTS: draft={v30['draft']} assets={v30['assets']}")
else:
    out.append("v0.3.0 RELEASE NOT FOUND")

open(r'C:\dev\DiskRaptor\status-report.txt', 'w').write('\n'.join(out))
