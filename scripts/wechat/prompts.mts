export const reviewSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise', 'blocked'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['severity', 'message', 'recommendation'],
        additionalProperties: false,
      },
    },
    coverBrief: { type: 'string' },
  },
  required: ['verdict', 'summary', 'findings', 'coverBrief'],
  additionalProperties: false,
} as const

export const editorialPrompt = (article: string, runDir: string) => `你是公众号生产流水线的编辑审校员。只读工作区，禁止修改任何文件、调用发布动作、创建草稿或群发。

审校文章：${article}
本次运行目录：${runDir}

目标是判断文章是否能进入既定的技术文章模板渲染。只检查：标题与二级/三级标题结构、事实表达风险、段落可读性、是否存在会阻断渲染或发布的内容。公众号硬规则：不得出现“解读版本”或“季度版本”这类元信息；目录和所有正文标题序号只可用自然数（1、2、3…），不得用 01、02、03 或 01.1。不要编写 HTML、CSS 或改写整篇文章。若只是可选的文案改善，请给 warning，但 verdict 仍为 pass；只有不能安全产出审阅包的问题才 blocked。coverBrief 要给出不超过 80 字的、与文章内容匹配的封面视觉说明。严格输出指定 JSON。`

export const visualPrompt = (article: string, html: string, qa: string) => `你是公众号视觉 QA 审阅员。只读工作区，禁止修改文件、创建草稿、上传或群发。

原文：${article}
渲染 HTML：${html}
确定性 QA：${qa}

你会收到一张移动端截图。核查首屏、目录、H2/H3 层级、列表、代码块和 CTA 是否清晰可读。目录和所有正文标题不得出现 01、02、03、01.1 等补零编号；不得出现“解读版本”或“季度版本”元信息。不要要求模型直接修改 HTML/CSS；只有视觉或结构问题会影响交付时才 verdict=revise，无法安全交付时 blocked。正常时 pass。coverBrief 仅描述是否与文章主题匹配；没有封面文件时明确写“待补封面”。严格输出指定 JSON。`
