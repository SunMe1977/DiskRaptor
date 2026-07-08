/**
 * DiskRaptor Diagrams — Canvas-based visualizations
 *
 * Two diagram modes:
 * 1. Pie Chart — File type distribution by total size
 * 2. Treemap — Directory size visualization
 */

class DiagramRenderer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    this.canvas = null;
    this.ctx = null;
    this.mode = 'pie'; // 'pie' or 'treemap'
    this.data = null;
    this._init();
  }

  _init() {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._draw();
  }

  setMode(mode) {
    if (mode !== 'pie' && mode !== 'treemap') return;
    this.mode = mode;
    this._draw();
  }

  setData(data) {
    this.data = data;
    this._draw();
  }

  _draw() {
    if (!this.ctx || !this.canvas || !this.data) return;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.clearRect(0, 0, w, h);

    if (this.mode === 'pie') {
      this._drawPie(w, h);
    } else {
      this._drawTreemap(w, h);
    }
  }

  _drawPie(w, h) {
    const ctx = this.ctx;
    const cx = w * 0.4;
    const cy = h / 2;
    const radius = Math.min(cx - 20, cy - 20, 120);

    const types = this.data.file_type_breakdown || [];
    const totalSize = this.data.total_size || 1;

    // Draw pie
    let startAngle = -Math.PI / 2;
    const colors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
                    '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff',
                    '#8b949e', '#484f58', '#30363d'];

    types.slice(0, 12).forEach((t, i) => {
      const sliceAngle = (t.total_size / totalSize) * Math.PI * 2;
      const color = colors[i % colors.length];

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      // Label
      if (sliceAngle > 0.15) {
        const midAngle = startAngle + sliceAngle / 2;
        const lx = cx + Math.cos(midAngle) * (radius * 0.6);
        const ly = cy + Math.sin(midAngle) * (radius * 0.6);
        ctx.fillStyle = '#fff';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t.extension, lx, ly + 4);
      }

      startAngle += sliceAngle;
    });

    // Legend
    const legendX = w * 0.65;
    let legendY = 30;
    ctx.font = '11px sans-serif';
    types.slice(0, 12).forEach((t, i) => {
      const color = colors[i % colors.length];
      const pct = ((t.total_size / totalSize) * 100).toFixed(1);

      ctx.fillStyle = color;
      ctx.fillRect(legendX, legendY, 10, 10);

      ctx.fillStyle = '#e6edf3';
      ctx.textAlign = 'left';
      ctx.fillText(t.extension + ' (' + pct + '%)', legendX + 16, legendY + 10);
      legendY += 18;
    });

    // Center text
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    const total = types.reduce((s, t) => s + t.count, 0);
    ctx.fillText((total || 0).toLocaleString() + ' files', cx, cy + 4);
  }

  _drawTreemap(w, h) {
    const ctx = this.ctx;
    const types = this.data.file_type_breakdown || [];
    if (types.length === 0) {
      ctx.fillStyle = '#484f58';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data', w / 2, h / 2);
      return;
    }

    const totalSize = types.reduce((s, t) => s + t.total_size, 0) || 1;
    const colors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
                    '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff',
                    '#8b949e', '#484f58'];

    // Simple squarified treemap using a row-based layout
    let x = 10, y = 10;
    let rowWidth = w - 20;
    let rowHeight = 0;
    let items = types.slice(0, 12).map(t => ({
      ...t,
      ratio: t.total_size / totalSize
    }));

    items.forEach((item, i) => {
      const area = item.ratio * (w - 20) * (h - 20);
      const cellW = Math.sqrt(area * (rowWidth / (rowWidth || 1)));
      const cellH = area / cellW;

      if (x + cellW > w - 10 && y + cellH < h - 10) {
        // Wrap to next line
        x = 10;
        y += rowHeight || cellH;
        rowHeight = cellH;
      } else if (x + cellW > w - 10) {
        // Start new column
        x = 10;
        y += 5;
      }

      const cw = Math.min(cellW, w - x - 10);
      const ch = Math.min(cellH, h - y - 10);

      if (cw > 5 && ch > 5) {
        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(x, y, cw, ch);

        // Label
        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        if (cw > 30) {
          ctx.fillText(item.extension, x + 4, y + 12);
          const pct = (item.ratio * 100).toFixed(1) + '%';
          ctx.font = '9px sans-serif';
          ctx.fillText(pct, x + 4, y + 24);
        }

        x += cw + 2;
        rowHeight = Math.max(rowHeight, ch);
      }
    });

    // Title
    ctx.fillStyle = '#8b949e';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('File Types by Size', w / 2, h - 8);
  }
}
