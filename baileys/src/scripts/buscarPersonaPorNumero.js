const { getPersonaByNumero } = require("../db");

module.exports = {
    async run(vars, numero) {

        const persona = getPersonaByNumero.get(numero);

        if (!persona) {
            return {
                next: "no_encontrado"
            };
        }

        return {
            next: "encontrado",
            vars: {
                persona: {
                    id: persona.id,
                    documento: persona.documento,
                    sexo: persona.sexo,
                    nombre: persona.nombre,
                    apellido: persona.apellido
                }
            }
        };
    }
};