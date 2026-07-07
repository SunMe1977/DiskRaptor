/**
 * VirtualScroll — Renderer for large lists with DOM recycling.
 *
 * Only renders the visible rows (plus a small overscan buffer).
 * Handles scroll events, resizing, and dynamic row heights.
 *
 * Usage:
 *   const vs = new VirtualScroll(container, {
 *     estimatedRowHeight: 26,
 *     overscan: 10,
 *     renderCell: (index) => {
 *       // Create or recycle a DOM element for this row
 *     }
 *   });
 */
class VirtualScroll {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      estimatedRowHeight: 26,
      overscan: 10,
      ...options,
    };

    this.totalItems = 0;
    this.totalHeight = 0;
    this.scrollTop = 0;
    this.viewportHeight = 0;

    // Pool of recycled row elements
    this.rows = new Map(); // index -> element
    this.rowCache = []; // free elements for recycling

    // Visible range
    this.firstVisible = 0;
    this.lastVisible = 0;

    // Bind
    this._onScroll = this._onScroll.bind(this);
    this._onResize = this._onResize.bind(this);

    // Set up the spacer element to control scroll height
    this.spacer = document.createElement('div');
    this.spacer.style.cssText = 'pointer-events:none;';
    this.container.prepend(this.spacer);

    // Observe scroll
    this.container.addEventListener('scroll', this._onScroll, { passive: true });

    // Observe resize via ResizeObserver
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(this.container);
    }

    // Initial layout
    this._updateViewport();
  }

  /** Set the total number of items and total height. */
  setTotalItems(count, totalHeight = count * this.options.estimatedRowHeight) {
    this.totalItems = count;
    this.totalHeight = totalHeight;
    this.spacer.style.height = `${totalHeight}px`;
    this._update();
  }

  /** Force re-render the visible range. */
  refresh() {
    this._updateViewport();
    this._update();
  }

  /** Scroll to a specific item index. */
  scrollToIndex(index) {
    const top = index * this.options.estimatedRowHeight;
    this.container.scrollTop = Math.max(0, top - this.viewportHeight / 3);
  }

  /** Destroy and clean up. */
  destroy() {
    this.container.removeEventListener('scroll', this._onScroll);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._clearAll();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _onScroll() {
    this.scrollTop = this.container.scrollTop;
    this._update();
  }

  _onResize() {
    this._updateViewport();
    this._update();
  }

  _updateViewport() {
    this.viewportHeight = this.container.clientHeight;
  }

  _update() {
    if (this.totalItems === 0) {
      this._clearAll();
      return;
    }

    const { estimatedRowHeight, overscan } = this.options;

    // Compute visible range
    this.firstVisible = Math.max(0, Math.floor(this.scrollTop / estimatedRowHeight) - overscan);
    this.lastVisible = Math.min(
      this.totalItems - 1,
      Math.ceil((this.scrollTop + this.viewportHeight) / estimatedRowHeight) + overscan
    );

    // Remove rows that are no longer visible
    for (const [index, el] of this.rows) {
      if (index < this.firstVisible || index > this.lastVisible) {
        this._recycleRow(index);
      }
    }

    // Add or update visible rows
    for (let i = this.firstVisible; i <= this.lastVisible; i++) {
      if (!this.rows.has(i)) {
        this._createRow(i);
      } else {
        this._updateRow(i);
      }
    }
  }

  _createRow(index) {
    // Recycle or create
    let el = this.rowCache.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'tree-row';
    }
    el.style.position = 'absolute';
    el.style.top = `${index * this.options.estimatedRowHeight}px`;
    el.style.left = '0';
    el.style.right = '0';
    el.style.height = `${this.options.estimatedRowHeight}px`;
    el.dataset.index = index;
    this.container.appendChild(el);
    this.rows.set(index, el);

    // Let the consumer fill the element
    if (this.options.renderCell) {
      this.options.renderCell(index, el);
    }
  }

  _updateRow(index) {
    const el = this.rows.get(index);
    if (el && this.options.renderCell) {
      this.options.renderCell(index, el);
    }
  }

  _recycleRow(index) {
    const el = this.rows.get(index);
    if (el) {
      this.rows.delete(index);
      this.container.removeChild(el);
      // Clear content for reuse
      el.innerHTML = '';
      this.rowCache.push(el);
    }
  }

  _clearAll() {
    for (const index of this.rows.keys()) {
      this._recycleRow(index);
    }
  }
}
