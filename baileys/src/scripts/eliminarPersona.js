const { unsetPersonaNumero } = require("../db");
const { normalizeJid } = require("../jidUtils")


module.exports = {
    async run(vars, numero) {
        try {
            numero = normalizeJid(numero)
            const result = unsetPersonaNumero.run(Date.now(), vars.id_persona, numero);

            console.log(`Filas modificadas: ${result.changes}`);

            return { next: "ok" };
        } catch (err) {
            console.error("Error eliminando persona", err);
            return { next: "error" };
        }
    }
};