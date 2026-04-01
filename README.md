# Gaoding Project

本目录用于集中管理稿定相关脚本和说明。

## 脚本

- `gaoding-toolkit.user.js`
  合并版稿定油猴脚本，包含两项能力：
  1. 自动拦截 `https://www.gaoding.com/api/ccm/editors/risk_materials`
  2. 优先触发并截获页面原生下载产物，并按 `PDF > PSD > PNG > JPG/JPEG > WEBP > AVIF` 选择；如果截获不到，再回退到当前可见画布，最后才回退到 `window.__SSR_TEMPLATE.preview.url`
  页面右下角只显示一个低调的“保存图片”按钮；右键该按钮可复制原图地址

## 当前关联文件

- 离线页面：
  `医保保险指南保险科普小红书笔记_设计页－稿定.html`

- 离线资源目录：
  `医保保险指南保险科普小红书笔记_设计页－稿定_files`

- 已导出的原图：
  `医保保险指南保险科普小红书笔记-196196592.jpg`

## 备注

- `gaoding-toolkit.user.js` 支持 `file://` 本地页面；需要在 Tampermonkey 中开启该脚本的 file URL 访问权限。
- 当前这份离线页面内嵌的预览图尺寸为 `1242 x 1656`。
