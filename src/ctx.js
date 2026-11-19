// Shared registry: each renderer module attaches its public API here
// (ctx.tabs, ctx.sidebar, ctx.nav, …) so modules can call each other
// without circular require() problems.
module.exports = {};
