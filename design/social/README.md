# 社交预览图

GitHub 仓库的 Social preview 用的海报：分享仓库链接时显示的那张图。

- `social-preview.html`：源文件。色值取自 `apps/extension/lib/base.css` 的亮色令牌，只用系统字体，K 标志直接引用 `../brand/kiwi-green/mark.svg`。没有第三方 logo：来源标记是中性色圆点，域名用保留的 `.example`。窗口里的搜索词、概览和结果都是示意，不是真实搜索输出。
- `social-preview.png`：1280 × 640，约 110 KB。GitHub 要求至少 640 × 320、小于 1 MB，1280 × 640 显示效果最好。

海报上刻意不写来源和模式的数量，也不写支持的浏览器或具体的引擎名，因为它们会陆续增加，写死就会过期。底部的标签写的是不会变的原则（登录、Key、账号）和许可证。品牌色变了，要照 `base.css` 更新 HTML 里的令牌。

## 重新生成

改了 HTML 之后，用 Chromium 或 Chrome 渲染（macOS 示例）。`--user-data-dir` 指向临时目录，不会碰日常用的浏览器配置：

```sh
cd design/social
/Applications/Chromium.app/Contents/MacOS/Chromium --headless=new --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1280,640 \
  --user-data-dir="$(mktemp -d)" \
  --screenshot="$PWD/social-preview.png" "file://$PWD/social-preview.html"
```

渲染后核对尺寸是 1280 × 640、文件小于 1 MB。

## 上传

GitHub 没有提供设置这张图的 API，只能在网页上操作：仓库的 Settings → General → Social preview → Edit → Upload an image。
