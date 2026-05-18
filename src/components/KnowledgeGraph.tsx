import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";

interface GraphNode {
  id: string;
  label: string;
  type: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface KnowledgeGraphProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function KnowledgeGraph({ data, onNodeClick }: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    cyRef.current = cytoscape({
      container: containerRef.current,
      elements: [
        ...data.nodes.map((n) => ({
          data: { id: n.id, label: n.label, type: n.type },
        })),
        ...data.edges.map((e, i) => ({
          data: {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            label: e.relation,
          },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "#4a9eff",
            color: "#fff",
            "text-valign": "center",
            "text-halign": "center",
            "font-size": "12px",
            width: "label",
            height: "label",
            padding: "8px",
            shape: "round-rectangle",
          } as cytoscape.Css.Node,
        },
        {
          selector: "node[type='concept']",
          style: { "background-color": "#9775fa" } as cytoscape.Css.Node,
        },
        {
          selector: "node[type='entity']",
          style: { "background-color": "#ff9f43" } as cytoscape.Css.Node,
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#555",
            "target-arrow-color": "#555",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "10px",
            color: "#888",
            "text-rotation": "autorotate",
            "text-margin-y": -10,
          } as cytoscape.Css.Edge,
        },
        {
          selector: "node:selected",
          style: {
            "background-color": "#ffd43b",
            color: "#000",
            "border-width": 2,
            "border-color": "#000",
          } as cytoscape.Css.Node,
        },
      ],
      layout: {
        name: "cose",
        animate: true,
        animationDuration: 800,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 120,
      } as cytoscape.LayoutOptions,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    if (onNodeClick) {
      cyRef.current.on("tap", "node", (evt) => {
        onNodeClick(evt.target.id());
      });
    }

    return () => {
      cyRef.current?.destroy();
    };
  }, [data, onNodeClick]);

  return (
    <div
      ref={containerRef}
      className="w-full h-[300px] border rounded-md bg-background"
    />
  );
}
