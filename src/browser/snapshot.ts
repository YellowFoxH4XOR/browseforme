import type { Target } from "./transport";

export interface ElementRecord {
  ref: string;
  role: string;
  name: string;
  disabled: boolean;
  inView: boolean;
}

export interface ScanResult {
  url: string;
  title: string;
  modal: boolean;
  total: number;
  elements: ElementRecord[];
  /** Visible page text (first 300 chars), present only when nothing on the page is interactive. */
  text?: string;
}

/** `button "Post" [disabled] [offscreen]` — the element description shared by snapshots, errors, and Jev state. */
export function describe(element: ElementRecord): string {
  let text = `${element.role} "${element.name}"`;
  if (element.disabled) text += " [disabled]";
  if (!element.inView) text += " [offscreen]";
  return text;
}

export function render(scan: ScanResult): string {
  const lines = [`url: ${scan.url}`, `title: ${scan.title}`];
  if (scan.modal) lines.push("scope: dialog");
  for (const element of scan.elements) lines.push(`@${element.ref} ${describe(element)}`);
  const more = scan.total - scan.elements.length;
  if (more > 0) lines.push(`… ${more} more (call browser_snapshot)`);
  if (scan.text) lines.push(`text: ${scan.text}`);
  return lines.join("\n");
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  parentId?: string;
  childIds?: string[];
  role?: { value?: unknown };
  name?: { value?: unknown };
}

const AX_CAP = 8000;

/** Flattened accessibility tree (`- role "name"`, two spaces per depth), capped at 8000 chars. */
export async function accessibilityTree(target: Target): Promise<string> {
  let nodes: AxNode[];
  try {
    ({ nodes } = await target.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree"));
  } catch {
    try {
      await target.send("Accessibility.enable");
      ({ nodes } = await target.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree"));
    } catch {
      return "(unavailable)";
    }
  }
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const lines: string[] = [];
  let size = 0;
  const walk = (node: AxNode, depth: number): boolean => {
    let childDepth = depth;
    if (!node.ignored) {
      const line = `${"  ".repeat(depth)}- ${String(node.role?.value ?? "")} "${String(node.name?.value ?? "")}"`;
      size += line.length + 1;
      if (size > AX_CAP) return false;
      lines.push(line);
      childDepth = depth + 1;
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child && !walk(child, childDepth)) return false;
    }
    return true;
  };
  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) continue;
    if (!walk(node, 0)) break;
  }
  return lines.join("\n") || "(unavailable)";
}
