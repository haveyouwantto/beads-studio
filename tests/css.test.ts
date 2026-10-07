// CSS 层叠自检。
//
// 起因：引入 Materialize 之后，它的 nav{height:56px;line-height:56px}
// 把侧边步骤栏直接压成了 56px 高，而算法测试完全发现不了这种事。
//
// 这里把 materialize + styles.css 一起灌进 jsdom，按真实层叠算 computed style，
// 专门盯住「框架样式误伤自定义组件」和「MD2 规格值」两类问题。
//
//   npm run test:css
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

const materialize = readFileSync('node_modules/materialize-css/dist/css/materialize.min.css', 'utf8')
const icons = readFileSync('node_modules/material-icons/iconfont/filled.css', 'utf8')
const mine = readFileSync('src/styles.css', 'utf8')

const markup = [
  '<!doctype html><html><head>',
  `<style>${materialize}</style>`,
  `<style>${icons}</style>`,
  `<style>${mine}</style>`,
  '</head><body>',
  '<nav class="rail">',
  '<button class="rail-step collection-item active"><span class="rail-num">',
  '<i class="material-icons sm">palette</i></span>',
  '<span class="rail-label">规范化</span></button></nav>',
  '<label class="check"><input type="checkbox" checked><span>包含扩展色号</span></label>',
  '<span class="badge">已打开</span>',
  '<div class="modal-overlay open"><div class="modal open modal-wide">',
  '<header class="modal-head">标题</header>',
  '<div class="modal-content modal-body">内容</div>',
  '<footer class="modal-foot">按钮</footer>',
  '</div></div>',
  '<button class="btn waves-effect waves-light">开始优化</button>',
  '<button class="btn-flat btn-small waves-effect">重来</button>',
  '<select id="metric"><option>Lab ΔE</option></select>',
  '<input type="number" value="12"><input type="text" value="名字">',
  '<input type="color" value="#123456">',
  '<label class="check"><input type="checkbox"><span>自动保存</span></label>',
  '<span class="btn-flat"><span class="pill">3</span></span>',
  '<ul class="tabs tabs-fixed-width segmented"><li class="tab"><a class="active">色号库</a></li><li class="indicator"></li></ul>',
  '<div class="row"><span>a</span></div>',
  '<div class="pattern-svg"></div>',
  '<div class="stat"><div class="k">平均</div><div class="v">12.3</div><div class="v sm">4</div></div>',
  '<div class="tiny muted">小字</div>',
  '<table class="bom"><thead><tr><th>色号</th></tr></thead></table>',
  '<div class="canvas-wrap edit-host"><canvas></canvas></div>',
  '<div class="swatch-grid">',
  '<div class="swatch on"><span class="pick"><i class="material-icons">check</i></span></div>',
  '<div class="swatch chip on"><span class="pick"><i class="material-icons">check</i></span></div>',
  '</div>',
  '<button class="btn-flat btn-small" id="flat-on">重来</button>',
  '<button class="btn-flat btn-small" id="flat-off" disabled>重来</button>',
  '<button class="btn" id="filled-on">导出文件</button>',
  '<button class="btn" id="filled-off" disabled>导出文件</button>',
  '<header class="panel-head">面板标题</header>',
  '<div class="card panel"><div class="card-title panel-head">面板标题</div><div class="card-content panel-body">内容</div></div>',
  '<div class="stage-head"><h1><i class="material-icons">palette</i>规范化</h1><p>把图片变成网格</p></div>',
  '<div id="root"></div>',
  '</body></html>',
].join('\n')

const dom = new JSDOM(markup, { pretendToBeVisual: true })
const win = dom.window

const style = (selector: string, prop: string): string =>
  win.getComputedStyle(win.document.querySelector(selector) as Element).getPropertyValue(prop).trim()

const rootVar = (name: string): string =>
  win.getComputedStyle(win.document.documentElement).getPropertyValue(name).trim()

// jsdom 不会把 var() 展开成具体值，这里自己解一层，
// 否则所有写 var(--radius) 的属性都只能拿到字面量。
const varCache = new Map<string, string>()
function cssVar(name: string): string {
  let v = varCache.get(name)
  if (v === undefined) {
    v = rootVar(name)
    varCache.set(name, v)
  }
  return v
}

