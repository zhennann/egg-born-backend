const uuid = require('uuid');
const mparse = require('egg-born-mparse').default;
const util = require('./util.js');
const ModelClass = require('../base/model.js');

module.exports = function(loader) {

  // meta
  const meta = loader.app.geto('meta');

  // workerId
  meta.workerId = uuid.v4();

  // app or agent
  meta.inApp = loader.app.type === 'application';
  meta.inAgent = loader.app.type === 'agent';

  // isProd
  meta.isProd = loader.app.config.env !== 'local' && loader.app.config.env !== 'unittest' && loader.app.config.env !== 'test';
  // isTest
  meta.isTest = loader.app.config.env === 'unittest' || loader.app.config.env === 'test';
  // isLocal
  meta.isLocal = loader.app.config.env === 'local';

  // util
  meta.util = util;

  // mockUtil
  meta.mockUtil = createMockUtil();

  // model
  meta.Model = ModelClass(loader.app);

  return meta;
};

function createMockUtil() {
  return {
    parseUrlFromPackage(dir) {
      const moduleInfo = this.parseInfoFromPackage(dir);
      if (!moduleInfo) return null;
      return `/api/${moduleInfo.pid}/${moduleInfo.name}`;
    },
    parseInfoFromPackage(dir) {
      const file = util.lookupPackage(dir);
      if (!file) return null;
      const pkg = require(file);
      return mparse.parseInfo(mparse.parseName(pkg.name));
    },
    mockUrl(dir, url) {
      if (url && url.charAt(0) === '/') return `/api${url}`;
      const prefix = this.parseUrlFromPackage(dir);
      return url ? `${prefix}/${url}` : `${prefix}/`;
    },
  };
}
