import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import { HIGHLIGHT_COLORS } from '../constants/highlights';
import { bytesToFloat32 } from '../utils/embeddings';
import type { Note, Flashcard, GraphNode, GraphEdge, GraphNodeType, GraphEdgeKind, Pdf } from '../types';

// Node fills — warm amber ramp from the design tokens; flashcards keep the
// app's semantic "flashcards" green so the graph reads with the same color
// language as highlights and the lens switcher.
const NODE_COLORS: Record<GraphNodeType, string> = {
  pdf: '#f5a623',                          // --accent-container
  note: '#ffd6a0',                         // --accent-bright
  flashcard: HIGHLIGHT_COLORS.green.hex,   // semantic flashcard green
  tag: '#9f8e7a',                          // --text-muted (hollow ring)
};

// ── Force simulation constants ──────────────────────────────────────────────
const ALPHA_MIN = 0.02;      // below this the layout is considered settled
const ALPHA_DECAY = 0.992;
const REPULSION = 2600;
const SPRING_K = 0.035;
const DAMPING = 0.82;
const GRAVITY = 0.012;
const MAX_VELOCITY = 14;
const REPULSION_CUTOFF = 360; // world units beyond which repulsion is skipped
const EDGE_REST: Record<GraphEdgeKind, number> = { citation: 120, derived: 85, tagged: 75, semantic: 190, linked: 100 };

// ── Semantic similarity edges ────────────────────────────────────────────────
// Document↔document edges derived from the ingestion pipeline's chunk
// embeddings: each PDF gets a normalized centroid vector (mean of its chunk
// embeddings), and doc pairs whose cosine similarity clears the threshold
// connect. Capped per doc so a homogeneous library doesn't become a hairball.
// Calibrated against real MiniLM doc centroids: related docs (e.g. a résumé
// and a statement of interest) score ~0.5; unrelated ones ≤ ~0.25.
const SEMANTIC_THRESHOLD = 0.45;
const SEMANTIC_WEIGHT_CEIL = 0.85; // sims at/above this render at full strength
const SEMANTIC_MAX_PER_DOC = 3;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Mean chunk embedding per PDF, L2-normalized so pair similarity below is a
// plain dot product.
function computeDocCentroids(chunks: Array<{ source_id: string; embedding: number[] }>): Map<string, Float32Array> {
  const sums = new Map<string, { v: Float64Array; n: number }>();
  for (const c of chunks) {
    if (!c.embedding.length) continue;
    const vec = bytesToFloat32(c.embedding);
    let entry = sums.get(c.source_id);
    if (!entry) {
      entry = { v: new Float64Array(vec.length), n: 0 };
      sums.set(c.source_id, entry);
    }
    for (let i = 0; i < vec.length; i++) entry.v[i] += vec[i];
    entry.n++;
  }
  const centroids = new Map<string, Float32Array>();
  for (const [id, { v, n }] of sums) {
    const mean = new Float32Array(v.length);
    let mag = 0;
    for (let i = 0; i < v.length; i++) {
      mean[i] = v[i] / n;
      mag += mean[i] * mean[i];
    }
    mag = Math.sqrt(mag) || 1;
    for (let i = 0; i < mean.length; i++) mean[i] /= mag;
    centroids.set(id, mean);
  }
  return centroids;
}

