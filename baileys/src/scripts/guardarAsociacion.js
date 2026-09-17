const {
  insertPersona,
  getPersonaByDocumento,
  insertPersonaNumero,
  desactivarOtrosNumeros
} = require("../db");

const { normalizeJid } = require("../jidUtils")

module.exports = {
  async run(vars, numero) {
    try {
      let persona = getPersonaByDocumento.get(vars.dni, vars.sexo);

      let id_persona;
      if (persona) {
        id_persona = persona.id;
      } else {
        const result = insertPersona.run({
          documento: vars.dni,
          sexo: vars.sexo,
          nombre: vars.persona.nombre,
          apellido: vars.persona.apellido,
          datetime: Date.now(),
          relacion: vars.relacion
        });
        id_persona = result.lastInsertRowid;
      }

      numero = normalizeJid(numero)
      // Si la persona tenía otro(s) número(s) activo(s), se desactivan
      desactivarOtrosNumeros.run(id_persona, numero);

      // Vincula (o reactiva) el número entrante como activo
      insertPersonaNumero.run({
        id_persona,
        numero,
        estado: 1,
        relacion: vars.relacion,
        datetime: Date.now()
      });

      return { next: "ok",
        vars: {id_persona: id_persona}
       };
    } catch (err) {
      console.error("Error guardando asociación:", err);
      return { next: "error" };
    }
  }
};