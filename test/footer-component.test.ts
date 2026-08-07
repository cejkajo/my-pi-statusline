import assert from "node:assert/strict";
import test from "node:test";
import { createFooterComponent } from "../footer-component.ts";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

test("bounds every footer line to Pi's supplied width", () => {
  const footer = createFooterComponent({
    onBranchChange: () => () => {},
    requestRender: () => {},
    renderLines: () => ["0123456789", "\x1b[31mabcdefghij\x1b[0m", "ok"],
    fitLine: (line, width) => stripAnsi(line).slice(0, width),
  });

  assert.deepEqual(footer.render(4), ["0123", "abcd", "ok"]);
  assert.deepEqual(footer.render(0), ["", "", ""]);
});

test("uses the supported branch subscription and component invalidation lifecycle", () => {
  let branchListener: (() => void) | undefined;
  let unsubscribeCount = 0;
  let invalidationCount = 0;
  let renderRequestCount = 0;

  const footer = createFooterComponent({
    onBranchChange(listener) {
      branchListener = listener;
      return () => { unsubscribeCount++; };
    },
    requestRender: () => { renderRequestCount++; },
    renderLines: () => [],
    fitLine: (line) => line,
    onInvalidate: () => { invalidationCount++; },
  });

  branchListener?.();
  footer.invalidate();
  assert.equal(invalidationCount, 2);
  assert.equal(renderRequestCount, 1);

  footer.dispose();
  footer.dispose();
  branchListener?.();
  assert.equal(unsubscribeCount, 1);
  assert.equal(invalidationCount, 2);
  assert.equal(renderRequestCount, 1);
});