function resolve(value: string, depth = 0): string {
  if (depth > 8 || !value.includes('var(')) return value
  const next = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_m, name: string, fb?: string) => {
    return cssVar(name) || (fb ?? '')
  })
  return next === value ? next : resolve(next, depth + 1)
}

/** 解析 var() 并压平空白，方便比较 */
const norm = (value: string): string => resolve(value).replace(/\s+/g, ' ').trim()
/** 忽略空白差异（jsdom 会把 rgba(0, 0, 0, .14) 输出成 rgba(0,0,0,0.14)） */
const compact = (value: string): string => norm(value).replace(/\s+/g, '')

function toHex(value: string): string {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(norm(value))
  if (!m) return norm(value).toLowerCase()
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
}

section('Materialize 不再误伤自定义组件')
{
  check('侧边步骤栏没有被压成 56px', style('nav.rail', 'height') === 'auto', style('nav.rail', 'height'))
  check('侧边步骤栏行高不被 nav 规则污染', style('nav.rail', 'line-height') === '1.5', style('nav.rail', 'line-height'))
  check(
    '侧边步骤栏不是 Materialize 的品红色',
    toHex(style('nav.rail', 'background-color')) !== '#ee6e73',
    style('nav.rail', 'background-color'),
  )

  check('复选框标签没有 35px 缩进', style('.check span', 'padding-left') === '0px', style('.check span', 'padding-left'))
  check('复选框标签高度不被固定', style('.check span', 'height') === 'auto', style('.check span', 'height'))
  check('小标签不会浮动', style('span.badge', 'float') === 'none', style('span.badge', 'float'))
  check('小标签宽度不被撑成 3rem', style('span.badge', 'min-width') === '0px', style('span.badge', 'min-width'))
  check('行容器没有负 margin', style('.row', 'margin-left') === '0px', style('.row', 'margin-left'))
  check('卡片没有 Materialize 的默认外边距', style('.card', 'margin-left') === '0px', style('.card', 'margin-left'))

  // Materialize 把原生 select 藏起来等它的 JS 接管；我们不用它的 JS，必须放回来
  check('原生下拉框没有被隐藏', style('select', 'display') === 'inline-block', style('select', 'display'))
  check('下拉框边框可见', style('select', 'border-top-width') === '1px', style('select', 'border-top-width'))

  // Materialize 给文本框写的是 content-box，宽 100% 会多出一圈内边距 + 边框
  check('输入框用 border-box', style('input[type=number]', 'box-sizing') === 'border-box', style('input[type=number]', 'box-sizing'))
  check('文本框用 border-box', style('input[type=text]', 'box-sizing') === 'border-box', style('input[type=text]', 'box-sizing'))

  // input[type=color] 是靠控件自己画的色块，不能被通用输入框规则接管：
  // 之前那条规则带 !important 的 height:auto / border / 透明背景，把色块压成一条看不见的线。
  check('颜色控件走自己的尺寸', style('input[type=color]', 'height') === '30px', style('input[type=color]', 'height'))
  check('颜色控件宽度来自专用规则', style('input[type=color]', 'width') === '42px', style('input[type=color]', 'width'))
  const sheetsAll = Array.from(win.document.styleSheets) as CSSStyleSheet[]
  const colorInput = win.document.querySelector('input[type=color]') as Element
  const hijacked = (Array.from(sheetsAll[sheetsAll.length - 1].cssRules) as (CSSRule & { selectorText?: string; style?: CSSStyleDeclaration })[])
    .filter((r) => r.selectorText && r.style?.getPropertyValue('background-color') && colorInput.matches(r.selectorText))
    .map((r) => r.selectorText as string)
  check('没有规则接管颜色控件的背景色', hijacked.length === 0, hijacked.join(' | '))

  // Materialize 把真复选框藏起来等它自己的伪元素来画，我们的 .check 又把伪元素关了
  // —— 两边一凑，复选框就彻底不可见。这里要求真复选框被放回来。
  check('复选框可见', style('.check input[type=checkbox]', 'opacity') === '1', style('.check input[type=checkbox]', 'opacity'))
  check('复选框不脱离文档流', style('.check input[type=checkbox]', 'position') === 'static', style('.check input[type=checkbox]', 'position'))
  check('复选框可点击', style('.check input[type=checkbox]', 'pointer-events') === 'auto', style('.check input[type=checkbox]', 'pointer-events'))
  check('复选框有尺寸', style('.check input[type=checkbox]', 'width') === '16px', style('.check input[type=checkbox]', 'width'))

  // 分段选择必须等宽：Materialize 的 .tabs 默认不是 flex，靠不住
  check('分段选择强制单行', style('.tabs.segmented', 'flex-wrap') === 'nowrap', style('.tabs.segmented', 'flex-wrap'))
  check('分段选择每项等分宽度', style('.tabs.segmented .tab', 'flex-grow') === '1', style('.tabs.segmented .tab', 'flex-grow'))
  check('对话框内容区可滚动', style('.modal .modal-content', 'overflow-y') === 'auto', style('.modal .modal-content', 'overflow-y'))

  // 步骤栏对勾垂直居中
  check('步骤序号行高归零对齐', style('.rail-num', 'line-height') === '1', style('.rail-num', 'line-height'))
  // Materialize 的 nav i.material-icons{height:56px} 会把图标盒子撑高，导致看着没居中
  // （jsdom 不会把 em 解析成 px，这里比的是「哪条规则赢了」）
  check('步骤图标高度不被 nav 规则撑成 56px', style('.rail-num .material-icons', 'height') === '1em', style('.rail-num .material-icons', 'height'))
  check('步骤图标宽度锁成 1em', style('.rail-num .material-icons', 'width') === '1em', style('.rail-num .material-icons', 'width'))
  // 计数气泡不被按钮的 36px 行高顶歪
  check('计数气泡行高独立', style('.pill', 'line-height') === '1', style('.pill', 'line-height'))
}

