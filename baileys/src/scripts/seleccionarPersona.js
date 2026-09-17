module.exports = {
    async run(vars) {
        const indice = parseInt(vars.indice_persona, 10);

        if (isNaN(indice) || indice < 1 || indice > vars.personas.length) {
            return {
                next: "invalido"
            };
        }

        const persona = vars.personas[indice - 1];

        return {
            next: "ok",
            vars: {
                persona,
                id_persona: persona.id,
                indice_persona: indice
            }
        };
    }
};