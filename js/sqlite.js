// sql.js 只初始化一次（登录与数据库共用），页面加载时即开始下载编译 wasm
let p = null;
export function getSQL() {
  if (!p) p = window.initSqlJs({ locateFile: (f) => `assets/vendor/sqljs/${f}` });
  return p;
}
