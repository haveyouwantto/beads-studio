/**
 * 八叉树减色（octree quantization）。
 *
 * 抗锯齿会把一张 80×80 的图碎成上千个只差一点点的颜色。逐色处理时，
 * 1~3 格的碎色会各自拖一颗豆进解里 —— 又花、又浪费豆位。
 *
 * 八叉树按「像素量最小的节点先被吸收」来做这件事：反复把像素最少的
 * 可折叠节点收拢，直到叶子数不超过 maxLeaves。没有阈值、没有特殊情况，
 * 碎色天然并入它所在的大颜色。
 *
 * 代表色取叶子里像素最多的那个原始颜色，而不是成员的加权平均：
 * 平均会把「深色描边 + 大片亮色」混出一个图里根本不存在的中间色，
 * 这种颜色到豆子的距离往往比两个原色都远（豆库匹配不到它）。
 * 用真实的原图颜色当代表，碎色只是悄悄跟着大颜色走。
 */
export interface OctreeInput {
  rgb: readonly [number, number, number]
  count: number
}

export interface OctreeLeaf {
  /** 代表色：这片叶子里像素最多的那个原始颜色 */
  rgb: [number, number, number]
  /** 吸收了多少像素 */
  count: number
  /** 被这片叶子吸收的输入颜色下标 */
  members: number[]
}

const DEPTH = 8

interface Node {
  /** 按八叉位稀疏存放（中间可能挖空），真实孩子数看 nchildren */
  children: (Node | undefined)[]
  nchildren: number
  /** 子树内像素的加权和（插入时沿途累加，折叠时现成可用） */
  r: number
  g: number
  b: number
  count: number
  members: number[]
  /** 根 = 0 */
  level: number
}

export function octreeReduce(colors: readonly OctreeInput[], maxLeaves: number): OctreeLeaf[] {
  const cap = Math.max(1, maxLeaves)
  if (colors.length <= cap) {
    return colors.map((c, i) => ({ rgb: [...c.rgb], count: c.count, members: [i] }))
  }

  const root: Node = { children: [], nchildren: 0, r: 0, g: 0, b: 0, count: 0, members: [], level: 0 }
  // 根一开始也算一片叶子；它长出第一个孩子时再减回去
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
        // 这棵子树第一次长孩子：node 自己从「叶子」变成「内部节点」
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

  // 反复收拢「像素量最少的可折叠节点」，直到叶子数达标。
  // 可折叠 = 所有孩子都是叶子；收拢后它自己变成一片叶子。
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
    // 全树只剩根时不可能再折（cap ≥ 1，while 条件已保证不会走到这）
    if (!node) break
    leafCount -= node.nchildren - 1
    node.children = []
    node.nchildren = 0
  }

  const collect = (node: Node, out: OctreeLeaf[]): void => {
    if (!node.nchildren) {
      // 代表色 = 成员里像素最多的那个颜色（不能平均，见文件头注释）
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
