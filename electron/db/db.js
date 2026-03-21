const fs = require("node:fs");
const path = require("node:path");

const { migrate } = require("./migrations");

let SQL = null;

async function getSqlJs() {
  if (SQL) return SQL;
  // sql.js loads a wasm file; locate it from node_modules (unpacked in production).
  // eslint-disable-next-line global-require
  const initSqlJs = require("sql.js");
  const distDir = path.join(__dirname, "..", "..", "node_modules", "sql.js", "dist");
  SQL = await initSqlJs({
    locateFile: (file) => path.join(distDir, file)
  });
  return SQL;
}

function createWrapper({ rawDb, dbPath }) {
  let dirty = false;
  let flushTimer = null;

  const normalizeParams = (args) => {
    if (!args || args.length === 0) return [];
    if (args.length === 1) {
      const p = args[0];
      if (Array.isArray(p)) return p;
      if (p && typeof p === "object") return p; // named params
      return [p]; // single scalar
    }
    return args; // positional params
  };

  const flushSync = () => {
    if (!dirty) return;
    const data = rawDb.export();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(data));
    dirty = false;
  };

  const markDirty = () => {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        flushSync();
      } catch {
        // ignore
      }
    }, 200);
  };

  const exec = (sql) => {
    rawDb.exec(sql);
    markDirty();
  };

  const pragma = (statement) => {
    rawDb.exec(`PRAGMA ${statement}`);
    markDirty();
  };

  const prepare = (sql) => {
    const stmt = rawDb.prepare(sql);
    const bind = (params) => {
      if (params == null) {
        stmt.bind([]);
        return;
      }
      if (Array.isArray(params)) {
        stmt.bind(params);
        return;
      }
      // sql.js named params: keys must include prefix (@, :, $). Map id -> @id.
      const out = {};
      for (const [k, v] of Object.entries(params)) {
        const key = /^[@:$]/.test(k) ? k : `@${k}`;
        out[key] = v;
      }
      stmt.bind(out);
    };

    const get = (...args) => {
      bind(normalizeParams(args));
      const has = stmt.step();
      const out = has ? stmt.getAsObject() : undefined;
      stmt.free();
      return out;
    };

    const all = (...args) => {
      bind(normalizeParams(args));
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      stmt.free();
      return out;
    };

    const run = (...args) => {
      bind(normalizeParams(args));
      while (stmt.step()) {
        // consume result rows if any
      }
      stmt.free();
      markDirty();
      return { ok: true };
    };

    return { get, all, run };
  };

  const transaction = (fn) => {
    return (...args) => {
      exec("BEGIN");
      try {
        const res = fn(...args);
        exec("COMMIT");
        markDirty();
        return res;
      } catch (e) {
        try {
          exec("ROLLBACK");
        } catch {
          // ignore
        }
        throw e;
      }
    };
  };

  const close = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushSync();
    rawDb.close();
  };

  return {
    exec,
    pragma,
    prepare,
    transaction,
    flushSync,
    close
  };
}

async function openDb(dbPath) {
  const SQL = await getSqlJs();
  let rawDb;
  if (fs.existsSync(dbPath)) {
    const bytes = fs.readFileSync(dbPath);
    rawDb = new SQL.Database(new Uint8Array(bytes));
  } else {
    rawDb = new SQL.Database();
  }

  const db = createWrapper({ rawDb, dbPath });
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.flushSync();
  return db;
}

function closeDb(db) {
  db.close();
}

module.exports = {
  openDb,
  closeDb
};

