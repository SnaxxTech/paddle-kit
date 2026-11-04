// src/db/index.ts
function fromPg(pool) {
  return {
    query: (text, params) => pool.query(text, params),
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (text, params) => client.query(text, params) });
        await client.query("COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        throw error;
      } finally {
        client.release(broken);
      }
    }
  };
}
var on = (s) => async (text, params) => ({ rows: [...await s.unsafe(text, params ?? [])] });
function fromPostgresJs(sql) {
  return {
    query: on(sql),
    transaction: async (fn) => await sql.begin((tx) => fn({ query: on(tx) }))
  };
}
function fromPostgresJsPerCall(make) {
  const scoped = async (fn) => {
    const sql = make();
    try {
      return await fn(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
  return {
    query: (text, params) => scoped((sql) => on(sql)(text, params)),
    transaction: (fn) => scoped(async (sql) => await sql.begin((tx) => fn({ query: on(tx) })))
  };
}
function fromPglite(db) {
  return {
    query: (text, params) => db.query(text, params),
    transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) }))
  };
}
export {
  fromPg,
  fromPglite,
  fromPostgresJs,
  fromPostgresJsPerCall
};