section('MD2 规格值')
{
  check('按钮高度 36dp', style('.btn', 'height') === '36px', style('.btn', 'height'))
  check('按钮圆角 4dp', norm(style('.btn', 'border-radius')) === '4px', norm(style('.btn', 'border-radius')))
  check('按钮字号 14sp', style('.btn', 'font-size') === '14px', style('.btn', 'font-size'))
  check('按钮字重 500', style('.btn', 'font-weight') === '500', style('.btn', 'font-weight'))
  check('按钮全大写', style('.btn', 'text-transform') === 'uppercase', style('.btn', 'text-transform'))
  check('按钮字距 1.25px', style('.btn', 'letter-spacing') === '1.25px', style('.btn', 'letter-spacing'))
  check('紧凑按钮 32dp', style('.btn-small', 'height') === '32px', style('.btn-small', 'height'))
  check('实心按钮用 primary 底 + on-primary 字', toHex(style('.btn', 'background-color')) === '#90caf9' && toHex(style('.btn', 'color')) === '#06233c', `${style('.btn', 'background-color')} / ${style('.btn', 'color')}`)
  check(
    '文字按钮是透明底',
    ['transparent', 'rgba(0,0,0,0)'].includes(compact(style('.btn-flat', 'background-color'))),
    style('.btn-flat', 'background-color'),
  )
  check('激活 tab 用 primary 字', toHex(style('.tabs .tab a.active', 'color')) === '#90caf9', style('.tabs .tab a.active', 'color'))
  check('tab 下划线用 primary', toHex(style('.tabs .indicator', 'background-color')) === '#90caf9', style('.tabs .indicator', 'background-color'))

  check(
    'Headline6 20/32 500',
    style('.stage-head h1', 'font-size') === '20px' &&
      style('.stage-head h1', 'line-height') === '32px' &&
      style('.stage-head h1', 'font-weight') === '500',
  )
  // 阶段标题用 Material 图标 + 文字，不用 ①②③ 这类字符
  check('阶段标题是图标 + 文字', style('.stage-head h1', 'display') === 'inline-flex', style('.stage-head h1', 'display'))
  check(
    '阶段标题图标 20dp 主题色',
    style('.stage-head h1 .material-icons', 'font-size') === '20px' &&
      toHex(style('.stage-head h1 .material-icons', 'color')) === '#90caf9',
    `${style('.stage-head h1 .material-icons', 'font-size')} / ${style('.stage-head h1 .material-icons', 'color')}`,
  )
  check('Body2 14/20', style('.stage-head p', 'font-size') === '14px' && style('.stage-head p', 'line-height') === '20px')
  check('Subtitle2 14/24 500', style('.panel-head', 'font-size') === '14px' && style('.panel-head', 'font-weight') === '500')
  check('Caption 12/16', style('.tiny', 'font-size') === '12px' && style('.tiny', 'line-height') === '16px')
  check('Overline 10/16 全大写', style('.bom th', 'font-size') === '10px' && style('.bom th', 'text-transform') === 'uppercase')
  check('统计数值走 Headline6', style('.stat .v', 'font-size') === '20px' && style('.stat .v', 'font-weight') === '500')

  check('surface 0 = #121212', toHex(style('body', 'background-color')) === '#121212', norm(style('body', 'background-color')))
  check('一级面板 = #1e1e1e（1dp 覆盖层）', rootVar('--md-surface-1') === '#1e1e1e', rootVar('--md-surface-1'))
  check('正文用 87% 白', compact(rootVar('--text')) === 'rgba(255,255,255,0.87)', rootVar('--text'))
  check('次要文字用 60% 白', compact(rootVar('--muted')) === 'rgba(255,255,255,0.6)', rootVar('--muted'))
  check('禁用文字用 38% 白', compact(rootVar('--muted-2')) === 'rgba(255,255,255,0.38)', rootVar('--muted-2'))
  check('primary 用浅色化变体', rootVar('--md-primary') === '#90caf9', rootVar('--md-primary'))
  check('primary 有配套的 on-primary', rootVar('--md-on-primary') === '#06233c', rootVar('--md-on-primary'))
  check('secondary 有配套的 on-secondary', Boolean(rootVar('--md-secondary')) && Boolean(rootVar('--md-on-secondary')))
  check('误差色用深色主题红', rootVar('--md-error') === '#cf6679', rootVar('--md-error'))
  check('圆角统一 4dp', rootVar('--radius') === '4px', rootVar('--radius'))
  check('间距按 8dp 网格', rootVar('--sp-2') === '8px' && rootVar('--sp-4') === '16px', rootVar('--sp-4'))

  const elev1 = compact(rootVar('--elev-1'))
  check(
    'elevation-1 是 MD2 三层阴影',
    elev1.includes('rgba(0,0,0,0.14)') && elev1.includes('rgba(0,0,0,0.2)'),
    elev1.slice(0, 80),
  )
}

