const { getPersonaByNumero } = require("../db");
const { normalizeJid } = require("../jidUtils")


module.exports = {
    async run(vars, numero) {
        numero = normalizeJid(numero);

        const personas = getPersonaByNumero.all(numero);
        if (personas.length === 0) {
            return {
                next: "no_encontrado"
            };
        }

        const lista = personas
            .map((p, i) =>
                `${i + 1}. ${p.nombre} ${p.apellido} (${p.relacion})\n   Documento: ${p.documento}`
            )
            .join("\n\n");

        return {
            next: "encontrado",
            vars: {
                personas,
                personas_texto: lista
            }
        };
    }
};