// All doc pairs above SEMANTIC_THRESHOLD, strongest first, each doc keeping
// at most SEMANTIC_MAX_PER_DOC edges. weight is the similarity re-normalized
// to 0–1 over the retained range for rendering.
function computeSemanticPairs(centroids: Map<string, Float32Array>): Array<{ a: string; b: string; weight: number }> {
  const ids = Array.from(centroids.keys());
  const scored: Array<{ a: string; b: string; sim: number }> = [];
  for (let i = 0; i < ids.length; i++) {
    const va = centroids.get(ids[i])!;
    for (let j = i + 1; j < ids.length; j++) {
      const vb = centroids.get(ids[j])!;
      let dot = 0;
      for (let k = 0; k < va.length; k++) dot += va[k] * vb[k];
      if (dot >= SEMANTIC_THRESHOLD) scored.push({ a: ids[i], b: ids[j], sim: dot });
    }
  }
  scored.sort((x, y) => y.sim - x.sim);
  const perDoc = new Map<string, number>();
  const pairs: Array<{ a: string; b: string; weight: number }> = [];
  for (const p of scored) {
    const usedA = perDoc.get(p.a) ?? 0;
    const usedB = perDoc.get(p.b) ?? 0;
    if (usedA >= SEMANTIC_MAX_PER_DOC || usedB >= SEMANTIC_MAX_PER_DOC) continue;
    perDoc.set(p.a, usedA + 1);
    perDoc.set(p.b, usedB + 1);
    pairs.push({
      a: p.a,
      b: p.b,
      weight: Math.min(1, (p.sim - SEMANTIC_THRESHOLD) / (SEMANTIC_WEIGHT_CEIL - SEMANTIC_THRESHOLD)),
    });
  }
  return pairs;
}