section('字体与图纸预览')
{
  check('正文用 Roboto 无衬线', norm(style('body', 'font-family')).includes('Roboto'), norm(style('body', 'font-family')))
  check('字体栈里没有等宽', !rootVar('--font-sans').includes('monospace'))
  check('图纸预览禁止选中文字', style('.pattern-svg', 'user-select') === 'none', style('.pattern-svg', 'user-select'))
}

// 像素编辑的画板：默认居中（以前是左上角对齐，图小了看着偏）
section('编辑画板')
{
  check(
    '编辑画板默认居中',
    style('.canvas-wrap.edit-host', 'place-items').includes('center'),
    style('.canvas-wrap.edit-host', 'place-items'),
  )
}

// 色块选中态：勾要大、居中，边框要加粗
section('色块选中态')
{
  check('选中的色块边框加粗', parseFloat(style('.swatch.on', 'border-width')) >= 3, style('.swatch.on', 'border-width'))
  check('勾是铺满整格居中的', style('.swatch .pick', 'display') === 'grid' && style('.swatch .pick', 'place-items') === 'center')
  check('勾的尺寸够大', parseFloat(style('.swatch .pick .material-icons', 'font-size')) >= 20, style('.swatch .pick .material-icons', 'font-size'))
  check('小方块里的勾会自动缩小', parseFloat(style('.swatch.chip .pick .material-icons', 'font-size')) <= 16)
}

