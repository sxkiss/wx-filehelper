// @input: dist/index.js 默认导出
// @output: CommonJS 插件入口
// @position: 兼容 require 场景的桥接文件
// @auto-doc: Update header and folder INDEX.md when this file changes

const plugin = require('./dist/index.js').default;
module.exports = plugin;
