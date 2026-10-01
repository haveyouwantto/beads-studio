/**
 * 应用 logo：机械臂夹着一颗拼豆，旁边是齿轮环与 AI 闪光。
 *
 * 原图是 108×108 的线稿（黑色描边），这里：
 * - 颜色改用 currentColor，跟随容器（品牌方块里是 on-primary，深色主题下才看得见）
 * - 图形整体略微放大并居中：原稿的笔画只占画布中间约 48%，小尺寸下几乎看不见
 */
export function BeadLogo({ title = 'Beads Studio' }: { title?: string }) {
  return (
    <svg viewBox="0 0 108 108" role="img" aria-label={title} focusable="false">
      <g transform="translate(54 54) scale(1.5) translate(-52.3 -49.8)">
        {/* 拼豆：环形，中间镂空 */}
        <g fill="none" stroke="currentColor" strokeWidth="2.2">
          <circle cx="39" cy="53" r="2.6" />
          <circle cx="49" cy="53" r="2.6" />
          <circle cx="69" cy="53" r="2.6" />
          <circle cx="39" cy="63" r="2.6" />
          <circle cx="49" cy="63" r="2.6" />
          <circle cx="59" cy="63" r="2.6" />
          <circle cx="69" cy="63" r="2.6" />
          <circle cx="39" cy="73" r="2.6" />
          <circle cx="49" cy="73" r="2.6" />
          <circle cx="59" cy="73" r="2.6" />
          <circle cx="69" cy="73" r="2.6" />
          {/* 夹着的豆 */}
          <circle cx="59" cy="40" r="2.6" />
          {/* 齿轮环 */}
          <circle cx="34" cy="42" r="4.5" strokeWidth="2.5" />
        </g>

        {/* 机械臂与夹爪 */}
        <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path d="M37.9,37.4 L46,28" strokeWidth="4.5" />
          <path d="M46,28 L59,28" strokeWidth="4" />
          <path d="M55.5,32 L53,37.5 L55,43 M62.5,32 L65,37.5 L63,43" strokeWidth="2.2" />
        </g>

        <g fill="currentColor">
          {/* 空位 */}
          <circle cx="59" cy="53" r="1" />
          {/* 齿轮齿 */}
          <g transform="translate(34 42)">
            <rect x="-1.5" y="-7.5" width="3" height="2.5" />
            <rect x="-1.5" y="-7.5" width="3" height="2.5" transform="rotate(45)" />
            <rect x="-1.5" y="-7.5" width="3" height="2.5" transform="rotate(90)" />
            <rect x="-1.5" y="-7.5" width="3" height="2.5" transform="rotate(135)" />
            <rect x="-1.5" y="-7.5" width="3" height="2.5" transform="rotate(180)" />
            <rect x="-1.5" y="-7.5" width="3" height="2.5" transform="rotate(225)" />
            <rect x="-1.5" y="-7.5" width="3" height="2.5" transform="rotate(270)" />
            <rect x="-1.5" y="-7.5" width="3" height="2.5" transform="rotate(315)" />
          </g>
          {/* 肘关节、夹爪头 */}
          <circle cx="46" cy="28" r="3.5" />
          <rect x="53" y="26" width="12" height="6" rx="2" />
          {/* AI 闪光 */}
          <path d="M73,35 C73.6,38.6 74.4,39.4 78,40 C74.4,40.6 73.6,41.4 73,45 C72.4,41.4 71.6,40.6 68,40 C71.6,39.4 72.4,38.6 73,35Z" />
          <path d="M70,28.5 C70.3,30.3 70.7,30.7 72.5,31 C70.7,31.3 70.3,31.7 70,33.5 C69.7,31.7 69.3,31.3 67.5,31 C69.3,30.7 69.7,30.3 70,28.5Z" />
        </g>
      </g>
    </svg>
  )
}