// 禁用态：以前实心按钮的禁用容器和正常容器几乎一个色，看不出点不动
section('禁用态一眼能看出')
{
  const flatOn = compact(style('#flat-on', 'color'))
  const flatOff = compact(style('#flat-off', 'color'))
  check('文字按钮禁用后文字更淡', flatOn === 'rgba(255,255,255,0.6)' && flatOff === 'rgba(255,255,255,0.3)', `${flatOn} → ${flatOff}`)
  check('文字按钮禁用后没有容器', compact(style('#flat-off', 'background-color')) === 'rgba(0,0,0,0)', style('#flat-off', 'background-color'))

  check(
    '实心按钮禁用后换成 12% 容器',
    compact(style('#filled-off', 'background-color')) === 'rgba(255,255,255,0.12)',
    style('#filled-off', 'background-color'),
  )
  check('禁用按钮不抬升', style('#filled-off', 'box-shadow') === 'none', style('#filled-off', 'box-shadow'))
  check('禁用按钮光标是 not-allowed', style('#filled-off', 'cursor') === 'not-allowed', style('#filled-off', 'cursor'))
  check('正常按钮还是 primary 容器', toHex(style('#filled-on', 'background-color')) === '#90caf9', style('#filled-on', 'background-color'))
  check(
    '禁用容器和正常容器不是一个色',
    compact(style('#filled-off', 'background-color')) !== compact(style('#filled-on', 'background-color')),
  )
}

// 手机浏览器的地址栏也算视口：100% / vh 用的是「大视口」，界面会高出可见区域，
// 底部被浏览器栏盖住。所有整屏高度与限高都要用 dvh（并保留 vh 兜底）。
section('移动端视口单位')
{
  check('根高度用 dvh', style('#root', 'height') === '100dvh', style('#root', 'height'))
  check('body 高度也用 dvh', style('body', 'height') === '100dvh', style('body', 'height'))

  // 限高都写在样式表里，直接查 CSSOM（这些元素不一定在测试 markup 里）
  const sheets = Array.from(win.document.styleSheets) as CSSStyleSheet[]
  const ours = sheets[sheets.length - 1]
  const declared = (selector: string, prop: string): string => {
    let found = ''
    for (const rule of Array.from(ours.cssRules) as (CSSRule & { selectorText?: string; style?: CSSStyleDeclaration })[]) {
      if (rule.selectorText?.split(',').map((s) => s.trim()).includes(selector)) {
        found = rule.style?.getPropertyValue(prop).trim() || found
      }
    }
    return found
  }
  const dvhRules = [
    ['.modal', 'max-height'],
    ['.canvas-wrap', 'max-height'],
    ['.canvas-wrap.fit canvas', 'max-height'],
    ['.canvas-wrap.pattern-host', 'max-height'],
    ['.modal.open', 'max-height'],
  ] as const
  for (const [selector, prop] of dvhRules) {
    const v = declared(selector, prop)
    check(`${selector} 的 ${prop} 用 dvh`, v.includes('dvh'), v)
  }

  // 像素编辑的画板：自己吞掉触摸手势（否则手机上画两笔就变成滚页面）；
  // 画板本身限高，画布在里面自由大小、装不下就在画板里滚
  check('编辑画板接管触摸手势', declared('.canvas-wrap.edit-host canvas', 'touch-action') === 'none', declared('.canvas-wrap.edit-host canvas', 'touch-action'))
  check(
    '编辑画板本身限高用 dvh',
    declared('.canvas-wrap.edit-host', 'max-height') === '62dvh',
    declared('.canvas-wrap.edit-host', 'max-height'),
  )
}

