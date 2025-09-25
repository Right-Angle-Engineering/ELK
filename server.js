import express from "express";
import { z } from "zod";
import ELK from "elkjs";

const app = express();
app.use(express.json({ limit: "2mb" }));
const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.ELK_SHARED_SECRET || "";
const elk = new ELK();

// Ports may include x,y (relative to node top-left, y grows downward)
const Port = z.object({
id: z.string(),
side: z.enum(["N", "E", "S", "W"]).optional(),
order: z.number().int().nonnegative().optional(),
x: z.number().optional(),
y: z.number().optional(),
});

const NodeSchema = z.object({
id: z.string(),
width: z.number().positive(),
height: z.number().positive(),
ports: z.array(Port).default([]),
});

const EdgeSchema = z.object({
id: z.string(),
source: z.string(),
target: z.string(),
});

const GraphSchema = z.object({
id: z.string().default("root"),
direction: z.enum(["DOWN", "RIGHT"]).default("DOWN"),
nodes: z.array(NodeSchema),
edges: z.array(EdgeSchema),
spacing: z
.object({
node: z.number().default(48),
edge: z.number().default(24),
port: z.number().default(12),
})
.default({}),
});

app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/readyz", (_req, res) => res.send("ready"));

app.post("/layout", async (req, res) => {
try {
if (SHARED_SECRET && req.get("x-elk-secret") !== SHARED_SECRET) {
return res.status(401).json({ error: "unauthorized" });
}

const { nodes, edges, direction, spacing, id } = GraphSchema.parse(req.body);

const sideMap = { N: "NORTH", E: "EAST", S: "SOUTH", W: "WEST" };

const elkGraph = {
  id,
  layoutOptions: {
    "org.eclipse.elk.algorithm": "layered",
    "org.eclipse.elk.direction": direction,
    "org.eclipse.elk.edgeRouting": "ORTHOGONAL",
    "org.eclipse.elk.spacing.nodeNodeBetweenLayers": String(spacing.node),
    "org.eclipse.elk.spacing.componentComponent": String(spacing.node),
    "org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers": String(spacing.node),
    "org.eclipse.elk.spacing.edgeEdge": String(spacing.edge),
  },
  children: nodes.map((n) => {
    // Force FIXED_POS during validation to ensure ELK honors x,y
    const constraint = "FIXED_POS";
    console.log(
      "[ELK] node", n.id,
      "constraint", constraint,
      "ports",
      (n.ports || []).map(p => ({ id: p.id, x: p.x, y: p.y, side: p.side, order: p.order }))
    );

    return {
      id: n.id,
      width: n.width,
      height: n.height,
      // Set both short and fully qualified keys for safety
      layoutOptions: {
        "org.eclipse.elk.portConstraints": constraint,
        "elk.portConstraints": constraint,
      },
      ports: (n.ports || []).map((p) => ({
        id: `${n.id}.${p.id}`,
        // Position relative to node top-left (y down)
        ...(typeof p.x === "number" ? { x: Number(p.x) } : {}),
        ...(typeof p.y === "number" ? { y: Number(p.y) } : {}),
        order: p.order ?? 0,
        layoutOptions: p.side
          ? {
              "org.eclipse.elk.port.side": sideMap[p.side],
              "elk.port.side": sideMap[p.side],
            }
          : {},
      })),
    };
  }),
  edges: edges.map((e) => ({
    id: e.id,
    sources: [e.source.includes(".") ? e.source : e.source],
    targets: [e.target.includes(".") ? e.target : e.target],
  })),
};

// Keep port order stable
elkGraph.children.forEach((c) => {
  if (c.ports) c.ports.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
});

const layout = await Promise.race([
  new ELK().layout(elkGraph),
  new Promise((_, rej) =>
    setTimeout(() => rej(new Error("layout_timeout")), Number(process.env.ELK_TIMEOUT_MS || 8000))
  ),
]);

res.json({
  nodes: (layout.children || []).map((c) => ({
    id: c.id,
    x: c.x ?? 0,
    y: c.y ?? 0,
    width: c.width,
    height: c.height,
    ports: (c.ports || []).map((p) => ({
      id: p.id,
      x: p.x ?? 0,
      y: p.y ?? 0,
    })),
  })),
  edges: (layout.edges || []).map((e) => ({
    id: e.id,
    sections: (e.sections || []).map((s) => ({
      start: { x: s.startPoint.x, y: s.startPoint.y },
      end: { x: s.endPoint.x, y: s.endPoint.y },
      bendPoints: (s.bendPoints || []).map((bp) => ({ x: bp.x, y: bp.y })),
    })),
  })),
});
} catch (err) {
res.status(400).json({ error: err?.message || "layout_failed" });
}
});

app.listen(PORT, () => console.log(`elk-sidecar listening on ${PORT}`));