/**
 * TopFiles — Renders the top 100 files table with optional delete buttons.
 */
class TopFilesPanel {
  constructor() {
    this.tbody = document.getElementById('topfiles-body');
  }

  /** Populate the table. Set showDelete=true to add delete buttons. */
  render(topFiles, showDelete) {
    this.tbody.innerHTML = '';

    if (!topFiles || topFiles.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = showDelete ? 4 : 3;
      td.textContent = 'No files found';
      td.style.textAlign = 'center';
      td.style.color = 'var(--text-muted)';
      td.style.padding = '24px';
      tr.appendChild(td);
      this.tbody.appendChild(tr);
      return;
    }

    for (var i = 0; i < Math.min(topFiles.length, 100); i++) {
      var entry = topFiles[i];
      var tr = document.createElement('tr');

      // Rank
      var rankTd = document.createElement('td');
      rankTd.textContent = i + 1;
      tr.appendChild(rankTd);

      // Path
      var pathTd = document.createElement('td');
      pathTd.textContent = entry.path || '?';
      pathTd.title = entry.path || '';
      tr.appendChild(pathTd);

      // Size
      var sizeTd = document.createElement('td');
      sizeTd.textContent = entry.size_human || this._formatSize(entry.size);
      tr.appendChild(sizeTd);

      // Delete button
      if (showDelete) {
        var delTd = document.createElement('td');
        delTd.style.width = '30px';
        delTd.style.textAlign = 'center';
        var delBtn = document.createElement('button');
        delBtn.textContent = '🗑';
        delBtn.style.cssText = 'padding:1px 6px;font-size:12px;background:transparent;border:1px solid var(--border);border-radius:3px;cursor:pointer';
        delBtn.title = 'Delete ' + (entry.path || '');
        delBtn.onclick = function (p) {
          return function () { deletePath(p); };
        }(entry.path);
        delTd.appendChild(delBtn);
        tr.appendChild(delTd);
      }

      this.tbody.appendChild(tr);
    }
  }

  clear() {
    this.tbody.innerHTML = '';
  }

  _formatSize(bytes) {
    if (bytes === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    var val = bytes / Math.pow(1024, i);
    return i === 0 ? bytes + ' B' : val.toFixed(2) + ' ' + units[i];
  }
}

/** Global delete function called by delete buttons. */
async function deletePath(path) {
  if (!path) return;
  if (!confirm('Delete this ' + (path.includes('.') ? 'file' : 'folder') + '?\n' + path)) return;
  try {
    await window.__TAURI__.invoke('delete_path', { path: path });
    // Remove the row visually
    var btn = document.activeElement;
    if (btn) {
      var tr = btn.closest('tr');
      if (tr) tr.style.display = 'none';
    }
    document.querySelector('.status-bar').textContent = 'Deleted: ' + path;
  } catch (e) {
    alert('Delete failed: ' + e);
  }
}
