import { useStore } from "../store";
import type { OutlineItem } from "../types";

function buildChildrenMap(items: OutlineItem[]): Map<string | null, OutlineItem[]> {
  const map = new Map<string | null, OutlineItem[]>();
  for (const item of items) {
    const key = item.parent_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  for (const list of map.values()) list.sort((a, b) => a.order_index - b.order_index);
  return map;
}

// Best-effort highlight: the latest heading at or before the current page.
function findActiveId(items: OutlineItem[], currentPage: number): string | null {
  let best: OutlineItem | null = null;
  for (const item of items) {
    if (item.page <= currentPage && (!best || item.page > best.page)) best = item;
  }
  return best?.id ?? null;
}

function OutlineNode({
  item,
  depth,
  childrenMap,
  activeId,
}: {
  item: OutlineItem;
  depth: number;
  childrenMap: Map<string | null, OutlineItem[]>;
  activeId: string | null;
}) {
  const { expandedOutlineIds, toggleOutlineExpanded, jumpToPage } = useStore();
  const children = childrenMap.get(item.id) ?? [];
  const hasChildren = children.length > 0;
  const expanded = expandedOutlineIds.has(item.id);

  return (
    <>
      <button
        className={`outline-item${activeId === item.id ? " outline-item--active" : ""}`}
        style={{ paddingLeft: `${18 + depth * 14}px` }}
        onClick={() => jumpToPage?.(item.page)}
        title={item.title}
      >
        {hasChildren ? (
          <span
            className={`outline-chevron${expanded ? " outline-chevron--expanded" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleOutlineExpanded(item.id);
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        ) : (
          <span className="outline-chevron outline-chevron--spacer" />
        )}
        <span className="outline-item-title">{item.title}</span>
        <span className="outline-item-page">p.{item.page}</span>
      </button>
      {hasChildren && expanded && (
        <>
          {children.map((child) => (
            <OutlineNode key={child.id} item={child} depth={depth + 1} childrenMap={childrenMap} activeId={activeId} />
          ))}
        </>
      )}
    </>
  );
}

export function OutlineSection() {
  const {
    selectedPdfId,
    outline,
    outlineLoading,
    outlineAttempted,
    currentPage,
    isOutlineSectionExpanded,
    setOutlineSectionExpanded,
    requestOutlineExtraction,
  } = useStore();

  if (!selectedPdfId) return null;

  const childrenMap = buildChildrenMap(outline);
  const roots = childrenMap.get(null) ?? [];
  const activeId = findActiveId(outline, currentPage);

  const handleToggle = () => {
    const next = !isOutlineSectionExpanded;
    setOutlineSectionExpanded(next);
    // Lazy extraction: only kick off the embedded/AI lookup the first time
    // the section is expanded for this PDF — not on every open/collapse.
    if (next && !outlineAttempted) {
      requestOutlineExtraction?.();
    }
  };

  return (
    <div className="nav-section">
      <button
        className="nav-section-header nav-section-header--toggle"
        onClick={handleToggle}
        aria-expanded={isOutlineSectionExpanded}
      >
        <span className={`outline-section-chevron${isOutlineSectionExpanded ? " outline-section-chevron--expanded" : ""}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="nav-section-title">Outline</span>
      </button>

      <div className={`outline-collapse${isOutlineSectionExpanded ? " outline-collapse--expanded" : ""}`}>
        <div className="outline-collapse-inner">
          {outlineLoading ? (
            <p className="sidebar-empty">Generating outline…</p>
          ) : outline.length === 0 ? (
            outlineAttempted && <p className="sidebar-empty">No outline available</p>
          ) : (
            <div className="outline-tree">
              {roots.map((item) => (
                <OutlineNode key={item.id} item={item} depth={0} childrenMap={childrenMap} activeId={activeId} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
