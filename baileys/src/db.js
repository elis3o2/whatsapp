const path = require("path");
const Database = require("better-sqlite3");

const SESSION_ID = process.env.SESSION_ID;

const db = new Database(
    path.join(__dirname, `messages_${SESSION_ID}.db`)
);


db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        TEXT NOT NULL,
    jid       TEXT NOT NULL,
    from_me   INTEGER NOT NULL DEFAULT 0,
    ack       INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL,
    body      TEXT,
    raw       TEXT NOT NULL,
    PRIMARY KEY (id, jid)
  );
  CREATE INDEX IF NOT EXISTS idx_jid ON messages(jid);
`)


db.exec(`
CREATE TABLE IF NOT EXISTS contactos (
    numero TEXT NOT NULL,
    documento TEXT NOT NULL,
    sexo TEXT NOT NULL,
    actualizado INTEGER NOT NULL,
    PRIMARY KEY(numero, documento, sexo)
);
`);

const stmtUpsert = db.prepare(`
  INSERT INTO messages (id, jid, from_me, ack, timestamp, body, raw)
  VALUES (@id, @jid, @from_me, @ack, @timestamp, @body, @raw)
  ON CONFLICT(id, jid) DO UPDATE SET ack = excluded.ack, raw = excluded.raw
`)


const stmtUpsertContacto = db.prepare(`
INSERT INTO contactos (
    numero,
    documento,
    sexo,
    actualizado
)
VALUES (
    @numero,
    @documento,
    @sexo,
    @actualizado
)
ON CONFLICT(numero, documento, sexo)
DO UPDATE SET
    actualizado = excluded.actualizado
`);

const stmtGetById    = db.prepare(`SELECT * FROM messages WHERE id = ? AND jid = ? LIMIT 1`)
const stmtGetByMsgId = db.prepare(`SELECT * FROM messages WHERE id = ? LIMIT 1`)  // fallback sin jid
const stmtGetByJid   = db.prepare(`SELECT * FROM messages WHERE jid = ? AND from_me = 1 ORDER BY timestamp DESC LIMIT 100`)
const stmtUpdateAck  = db.prepare(`UPDATE messages SET ack = ? WHERE id = ?`)     // actualiza por id sin importar jid


module.exports = {
    db,
    stmtUpsert,
    stmtUpsertContacto,
    stmtGetById,
    stmtGetByMsgId,
    stmtGetByJid,
    stmtUpdateAck
};