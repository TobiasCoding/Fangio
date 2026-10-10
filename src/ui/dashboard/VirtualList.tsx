// Fixed-row-height windowing: only visible rows (+ overscan) are in the DOM.

import type { ComponentChildren, HTMLAttributes, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface VirtualListProps<T> {
  items: readonly T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ComponentChildren;
  overscan?: number;
  class?: string;
  /** Changing this value scrolls back to the top (e.g. new filters). */
  resetKey?: unknown;
  /** When set (with a new seq), scrolls so that this index is visible. */
  ensureVisible?: { index: number; seq: number } | null;
  /** Props for the scroll container (role, tabIndex, aria-*, onKeyDown...). */
  containerProps?: HTMLAttributes<HTMLDivElement>;
  empty?: ComponentChildren;
  /** Receives the scroll container element. */
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Stable key per item (defaults to the index). */
  getKey?: (item: T, index: number) => string | number;
  /** Fixed height in px; otherwise the container fills its flex parent. */
  height?: number;
}

export function VirtualList<T>(props: VirtualListProps<T>) {
  const { items, rowHeight } = props;
  const overscan = props.overscan ?? 12;
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(props.height ?? 600);
  const frame = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewport(el.clientHeight || props.height || 600);
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.height]);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = 0;
    setScrollTop(0);
  }, [props.resetKey]);

  useEffect(() => {
    const ev = props.ensureVisible;
    const el = ref.current;
    if (!ev || !el) return;
    const top = ev.index * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  }, [props.ensureVisible?.seq]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = ref.current;
      if (el) setScrollTop(el.scrollTop);
    });
  };

  const total = items.length * rowHeight;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  const rows: ComponentChildren[] = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div class="vrow" key={props.getKey ? props.getKey(items[i] as T, i) : i} style={{ transform: `translateY(${i * rowHeight}px)`, height: `${rowHeight}px` }}>
        {props.renderRow(items[i] as T, i)}
      </div>,
    );
  }

  const style = props.height ? { height: `${props.height}px` } : undefined;
  return (
    <div
      {...props.containerProps}
      ref={(el: HTMLDivElement | null) => {
        ref.current = el;
        if (props.containerRef) props.containerRef.current = el;
      }}
      class={`vlist ${props.class ?? ''}`} style={style} onScroll={onScroll}>
      {items.length === 0 && props.empty ? (
        <div class="vlist-empty">{props.empty}</div>
      ) : (
        <div class="vlist-inner" style={{ height: `${total}px` }}>
          {rows}
        </div>
      )}
    </div>
  );
}
