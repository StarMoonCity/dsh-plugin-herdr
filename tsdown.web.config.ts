import { defineConfig } from 'tsdown'

// Web 客户端 bundle：浏览器平台，JSX，外部化 react / dsh client 依赖
// （运行时由 web shell 的 ClientModuleLoader 解析，见 dsh-client-modules）。
// banner/footer 生成 __ModuleLoader__.load 注册包装（factory 单参 require，返回 exports）。
// neverBundle 只列 bundle 中真实存在的 bare import：react、react/jsx-runtime 与
// dsh-client-ui-primitives（PLATFORM_MODULES 静态 UI 库，基线模块表提供）。
// 服务（slots / locale / sessions / uiWorkspace）经 Cordis 服务图获取，不是模块边；
// 其提供者由 package.json 的 dsh.client.inject + 服务级 inject 表达。
// 注：tsdown 的顶层 `external` 已弃用，改用 deps.neverBundle。
const MODULE_LOADER_ID = 'dsh-plugin-herdr'

export default defineConfig({
  entry: ['src/client.tsx'],
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  jsx: 'automatic',
  target: 'es2022',
  dts: true,
  clean: false,
  banner: () => `window.__ModuleLoader__.load({
  id: "${MODULE_LOADER_ID}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`,
  footer: () => `
    return module.exports;
  }
});
`,
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    alwaysBundle: ['@xterm/xterm', '@xterm/addon-fit'],
  },
})
