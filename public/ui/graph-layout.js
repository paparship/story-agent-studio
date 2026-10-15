/* Pure layout and camera geometry; shared by the browser and layout checks. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StoryGraphLayout = factory();
})(typeof window === 'undefined' ? this : window, function () {
  const NODE_WIDTH = 196, NODE_HEIGHT = 68;
  const PORTS = {yes: '成立', no: '不成立', failed: '失败', rejected: '未接取', insufficient: '数量不足'};

  function layoutGraph(source, engine, direction = 'TB') {
    const graph = new engine.graphlib.Graph({multigraph: true});
    graph.setGraph({rankdir: direction, nodesep: 36, edgesep: 24, ranksep: 42, marginx: 28, marginy: 28});
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of source.nodes) graph.setNode(node.id, {width: NODE_WIDTH, height: NODE_HEIGHT});
    for (const node of source.nodes) {
      for (const [port, to] of Object.entries(node.outputs)) {
        if (!graph.hasNode(to)) throw Error('连线引用了不存在的节点：' + to);
        const label = PORTS[port] || (port === 'next' ? '' : port);
        graph.setEdge(node.id, to, {port, label, width: label ? Math.max(38, label.length * 12 + 16) : 0,
          height: label ? 22 : 0, labelpos: 'c', labeloffset: 0}, port);
      }
    }
    engine.layout(graph);
    return {
      width: Math.max(1, graph.graph().width), height: Math.max(1, graph.graph().height), direction,
      nodes: source.nodes.map(node => ({...graph.node(node.id), node})),
      edges: graph.edges().map(edge => ({...graph.edge(edge), from: edge.v, to: edge.w, name: edge.name}))
    };
  }

  function fit(bounds, width, height, padding = 24) {
    const scale = Math.min(1, Math.max(1, width - padding * 2) / bounds.width,
      Math.max(1, height - padding * 2) / bounds.height);
    return {scale, x: (width - bounds.width * scale) / 2, y: (height - bounds.height * scale) / 2};
  }

  function zoomAt(camera, factor, x, y) {
    const scale = Math.min(2.4, Math.max(0.025, camera.scale * factor));
    const ratio = scale / camera.scale;
    return {scale, x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio};
  }

  return {layoutGraph, fit, zoomAt, PORTS, NODE_WIDTH, NODE_HEIGHT};
});
