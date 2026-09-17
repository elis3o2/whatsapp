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
    relacion    TEXT NOT NULL,
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
    name        TEXT,
    id_calle    INTEGER,
    altura      INTEGER,
    bis         INTEGER DEFAULT 0,
    latitud     REAL,
    longitud    REAL,
    datetime    INTEGER NOT NULL,

    UNIQUE(id_calle, altura, bis)
);

CREATE TABLE IF NOT EXISTS domicilio_persona (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    id_domicilio  INTEGER NOT NULL,
    id_persona    INTEGER NOT NULL,
    estado        INTEGER NOT NULL DEFAULT 1,
    datetime      INTEGER NOT NULL,

    UNIQUE(id_domicilio, id_persona),

    FOREIGN KEY(id_domicilio)
        REFERENCES domicilio(id)
        ON DELETE CASCADE,

    FOREIGN KEY(id_persona)
        REFERENCES persona(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_domicilio_persona_persona
ON domicilio_persona(id_persona);

CREATE INDEX IF NOT EXISTS idx_domicilio_persona_domicilio
ON domicilio_persona(id_domicilio);

CREATE TABLE IF NOT EXISTS interseccion (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT,
    codigo_interseccion   INTEGER,
    latitud               REAL,
    longitud              REAL,
    datetime              INTEGER,

    UNIQUE(name, codigo_interseccion)
);

CREATE TABLE IF NOT EXISTS interseccion_persona (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    id_interseccion INTEGER NOT NULL,
    id_persona      INTEGER NOT NULL,
    datetime        INTEGER NOT NULL,
    estado          INTEGER DEFAULT 1,

    UNIQUE(id_interseccion, id_persona),

    FOREIGN KEY(id_interseccion)
        REFERENCES interseccion(id)
        ON DELETE CASCADE,

    FOREIGN KEY(id_persona)
        REFERENCES persona(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interseccion_persona_persona
ON interseccion_persona(id_persona);

CREATE INDEX IF NOT EXISTS idx_interseccion_persona_interseccion
ON interseccion_persona(id_interseccion);

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
    relacion,
    datetime
)
VALUES (
    @id_persona,
    @numero,
    @estado,
    @relacion,
    @datetime
)
ON CONFLICT(id_persona, numero)
DO UPDATE SET
    relacion = excluded.relacion,
    estado = excluded.estado,
    datetime = excluded.datetime
`);


const getPersonaByDocumento = db.prepare(`SELECT * FROM persona WHERE documento = ? AND sexo = ? LIMIT 1`);
const getPersonaById = db.prepare(`SELECT * FROM persona WHERE id = ? LIMIT 1`);
const getPersonaByNumero = db.prepare(`SELECT p.*, pn.relacion FROM persona p JOIN persona_numero pn ON pn.id_persona = p.id
                                      WHERE pn.numero = ? AND pn.estado = 1`);
const desactivarOtrosNumeros = db.prepare(`UPDATE persona_numero SET estado = 0 WHERE id_persona = ? AND numero != ? AND estado = 1`);

// ==============================
// DOMICILIO
// ==============================

const insertDomicilio = db.prepare(`
INSERT INTO domicilio (
    name,
    id_calle,
    altura,
    bis,
    latitud,
    longitud,
    datetime
)
VALUES (
    @name,
    @id_calle,
    @altura,
    @bis,
    @latitud,
    @longitud,
    @datetime
)
`);

const insertDomicilioPersona = db.prepare(`
INSERT INTO domicilio_persona (
    id_domicilio,
    id_persona,
    estado,
    datetime
)
VALUES (
    @id_domicilio,
    @id_persona,
    @estado,
    @datetime
)
ON CONFLICT(id_domicilio, id_persona)
DO UPDATE SET
    estado = excluded.estado,
    datetime = excluded.datetime
`);

const getDomicilioPersona = db.prepare(`
SELECT d.*
FROM domicilio d
JOIN domicilio_persona dp
  ON dp.id_domicilio = d.id
WHERE dp.id_persona = ?
  AND dp.estado = 1
LIMIT 1
`);

const findDomicilio = db.prepare(`
SELECT *
FROM domicilio
WHERE id_calle = ?
  AND altura = ?
  AND bis = ?
LIMIT 1
`);

// ==============================
// INTERSECCION
// ==============================

const insertInterseccion = db.prepare(`
INSERT INTO interseccion (
    name,
    codigo_interseccion,
    latitud,
    longitud,
    datetime
)
VALUES (
    @name,
    @codigo_interseccion,
    @latitud,
    @longitud,
    @datetime
)
`);

const insertInterseccionPersona = db.prepare(`
INSERT INTO interseccion_persona (
    id_interseccion,
    id_persona,
    estado,
    datetime
)
VALUES (
    @id_interseccion,
    @id_persona,
    @estado,
    @datetime
)
ON CONFLICT(id_interseccion, id_persona)
DO UPDATE SET
    estado = excluded.estado,
    datetime = excluded.datetime
`);

const findInterseccion = db.prepare(`
SELECT *
FROM interseccion
WHERE codigo_interseccion = ?
LIMIT 1
`);

const getInterseccionPersona = db.prepare(`
SELECT i.*
FROM interseccion i
JOIN interseccion_persona ip
  ON ip.id_interseccion = i.id
WHERE ip.id_persona = ?
  AND ip.estado = 1
LIMIT 1
`);
// ==============================

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

const unsetDomicilios = db.prepare(`
UPDATE domicilio_persona
SET estado = 0,
    datetime = ?
WHERE id_persona = ?
  AND estado = 1
`);

const unsetIntersecciones = db.prepare(`
UPDATE interseccion_persona
SET estado = 0,
    datetime = ?
WHERE id_persona = ?
  AND estado = 1
`);

const unsetDomiciliosNoRegistrados = db.prepare(`
UPDATE domicilio_no_registrado
SET estado = 0,
    datetime = ?
WHERE id_persona = ?
  AND estado = 1
`);

const unsetPersonaNumero = db.prepare(`
UPDATE persona_numero
SET estado = 0,
    datetime = ?
WHERE id_persona = ?
  AND numero = ?
`);

const unsetDomiciliosPersona = db.transaction((id_persona, datetime) => {
    unsetDomicilios.run(datetime, id_persona);
    unsetIntersecciones.run(datetime, id_persona);
    unsetDomiciliosNoRegistrados.run(datetime, id_persona);
});

const getDatosDomicilioSet = db.prepare(`
SELECT
    d.id          AS domicilio_id,
    d.name        AS domicilio_nombre,

    i.id          AS interseccion_id,
    i.name        AS interseccion_nombre,

    dnr.id        AS domicilio_nr_id,
    dnr.domicilio AS domicilio_no_registrado

FROM persona p

LEFT JOIN domicilio_persona dp
       ON dp.id_persona = p.id
      AND dp.estado = 1

LEFT JOIN domicilio d
       ON d.id = dp.id_domicilio

LEFT JOIN interseccion_persona ip
       ON ip.id_persona = p.id
      AND ip.estado = 1

LEFT JOIN interseccion i
       ON i.id = ip.id_interseccion

LEFT JOIN domicilio_no_registrado dnr
       ON dnr.id_persona = p.id
      AND dnr.estado = 1

WHERE p.id = ?
LIMIT 1
`);

module.exports = {
    db,
    insertMensaje,
    getMensajeById,
    getMensajesByNumero,
    updateMensaje,
    insertPersona,
    insertInterseccionPersona,
    getInterseccionPersona,
    findInterseccion,
    getPersonaByNumero,
    getPersonaByDocumento,
    getPersonaById,
    insertDomicilio,
    insertDomicilioPersona,
    getDomicilioPersona,
    findDomicilio,
    insertInterseccion,
    getDatosDomicilioSet,
    insertDomicilioNoRegistrado,
    insertPersonaNumero,
    desactivarOtrosNumeros,
    unsetDomiciliosPersona,
    unsetPersonaNumero
  };