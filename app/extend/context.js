const http = require('http');
const compose = require('koa-compose');
const onFinished = require('on-finished');
const statuses = require('statuses');
const isJSON = require('koa-is-json');
const Stream = require('stream');
const is = require('is-type-of');
const mparse = require('egg-born-mparse').default;

const MODULE = Symbol.for('Context#__module');
const DATABASE = Symbol.for('Context#__database');
const DATABASEMETA = Symbol.for('Context#__databasemeta');
const SAFEACCESS = Symbol.for('Context#__safeaccess');

module.exports = {
  get module() {
    if (this[MODULE] === undefined) {
      const info = mparse.parseInfo(mparse.parseName(this.req.mockUrl || this.req.url));
      this[MODULE] = info ? this.app.meta.modules[info.relativeName] : null;
    }
    return this[MODULE];
  },
  get db() {
    if (!this[DATABASE]) {
      this[DATABASE] = createDatabase(this);
    }
    return this[DATABASE];
  },
  get dbMeta() {
    if (!this[DATABASEMETA]) {
      this[DATABASEMETA] = { master: true, transaction: false, connection: { conn: null } };
    }
    return this[DATABASEMETA];
  },
  set dbMeta(meta) {
    if (meta.transaction) {
      this.dbMeta.master = false;
      this.dbMeta.transaction = true;
      this.dbMeta.connection = meta.connection;
    }
  },
  get safeAccess() {
    return this[SAFEACCESS];
  },
  set safeAccess(value) {
    this[SAFEACCESS] = value;
  },

  /**
   * perform action of this or that module
   * @param  {string} options.method method
   * @param  {string} options.url    url
   * @param  {json} options.data   data(optional)
   * @return {promise}                response.body.data or throw error
   */
  performAction({ method, url, query, params, body }) {
    return new Promise((resolve, reject) => {
      const handleRequest = appCallback.call(this.app);
      const request = createRequest({
        method,
        url: adjustUrl(this, url),
      }, this.request);
      const response = new http.ServerResponse(request);
      handleRequest(this, request, response, resolve, reject, query, params, body);
    });
  },

  getVal(name) {
    return (this.params && this.params[name]) || (this.query && this.query[name]) || (this.request.body && this.request.body[name]);
  },

  getInt(name) {
    return parseInt(this.getVal(name));
  },

  getFloat(name) {
    return parseFloat(this.getVal(name));
  },

  getStr(name) {
    const v = this.getVal(name);
    return (v && v.toString()) || '';
  },

  getSafeStr(name) {
    const v = this.getStr(name);
    return v.replace(/'/gi, "''");
  },

  successMore(list, index, size) {
    this.success({ list, index: index + list.length, finished: list.length < size });
  },

};

function appCallback() {
  const fn = compose(this.middleware);
  const self = this;

  if (!this.listeners('error').length) this.on('error', this.onerror);

  return function handleRequest(ctxCaller, req, res, resolve, reject, query, params, body) {
    res.statusCode = 404;
    const ctx = self.createContext(req, res);
    onFinished(res, ctx.onerror);

    // query params body
    if (query) ctx.query = query;
    if (params) ctx.params = params;
    if (body) ctx.request.body = body;

    // multipart
    ctx.multipart = function(options) {
      return ctxCaller.multipart(options);
    };

    // cookies
    delegateCookies(ctx, ctxCaller);

    // transaction
    ctx.dbMeta = ctxCaller.dbMeta;

    // ctxCaller
    ctx.ctxCaller = ctxCaller;

    // safeAccess
    ctx.safeAccess = true;

    // call
    fn(ctx).then(function handleResponse() {
      respond.call(ctx);
      if (ctx.status === 200 && ctx.body) {
        if (ctx.body.code === 0) {
          resolve(ctx.body.data);
        } else {
          reject(ctx.body);
        }
      } else {
        reject({ code: ctx.status, message: ctx.body });
      }
    }).catch(err => {
      ctx.onerror(err);
      reject({ code: err.code || ctx.status, message: err.message || ctx.body });
    });
  };
}

function respond() {
  // allow bypassing koa
  if (this.respond === false) return;

  const res = this.res;
  if (res.headersSent || !this.writable) return;

  let body = this.body;
  const code = this.status;

  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    this.body = null;
    return res.end();
  }

  if (this.method === 'HEAD') {
    if (isJSON(body)) this.length = Buffer.byteLength(JSON.stringify(body));
    return res.end();
  }

  // status body
  if (body == null) {
    this.type = 'text';
    body = this.message || String(code);
    this.length = Buffer.byteLength(body);
    return res.end(body);
  }

  // responses
  if (Buffer.isBuffer(body)) return res.end(body);
  if (typeof body === 'string') return res.end(body);
  if (body instanceof Stream) return body.pipe(res);

  // body: json
  body = JSON.stringify(body);
  this.length = Buffer.byteLength(body);
  res.end(body);
}

function delegateCookies(ctx, ctxCaller) {
  Object.defineProperty(ctx.cookies, 'keys', {
    get() {
      return ctxCaller.cookies.keys;
    },
  });
  Object.defineProperty(ctx.cookies, 'get', {
    get() {
      return function(name, opts) {
        return ctxCaller.cookies.get(name, opts);
      };
    },
  });
  Object.defineProperty(ctx.cookies, 'set', {
    get() {
      return function(name, value, opts) {
        return ctxCaller.cookies.set(name, value, opts);
      };
    },
  });
}

function adjustUrl(ctx, url) {
  if (url.substr(0, 2) === '//') return url.substr(1);
  if (url.charAt(0) === '/') return `/api${url}`;

  if (!ctx.module) throw new Error('invalid url');
  return `/api/${ctx.module.info.url}/${url}`;
}

function createRequest({ method, url }, _req) {
  const req = new http.IncomingMessage();
  req.headers = _req.headers;
  req.host = _req.host;
  req.hostname = _req.hostname;
  req.protocol = _req.protocol;
  req.secure = _req.secure;
  req.method = method.toUpperCase();
  req.url = url;
  // path,
  req.socket = {
    remoteAddress: _req.socket.remoteAddress,
    remotePort: _req.socket.remotePort,
  };
  return req;
}

function createDatabase(ctx) {

  const __db = {};

  const db = ctx.app.mysql.__ebdb_test || ctx.app.mysql.get('__ebdb');
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(db));
  Object.keys(proto).forEach(key => {
    Object.defineProperty(__db, key, {
      get() {
        if (is.function(db[key])) {
          return function() {
            const args = arguments;

            // check if promise
            if (db[key].name !== 'createPromise') {
              return db[key].apply(db, args);
            }

            // check if use transaction
            if (!ctx.dbMeta.transaction) return db[key].apply(db, args);

            // use transaction
            if (!ctx.dbMeta.connection.conn) {
              return new Promise(function(resolve, reject) {
                db.beginTransaction()
                  .then(conn => {
                    ctx.dbMeta.connection.conn = conn;
                    const fn = ctx.dbMeta.connection.conn[key].apply(ctx.dbMeta.connection.conn, args);
                    if (!is.promise(fn)) {
                      resolve(fn);
                    } else {
                      fn.then(res => resolve(res)).catch(err => reject(err));
                    }
                  })
                  .catch(err => reject(err));
              });
            }
            // connection ready
            return ctx.dbMeta.connection.conn[key].apply(ctx.dbMeta.connection.conn, args);
          };
        }
        // property
        return db[key];
      },
    });
  });

  return __db;
}
