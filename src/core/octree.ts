/**
 * 八叉树颜色减量。
 *
 * 通过自底向上合并低频节点，将颜色数量缩减至 maxLeaves。
 * 代表色使用原始颜色中权重最高的值。
 */
export interface OctreeInput {
  rgb: readonly [number, number, number]
  count: number
}

export interface OctreeLeaf {
  /** 节点代表色 */
  rgb: [number, number, number]
  /** 总像素权重 */
  count: number
  /** 包含的原始颜色下标 */
  members: number[]
}

const DEPTH = 8

interface Node {
  children: (Node | undefined)[]
  nchildren: number
  r: number
  g: number
  b: number
  count: number
  members: number[]
  level: number
}

export function octreeReduce(colors: readonly OctreeInput[], maxLeaves: number): OctreeLeaf[] {
  const cap = Math.max(1, maxLeaves)
  if (colors.length <= cap) {
    return colors.map((c, i) => ({ rgb: [...c.rgb], count: c.count, members: [i] }))
  }

  const root: Node = { children: [], nchildren: 0, r: 0, g: 0, b: 0, count: 0, members: [], level: 0 }
  let leafCount = 1
  const allNodes: Node[] = [root]

  const childIndex = (rgb: readonly [number, number, number], level: number): number =>
    (((rgb[0] >> (DEPTH - 1 - level)) & 1) << 2) |
    (((rgb[1] >> (DEPTH - 1 - level)) & 1) << 1) |
    ((rgb[2] >> (DEPTH - 1 - level)) & 1)

  for (let i = 0; i < colors.length; i++) {
    const { rgb, count } = colors[i]
    let node = root
    node.r += rgb[0] * count
    node.g += rgb[1] * count
    node.b += rgb[2] * count
    node.count += count
    node.members.push(i)
    for (let level = 0; level < DEPTH; level++) {
      const idx = childIndex(rgb, level)
      let child = node.children[idx]
      if (!child) {
        child = { children: [], nchildren: 0, r: 0, g: 0, b: 0, count: 0, members: [], level: level + 1 }
        node.children[idx] = child
        if (node.nchildren === 0) leafCount--
        node.nchildren++
        allNodes.push(child)
        leafCount++
      }
      child.r += rgb[0] * count
      child.g += rgb[1] * count
      child.b += rgb[2] * count
      child.count += count
      child.members.push(i)
      node = child
    }
  }

  const reducible = (): Node | null => {
    let best: Node | null = null
    for (const node of allNodes) {
      if (!node.nchildren) continue
      if (node.children.some((c) => c && c.nchildren)) continue
      if (!best || node.count < best.count) best = node
    }
    return best
  }

  while (leafCount > cap) {
    const node = reducible()
    if (!node) break
    leafCount -= node.nchildren - 1
    node.children = []
    node.nchildren = 0
  }

  const collect = (node: Node, out: OctreeLeaf[]): void => {
    if (!node.nchildren) {
      let dom = node.members[0]
      for (const j of node.members) if (colors[j].count > colors[dom].count) dom = j
      const [r, g, b] = colors[dom].rgb
      out.push({ rgb: [r, g, b], count: node.count, members: node.members })
      return
    }
    for (const child of node.children) if (child) collect(child, out)
  }
  const leaves: OctreeLeaf[] = []
  collect(root, leaves)
  return leaves
}