// 媒体查询在 jsdom 里算不出 computed style（它不做视口匹配），
// 所以窄屏规则改成直接读 CSSOM：确认断点存在、且写的是预期的声明。
// 真实布局由浏览器实测验证，这里只做「别被删掉/写错」的回归网。
section('响应式断点')
{
  type RuleInfo = { media: string; selector: string; style: CSSStyleDeclaration }

  function collectRules(sheet: CSSStyleSheet, media = ''): RuleInfo[] {
    const out: RuleInfo[] = []
    for (const rule of Array.from(sheet.cssRules) as (CSSRule & {
      // jsdom 用 media.mediaText 表示 @media 条件，标准里是 conditionText
      conditionText?: string
      media?: { mediaText?: string }
      cssRules?: CSSRuleList
      selectorText?: string
      style?: CSSStyleDeclaration
    })[]) {
      const condition = rule.conditionText ?? rule.media?.mediaText
      if (rule.cssRules && typeof condition === 'string') {
        out.push(...collectRules(rule as unknown as CSSStyleSheet, condition.replace(/^\(|\)$/g, '').trim()))
      } else if (rule.selectorText && rule.style) {
        out.push({ media, selector: rule.selectorText, style: rule.style })
      }
    }
    return out
  }

  const sheets = Array.from(win.document.styleSheets) as CSSStyleSheet[]
  const ours = sheets[sheets.length - 1]
  const rules = collectRules(ours)
  // 取最后一条匹配：同优先级下靠后的声明才是生效的那个
  const at = (media: string, selector: string) =>
    [...rules]
      .reverse()
      .find((r) => r.media === media && r.selector.split(',').map((s) => s.trim()).includes(selector))
  const value = (media: string, selector: string, prop: string) => at(media, selector)?.style.getPropertyValue(prop).trim() ?? ''

  const narrow = 'max-width: 900px'
  const phone = 'max-width: 600px'

  check('存在 ≤900px 断点', rules.some((r) => r.media === narrow))
  check('存在 ≤600px 断点', rules.some((r) => r.media === phone))

  // 步骤栏：左侧竖排 → 顶部横排，让出主区整个宽度
  check('窄屏步骤栏横排', value(narrow, 'nav.rail', 'flex-direction') === 'row', value(narrow, 'nav.rail', 'flex-direction'))
  check('窄屏步骤栏占满宽度', value(narrow, 'nav.rail', 'width') === '100%', value(narrow, 'nav.rail', 'width'))
  check('窄屏主体改成纵向堆叠', value(narrow, '.body', 'flex-direction') === 'column', value(narrow, '.body', 'flex-direction'))
  check(
    // 四步挤一行会把字压没：每项保持自己的宽度，装不下就横向滚动
    '窄屏步骤项不挤成一团',
    value(narrow, '.rail-step', 'flex-basis') === 'auto' && value(narrow, '.rail-step', 'flex-shrink') === '0',
    `${value(narrow, '.rail-step', 'flex-basis')} / ${value(narrow, '.rail-step', 'flex-shrink')}`,
  )
  check('窄屏步骤栏可以横向滚动', value(narrow, 'nav.rail', 'overflow-x') === 'auto', value(narrow, 'nav.rail', 'overflow-x'))
  check('窄屏步骤栏不露出滚动条', value(narrow, 'nav.rail', 'scrollbar-width') === 'none')
  check('窄屏步骤标题不省略号截断', value(narrow, '.rail-label', 'text-overflow') !== 'ellipsis')
  check('窄屏步骤项保留标题', value(narrow, '.rail-label', 'display') === 'block', value(narrow, '.rail-label', 'display'))

  // 顶栏：窄屏（平板）标签栏独占一行，不然会和按钮挤在一起
  check('窄屏标签栏独占一行', value(narrow, '.tabstrip', 'flex-basis') === '100%', value(narrow, '.tabstrip', 'flex-basis'))
  check('窄屏标签栏不限宽（原来的 62vw 会截断）', value(narrow, '.tabstrip', 'max-width') === '100%', value(narrow, '.tabstrip', 'max-width'))
  check('窄屏顶栏用两列网格', value(phone, '.topbar', 'display') === 'grid', value(phone, '.topbar', 'display'))
  check('手机顶栏工具收进侧边栏', value(phone, '.topbar-actions', 'display') === 'none', value(phone, '.topbar-actions', 'display'))
  check('手机显示菜单按钮', value(phone, '.topbar-menu', 'display') === 'grid', value(phone, '.topbar-menu', 'display'))
  // 手机上标题栏只留 logo，位置让给项目标签（一行放完，不再单独占一行）
  check('手机顶栏不写品牌名', value(phone, '.brand-text', 'display') === 'none', value(phone, '.brand-text', 'display'))
  check('手机标签栏就在标题栏里', value(phone, '.tabstrip', 'grid-area') === 'tabs', value(phone, '.tabstrip', 'grid-area'))
  check(
    '手机标题栏一行放菜单 + logo + 标签',
    value(phone, '.topbar', 'grid-template-areas').replace(/\s+/g, ' ').includes('menu brand tabs'),
    value(phone, '.topbar', 'grid-template-areas'),
  )
  check('宽屏不显示菜单按钮', value('', '.topbar-menu', 'display') === 'none', value('', '.topbar-menu', 'display'))
  // 工具栏现在是纯图标，任何一档把图标藏起来都会变成一排空按钮
  check('宽屏工具栏图标不被隐藏', value('', '.topbar-actions .material-icons', 'display') !== 'none', value('', '.topbar-actions .material-icons', 'display'))
  check('手机顶栏按钮不被挤扁', value(narrow, '.topbar-actions > *', 'flex-shrink') === '0')
  check('侧边栏是固定定位抽屉', value('', '.drawer', 'position') === 'fixed', value('', '.drawer', 'position'))
  check('工具栏按钮是图标尺寸', value('', '.icon-only', 'min-width') === '40px', value('', '.icon-only', 'min-width'))

  // 溢出根源：网格子项的 min-width:auto 会被内容顶宽
  check(
    '网格子项允许收缩',
    ['0', '0px'].includes(value('', '.columns > *', 'min-width')),
    value('', '.columns > *', 'min-width'),
  )
  check('预览画布等比缩进容器', value('', '.canvas-wrap.fit .overlay-host', 'max-width') === '100%')
  check('预览容器只有一列', value('', '.canvas-wrap.fit', 'grid-template-columns') === 'minmax(0, 1fr)')
  check('面板标题允许换行', value('', '.panel-head', 'flex-wrap') === 'wrap', value('', '.panel-head', 'flex-wrap'))
  check('用料清单可横向滚动', value('', '.bom-wrap', 'overflow-x') === 'auto', value('', '.bom-wrap', 'overflow-x'))
  check('手机弹窗留出边距', value(phone, '.modal', 'width') === 'calc(100% - 16px)', value(phone, '.modal', 'width'))
  check('手机全屏工具栏换行', value(phone, '.fullscreen-stage .fs-bar', 'flex-wrap') === 'wrap')

  // 主界面图纸只做展示：等比缩进容器，缩放/平移都留给全屏
  check('主界面图纸等比适配', value('', '.canvas-wrap.pattern-host .pattern-svg svg', 'width') === '100%')
  // 手机浏览器把地址栏也算进视口，限高要用 dvh；不认识的浏览器退回 vh（两条都写在样式里）
  check('主界面图纸限高用 dvh', value('', '.canvas-wrap.pattern-host .pattern-svg svg', 'max-height') === '54dvh')
  check('主界面图纸有留白', value('', '.canvas-wrap.pattern-host .pattern-svg', 'padding') === 'var(--sp-3)')
  // 画布与预览框一起等比缩进容器，内容只留边不拉伸
  check(
    '预览画布用 contain',
    value('', '.canvas-wrap.fit .overlay-host > canvas:not(.handle-layer):not(.grid-layer)', 'object-fit') === 'contain',
  )
  // 四角变换的内部网格：单独一层反色（白色 + 差值混合），压在照片上也看得见
  check(
    '四角网格用反色混合',
    value('', '.overlay-host > canvas.grid-layer', 'mix-blend-mode') === 'difference',
    value('', '.overlay-host > canvas.grid-layer', 'mix-blend-mode'),
  )
  check('四角网格层不挡鼠标', value('', '.overlay-host > canvas.grid-layer', 'pointer-events') === 'none')
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failures.length) console.log(`失败项：${failures.join('、')}`)
process.exit(failed > 0 ? 1 : 0)
