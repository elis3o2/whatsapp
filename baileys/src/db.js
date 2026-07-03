const path = require("path");
const Database = require("better-sqlite3");

const SESSION_ID = process.env.SESSION_ID;

const db = new Database(
    path.join(__dirname, `messages_${SESSION_ID}.db`)
);

// Habilitar claves foráneas
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS persona (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    documento   TEXT NOT NULL,
    sexo        TEXT NOT NULL,
    nombre      TEXT,
    apellido    TEXT,
    datetime    INTEGER NOT NULL,

    UNIQUE(documento, sexo)
);

CREATE INDEX IF NOT EXISTS idx_persona_documento
ON persona(documento, sexo);

CREATE TABLE IF NOT EXISTS persona_numero (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    id_persona  INTEGER NOT NULL,
    numero      TEXT NOT NULL,
    estado      INTEGER NOT NULL DEFAULT 1,
    datetime    INTEGER NOT NULL,

    UNIQUE(id_persona, numero),
    FOREIGN KEY(id_persona)
        REFERENCES persona(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_persona_numero_persona
ON persona_numero(id_persona);

CREATE INDEX IF NOT EXISTS idx_persona_numero_numero ON persona_numero(numero);


CREATE TABLE IF NOT EXISTS domicilio (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    id_persona  INTEGER NOT NULL,
    name        TEXT,
    id_calle    INTEGER,
    altura      INTEGER,
    bis         INTEGER DEFAULT 0,
    latitud     REAL,
    longitud    REAL,
    datetime    INTEGER NOT NULL,
    estado      INTEGER DEFAULT 1,

    FOREIGN KEY(id_persona)
        REFERENCES persona(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_domicilio_persona
ON domicilio(id_persona);


CREATE TABLE IF NOT EXISTS interseccion (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    id_persona            INTEGER NOT NULL,
    name                  TEXT,
    codigo_interseccion   INTEGER,
    latitud               REAL,
    longitud              REAL,
    datetime              INTEGER NOT NULL,
    estado                INTEGER DEFAULT 1,

    FOREIGN KEY(id_persona)
        REFERENCES persona(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interseccion_persona
ON interseccion(id_persona);


CREATE TABLE IF NOT EXISTS domicilio_no_registrado (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    id_persona  INTEGER NOT NULL,
    domicilio   TEXT NOT NULL,
    datetime    INTEGER NOT NULL,
    estado      INTEGER DEFAULT 1,
    
    FOREIGN KEY(id_persona)
        REFERENCES persona(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_domicilio_nr_persona
ON domicilio_no_registrado(id_persona);


CREATE TABLE IF NOT EXISTS mensaje (
    id             TEXT PRIMARY KEY,
    numero         TEXT NOT NULL,
    from_me        INTEGER NOT NULL DEFAULT 0,
    ack            INTEGER NOT NULL DEFAULT 0,
    datetime_envio INTEGER NOT NULL, 
    timestamp      INTEGER NOT NULL,
    body           TEXT
);

CREATE INDEX IF NOT EXISTS idx_mensaje_numero
ON mensaje(numero);

CREATE INDEX IF NOT EXISTS idx_mensaje_timestamp
ON mensaje(timestamp);
`);

// ==============================
// MENSAJES
// ==============================
const insertMensaje = db.prepare(`
INSERT INTO mensaje (
    id,
    numero,
    from_me,
    ack,
    datetime_envio,
    timestamp,
    body
)
VALUES (
    @id,
    @numero,
    @from_me,
    @ack,
    @datetime_envio,
    @timestamp,
    @body
)
ON CONFLICT(id)
DO UPDATE SET
    ack       = excluded.ack,
    body      = excluded.body,
    timestamp = excluded.timestamp
`);
const getMensajeById = db.prepare(`SELECT * FROM mensaje WHERE id = ? LIMIT 1`);
const getMensajesByNumero = db.prepare(`SELECT * FROM mensaje WHERE numero = ? ORDER BY timestamp DESC LIMIT 100`);
const updateMensaje = db.prepare(`UPDATE mensaje SET ack = ? WHERE id = ?`);

// ==============================
// PERSONA
// ==============================
const insertPersona = db.prepare(`
INSERT INTO persona (
    documento,
    sexo,
    nombre,
    apellido,
    datetime
)
VALUES (
    @documento,
    @sexo,
    @nombre,
    @apellido,
    @datetime
)
`);

const insertPersonaNumero = db.prepare(`
INSERT INTO persona_numero (
    id_persona,
    numero,
    estado,
    datetime
)
VALUES (
    @id_persona,
    @numero,
    @estado,
    @datetime
)
ON CONFLICT(id_persona, numero)
DO UPDATE SET
    estado = excluded.estado
`);


const getPersonaByDocumento = db.prepare(`SELECT * FROM persona WHERE documento = ? AND sexo = ? LIMIT 1`);
const getPersonaById = db.prepare(`SELECT * FROM persona WHERE id = ? LIMIT 1`);
const getPersonaByNumero = db.prepare(`SELECT p.* FROM persona p JOIN persona_numero pn ON pn.id_persona = p.id
                                      WHERE pn.numero = ? AND pn.estado = 1`);
const desactivarOtrosNumeros = db.prepare(`UPDATE persona_numero SET estado = 0 WHERE id_persona = ? AND numero != ? AND estado = 1`);


// ==============================
// DOMICILIO
// ==============================
const insertDomicilio = db.prepare(`
INSERT INTO domicilio (
    id_persona,
    name,
    id_calle,
    altura,
    bis,
    latitud,
    longitud,
    datetime
)
VALUES (
    @id_persona,
    @name,
    @id_calle,
    @altura,
    @bis,
    @latitud,
    @longitud,
    @datetime
)
`);
const getDomicilio = db.prepare(`SELECT * FROM domicilio WHERE id_persona = ? LIMIT 1`);
const insertInterseccion = db.prepare(`
INSERT INTO interseccion (
    id_persona,
    name,
    codigo_interseccion,
    latitud,
    longitud,
    datetime
)
VALUES (
    @id_persona,
    @name,
    @codigo_interseccion,
    @latitud,
    @longitud,
    @datetime
)
`);

const getInterseccion = db.prepare(`SELECT * FROM interseccion WHERE id_persona = ? LIMIT 1`);
const insertDomicilioNoRegistrado = db.prepare(`
INSERT INTO domicilio_no_registrado (
    id_persona,
    domicilio,
    datetime
)
VALUES (
    @id_persona,
    @domicilio,
    @datetime
)
`);
const unsetDomicilios = db.prepare(`UPDATE domicilio SET estado = 0 WHERE id_persona = ? AND estado = 1`);
const unsetIntersecciones = db.prepare(`UPDATE interseccion SET estado = 0 WHERE id_persona = ? AND estado = 1`);
const unsetDomiciliosNoRegistrados = db.prepare(`UPDATE domicilio_no_registrado SET estado = 0 WHERE id_persona = ? AND estado = 1`);

const unsetDomiciliosPersona = db.transaction((id_persona) => {
  unsetDomicilios.run(id_persona);
  unsetIntersecciones.run(id_persona);
  unsetDomiciliosNoRegistrados.run(id_persona);
});

const getDomicilioNoRegistrado = db.prepare(`SELECT * FROM domicilio_no_registrado WHERE id_persona = ? LIMIT 1`);
module.exports = {
    db,
    insertMensaje,
    getMensajeById,
    getMensajesByNumero,
    updateMensaje,
    insertPersona,
    getPersonaByNumero,
    getPersonaByDocumento,
    getPersonaById,
    insertDomicilio,
    getDomicilio,
    insertInterseccion,
    getInterseccion,
    insertDomicilioNoRegistrado,
    getDomicilioNoRegistrado,
    insertPersonaNumero,
    desactivarOtrosNumeros,
    unsetDomiciliosPersona
  };