// Crude markdown → plain text for the info-card preview.
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]()!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extracts [[wiki link]] targets from note markdown — the explicit
// note-to-note references users draw themselves. Supports the
// [[target|alias]] form; returns trimmed, lowercased target titles.
function extractWikiLinks(markdown: string): string[] {
  const targets: string[] = [];
  const re = /\[\[([^[\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const target = m[1].split('|')[0].trim().toLowerCase();
    if (target) targets.push(target);
  }
  return targets;
}

// Builds nodes + edges from the raw entities. Positions of nodes that already
// existed in the previous build are preserved (keyed by id) so live refreshes
// don't scramble a layout the user has arranged.
function buildGraph(
  pdfs: Pdf[],
  notes: Note[],
  cards: Flashcard[],
  semanticPairs: Array<{ a: string; b: string; weight: number }>,
  prev: Map<string, GraphNode>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byId = new Map<string, GraphNode>();

  const push = (n: GraphNode) => {
    const old = prev.get(n.id);
    if (old) {
      n.x = old.x; n.y = old.y; n.vx = old.vx; n.vy = old.vy;
    }
    nodes.push(n);
    byId.set(n.id, n);
  };

  // Documents seeded on a ring so the first layout starts untangled.
  const ring = 140 + 26 * Math.sqrt(pdfs.length);
  pdfs.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, pdfs.length);
    push({
      id: `pdf:${p.id}`, refId: p.id, type: 'pdf',
      label: truncate(p.filename.replace(/\.pdf$/i, ''), 28),
      pdfId: p.id, page: null, radius: 10,
      x: Math.cos(angle) * ring, y: Math.sin(angle) * ring, vx: 0, vy: 0,
    });
  });

  const pdfIds = new Set(pdfs.map((p) => p.id));

  for (const pair of semanticPairs) {
    if (pdfIds.has(pair.a) && pdfIds.has(pair.b)) {
      edges.push({ source: `pdf:${pair.a}`, target: `pdf:${pair.b}`, kind: 'semantic', weight: pair.weight });
    }
  }

  const jitterNear = (anchorId: string | null) => {
    const anchor = anchorId ? byId.get(`pdf:${anchorId}`) : undefined;
    return {
      x: (anchor?.x ?? 0) + (Math.random() - 0.5) * 130,
      y: (anchor?.y ?? 0) + (Math.random() - 0.5) * 130,
    };
  };

  const tagNames = new Set<string>();
  for (const note of notes) {
    const srcPdfId = note.source_pdf_id && pdfIds.has(note.source_pdf_id) ? note.source_pdf_id : null;
    const pos = jitterNear(srcPdfId);
    push({
      id: `note:${note.id}`, refId: note.id, type: 'note',
      label: truncate(note.title || 'Untitled', 26),
      pdfId: srcPdfId, page: note.source_page, radius: 6.5,
      x: pos.x, y: pos.y, vx: 0, vy: 0,
    });
    if (srcPdfId) edges.push({ source: `note:${note.id}`, target: `pdf:${srcPdfId}`, kind: 'citation' });
    for (const t of note.tags) tagNames.add(t);
  }

  // Explicit [[wiki links]] between notes. Titles resolve case-insensitively;
  // when several notes share a title, the most recently updated wins
  // (get_notes orders by updated_at DESC, so the first occurrence is newest).
  const noteIdByTitle = new Map<string, string>();
  for (const note of notes) {
    const key = note.title.trim().toLowerCase();
    if (key && !noteIdByTitle.has(key)) noteIdByTitle.set(key, note.id);
  }
  const seenLinks = new Set<string>();
  for (const note of notes) {
    for (const target of extractWikiLinks(note.content_markdown)) {
      const targetId = noteIdByTitle.get(target);
      if (!targetId || targetId === note.id) continue;
      const pairKey = note.id < targetId ? `${note.id}|${targetId}` : `${targetId}|${note.id}`;
      if (seenLinks.has(pairKey)) continue;
      seenLinks.add(pairKey);
      edges.push({ source: `note:${note.id}`, target: `note:${targetId}`, kind: 'linked' });
    }
  }

  for (const card of cards) {
    const srcPdfId = card.pdf_id && pdfIds.has(card.pdf_id) ? card.pdf_id : null;
    const pos = jitterNear(srcPdfId);
    push({
      id: `card:${card.id}`, refId: card.id, type: 'flashcard',
      label: truncate(card.front, 24),
      pdfId: srcPdfId, page: card.page, radius: 4.5,
      x: pos.x, y: pos.y, vx: 0, vy: 0,
    });
    if (srcPdfId) edges.push({ source: `card:${card.id}`, target: `pdf:${srcPdfId}`, kind: 'derived' });
  }

  // Tags become nodes of their own — two notes sharing a tag connect through
  // it, which is how "shared tag" relationships surface as graph structure.
  for (const tag of tagNames) {
    const tagged = notes.filter((n) => n.tags.includes(tag));
    const cx = tagged.reduce((s, n) => s + (byId.get(`note:${n.id}`)?.x ?? 0), 0) / Math.max(1, tagged.length);
    const cy = tagged.reduce((s, n) => s + (byId.get(`note:${n.id}`)?.y ?? 0), 0) / Math.max(1, tagged.length);
    push({
      id: `tag:${tag}`, refId: tag, type: 'tag',
      label: `#${tag}`, pdfId: null, page: null, radius: 5.5,
      x: cx + (Math.random() - 0.5) * 60, y: cy + (Math.random() - 0.5) * 60, vx: 0, vy: 0,
    });
    for (const n of tagged) edges.push({ source: `note:${n.id}`, target: `tag:${tag}`, kind: 'tagged' });
  }

  // Well-connected documents grow with their degree so hubs read as hubs.
  // Semantic edges are excluded — document size means "annotation activity",
  // not "topically similar to other documents".
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (e.kind === 'semantic') continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  for (const n of nodes) {
    if (n.type === 'pdf') n.radius = 9 + Math.min(8, (degree.get(n.id) ?? 0) * 1.1);
    if (n.type === 'tag') n.radius = 5 + Math.min(4, (degree.get(n.id) ?? 0) * 0.6);
  }

  return { nodes, edges };
}

export function GraphView() {
  const { pdfs, notes, flashcards } = useStore();
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 });
  const [loaded, setLoaded] = useState(false);
  // Info card shown when a clicked node has nothing to navigate to (tags,
  // and notes/cards whose source PDF was deleted). Anchored at the click
  // position in container coordinates.
  const [infoCard, setInfoCard] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  // One-time onboarding card on first graph open — persisted via the
  // settings table (key `graph_hint_seen`) so it never reappears.
  const [showOnboardCard, setShowOnboardCard] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);
  const nodeMapRef = useRef<Map<string, GraphNode>>(new Map());
  const adjacencyRef = useRef<Map<string, Set<string>>>(new Map());
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const alphaRef = useRef(1);
  const hoverRef = useRef<GraphNode | null>(null);
  const focusRef = useRef<string | null>(null);
  const dragRef = useRef<{ mode: 'pan' | 'node'; node: GraphNode | null; sx: number; sy: number; vx0: number; vy0: number; moved: boolean } | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const fittedRef = useRef(false);
  // Full Note rows keyed by id — the info card needs content/tags, which
  // GraphNode deliberately doesn't carry.
  const noteDetailsRef = useRef<Map<string, Note>>(new Map());

  const fitView = useCallback(() => {
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    if (!w || !h) return;
    if (!nodes.length) {
      viewRef.current = { x: w / 2, y: h / 2, k: 1 };
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const bw = Math.max(maxX - minX, 1) + 160;
    const bh = Math.max(maxY - minY, 1) + 160;
    const k = Math.min(Math.max(Math.min(w / bw, h / bh), 0.2), 1.4);
    viewRef.current = {
      k,
      x: w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k,
    };
  }, []);

  // First-open hint: `get_setting` returns '' for unknown keys, so anything
  // other than 'true' means the user hasn't dismissed the card yet.
  useEffect(() => {
    invoke<string>('get_setting', { key: 'graph_hint_seen' })
      .then((v) => { if (v !== 'true') setShowOnboardCard(true); })
      .catch(() => {});
  }, []);

  const dismissOnboardCard = useCallback(() => {
    setShowOnboardCard(false);
    invoke('set_setting', { key: 'graph_hint_seen', value: 'true' }).catch(() => {});
  }, []);

  // ── Canvas sizing (DPR-aware, tracks the container) ───────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // ── Data → graph. Refetches everything whenever the store's pdfs/notes/
  // flashcards slices change, so edits and background sync pulls made while
  // the graph is open flow straight into the map. ─────────────────────────
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const [notesJson, cardsJson, chunksJson] = await Promise.all([
          invoke<string>('get_notes', {}),
          invoke<string>('get_all_flashcards'),
          invoke<string>('get_all_chunks'),
        ]);
        if (stale) return;
        const allNotes: Note[] = JSON.parse(notesJson);
        const allCards: Flashcard[] = JSON.parse(cardsJson);
        const allChunks: Array<{ source_id: string; embedding: number[] }> = JSON.parse(chunksJson);
        noteDetailsRef.current = new Map(allNotes.map((n) => [n.id, n]));
        const semanticPairs = computeSemanticPairs(computeDocCentroids(allChunks));
        const { nodes, edges } = buildGraph(pdfs, allNotes, allCards, semanticPairs, nodeMapRef.current);

        nodesRef.current = nodes;
        edgesRef.current = edges;
        nodeMapRef.current = new Map(nodes.map((n) => [n.id, n]));
        const adjacency = new Map<string, Set<string>>();
        for (const e of edges) {
          if (!adjacency.has(e.source)) adjacency.set(e.source, new Set());
          if (!adjacency.has(e.target)) adjacency.set(e.target, new Set());
          adjacency.get(e.source)!.add(e.target);
          adjacency.get(e.target)!.add(e.source);
        }
        adjacencyRef.current = adjacency;
        if (focusRef.current && !nodeMapRef.current.has(focusRef.current)) focusRef.current = null;

        alphaRef.current = 1;
        if (!fittedRef.current) {
          fitView();
          fittedRef.current = true;
        }
        setCounts({ nodes: nodes.length, edges: edges.length });
        setLoaded(true);
      } catch (err) {
        console.error('Failed to load graph data:', err);
        setLoaded(true);
      }
    })();
    return () => { stale = true; };
  }, [pdfs, notes, flashcards, fitView]);

  // ── Simulation + render loop ───────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;

    const tick = () => {
      const alpha = alphaRef.current;
      if (alpha < ALPHA_MIN) return;
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const map = nodeMapRef.current;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          if (d2 > REPULSION_CUTOFF * REPULSION_CUTOFF) continue;
          const d = Math.sqrt(d2);
          const f = (REPULSION * alpha) / d2;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }

      for (const e of edges) {
        const a = map.get(e.source), b = map.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        // Semantic springs are deliberately soft — they nudge related
        // document clusters toward each other without collapsing the layout,
        // pulling harder the more similar the pair.
        const stiffness = e.kind === 'semantic' ? 0.15 + 0.35 * (e.weight ?? 0.5) : 1;
        const f = SPRING_K * stiffness * (d - EDGE_REST[e.kind]) * alpha;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      const dragged = dragRef.current?.mode === 'node' ? dragRef.current.node : null;
      for (const n of nodes) {
        if (n === dragged) { n.vx = 0; n.vy = 0; continue; }
        n.vx = (n.vx - n.x * GRAVITY * alpha) * DAMPING;
        n.vy = (n.vy - n.y * GRAVITY * alpha) * DAMPING;
        n.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, n.vx));
        n.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, n.vy));
        n.x += n.vx;
        n.y += n.vy;
      }
      alphaRef.current = alpha * ALPHA_DECAY;
    };

    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const { w, h, dpr } = sizeRef.current;
      const view = viewRef.current;
      const nodes = nodesRef.current;
      const edges = edgesRef.current;
      const map = nodeMapRef.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);

      // Faint dot grid for pan/zoom orientation
      if (view.k > 0.35) {
        const step = 48;
        const x0 = Math.floor(-view.x / view.k / step) * step;
        const y0 = Math.floor(-view.y / view.k / step) * step;
        const x1 = (w - view.x) / view.k;
        const y1 = (h - view.y) / view.k;
        const dot = 1.5 / view.k;
        ctx.fillStyle = 'rgba(159, 142, 122, 0.10)';
        for (let gx = x0; gx <= x1; gx += step) {
          for (let gy = y0; gy <= y1; gy += step) {
            ctx.fillRect(gx - dot / 2, gy - dot / 2, dot, dot);
          }
        }
      }

      const focusNode = focusRef.current ? map.get(focusRef.current) ?? null : null;
      const active = hoverRef.current ?? focusNode;
      const activeSet = active
        ? new Set([active.id, ...(adjacencyRef.current.get(active.id) ?? [])])
        : null;

      for (const e of edges) {
        const a = map.get(e.source), b = map.get(e.target);
        if (!a || !b) continue;
        const lit = active !== null && (e.source === active.id || e.target === active.id);
        if (e.kind === 'semantic') {
          // Fine-dotted amber, opacity and width scaling with similarity.
          const wgt = e.weight ?? 0.5;
          ctx.strokeStyle = lit
            ? 'rgba(245, 166, 35, 0.85)'
            : activeSet ? 'rgba(245, 166, 35, 0.06)' : `rgba(245, 166, 35, ${0.12 + 0.22 * wgt})`;
          ctx.lineWidth = (lit ? 1.8 : 0.8 + wgt) / view.k;
          ctx.setLineDash([2 / view.k, 3 / view.k]);
        } else {
          // Wiki links are user-drawn — render them a notch brighter and
          // heavier than the inferred citation/derived/tagged edges.
          ctx.strokeStyle = lit
            ? 'rgba(255, 200, 128, 0.75)'
            : activeSet
              ? 'rgba(159, 142, 122, 0.08)'
              : e.kind === 'linked' ? 'rgba(255, 214, 160, 0.40)' : 'rgba(159, 142, 122, 0.22)';
          ctx.lineWidth = (lit ? 1.6 : e.kind === 'linked' ? 1.3 : 1) / view.k;
          ctx.setLineDash(e.kind === 'tagged' ? [4 / view.k, 4 / view.k] : []);
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of nodes) {
        ctx.globalAlpha = activeSet && !activeSet.has(n.id) ? 0.22 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        if (n.type === 'tag') {
          ctx.fillStyle = '#19120a';
          ctx.fill();
          ctx.strokeStyle = NODE_COLORS.tag;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.fillStyle = NODE_COLORS[n.type];
          ctx.fill();
        }
        if (active && n.id === active.id) {
          ctx.strokeStyle = 'rgba(255, 240, 220, 0.9)';
          ctx.lineWidth = 2 / view.k;
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius + 4 / view.k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // Persistent dashed ring on the click-focused node — stays visible
      // even while hover moves elsewhere.
      if (focusNode) {
        ctx.strokeStyle = 'rgba(255, 200, 128, 0.9)';
        ctx.lineWidth = 1.5 / view.k;
        ctx.setLineDash([5 / view.k, 4 / view.k]);
        ctx.beginPath();
        ctx.arc(focusNode.x, focusNode.y, focusNode.radius + 7 / view.k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Labels render at constant screen size (world font scaled by 1/k)
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const fontSize = 11 / view.k;
      for (const n of nodes) {
        if (activeSet && !activeSet.has(n.id)) continue;
        const isActive = active !== null && n.id === active.id;
        const isNeighbor = activeSet?.has(n.id) ?? false;
        const show = n.type === 'pdf' ? view.k > 0.45 : isActive || isNeighbor || view.k > 1.25;
        if (!show) continue;
        ctx.font = `${n.type === 'pdf' ? 500 : 400} ${fontSize}px 'Hanken Grotesk', system-ui, sans-serif`;
        ctx.fillStyle = isActive ? '#ffd6a0' : n.type === 'pdf' ? '#d7c3ae' : '#9f8e7a';
        ctx.fillText(n.label, n.x, n.y + n.radius + 5 / view.k);
      }
    };

    const loop = () => {
      tick();
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Interaction: pan, zoom, node drag, hover, click-to-open ───────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const localPos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    };
    const toWorld = (sx: number, sy: number) => {
      const v = viewRef.current;
      return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
    };
    const pick = (sx: number, sy: number): GraphNode | null => {
      const { x, y } = toWorld(sx, sy);
      const nodes = nodesRef.current;
      // Hit radius floors at ~12 CSS px — at fit zoom the small note/card
      // dots are only a few pixels wide, far too small a click target.
      const minR = 12 / viewRef.current.k;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = Math.max(n.radius + 2 / viewRef.current.k, minR);
        const dx = x - n.x, dy = y - n.y;
        if (dx * dx + dy * dy <= r * r) return n;
      }
      return null;
    };

    // Clicking a node routes into the app's existing navigation: documents
    // open in the reader, notes open their editor in the right panel, and
    // flashcards jump to the page of their source highlight. Tags — and
    // orphaned notes/cards whose source PDF was deleted (delete_pdf severs
    // notes.source_pdf_id on purpose) — have nothing to open, so they get a
    // neighborhood focus plus an info card at the click position instead.
    // Opens pdfId into whichever pane already has it (jumping directly and
    // just focusing), or into the focused pane if it isn't open anywhere —
    // same "jump always targets the focused pane" rule SearchModal follows.
    // Returns which pane the document ended up in, so the caller can route
    // any follow-up pane-scoped action (e.g. setSelectedNoteId) correctly.
    const openPdfForNode = (pdfId: string, page: number | null): 'A' | 'B' => {
      const s = useStore.getState();
      if (s.selectedPdfId === pdfId) {
        if (page != null) s.jumpToPage?.(page);
        s.focusPane('A');
        return 'A';
      }
      if (s.paneB?.pdfId === pdfId) {
        if (page != null) s.paneB.jumpToPage?.(page);
        s.focusPane('B');
        return 'B';
      }
      if (s.focusedPane === 'A') {
        if (page != null) s.setPendingJumpPage(page);
        s.selectPdf(pdfId);
        return 'A';
      }
      if (page != null) s.setPendingJumpPageB(page);
      s.openPaneB(pdfId);
      return 'B';
    };

    const openNode = (n: GraphNode, sx: number, sy: number) => {
      const s = useStore.getState();
      if (n.type === 'pdf') {
        openPdfForNode(n.refId, null);
        return;
      }
      // Standalone notes (no source PDF) open in the full-page Notebook
      // workspace instead of falling through to the generic "no
      // destination" info-card behavior tags and orphaned notes get.
      if (n.type === 'note' && !n.pdfId) {
        s.openStandaloneNote(n.refId);
        return;
      }
      if (n.type === 'tag' || !n.pdfId) {
        focusRef.current = n.id;
        const { w, h } = sizeRef.current;
        setInfoCard({
          nodeId: n.id,
          x: Math.max(8, Math.min(sx + 14, w - 274)),
          y: Math.max(8, Math.min(sy + 14, h - 190)),
        });
        return;
      }
      const targetPane = openPdfForNode(n.pdfId, n.page ?? null);
      if (n.type === 'note') {
        if (targetPane === 'A') s.setSelectedNoteId(n.refId);
        else s.setSelectedNoteIdB(n.refId);
        s.setRightPanelTab('notes');
        s.setRightPanelOpen(true);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      setInfoCard(null);
      const { sx, sy } = localPos(e);
      const node = pick(sx, sy);
      dragRef.current = {
        mode: node ? 'node' : 'pan',
        node, sx, sy,
        vx0: viewRef.current.x, vy0: viewRef.current.y,
        moved: false,
      };
      canvas.style.cursor = node ? 'grabbing' : 'grab';
    };

    const onCanvasMove = (e: MouseEvent) => {
      if (dragRef.current) return;
      const { sx, sy } = localPos(e);
      const node = pick(sx, sy);
      hoverRef.current = node;
      canvas.style.cursor = node ? 'pointer' : 'grab';
    };

    const onWindowMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const { sx, sy } = localPos(e);
      if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 4) drag.moved = true;
      if (drag.mode === 'node' && drag.node) {
        const wpt = toWorld(sx, sy);
        drag.node.x = wpt.x;
        drag.node.y = wpt.y;
        drag.node.vx = 0;
        drag.node.vy = 0;
        alphaRef.current = Math.max(alphaRef.current, 0.25);
      } else {
        viewRef.current.x = drag.vx0 + (sx - drag.sx);
        viewRef.current.y = drag.vy0 + (sy - drag.sy);
      }
    };

    const onWindowUp = (e: MouseEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      canvas.style.cursor = 'grab';
      if (!drag || drag.moved) return;
      if (drag.node) {
        const { sx, sy } = localPos(e);
        openNode(drag.node, sx, sy);
      } else {
        // Click on empty canvas clears any lingering focus ring.
        focusRef.current = null;
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setInfoCard(null);
      const { sx, sy } = localPos(e);
      const v = viewRef.current;
      const k = Math.min(3, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0012)));
      const wx = (sx - v.x) / v.k;
      const wy = (sy - v.y) / v.k;
      v.k = k;
      v.x = sx - wx * k;
      v.y = sy - wy * k;
    };

    const onLeave = () => { hoverRef.current = null; };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onCanvasMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onCanvasMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onWindowUp);
    };
  }, []);

  return (
    <div className="graph-view" ref={wrapRef}>
      <canvas ref={canvasRef} className="graph-canvas" />

      <div className="graph-hud">
        <span className="graph-hud-title">Knowledge Map</span>
        <span className="graph-hud-meta">
          {counts.nodes} {counts.nodes === 1 ? 'node' : 'nodes'} · {counts.edges} {counts.edges === 1 ? 'connection' : 'connections'}
        </span>
      </div>

      <button className="graph-fit-btn" title="Fit graph to view" onClick={fitView}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
          <path d="M3 16v3a2 2 0 0 0 2 2h3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      </button>

      <div className="graph-legend">
        <span className="graph-legend-item"><i style={{ background: NODE_COLORS.pdf }} />Documents</span>
        <span className="graph-legend-item"><i style={{ background: NODE_COLORS.note }} />Notes</span>
        <span className="graph-legend-item"><i style={{ background: NODE_COLORS.flashcard }} />Flashcards</span>
        <span className="graph-legend-item"><i className="graph-legend-tag" />Tags</span>
        <span className="graph-legend-item"><i className="graph-legend-linked" />Note links</span>
        <span className="graph-legend-item"><i className="graph-legend-semantic" />Related content</span>
      </div>

      <div className="graph-hint">Scroll to zoom · Drag to pan · Click a node to open it</div>

      {infoCard && (() => {
        const node = nodeMapRef.current.get(infoCard.nodeId);
        if (!node) return null;
        const close = () => {
          setInfoCard(null);
          focusRef.current = null;
        };
        if (node.type === 'tag') {
          const linked = Array.from(adjacencyRef.current.get(node.id) ?? [])
            .map((id) => nodeMapRef.current.get(id))
            .filter((n): n is GraphNode => !!n && n.type === 'note');
          return (
            <div className="graph-info-card" style={{ left: infoCard.x, top: infoCard.y }}>
              <button className="graph-info-close" onClick={close} aria-label="Close">×</button>
              <span className="graph-info-kicker">Tag</span>
              <span className="graph-info-title">{node.label}</span>
              <span className="graph-info-meta">
                {linked.length} {linked.length === 1 ? 'note shares' : 'notes share'} this tag
              </span>
              <ul className="graph-info-list">
                {linked.slice(0, 4).map((n) => <li key={n.id}>{n.label}</li>)}
                {linked.length > 4 && <li>+{linked.length - 4} more…</li>}
              </ul>
            </div>
          );
        }
        const note = node.type === 'note' ? noteDetailsRef.current.get(node.refId) : undefined;
        const preview = note ? truncate(stripMarkdown(note.content_markdown), 140) : '';
        return (
          <div className="graph-info-card" style={{ left: infoCard.x, top: infoCard.y }}>
            <button className="graph-info-close" onClick={close} aria-label="Close">×</button>
            <span className="graph-info-kicker">{node.type === 'note' ? 'Note' : 'Flashcard'}</span>
            <span className="graph-info-title">{note?.title || node.label}</span>
            {preview && <p className="graph-info-preview">{preview}</p>}
            {note && note.tags.length > 0 && (
              <div className="graph-info-tags">
                {note.tags.map((t) => <span key={t} className="graph-info-tag">#{t}</span>)}
              </div>
            )}
            <span className="graph-info-meta">
              Not linked to a document in your library, so it can't be opened in the reader.
            </span>
          </div>
        );
      })()}

      {showOnboardCard && (
        <div className="graph-onboard-card">
          <span className="graph-info-kicker">Knowledge Map</span>
          <span className="graph-info-title">How to read this map</span>
          <ul className="graph-onboard-list">
            <li>
              <b>Dots are your knowledge</b> — documents, notes, flashcards, and tags,
              colored as in the legend. Solid lines are links you made; dotted amber
              lines mean Pagedge found related content.
            </li>
            <li>
              <b>Click any node</b> to open it — documents open in the reader, notes
              open in the editor.
            </li>
            <li>
              <b>Draw your own connections</b> by typing <code>[[Note Title]]</code>{' '}
              inside another note.
            </li>
          </ul>
          <button className="graph-onboard-dismiss" onClick={dismissOnboardCard}>
            Got it
          </button>
        </div>
      )}

      {loaded && counts.nodes === 0 && (
        <div className="graph-empty">
          <p className="empty-state-headline">Nothing to map yet</p>
          <span className="empty-state-subtext">
            Import PDFs, write notes, and tag them — their connections will appear here.
            Link notes to each other by typing [[Note Title]] inside a note.
          </span>
        </div>
      )}

      {loaded && !showOnboardCard && counts.nodes >= 2 && counts.edges < counts.nodes / 2 && (
        <div className="graph-sparse-hint">
          Sparse map? Connect notes by typing [[Note Title]] inside another note.
        </div>
      )}
    </div>
  );
}
