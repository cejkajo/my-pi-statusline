export interface FooterComponent {
  dispose(): void;
  invalidate(): void;
  render(width: number): string[];
}

interface FooterComponentOptions {
  onBranchChange(callback: () => void): () => void;
  requestRender(): void;
  renderLines(width: number): string[];
  fitLine(line: string, width: number): string;
  onInvalidate?(): void;
  onDispose?(): void;
}

/**
 * Build a custom footer using only Pi's documented footer lifecycle.
 *
 * Pi owns terminal composition and requests ordinary renders when extension
 * statuses change. The footer only subscribes to the one extra signal exposed
 * by FooterDataProvider: Git branch changes.
 */
export function createFooterComponent(options: FooterComponentOptions): FooterComponent {
  let disposed = false;

  const clearCache = () => {
    if (disposed) return;
    options.onInvalidate?.();
  };
  const refresh = () => {
    clearCache();
    if (!disposed) options.requestRender();
  };
  const unsubscribe = options.onBranchChange(refresh);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      options.onDispose?.();
    },
    invalidate() {
      clearCache();
    },
    render(width: number): string[] {
      const boundedWidth = Math.max(0, Math.floor(width));
      return options.renderLines(boundedWidth).map((line) => options.fitLine(line, boundedWidth));
    },
  };
}
